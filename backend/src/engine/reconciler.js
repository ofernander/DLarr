// DLarr — state reconciler
//
// Merges three data sources into the authoritative state for each file:
//   1. Remote scan (from RemoteScanner, per-watch)
//   2. Local scan  (from LocalScanner, per-watch)
//   3. LFTP job status (shared, from Lftp.jobs() + parseJobs())
//
// Data model (as of 2026-04-18):
//   - `state` tracks DLarr's workflow state: what we did or are doing
//     with the file (seen / queued / downloading / downloaded / error /
//     ignored / dismissed).
//   - `on_remote` / `on_local` are presence bits, refreshed every scan.
//     They describe where the file exists *right now*, not what DLarr
//     did with it. UI shows them as a split "remote ✓ local ✗" chip.
//   - Rows where BOTH presence bits are false AND the state is not in
//     an active LFTP workflow (queued/downloading) are purged at the end
//     of each tick. No tombstones — if a file is nowhere and we're not
//     working on it, it stops existing in our tracking.
//
// For each watch tick, the reconciler:
//   - Pass 1: For every remote file, upsert the row; set on_remote=1;
//     set on_local=(1 if local else 0); run workflow-state derivation.
//   - Pass 2: For rows not seen in this remote scan, set on_remote=0.
//     No state change — the workflow state records history, presence
//     bits record current reality.
//   - Pass 3: Delete-on-disappear handling for downloaded files that
//     went missing locally (optional per-watch, guardrailed).
//   - Pass 4: Tombstone purge — delete rows with both presence bits
//     false and no active LFTP workflow.
//
// The dispatcher (separate module) actually issues LFTP commands and SSH
// deletes. The reconciler only *records state*; it returns a list of
// recommended actions for the dispatcher to carry out.
//
// Actions returned:
//   [{ type: 'queue',         fileId, remotePath, localPath, isDir }]
//   [{ type: 'delete_remote', fileId, remotePath, triggeredBy }]
//
// If `opts.onDownloaded(fileId)` is provided, it's invoked (fire-and-forget)
// for each file that transitions into the `downloaded` state. The arr
// notifier hooks in here.

import { getDb } from '../db/db.js';
import { decide as decidePattern } from './matcher.js';
import { isDestinationReadable } from '../local/scanner.js';
import { logger } from '../logging/logger.js';
import { publishFileUpdate } from '../web/events.js';

function publishRow(db, fileId) {
  try {
    const row = db.prepare(`SELECT * FROM files WHERE id = ?`).get(fileId);
    if (row) publishFileUpdate(row);
  } catch { /* ignore */ }
}

// States that are user-visible terminal/near-terminal outcomes. Transitions
// *into* these are logged at INFO. Everything else (seen, queued, downloading)
// is internal churn and logged at DEBUG.
const USER_VISIBLE_STATES = new Set([
  'downloaded',
  'error',
]);

/**
 * Reconcile a single watch's state.
 *
 * @param {object} watch                 row from `watches` table
 * @param {Array}  remoteTree            output of RemoteScanner.scan()
 * @param {Array}  localTree             output of scanLocal()
 * @param {Array}  lftpJobs              output of parseJobs().jobs
 * @param {Array}  patterns              applicable pattern rows (global + this watch)
 * @param {object} [opts]
 * @param {Date}   [opts.now]            injected for testability
 * @param {function(number): void} [opts.onDownloaded]  called with fileId on DOWNLOADED transition
 * @returns {Array} list of dispatcher actions to execute
 */
export function reconcileWatch(watch, remoteTree, localTree, lftpJobs, patterns, opts = {}) {
  const db = getDb();
  const now = opts.now ?? new Date();
  const onDownloaded = opts.onDownloaded ?? (() => {});

  // Index sources by top-level name for quick lookup
  const localByName = new Map();
  for (const node of localTree) localByName.set(node.name, node);

  // LFTP jobs are keyed by the REMOTE path basename. The remote path is
  // preserved verbatim in our LFTP commands and uniquely identifies the
  // file. localPath does NOT work here because our commands pass parent
  // directories as LFTP targets (for both pget -o and mirror), so every
  // job's localPath is the same parent dir, not the target filename.
  const jobsByFileName = new Map();
  for (const job of lftpJobs) {
    if (!job.remotePath) continue;
    const name = job.remotePath.replace(/\/+$/, '').split('/').pop();
    if (name) jobsByFileName.set(name, job);
  }

  // Pull existing file rows for this watch, index by remote_path
  const existingRows = db.prepare(
    `SELECT * FROM files WHERE watch_id = ?`
  ).all(watch.id);
  const rowsByName = new Map(existingRows.map(r => [r.remote_path, r]));

  const actions = [];
  const seenNames = new Set();

  // Pass 1: iterate remote files — update/insert, set presence, decide actions
  for (const remote of remoteTree) {
    seenNames.add(remote.name);
    const local = localByName.get(remote.name) ?? null;
    const job = jobsByFileName.get(remote.name) ?? null;
    const row = rowsByName.get(remote.name) ?? null;

    const action = reconcileFile({
      watch, remote, local, job, row, patterns, now, db, onDownloaded,
    });
    if (action) actions.push(action);
  }

  // Pass 2: rows whose remote_path was NOT in this remote scan →
  // the file isn't on the remote right now. Flip on_remote=0. Don't
  // touch state — workflow state is independent of current presence.
  // Also refresh on_local from the local scan so the row is accurate.
  for (const [name, row] of rowsByName) {
    if (seenNames.has(name)) continue;
    const localNow = localByName.get(name) ? 1 : 0;
    db.prepare(`
      UPDATE files
      SET on_remote = 0,
          on_local  = ?,
          local_size = ?
      WHERE id = ?
    `).run(localNow, localByName.get(name)?.size ?? null, row.id);
    // Mutate the in-memory row so pass 3/4 see fresh values
    row.on_remote = 0;
    row.on_local  = localNow;
    row.local_size = localByName.get(name)?.size ?? null;
    publishRow(db, row.id);
  }

  // Pass 3: delete-on-disappear scan.
  // For DOWNLOADED files that are missing locally, increment their
  // missing-scan counter and, if the threshold is met and guardrails
  // pass, request a remote delete.
  if (watch.auto_delete_remote_on_local_missing === 1) {
    const destReadable = isDestinationReadable(watch.local_path);
    if (!destReadable) {
      logger.warn(
        `Watch "${watch.name}" destination ${watch.local_path} is not readable; ` +
        `delete-on-disappear suspended this tick`,
        { watchId: watch.id }
      );
    } else {
      for (const row of existingRows) {
        if (row.state !== 'downloaded') continue;
        const stillLocal = !!localByName.get(row.remote_path);
        if (stillLocal) {
          if (row.consecutive_missing_scans > 0) {
            db.prepare(
              `UPDATE files SET consecutive_missing_scans = 0 WHERE id = ?`
            ).run(row.id);
          }
          continue;
        }
        // File is missing locally
        const newCount = row.consecutive_missing_scans + 1;
        db.prepare(
          `UPDATE files SET consecutive_missing_scans = ? WHERE id = ?`
        ).run(newCount, row.id);

        if (newCount >= watch.missing_scan_threshold) {
          logger.info(
            `Delete-on-disappear triggered for ${row.remote_path} (missing ${newCount} scans)`,
            { watchId: watch.id, fileId: row.id }
          );
          // Presence bit reflects reality; state stays `downloaded` as
          // history ("we had this file once"). The purge pass below will
          // clean up once on_remote also flips to 0 after the delete.
          db.prepare(
            `UPDATE files SET on_local = 0 WHERE id = ?`
          ).run(row.id);
          row.on_local = 0;
          publishRow(db, row.id);
          actions.push({
            type: 'delete_remote',
            fileId: row.id,
            remotePath: absoluteRemotePath(watch, row.remote_path),
            triggeredBy: 'delete_on_disappear',
          });
        }
      }
    }
  }

  // Pass 4: tombstone purge.
  // Rows that are gone from both sides AND are not actively being worked
  // on by LFTP have no reason to exist. History lives in the events log.
  // If the same filename shows up again later, it's a fresh row and the
  // new-file path (pass 1) handles it correctly.
  const activeStates = new Set(['queued', 'downloading']);
  for (const row of existingRows) {
    if (row.on_remote === 1 || row.on_local === 1) continue;
    if (activeStates.has(row.state)) continue;
    // Extra guard: if LFTP has a matching job for this name, hold the row
    if (jobsByFileName.has(row.remote_path)) continue;

    db.prepare(`DELETE FROM files WHERE id = ?`).run(row.id);
    publishFileUpdate({ id: row.id, deleted: true });
    logger.debug(
      `Purged row ${row.remote_path} (no longer on remote or local, state=${row.state})`,
      { watchId: watch.id, fileId: row.id }
    );
  }

  return actions;
}

/**
 * Decide the state/action for a single file given all sources.
 * Returns an action to dispatch, or null.
 */
function reconcileFile({ watch, remote, local, job, row, patterns, now, db, onDownloaded }) {
  const onRemote = 1;
  const onLocal  = local ? 1 : 0;

  // Insert row if it doesn't exist
  if (!row) {
    const decision = decidePattern(remote.name, patterns);
    const initialState = decision.action === 'ignore' ? 'ignored' : 'seen';

    const info = db.prepare(`
      INSERT INTO files (
        watch_id, remote_path, local_path, is_dir, remote_size, local_size,
        on_remote, on_local,
        state, remote_modified_at, matched_pattern_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      watch.id,
      remote.name,
      remote.name,
      remote.is_dir ? 1 : 0,
      remote.size ?? null,
      local?.size ?? null,
      onRemote,
      onLocal,
      initialState,
      new Date((remote.mtime ?? 0) * 1000).toISOString(),
      decision.patternId,
    );

    publishRow(db, info.lastInsertRowid);

    if (decision.action === 'queue') {
      return {
        type: 'queue',
        fileId: info.lastInsertRowid,
        remotePath: absoluteRemotePath(watch, remote.name),
        localPath:  absoluteLocalPath(watch, remote.name),
        isDir: !!remote.is_dir,
      };
    }

    if (decision.action === 'delete_remote') {
      return {
        type: 'delete_remote',
        fileId: info.lastInsertRowid,
        remotePath: absoluteRemotePath(watch, remote.name),
        triggeredBy: 'pattern_exclude',
      };
    }

    return null;
  }

  // Row exists — update sizes + presence, potentially transition state
  const updates = ['on_remote = ?', 'on_local = ?'];
  const params  = [onRemote, onLocal];

  if (remote.size !== row.remote_size) {
    updates.push('remote_size = ?');
    params.push(remote.size ?? null);
  }
  const localSize = local?.size ?? null;
  if (localSize !== row.local_size) {
    updates.push('local_size = ?');
    params.push(localSize);
  }
  const remoteMtime = new Date((remote.mtime ?? 0) * 1000).toISOString();
  if (remoteMtime !== row.remote_modified_at) {
    updates.push('remote_modified_at = ?');
    params.push(remoteMtime);
  }

  params.push(row.id);
  db.prepare(`UPDATE files SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  // Refresh row for state logic below
  Object.assign(row, {
    remote_size: remote.size ?? null,
    local_size: localSize,
    remote_modified_at: remoteMtime,
    on_remote: onRemote,
    on_local: onLocal,
  });

  // Transition logic
  const oldState = row.state;
  const newState = deriveState(row, { remote, local, job });
  if (newState && newState !== oldState) {
    logStateTransition(row, newState, watch);
    transitionState(db, row.id, newState, now);
    row.state = newState;
    if (newState === 'downloaded') {
      db.prepare(`UPDATE files SET downloaded_at = ? WHERE id = ?`)
        .run(now.toISOString(), row.id);
      // Fire-and-forget arr notifications
      try { onDownloaded(row.id); }
      catch (err) {
        logger.error(
          `onDownloaded callback threw for file ${row.id}: ${err.message}`,
          { fileId: row.id }
        );
      }
    }
  }

  publishRow(db, row.id);

  return null;
}

/**
 * Derive the correct state for an existing row given current sources.
 * Returns a new state or null if no change.
 */
function deriveState(row, { remote, local, job }) {
  // Terminal / user-driven states we don't auto-flip from
  const sticky = ['ignored', 'error'];
  if (sticky.includes(row.state)) return null;

  // LFTP says it's transferring
  if (job && job.state === 'running') {
    return 'downloading';
  }
  if (job && job.state === 'queued') {
    return 'queued';
  }

  // Size-based "already complete" detection. ONLY fires for files that
  // are NOT currently in our queue→downloading workflow. A file in state
  // 'seen' (discovered but not yet queued by us) with matching sizes
  // means the user already has a complete copy locally — no transfer
  // needed. We use strict equality because directories can have inflated
  // local.size mid-transfer due to LFTP's *.lftp temp files counting
  // toward the sum; only exact match is safe. We also only promote from
  // `seen` — never from `downloading` or `queued`, which must be cleared
  // by LFTP actually finishing (handled by the job-gone branch below).
  if (row.state === 'seen' && local && remote.size != null && local.size === remote.size) {
    return 'downloaded';
  }

  // LFTP no longer has a job for us. Two cases:
  //   - We were 'downloading': LFTP finished (successfully or not).
  //     If local size matches remote size exactly → downloaded.
  //     Otherwise → interrupted; fall back to 'seen' so retry can re-queue.
  //   - We were 'queued': LFTP dropped the job before starting (rare).
  //     Fall back to 'seen' so retry can re-queue.
  if (row.state === 'downloading' && !job) {
    if (local && remote.size != null && local.size === remote.size) {
      return 'downloaded';
    }
    return 'seen';
  }
  if (row.state === 'queued' && !job) {
    return 'seen';
  }

  // Default: leave state as-is
  return null;
}

/**
 * Log a state transition at the appropriate level.
 * INFO for user-visible outcomes (downloaded, error), DEBUG for internal
 * churn (seen, queued, downloading). Runs before the DB update so
 * row.state still reflects the old value.
 */
function logStateTransition(row, newState, watch) {
  const level = USER_VISIBLE_STATES.has(newState) ? 'info' : 'debug';
  logger[level](
    `File ${row.remote_path}: ${row.state} → ${newState}`,
    { watchId: watch?.id, fileId: row.id }
  );
}

/**
 * Update state and last_state_change_at atomically.
 */
function transitionState(db, fileId, newState, now) {
  db.prepare(
    `UPDATE files SET state = ?, last_state_change_at = ? WHERE id = ?`
  ).run(newState, now.toISOString(), fileId);
}

/**
 * Build absolute remote path for a file within a watch.
 */
function absoluteRemotePath(watch, relativeName) {
  return joinPath(watch.remote_path, relativeName);
}

/**
 * Build absolute local path for a file within a watch.
 */
function absoluteLocalPath(watch, relativeName) {
  return joinPath(watch.local_path, relativeName);
}

function joinPath(base, part) {
  if (!base) return part;
  if (base.endsWith('/')) return base + part;
  return `${base}/${part}`;
}
