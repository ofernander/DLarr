// DLarr — /api/patterns routes
//
// GET    /api/patterns?watch_id=N   → list (filter by watch_id; global if not provided)
// POST   /api/patterns              → create
// DELETE /api/patterns/:id          → delete
//
// watch_id = null  → global pattern (applies to every watch)
// watch_id = <id>  → per-watch pattern
//
// Patterns are UI-only per design §5. No env-var configuration.

import { getDb } from '../../db/db.js';

const VALID_KINDS   = new Set(['include', 'exclude']);
const VALID_ACTIONS = new Set(['queue', 'ignore', 'delete_remote']);

export default async function patternsRoutes(fastify) {
  fastify.get('/api/patterns', async (req) => {
    const db = getDb();
    const { watch_id, scope } = req.query ?? {};

    let rows;
    if (scope === 'global') {
      rows = db.prepare(
        `SELECT * FROM patterns WHERE watch_id IS NULL ORDER BY id`
      ).all();
    } else if (watch_id !== undefined) {
      rows = db.prepare(
        `SELECT * FROM patterns WHERE watch_id = ? ORDER BY id`
      ).all(Number(watch_id));
    } else {
      rows = db.prepare(`SELECT * FROM patterns ORDER BY id`).all();
    }
    return { patterns: rows };
  });

  fastify.post('/api/patterns', async (req, reply) => {
    const body = req.body ?? {};
    const { watch_id, kind, pattern } = body;
    let { action } = body;

    if (!VALID_KINDS.has(kind)) {
      return reply.code(400).send({
        error: 'invalid_kind',
        message: `kind must be one of: ${[...VALID_KINDS].join(', ')}`,
      });
    }
    if (!pattern || typeof pattern !== 'string') {
      return reply.code(400).send({
        error: 'missing_pattern',
        message: 'pattern must be a non-empty string',
      });
    }

    if (kind === 'exclude') {
      action = action ?? 'ignore';
      if (!VALID_ACTIONS.has(action)) {
        return reply.code(400).send({
          error: 'invalid_action',
          message: `action must be one of: ${[...VALID_ACTIONS].join(', ')}`,
        });
      }
    } else {
      // include patterns don't carry an action
      action = null;
    }

    const db = getDb();
    if (watch_id != null) {
      const w = db.prepare(`SELECT id FROM watches WHERE id = ?`).get(Number(watch_id));
      if (!w) {
        return reply.code(400).send({
          error: 'invalid_watch_id',
          message: `No watch with id=${watch_id}`,
        });
      }
    }

    const info = db.prepare(`
      INSERT INTO patterns (watch_id, kind, pattern, action)
      VALUES (?, ?, ?, ?)
    `).run(watch_id != null ? Number(watch_id) : null, kind, pattern, action);

    const created = db.prepare(`SELECT * FROM patterns WHERE id = ?`).get(info.lastInsertRowid);
    return reply.code(201).send({ pattern: created });
  });

  fastify.delete('/api/patterns/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = getDb().prepare(`SELECT id FROM patterns WHERE id = ?`).get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    getDb().prepare(`DELETE FROM patterns WHERE id = ?`).run(id);
    return { ok: true };
  });
}
