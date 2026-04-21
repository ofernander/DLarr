// DLarr — /api/logs route
//
// Historical log backfill for the UI. Reads from the `events` table.
// Reverse-chronological by default (newest first) with a sane default
// limit; the Logs page calls this on mount to populate history before
// subscribing to SSE for new events.
//
// Query params:
//   limit  — integer, default 200, max 1000
//   before — integer event id, return events with id < before (pagination)
//
// Response:
//   { logs: [{ id, level, message, timestamp, watch_id, file_id, arr_id }, ...] }
//
// `timestamp` is always ISO8601 so the frontend can parse it the same way
// it parses live SSE events.

import { getDb } from '../../db/db.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT     = 1000;

export default async function logsRoutes(fastify) {
  fastify.get('/api/logs', async (req) => {
    const db = getDb();
    const q = req.query ?? {};
    let limit = Number.parseInt(q.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const before = Number.parseInt(q.before, 10);
    const useBefore = Number.isFinite(before) && before > 0;

    const rows = useBefore
      ? db.prepare(
          `SELECT id, ts, level, message, watch_id, file_id, arr_id
           FROM events WHERE id < ? ORDER BY id DESC LIMIT ?`
        ).all(before, limit)
      : db.prepare(
          `SELECT id, ts, level, message, watch_id, file_id, arr_id
           FROM events ORDER BY id DESC LIMIT ?`
        ).all(limit);

    // Return oldest-first so the client can append without resorting.
    rows.reverse();
    return {
      logs: rows.map(r => ({
        id:        r.id,
        level:     r.level,
        message:   r.message,
        timestamp: normalizeTimestamp(r.ts),
        watch_id:  r.watch_id,
        file_id:   r.file_id,
        arr_id:    r.arr_id,
      })),
    };
  });
}

/**
 * The events.ts column is stored via SQLite's CURRENT_TIMESTAMP which uses
 * "YYYY-MM-DD HH:MM:SS" (no T, no Z). Normalize to ISO8601 for the UI.
 */
function normalizeTimestamp(ts) {
  if (!ts) return new Date().toISOString();
  if (ts.includes('T')) return ts;
  // SQLite CURRENT_TIMESTAMP is UTC — append 'Z' after swapping space for T.
  return ts.replace(' ', 'T') + 'Z';
}
