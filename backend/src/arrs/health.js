// DLarr — arr health check loop
//
// Periodically tests every arr_instance's connection and updates its
// last_status / last_status_msg / last_check_at fields. UI consumes these
// to render the per-arr status dot.
//
// Also provides a single-shot `checkOne(arrId)` used by the POST /api/arrs/:id/test
// web endpoint for on-demand "Test" button.
//
// Notifications (design §8.7) skip arrs whose last_status != 'ok', so this
// loop directly affects which notifications fire.
//
// After each check, the updated arr row is published to the event bus so
// SSE subscribers see status changes live.

import { getDb } from '../db/db.js';
import { clientForRow, isSupportedType } from './registry.js';
import { ArrError } from './base.js';
import { logger } from '../logging/logger.js';
import { publishArrUpdate } from '../web/events.js';

const ARR_PUBLIC_SELECT = `
  SELECT id, name, type, url, dir, env_locked,
         last_status, last_status_msg, last_check_at, created_at
  FROM arr_instances
`;

function publishArrById(arrId) {
  try {
    const row = getDb().prepare(`${ARR_PUBLIC_SELECT} WHERE id = ?`).get(arrId);
    if (row) {
      publishArrUpdate({
        ...row,
        env_locked: row.env_locked === 1,
        api_key: '***',
      });
    }
  } catch { /* ignore */ }
}

/**
 * Derive the `last_status` value for a given ArrError or success.
 */
function statusFromError(err) {
  if (!err) return 'ok';
  if (err instanceof ArrError) {
    if (err.code === 'unreachable') return 'unreachable';
    if (err.code === 'auth_failed') return 'auth_failed';
  }
  return 'unknown';
}

/**
 * Check a single arr instance and update its status row.
 *
 * @param {number} arrId
 * @returns {Promise<{ ok: boolean, version?: string, error?: string, status: string }>}
 */
export async function checkOne(arrId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM arr_instances WHERE id = ?`).get(arrId);
  if (!row) throw new Error(`No arr instance with id=${arrId}`);

  if (!isSupportedType(row.type)) {
    const msg = `Unsupported arr type "${row.type}"`;
    db.prepare(`
      UPDATE arr_instances
      SET last_status = 'unknown',
          last_status_msg = ?,
          last_check_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(msg, row.id);
    publishArrById(row.id);
    return { ok: false, error: msg, status: 'unknown' };
  }

  const client = clientForRow(row);
  try {
    const { version } = await client.testConnection();
    db.prepare(`
      UPDATE arr_instances
      SET last_status = 'ok',
          last_status_msg = NULL,
          last_check_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(row.id);
    publishArrById(row.id);
    return { ok: true, version, status: 'ok' };
  } catch (err) {
    const status = statusFromError(err);
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(`
      UPDATE arr_instances
      SET last_status = ?,
          last_status_msg = ?,
          last_check_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, msg, row.id);
    publishArrById(row.id);
    return { ok: false, error: msg, status };
  }
}

/**
 * Check all arr instances in one pass. Errors on individual instances are
 * caught and recorded; the loop never throws.
 */
export async function checkAll() {
  const db = getDb();
  const rows = db.prepare(`SELECT id FROM arr_instances`).all();

  for (const row of rows) {
    try {
      const res = await checkOne(row.id);
      if (res.ok) {
        logger.debug(`Arr health OK: ${row.id}`, { arrId: row.id });
      } else {
        logger.warn(`Arr health not ok (${res.status}): ${res.error}`, { arrId: row.id });
      }
    } catch (err) {
      logger.error(`Arr health check crashed for id=${row.id}: ${err.message}`, { arrId: row.id });
    }
  }
}

/**
 * Periodic health check loop. Start at boot, stop on shutdown.
 */
export class HealthChecker {
  /**
   * @param {object} opts
   * @param {number} opts.intervalSecs  from DLARR_ARR_HEALTH_CHECK_INTERVAL_SECS
   */
  constructor({ intervalSecs }) {
    this.intervalSecs = intervalSecs;
    this._timer = null;
    this._running = false;
    this._stopSignal = false;
  }

  start() {
    if (this._timer) return;

    // Kick off an immediate check on start so the UI has status ASAP
    this._tick();

    this._timer = setInterval(() => this._tick(), this.intervalSecs * 1000);
    logger.info(`Arr health checker started (every ${this.intervalSecs}s)`);
  }

  async stop() {
    this._stopSignal = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Wait for any in-flight tick to complete
    while (this._running) await sleep(50);
    logger.info('Arr health checker stopped');
  }

  async _tick() {
    if (this._running || this._stopSignal) return;
    this._running = true;
    try {
      await checkAll();
    } catch (err) {
      logger.error(`Health check tick error: ${err.message}`);
    } finally {
      this._running = false;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
