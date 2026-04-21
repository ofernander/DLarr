// DLarr — action dispatcher
//
// Consumes the list of actions returned by reconcileWatch() and executes
// them. Bridges the pure-logic reconciler to the side-effect-laden LFTP
// and SSH wrappers.
//
// Action types:
//   { type: 'queue', fileId, remotePath, localPath, isDir }
//   { type: 'delete_remote', fileId, remotePath, triggeredBy }
//   { type: 'delete_local', fileId, localPath }
//   { type: 'stop', fileId, jobId }        // issued by user action / exhausted retry
//
// Each dispatch is wrapped in a try/catch; failures are:
//   - logged via logger (info/warn/error per severity)
//   - recorded in DB via error_reason / error_message / retry_count
//   - never allowed to propagate out of this module
//
// Delete handlers flip presence bits (on_remote / on_local) rather than
// transitioning `state` to `deleted_*`. The next reconciler pass will
// observe the new presence and purge the row if appropriate. Workflow
// state reflects what DLarr did; presence reflects current reality.
//
// After each state change, the updated row is published to the event bus
// so SSE subscribers (UI) see the change live.
//
// The dispatcher does NOT decide retries — that's `retry.js` at the scheduler
// level. The dispatcher just tries once and reports success/failure.

import { getDb } from '../db/db.js';
import { deleteRemotePath } from '../remote/deleter.js';
import { categorizeError } from './retry.js';
import { logger } from '../logging/logger.js';
import { publishFileUpdate } from '../web/events.js';

function publishFileById(fileId) {
  if (!fileId) return;
  try {
    const row = getDb().prepare(`SELECT * FROM files WHERE id = ?`).get(fileId);
    if (row) publishFileUpdate(row);
  } catch { /* ignore */ }
}

/**
 * @param {object} deps
 * @param {Lftp}   deps.lftp       an active Lftp instance
 * @param {object} deps.sshConfig  SSH config for deleter
 * @param {function(number): void} [deps.onAfterDelete]  optional callback
 *   invoked with the file's watch_id after a successful delete_remote or
 *   delete_local. Used by Engine to trigger forceScan so Pass 4 (tombstone
 *   purge) runs promptly when both presence bits reach 0.
 */
export class Dispatcher {
  constructor({ lftp, sshConfig, onAfterDelete }) {
    if (!lftp)       throw new Error('Dispatcher requires lftp');
    if (!sshConfig)  throw new Error('Dispatcher requires sshConfig');
    this.lftp = lftp;
    this.sshConfig = sshConfig;
    this.onAfterDelete = typeof onAfterDelete === 'function' ? onAfterDelete : null;
  }

  /**
   * Execute a list of actions in order. Errors on individual actions are
   * caught and logged; we do not short-circuit the list.
   */
  async executeMany(actions) {
    for (const action of actions) {
      await this.executeOne(action);
    }
  }

  async executeOne(action) {
    try {
      switch (action.type) {
        case 'queue':         return await this._queue(action);
        case 'delete_remote': return await this._deleteRemote(action);
        case 'delete_local':  return await this._deleteLocal(action);
        case 'stop':          return await this._stop(action);
        default:
          logger.warn(`Dispatcher: unknown action type "${action.type}"`);
      }
    } catch (err) {
      this._recordFailure(action, err);
    }
  }

  // ---------------------------------------------------------------

  async _queue(action) {
    const { fileId, remotePath, localPath, isDir } = action;

    await this.lftp.queue({ remotePath, localPath, isDir });

    const db = getDb();
    db.prepare(`
      UPDATE files
      SET state = 'queued',
          last_state_change_at = CURRENT_TIMESTAMP,
          last_error_reason = NULL,
          last_error_message = NULL
      WHERE id = ?
    `).run(fileId);

    logger.info(`Queued ${isDir ? 'dir' : 'file'} ${remotePath}`, { fileId });
    publishFileById(fileId);
  }

  async _deleteRemote(action) {
    const { fileId, remotePath, triggeredBy } = action;

    await deleteRemotePath(this.sshConfig, remotePath);

    // Flip presence bit. State is untouched — if on_local is also 0, the
    // next reconcile pass will purge the row.
    const db = getDb();
    db.prepare(`
      UPDATE files
      SET on_remote = 0,
          last_state_change_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fileId);

    logger.info(
      `Remote delete succeeded for ${remotePath}` +
      (triggeredBy ? ` (trigger=${triggeredBy})` : ''),
      { fileId }
    );
    publishFileById(fileId);
    this._notifyAfterDelete(fileId);
  }

  async _deleteLocal(action) {
    const { fileId, localPath } = action;

    // Local delete is a simple fs operation — use the stdlib here rather
    // than adding a dedicated module for one caller.
    const { rmSync, existsSync, statSync } = await import('node:fs');

    if (!existsSync(localPath)) {
      logger.warn(`Local delete: path does not exist: ${localPath}`, { fileId });
      // Still flip the presence bit — DB said local=1 but it's actually 0
      const db = getDb();
      db.prepare(`UPDATE files SET on_local = 0 WHERE id = ?`).run(fileId);
      publishFileById(fileId);
      this._notifyAfterDelete(fileId);
      return;
    }
    const st = statSync(localPath);
    rmSync(localPath, { recursive: st.isDirectory(), force: true });

    const db = getDb();
    db.prepare(`
      UPDATE files
      SET on_local = 0,
          last_state_change_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fileId);

    logger.info(`Local delete succeeded for ${localPath}`, { fileId });
    publishFileById(fileId);
    this._notifyAfterDelete(fileId);
  }

  async _stop(action) {
    const { fileId, jobId, queued } = action;

    if (queued) {
      await this.lftp.queueDelete(jobId);
    } else {
      await this.lftp.kill(jobId);
    }

    const db = getDb();
    db.prepare(`
      UPDATE files
      SET state = 'seen',
          last_state_change_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fileId);

    logger.info(`Stopped job ${jobId}`, { fileId });
    publishFileById(fileId);
  }

  _recordFailure(action, err) {
    const reason = categorizeError(err);
    const msg = err instanceof Error ? err.message : String(err);

    if (action.fileId) {
      const db = getDb();
      db.prepare(`
        UPDATE files
        SET last_error_reason = ?,
            last_error_message = ?,
            retry_count = retry_count + 1,
            last_state_change_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(reason, msg, action.fileId);
      publishFileById(action.fileId);
    }

    logger.error(
      `Dispatcher action "${action.type}" failed (${reason}): ${msg}`,
      { fileId: action.fileId ?? null }
    );
  }

  /**
   * Invoke the onAfterDelete callback with the file's watch_id, if set.
   * Looks up the row at call time because the row may have been updated
   * between the action and now.
   */
  _notifyAfterDelete(fileId) {
    if (!this.onAfterDelete || !fileId) return;
    try {
      const row = getDb().prepare(
        `SELECT watch_id FROM files WHERE id = ?`
      ).get(fileId);
      if (row?.watch_id) this.onAfterDelete(row.watch_id);
    } catch { /* ignore */ }
  }
}
