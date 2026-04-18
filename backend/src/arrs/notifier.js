// DLarr — arr notifier
//
// Called when a file transitions to DOWNLOADED. Looks up which arrs should
// be notified for that file's watch (via watch_arr_notifications join),
// skips any arrs that are not currently healthy (last_status !== 'ok'),
// and issues the rescan command with backoff-retry for transient failures.
//
// All attempts (success and failure) are recorded in arr_notifications
// for UI visibility.
//
// The notifier does NOT block state reconciliation. The scheduler/dispatcher
// calls `notifyOnDownloaded(fileId)` which returns immediately; the actual
// HTTP work happens in a detached async task.

import { getDb } from '../db/db.js';
import { clientForRow, isSupportedType } from './registry.js';
import { logger } from '../logging/logger.js';
import { get as getSetting } from '../config/settings.js';

const BACKOFF_MS = [15_000, 30_000, 60_000];

/**
 * Trigger arr notifications for a freshly-DOWNLOADED file.
 *
 * @param {number} fileId
 * @returns {Promise<void>} resolves immediately after scheduling. Work is
 *                          fire-and-forget from the caller's perspective.
 */
export function notifyOnDownloaded(fileId) {
  // Detach: don't block the dispatcher/reconciler.
  // We still return a promise for testability.
  return new Promise((resolve) => {
    setImmediate(() => {
      runNotifications(fileId)
        .catch((err) => {
          logger.error(
            `Arr notification flow crashed for file ${fileId}: ${err.stack || err.message}`,
            { fileId }
          );
        })
        .finally(resolve);
    });
  });
}

async function runNotifications(fileId) {
  const db = getDb();

  const file = db.prepare(`SELECT * FROM files WHERE id = ?`).get(fileId);
  if (!file) {
    logger.warn(`notifyOnDownloaded: file ${fileId} not found`);
    return;
  }

  // Pull the arrs configured to be notified for this file's watch
  const arrs = db.prepare(`
    SELECT a.*
    FROM arr_instances a
    JOIN watch_arr_notifications wan ON wan.arr_instance_id = a.id
    WHERE wan.watch_id = ?
  `).all(file.watch_id);

  if (arrs.length === 0) {
    logger.debug(`No arrs configured for watch ${file.watch_id}`, { fileId, watchId: file.watch_id });
    return;
  }

  const maxRetries = getSetting('ARR_NOTIFY_MAX_RETRIES') ?? 3;

  // Process each arr sequentially. Each has its own retry loop.
  for (const arr of arrs) {
    await notifyOneArr(file, arr, maxRetries);
  }
}

async function notifyOneArr(file, arr, maxRetries) {
  const db = getDb();

  // Skip-on-unhealthy (design §8.7)
  if (arr.last_status && arr.last_status !== 'ok') {
    recordAttempt(file.id, arr.id, 0, false,
      `arr marked ${arr.last_status} at notification time`);
    logger.warn(
      `Skipping notification: ${arr.name} is ${arr.last_status}`,
      { fileId: file.id, arrId: arr.id }
    );
    return;
  }

  if (!isSupportedType(arr.type)) {
    recordAttempt(file.id, arr.id, 0, false, `Unsupported arr type "${arr.type}"`);
    return;
  }

  const client = clientForRow(arr);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.notifyDownloadComplete();
      recordAttempt(file.id, arr.id, attempt, true, null);
      logger.info(
        `Notified ${arr.name} to rescan ${arr.dir}`,
        { fileId: file.id, arrId: arr.id }
      );
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isFinalAttempt = attempt >= maxRetries;

      if (isFinalAttempt) {
        recordAttempt(file.id, arr.id, attempt, false, msg);
        logger.error(
          `Notification to ${arr.name} exhausted after ${attempt} attempts: ${msg}`,
          { fileId: file.id, arrId: arr.id }
        );
        return;
      }

      logger.warn(
        `Notification to ${arr.name} failed (attempt ${attempt}/${maxRetries}): ${msg}`,
        { fileId: file.id, arrId: arr.id }
      );
      const backoff = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
      await sleep(backoff);
    }
  }
}

function recordAttempt(fileId, arrInstanceId, attemptCount, succeeded, errorMessage) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO arr_notifications
        (file_id, arr_instance_id, attempted_at, succeeded, attempt_count, error_message)
      VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
    `).run(fileId, arrInstanceId, succeeded ? 1 : 0, attemptCount, errorMessage);
  } catch (err) {
    logger.error(`Failed to record arr_notification: ${err.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
