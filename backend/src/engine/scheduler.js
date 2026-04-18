// DLarr — scheduler
//
// Ticks each enabled watch on its configured interval, running:
//   1. remote scan
//   2. local scan
//   3. LFTP job poll
//   4. reconcile → actions
//   5. dispatch actions
//
// Also handles retry-eligible files: files in `error` or `seen` state with
// a non-zero retry_count get re-evaluated per the backoff schedule.
//
// Runs as a single async loop with a `Promise`-friendly tick per watch.
// No concurrency across watches within a single process — watches tick
// sequentially to avoid LFTP command interleaving complexity. If scan
// latency becomes a problem we can parallelize later.

import { getDb } from '../db/db.js';
import { scanLocal } from '../local/scanner.js';
import { parseJobs } from '../lftp/status-parser.js';
import { reconcileWatch } from './reconciler.js';
import { retryDecision } from './retry.js';
import { notifyOnDownloaded } from '../arrs/notifier.js';
import { logger } from '../logging/logger.js';

const MIN_TICK_WAIT_MS = 1_000;
const CONSECUTIVE_PARSE_FAILURE_LIMIT = 2;

/**
 * @param {object} deps
 * @param {RemoteScanner} deps.remoteScanner
 * @param {Lftp}          deps.lftp
 * @param {Dispatcher}    deps.dispatcher
 * @param {function(string): any} deps.getSetting  settings accessor (settings.get)
 */
export class Scheduler {
  constructor({ remoteScanner, lftp, dispatcher, getSetting }) {
    this.remoteScanner = remoteScanner;
    this.lftp = lftp;
    this.dispatcher = dispatcher;
    this.getSetting = getSetting;

    this._running = false;
    this._stopSignal = false;
    this._lastTickByWatch = new Map(); // watchId -> Date
    this._forceScanByWatch = new Set(); // watchIds due for immediate rescan
    this._parseFailureStreak = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._stopSignal = false;
    logger.info('Scheduler started');
    this._loop().catch((err) => {
      logger.error(`Scheduler loop crashed: ${err.stack || err.message}`);
      this._running = false;
    });
  }

  async stop() {
    this._stopSignal = true;
    while (this._running) {
      await sleep(50);
    }
    logger.info('Scheduler stopped');
  }

  /**
   * Request an immediate scan on the next loop iteration for the given watch.
   */
  forceScan(watchId) {
    this._forceScanByWatch.add(watchId);
  }

  // -----------------------------------------------------------
  // Internal loop
  // -----------------------------------------------------------

  async _loop() {
    while (!this._stopSignal) {
      try {
        await this._tickAll();
      } catch (err) {
        logger.error(`Scheduler tick error: ${err.stack || err.message}`);
      }
      await sleep(MIN_TICK_WAIT_MS);
    }
    this._running = false;
  }

  async _tickAll() {
    const db = getDb();
    const watches = db.prepare(
      `SELECT * FROM watches WHERE enabled = 1`
    ).all();

    if (watches.length === 0) return;

    // Grab a single LFTP status snapshot for this round; all watches share.
    // (If this becomes stale between watches that's acceptable — next round
    // gets a fresh one.)
    let lftpJobs = [];
    try {
      const raw = await this.lftp.jobs();
      const parsed = parseJobs(raw);
      lftpJobs = parsed.jobs;
      if (parsed.unparsed > 0) {
        this._parseFailureStreak++;
        if (this._parseFailureStreak > CONSECUTIVE_PARSE_FAILURE_LIMIT) {
          logger.warn(
            `LFTP status has ${parsed.unparsed} unparsed blocks ` +
            `(streak=${this._parseFailureStreak}); output may have shifted format`
          );
          // Don't give up — just keep going with what we have
        }
      } else {
        this._parseFailureStreak = 0;
      }

      // Per-tick visibility: one DEBUG line per active LFTP job. Useful for
      // watching a large transfer progress through several ticks. Silent at
      // INFO level to avoid spam. Bump LOG_LEVEL=debug to see.
      for (const job of lftpJobs) {
        const bits = [
          `${job.type} #${job.id}`,
          job.state,
          job.localPath ? `→ ${job.localPath}` : null,
          job.progress != null ? `${Math.round(job.progress * 100)}%` : null,
          job.speed != null ? formatSpeed(job.speed) : null,
          job.eta != null ? `eta ${job.eta}s` : null,
        ].filter(Boolean).join(' ');
        logger.debug(`LFTP job: ${bits}`);
      }
    } catch (err) {
      logger.warn(`LFTP status poll failed: ${err.message}`);
      lftpJobs = [];
    }

    const defaultIntervalSecs = this.getSetting('DEFAULT_SCAN_INTERVAL_SECS') ?? 30;
    const now = new Date();

    for (const watch of watches) {
      if (this._stopSignal) break;

      const intervalSecs = watch.scan_interval ?? defaultIntervalSecs;
      const intervalMs = intervalSecs * 1000;

      const lastTick = this._lastTickByWatch.get(watch.id) ?? 0;
      const forced = this._forceScanByWatch.has(watch.id);
      const due = forced || (now - lastTick >= intervalMs);

      if (!due) continue;

      this._forceScanByWatch.delete(watch.id);

      try {
        await this._tickWatch(watch, lftpJobs, now);
      } catch (err) {
        logger.error(
          `Watch "${watch.name}" tick failed: ${err.stack || err.message}`,
          { watchId: watch.id }
        );
      }

      this._lastTickByWatch.set(watch.id, new Date());
    }
  }

  async _tickWatch(watch, lftpJobs, now) {
    const db = getDb();

    // 1. Remote scan (the slow step)
    let remoteTree = [];
    try {
      remoteTree = await this.remoteScanner.scan(watch.remote_path);
    } catch (err) {
      logger.warn(
        `Watch "${watch.name}" remote scan failed: ${err.message}`,
        { watchId: watch.id }
      );
      // Still run local reconciliation — local state changes matter even
      // if the remote is unreachable this tick.
    }

    // 2. Local scan
    let localTree = [];
    try {
      localTree = scanLocal(watch.local_path);
    } catch (err) {
      logger.warn(
        `Watch "${watch.name}" local scan failed: ${err.message}`,
        { watchId: watch.id }
      );
    }

    // 3. Load patterns for this watch (global patterns have watch_id IS NULL)
    const patterns = db.prepare(`
      SELECT * FROM patterns
      WHERE watch_id IS NULL OR watch_id = ?
      ORDER BY (watch_id IS NULL) ASC, id ASC
    `).all(watch.id);

    // 4. Reconcile — pass notifier as the onDownloaded hook
    const actions = reconcileWatch(watch, remoteTree, localTree, lftpJobs, patterns, {
      now,
      onDownloaded: (fileId) => { notifyOnDownloaded(fileId); },
    });

    // 5. Retry-eligible files — add re-queue actions where appropriate
    const retryActions = this._collectRetryActions(watch, now);
    actions.push(...retryActions);

    // 6. Dispatch actions
    if (actions.length > 0) {
      await this.dispatcher.executeMany(actions);
    }
  }

  /**
   * Find files in retryable states whose backoff has elapsed and queue them.
   */
  _collectRetryActions(watch, now) {
    const db = getDb();
    const maxRetries = this.getSetting('MAX_RETRIES') ?? 5;

    // Candidates: files in 'seen' state with retry_count > 0 (failed + retrying),
    // AND files in 'error' state but with retry_count < maxRetries (shouldn't
    // normally happen — error implies exhausted — but defensive).
    const candidates = db.prepare(`
      SELECT * FROM files
      WHERE watch_id = ? AND retry_count > 0 AND state = 'seen'
    `).all(watch.id);

    const actions = [];
    for (const row of candidates) {
      const decision = retryDecision(row, maxRetries, now);
      if (decision === 'retry_now') {
        actions.push({
          type: 'queue',
          fileId: row.id,
          remotePath: joinPath(watch.remote_path, row.remote_path),
          localPath:  joinPath(watch.local_path,  row.remote_path),
          isDir: row.is_dir === 1,
        });
      } else if (decision === 'exhausted') {
        db.prepare(`
          UPDATE files
          SET state = 'error',
              last_state_change_at = ?
          WHERE id = ?
        `).run(now.toISOString(), row.id);
        logger.error(
          `Retries exhausted for ${row.remote_path} (${row.last_error_reason || 'unknown'})`,
          { watchId: watch.id, fileId: row.id }
        );
      }
      // 'wait' → do nothing
    }
    return actions;
  }
}

function joinPath(base, part) {
  if (!base) return part;
  if (base.endsWith('/')) return base + part;
  return `${base}/${part}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return `${bytesPerSec}B/s`;
  if (bytesPerSec < 1024 ** 2) return `${(bytesPerSec / 1024).toFixed(1)}KB/s`;
  if (bytesPerSec < 1024 ** 3) return `${(bytesPerSec / 1024 ** 2).toFixed(1)}MB/s`;
  return `${(bytesPerSec / 1024 ** 3).toFixed(2)}GB/s`;
}
