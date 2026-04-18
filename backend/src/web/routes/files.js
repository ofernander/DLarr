// DLarr — /api/files routes
//
// GET  /api/files                       → paginated list; filter by watch_id / state / search
// POST /api/files/:id/queue             → user-initiated queue (resets retry_count)
// POST /api/files/:id/stop              → kill running or remove queued job
// POST /api/files/:id/retry             → reset retry_count + trigger next-tick retry
// POST /api/files/:id/dismiss           → mark dismissed (hidden from default UI view)
// POST /api/files/:id/delete-local      → delete local copy
// POST /api/files/:id/delete-remote     → delete remote copy
// GET  /api/files/:id/arr-notifications → notification history for this file
//
// The actual LFTP/SSH work for the POST endpoints is delegated to the
// dispatcher via engine.dispatcher. If the sync engine is offline, these
// endpoints respond 503.

import { getDb } from '../../db/db.js';
import { parseJobs } from '../../lftp/status-parser.js';
import { publishFileUpdate } from '../events.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function absoluteRemotePath(watch, relativeName) {
  return joinPath(watch.remote_path, relativeName);
}
function absoluteLocalPath(watch, relativeName) {
  return joinPath(watch.local_path, relativeName);
}
function joinPath(base, part) {
  if (!base) return part;
  if (base.endsWith('/')) return base + part;
  return `${base}/${part}`;
}

function loadFile(id) {
  return getDb().prepare(`SELECT * FROM files WHERE id = ?`).get(id);
}
function loadWatch(id) {
  return getDb().prepare(`SELECT * FROM watches WHERE id = ?`).get(id);
}

export default async function filesRoutes(fastify, { engine }) {
  fastify.get('/api/files', async (req) => {
    const db = getDb();
    const q = req.query ?? {};
    const limit = Math.min(Number(q.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(Number(q.offset) || 0, 0);

    const where = [];
    const params = [];
    if (q.watch_id) { where.push(`watch_id = ?`); params.push(Number(q.watch_id)); }
    if (q.state)    { where.push(`state = ?`);    params.push(String(q.state)); }
    if (q.search)   { where.push(`remote_path LIKE ?`); params.push(`%${q.search}%`); }
    if (q.include_dismissed !== 'true') {
      where.push(`state != 'dismissed'`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT * FROM files
      ${whereClause}
      ORDER BY last_state_change_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = db.prepare(
      `SELECT COUNT(*) AS c FROM files ${whereClause}`
    ).get(...params).c;

    return { files: rows, total, limit, offset };
  });

  fastify.post('/api/files/:id/queue', async (req, reply) => {
    const id = Number(req.params.id);
    const file = loadFile(id);
    if (!file) return reply.code(404).send({ error: 'not_found' });

    if (!engine?.dispatcher) {
      return reply.code(503).send({ error: 'engine_offline' });
    }

    const watch = loadWatch(file.watch_id);
    if (!watch) return reply.code(500).send({ error: 'orphaned_file' });

    // Reset retry counter since this is user-initiated
    getDb().prepare(
      `UPDATE files SET retry_count = 0, last_error_reason = NULL, last_error_message = NULL WHERE id = ?`
    ).run(id);

    await engine.dispatcher.executeOne({
      type: 'queue',
      fileId: id,
      remotePath: absoluteRemotePath(watch, file.remote_path),
      localPath:  absoluteLocalPath(watch, file.remote_path),
      isDir: file.is_dir === 1,
    });

    const updated = loadFile(id);
    publishFileUpdate(updated);
    return { file: updated };
  });

  fastify.post('/api/files/:id/stop', async (req, reply) => {
    const id = Number(req.params.id);
    const file = loadFile(id);
    if (!file) return reply.code(404).send({ error: 'not_found' });

    if (!engine?.dispatcher || !engine?.lftp?.alive) {
      return reply.code(503).send({ error: 'engine_offline' });
    }

    // Find the matching LFTP job (if any) so we can kill or queue-delete it
    const watch = loadWatch(file.watch_id);
    const localPath = absoluteLocalPath(watch, file.remote_path);
    let job = null;
    try {
      const raw = await engine.lftp.jobs();
      const { jobs } = parseJobs(raw);
      job = jobs.find(j => j.localPath === localPath) ?? null;
    } catch (err) {
      req.log.warn(`Stop: failed to query LFTP jobs: ${err.message}`);
    }

    if (!job) {
      // No active job. Revert state to 'seen' so the next scan re-evaluates.
      getDb().prepare(
        `UPDATE files SET state = 'seen', last_state_change_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(id);
      const updated = loadFile(id);
      publishFileUpdate(updated);
      return { file: updated, note: 'no active job found; state reset' };
    }

    await engine.dispatcher.executeOne({
      type: 'stop',
      fileId: id,
      jobId: job.id,
      queued: job.state === 'queued',
    });

    const updated = loadFile(id);
    publishFileUpdate(updated);
    return { file: updated };
  });

  fastify.post('/api/files/:id/retry', async (req, reply) => {
    const id = Number(req.params.id);
    const file = loadFile(id);
    if (!file) return reply.code(404).send({ error: 'not_found' });

    // Reset to 'seen' + clear retry counter → next scheduler tick will re-queue
    getDb().prepare(`
      UPDATE files
      SET state = 'seen',
          retry_count = 0,
          last_error_reason = NULL,
          last_error_message = NULL,
          last_state_change_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);

    if (engine && typeof engine.forceScan === 'function') {
      engine.forceScan(file.watch_id);
    }

    const updated = loadFile(id);
    publishFileUpdate(updated);
    return { file: updated };
  });

  fastify.post('/api/files/:id/dismiss', async (req, reply) => {
    const id = Number(req.params.id);
    const file = loadFile(id);
    if (!file) return reply.code(404).send({ error: 'not_found' });

    getDb().prepare(`
      UPDATE files
      SET state = 'dismissed', last_state_change_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);

    const updated = loadFile(id);
    publishFileUpdate(updated);
    return { file: updated };
  });

  fastify.post('/api/files/:id/delete-local', async (req, reply) => {
    const id = Number(req.params.id);
    const file = loadFile(id);
    if (!file) return reply.code(404).send({ error: 'not_found' });

    if (!engine?.dispatcher) {
      return reply.code(503).send({ error: 'engine_offline' });
    }

    const watch = loadWatch(file.watch_id);
    await engine.dispatcher.executeOne({
      type: 'delete_local',
      fileId: id,
      localPath: absoluteLocalPath(watch, file.remote_path),
    });

    const updated = loadFile(id);
    publishFileUpdate(updated);
    return { file: updated };
  });

  fastify.post('/api/files/:id/delete-remote', async (req, reply) => {
    const id = Number(req.params.id);
    const file = loadFile(id);
    if (!file) return reply.code(404).send({ error: 'not_found' });

    if (!engine?.dispatcher) {
      return reply.code(503).send({ error: 'engine_offline' });
    }

    const watch = loadWatch(file.watch_id);
    await engine.dispatcher.executeOne({
      type: 'delete_remote',
      fileId: id,
      remotePath: absoluteRemotePath(watch, file.remote_path),
      triggeredBy: 'user',
    });

    const updated = loadFile(id);
    publishFileUpdate(updated);
    return { file: updated };
  });

  fastify.get('/api/files/:id/arr-notifications', async (req, reply) => {
    const id = Number(req.params.id);
    const file = loadFile(id);
    if (!file) return reply.code(404).send({ error: 'not_found' });

    const rows = getDb().prepare(`
      SELECT an.*, a.name AS arr_name, a.type AS arr_type
      FROM arr_notifications an
      JOIN arr_instances a ON a.id = an.arr_instance_id
      WHERE an.file_id = ?
      ORDER BY an.attempted_at DESC
    `).all(id);

    return { notifications: rows };
  });
}
