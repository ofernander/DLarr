// DLarr — /api/arrs routes
//
// GET    /api/arrs            → list with status + env_locked
// POST   /api/arrs            → create UI arr; 409 if name collides (env or UI)
// PATCH  /api/arrs/:id        → update fields; 409 if env_locked
// DELETE /api/arrs/:id        → delete; 409 if env_locked
// POST   /api/arrs/:id/test   → on-demand testConnection(); updates last_status

import { getDb } from '../../db/db.js';
import { isSupportedType, SUPPORTED_TYPES } from '../../arrs/registry.js';
import { checkOne } from '../../arrs/health.js';
import { publishArrUpdate } from '../events.js';

const API_KEY_MASK = '***';

const SELECT_PUBLIC = `
  SELECT id, name, type, url, dir, env_locked,
         last_status, last_status_msg, last_check_at, created_at
  FROM arr_instances
`;

function rowToPublic(row) {
  if (!row) return null;
  return {
    ...row,
    env_locked: row.env_locked === 1,
    api_key: API_KEY_MASK,
  };
}

function listArrs() {
  return getDb().prepare(`${SELECT_PUBLIC} ORDER BY name`).all()
    .map(r => ({ ...r, env_locked: r.env_locked === 1, api_key: API_KEY_MASK }));
}

export default async function arrsRoutes(fastify) {
  fastify.get('/api/arrs', async () => {
    return { arrs: listArrs() };
  });

  fastify.post('/api/arrs', async (req, reply) => {
    const body = req.body ?? {};
    const { name, type, url, api_key, dir } = body;

    if (!name || !type || !url || !api_key || !dir) {
      return reply.code(400).send({
        error: 'missing_fields',
        message: 'name, type, url, api_key, and dir are required',
      });
    }
    if (!isSupportedType(type)) {
      return reply.code(400).send({
        error: 'invalid_type',
        message: `type must be one of: ${SUPPORTED_TYPES.join(', ')}`,
      });
    }

    const db = getDb();
    const existing = db.prepare(
      `SELECT id, env_locked FROM arr_instances WHERE name = ?`
    ).get(name);
    if (existing) {
      return reply.code(409).send({
        error: 'name_conflict',
        message: `An arr named "${name}" already exists`,
      });
    }

    const info = db.prepare(`
      INSERT INTO arr_instances (name, type, url, api_key, dir, env_locked)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(name, type, url, api_key, dir);

    const created = db.prepare(
      `${SELECT_PUBLIC} WHERE id = ?`
    ).get(info.lastInsertRowid);
    const row = { ...created, env_locked: created.env_locked === 1, api_key: API_KEY_MASK };
    publishArrUpdate(row);
    return reply.code(201).send({ arr: row });
  });

  fastify.patch('/api/arrs/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getDb().prepare(
      `SELECT * FROM arr_instances WHERE id = ?`
    ).get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    if (existing.env_locked === 1) {
      return reply.code(409).send({
        error: 'env_locked',
        message: `Arr "${existing.name}" is locked by env vars; edit via DLARR_* env vars and restart`,
      });
    }

    const body = req.body ?? {};
    const allowed = ['name', 'type', 'url', 'api_key', 'dir'];
    const updates = [];
    const params = [];
    for (const k of allowed) {
      if (!(k in body)) continue;
      if (k === 'type' && !isSupportedType(body.type)) {
        return reply.code(400).send({ error: 'invalid_type' });
      }
      updates.push(`${k} = ?`);
      params.push(body[k]);
    }
    if (updates.length === 0) {
      return reply.code(400).send({ error: 'no_valid_fields' });
    }
    params.push(id);

    try {
      getDb().prepare(
        `UPDATE arr_instances SET ${updates.join(', ')} WHERE id = ?`
      ).run(...params);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'name_conflict' });
      }
      throw err;
    }

    const updated = getDb().prepare(
      `${SELECT_PUBLIC} WHERE id = ?`
    ).get(id);
    const row = { ...updated, env_locked: updated.env_locked === 1, api_key: API_KEY_MASK };
    publishArrUpdate(row);
    return { arr: row };
  });

  fastify.delete('/api/arrs/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getDb().prepare(
      `SELECT env_locked, name FROM arr_instances WHERE id = ?`
    ).get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    if (existing.env_locked === 1) {
      return reply.code(409).send({
        error: 'env_locked',
        message: `Arr "${existing.name}" is locked by env vars; remove via env and restart`,
      });
    }

    getDb().prepare(`DELETE FROM arr_instances WHERE id = ?`).run(id);
    publishArrUpdate({ id, deleted: true });
    return { ok: true };
  });

  fastify.post('/api/arrs/:id/test', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getDb().prepare(
      `SELECT id FROM arr_instances WHERE id = ?`
    ).get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const result = await checkOne(id);
    // checkOne already updated the DB row; publish the fresh state
    const updated = getDb().prepare(
      `${SELECT_PUBLIC} WHERE id = ?`
    ).get(id);
    publishArrUpdate({ ...updated, env_locked: updated.env_locked === 1, api_key: API_KEY_MASK });
    return result;
  });
}
