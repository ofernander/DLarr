// DLarr — local filesystem watcher manager
//
// Owns one chokidar instance per enabled watch. On any add/change/unlink
// event inside a watch's local_path, calls engine.forceScan(watchId) so
// the scheduler picks up the change on its next loop iteration (~1s).
//
// Events are debounced per-watch (DEBOUNCE_MS) so a burst of events from
// a single user action coalesces into one force-scan.
//
// The scheduler's interval polling remains as a safety net — the watcher
// is additive, not a replacement.
//
// Lifecycle is driven by the engine:
//   - engine.start() (sync branch only)   → manager.start()
//   - engine.stop()                       → manager.stop()
//   - bus 'watch-update' event            → manager.onWatchUpdate(row)
//
// Missing / unreadable local_path is logged once per watch and the
// watcher is not created. Next watch-update event will retry.

import chokidar from 'chokidar';
import { getDb } from '../db/db.js';
import { isDestinationReadable } from './scanner.js';
import { logger } from '../logging/logger.js';

const DEBOUNCE_MS = 300;

// Chokidar events we care about. 'change' catches in-place file edits
// (e.g. user replaces a file); add/unlink cover the common cases.
const RELEVANT_EVENTS = new Set([
  'add', 'addDir', 'unlink', 'unlinkDir', 'change',
]);

// LFTP writes to `*.lftp` (with use-temp-file=yes) and `*.lftp-pget-status`
// (chunk progress files) during transfers. These aren't files we care about
// — they're implementation details. When LFTP finishes, it renames the
// .lftp file to the final name, which fires a clean `add` event we do want.
const LFTP_INTERNAL_RE = /\.lftp(?:-pget-status)?$/;

export class LocalWatcherManager {
  /**
   * @param {object} deps
   * @param {function(number): void} deps.forceScan  called with watchId
   */
  constructor({ forceScan }) {
    this._forceScan = forceScan;
    this._watchers = new Map();       // watchId -> chokidar instance
    this._debounceTimers = new Map(); // watchId -> Timeout
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;

    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM watches WHERE enabled = 1`
    ).all();

    for (const row of rows) {
      this._startOne(row);
    }
    logger.info(`Local watcher manager started (${this._watchers.size} watcher(s))`);
  }

  async stop() {
    if (!this._started) return;
    this._started = false;

    for (const timer of this._debounceTimers.values()) clearTimeout(timer);
    this._debounceTimers.clear();

    const closers = [];
    for (const [id, w] of this._watchers) {
      closers.push(
        w.close().catch((err) => {
          logger.warn(`Error closing local watcher for watch ${id}: ${err.message}`);
        })
      );
    }
    this._watchers.clear();
    await Promise.all(closers);
    logger.info('Local watcher manager stopped');
  }

  /**
   * Reconcile a single watch's watcher state with the DB row.
   * Called from a 'watch-update' subscription.
   *
   * @param {object} row  watch row (may include {id, deleted: true})
   */
  onWatchUpdate(row) {
    if (!this._started) return;

    // Delete case: bus publishes {id, deleted:true}
    if (row.deleted) {
      this._stopOne(row.id);
      return;
    }

    const existing = this._watchers.get(row.id);
    const enabled = row.enabled === 1 || row.enabled === true;

    if (!enabled) {
      if (existing) this._stopOne(row.id);
      return;
    }

    // Path change while running → tear down and restart
    if (existing) {
      // chokidar instances don't expose the watched path directly; we
      // track it on the wrapper we stored.
      if (existing.__localPath !== row.local_path) {
        this._stopOne(row.id);
        this._startOne(row);
      }
      return;
    }

    this._startOne(row);
  }

  // -----------------------------------------------------------

  _startOne(row) {
    if (!isDestinationReadable(row.local_path)) {
      logger.warn(
        `Watch "${row.name}" local path ${row.local_path} is not readable; ` +
        `local watcher not started`,
        { watchId: row.id }
      );
      return;
    }

    const watcher = chokidar.watch(row.local_path, {
      ignoreInitial: true,      // don't fire for files already present
      persistent: true,
      awaitWriteFinish: false,  // wire to stability-check bug later
      ignorePermissionErrors: true,
      ignored: (p) => LFTP_INTERNAL_RE.test(p),
    });

    watcher.on('all', (event, path) => {
      if (!RELEVANT_EVENTS.has(event)) return;
      this._schedule(row.id);
    });

    watcher.on('error', (err) => {
      logger.warn(
        `Local watcher for "${row.name}" error: ${err.message}`,
        { watchId: row.id }
      );
    });

    watcher.__localPath = row.local_path;
    this._watchers.set(row.id, watcher);
    logger.info(
      `Local watcher started for "${row.name}" on ${row.local_path}`,
      { watchId: row.id }
    );
  }

  _stopOne(watchId) {
    const w = this._watchers.get(watchId);
    if (!w) return;
    const timer = this._debounceTimers.get(watchId);
    if (timer) {
      clearTimeout(timer);
      this._debounceTimers.delete(watchId);
    }
    this._watchers.delete(watchId);
    w.close().catch((err) => {
      logger.warn(`Error closing local watcher for watch ${watchId}: ${err.message}`);
    });
    logger.info(`Local watcher stopped for watch ${watchId}`, { watchId });
  }

  _schedule(watchId) {
    const existing = this._debounceTimers.get(watchId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this._debounceTimers.delete(watchId);
      try {
        this._forceScan(watchId);
      } catch (err) {
        logger.error(
          `forceScan from local watcher failed: ${err.message}`,
          { watchId }
        );
      }
    }, DEBOUNCE_MS);
    this._debounceTimers.set(watchId, t);
  }
}
