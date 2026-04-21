// DLarr — events table retention
//
// Keeps the events table bounded. Runs pruneEvents() on a loop at
// RETENTION_CHECK_INTERVAL_MS. Keeps the most recent N rows by id
// (events.id is monotonically increasing, so id-order == insertion-order).
//
// Retention target is EVENTS_RETENTION_ROWS from settings. Set to 0 or
// negative to disable pruning entirely.

import { getDb } from '../db/db.js';
import { get as getSetting } from '../config/settings.js';
import { logger } from './logger.js';

const RETENTION_CHECK_INTERVAL_MS = 60_000; // 1 min

let _timer = null;

/**
 * One-shot prune: delete all events with id <= (max_id - keep).
 * Returns number of rows deleted.
 */
export function pruneEvents() {
  const keep = Number(getSetting('EVENTS_RETENTION_ROWS') ?? 10000);
  if (!Number.isFinite(keep) || keep <= 0) return 0;

  const db = getDb();
  const maxRow = db.prepare(`SELECT MAX(id) AS maxId FROM events`).get();
  const maxId = maxRow?.maxId;
  if (!Number.isFinite(maxId)) return 0;

  const cutoff = maxId - keep;
  if (cutoff <= 0) return 0;

  const info = db.prepare(`DELETE FROM events WHERE id <= ?`).run(cutoff);
  return info.changes ?? 0;
}

/**
 * Start the periodic pruner. Safe to call once at boot.
 */
export function startRetention() {
  if (_timer) return;
  // Run once immediately so a restart after long downtime catches up
  try {
    const deleted = pruneEvents();
    if (deleted > 0) {
      logger.info(`Events retention: pruned ${deleted} old rows on boot`);
    }
  } catch (err) {
    logger.warn(`Events retention initial prune failed: ${err.message}`);
  }

  _timer = setInterval(() => {
    try {
      const deleted = pruneEvents();
      if (deleted > 0) {
        logger.debug(`Events retention: pruned ${deleted} rows`);
      }
    } catch (err) {
      logger.warn(`Events retention prune failed: ${err.message}`);
    }
  }, RETENTION_CHECK_INTERVAL_MS);

  _timer.unref?.();
}

export function stopRetention() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
