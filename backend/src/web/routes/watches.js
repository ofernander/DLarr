// DLarr — /api/watches routes
//
// Watches are UI-only (design §5): no env-var configuration.
//
// GET    /api/watches                         → list
// POST   /api/watches                         → create
// PATCH  /api/watches/:id                     → update (partial)
// DELETE /api/watches/:id                     → delete
// POST   /api/watches/:id/scan-now            → force immediate rescan
// PUT    /api/watches/:id/arr-notifications   → replace full arr-notification set

import { getDb } from '../../db/db.js';
import { publishWatchUpdate } from '../events.js';

const ALLOWED_FIELDS = new Set([
  'name', 'remote_path', 'local_path', 'scan_interval', 'enabled',
  'auto_delete_remote_on_local_missing', 'missing_scan_threshold',
]);

function loadWatch(id) {
  return getDb().prepare(`SELECT * FROM watches WHERE id = ?`).get(id);
}

function listWatches() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM watches ORDER BY name`).all();
  // Attach linked arr IDs for convenience
  const linkStmt = db.prepare(
    `SELECT arr_instance_id FROM watch_arr_notifications WHERE watch_id = ?`
  );
  return rows.map(w => ({
    ...w,
    enabled: w.enabled === 1,
    auto_delete_remote_on_local_missing: w.auto_delete_remote_on_local_missing === 1,
    arr_instance_ids: linkStmt.all(w.id).map(r => r.arr_instance_id),
  }));
}

export default async function watchesRoutes(fastify, { engine }) {
  fastify.get('/api/watches', async () => {
    return { watches: listWatches() };
  });

  fastify.post('/api/watches', async (req, reply) => {
    const body = req.body ?? {};
    const { name, remote_path, local_path } = body;
    if (!name || !remote_path || !local_path) {
      return reply.code(400).send({
        error: 'missing_fields',
        message: 'name, remote_path, and local_path are required',
      });
    }

    const db = getDb();
    try {
      const info = db.prepare(`
        INSERT INTO watches
          (name, remote_path, local_path, scan_interval, enabled,
           auto_delete_remote_on_local_missing, missing_scan_threshold)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        name,
        remote_path,
        local_path,
        body.scan_interval ?? null,
        body.enabled === false ? 0 : 1,
        body.auto_delete_remote_on_local_missing === true ? 1 : 0,
        body.missing_scan_threshold ?? 3,
      );
      const watch = loadWatch(info.lastInsertRowid);
      publishWatchUpdate(watch);
      return reply.code(201).send({ watch });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return reply.code(409).send({
          error: 'name_conflict',
          message: `A watch named "${name}" already exists`,
        });
      }
      throw err;
    }
  });

  fastify.patch('/api/watches/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const body = req.body ?? {};
    const existing = loadWatch(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const updates = [];
    const params = [];
    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_FIELDS.has(key)) continue;
      let v = value;
      if (key === 'enabled' || key === 'auto_delete_remote_on_local_missing') {
        v = v ? 1 : 0;
      }
      updates.push(`${key} = ?`);
      params.push(v);
    }
    if (updates.length === 0) {
      return reply.code(400).send({ error: 'no_valid_fields' });
    }
    params.push(id);

    try {
      getDb().prepare(
        `UPDATE watches SET ${updates.join(', ')} WHERE id = ?`
      ).run(...params);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'name_conflict' });
      }
      throw err;
    }

    const watch = loadWatch(id);
    publishWatchUpdate(watch);
    return { watch };
  });

  fastify.delete('/api/watches/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = loadWatch(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    getDb().prepare(`DELETE FROM watches WHERE id = ?`).run(id);
    publishWatchUpdate({ id, deleted: true });
    return { ok: true };
  });

  fastify.post('/api/watches/:id/scan-now', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = loadWatch(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    if (engine && typeof engine.forceScan === 'function') {
      engine.forceScan(id);
      return { ok: true };
    }
    return reply.code(503).send({
      error: 'engine_offline',
      message: 'Sync engine is not running; cannot force scan',
    });
  });

  fastify.put('/api/watches/:id/arr-notifications', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = loadWatch(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const body = req.body ?? {};
    const ids = Array.isArray(body.arr_instance_ids) ? body.arr_instance_ids : null;
    if (!ids) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Body must include arr_instance_ids: number[]',
      });
    }

    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM watch_arr_notifications WHERE watch_id = ?`).run(id);
      const ins = db.prepare(`
        INSERT INTO watch_arr_notifications (watch_id, arr_instance_id) VALUES (?, ?)
      `);
      for (const arrId of ids) {
        // Validate each arr exists; reject the whole request if any don't
        const arr = db.prepare(`SELECT id FROM arr_instances WHERE id = ?`).get(arrId);
        if (!arr) {
          const err = new Error(`Arr instance id=${arrId} does not exist`);
          err.statusCode = 400;
          throw err;
        }
        ins.run(id, arrId);
      }
    });

    try {
      tx();
    } catch (err) {
      if (err.statusCode === 400) {
        return reply.code(400).send({ error: 'invalid_arr_id', message: err.message });
      }
      throw err;
    }

    const watch = loadWatch(id);
    publishWatchUpdate(watch);
    return { ok: true, arr_instance_ids: ids };
  });
}
