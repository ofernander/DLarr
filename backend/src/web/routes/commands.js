// DLarr — /api/status and /api/server routes
//
// GET  /api/status           → coarse-grained server state for UI header/dashboard
// POST /api/server/restart   → graceful shutdown; container orchestrator restarts us
//
// The restart endpoint does NOT try to re-init the engine in-place. That's
// fragile and hard to get right with long-lived subprocesses. Instead we
// exit cleanly with code 0 and trust the Docker restart policy to bring
// us back up. The UI warns the user about the disconnect window.

import { getDb } from '../../db/db.js';

export default async function commandsRoutes(fastify, { engine, bus }) {
  fastify.get('/api/status', async () => {
    const db = getDb();
    const counts = {
      watches:  db.prepare(`SELECT COUNT(*) AS c FROM watches`).get().c,
      arrs:     db.prepare(`SELECT COUNT(*) AS c FROM arr_instances`).get().c,
      files: {
        queued:      db.prepare(`SELECT COUNT(*) AS c FROM files WHERE state = 'queued'`).get().c,
        downloading: db.prepare(`SELECT COUNT(*) AS c FROM files WHERE state = 'downloading'`).get().c,
        downloaded:  db.prepare(`SELECT COUNT(*) AS c FROM files WHERE state = 'downloaded'`).get().c,
        error:       db.prepare(`SELECT COUNT(*) AS c FROM files WHERE state = 'error'`).get().c,
      },
    };
    return {
      version: '0.1.0',
      sync_active: engine?.syncActive === true,
      arr_health_active: engine?.healthChecker != null,
      sse_subscribers: bus?.subscriberCount?.() ?? 0,
      counts,
      uptime_seconds: Math.floor(process.uptime()),
    };
  });

  fastify.post('/api/server/restart', async (_req, reply) => {
    // Fire-and-forget async shutdown so we can reply first
    reply.send({ ok: true, message: 'Restart initiated' });
    setTimeout(() => {
      process.kill(process.pid, 'SIGTERM');
    }, 100);
  });
}
