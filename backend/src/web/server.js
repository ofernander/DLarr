// DLarr — Fastify web server
//
// One place to:
//   - configure Fastify
//   - register routes
//   - serve the frontend static files (when built)
//   - centralize error handling
//
// The server is started by index.js after the engine is up so route
// handlers can assume DB + engine are available (engine may be offline
// if SSH isn't configured; handlers check and 503 in that case).
//
// Frontend static serving: the frontend lives at <repo>/frontend/. When
// the server starts we register a Fastify plugin that serves that tree.
// If the directory doesn't exist we log a warning and skip — the API
// still works, which is useful for backend-only dev/debugging.

import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bus } from './events.js';
import { logger as dlarrLogger } from '../logging/logger.js';

import settingsRoutes from './routes/settings.js';
import watchesRoutes  from './routes/watches.js';
import patternsRoutes from './routes/patterns.js';
import arrsRoutes     from './routes/arrs.js';
import filesRoutes    from './routes/files.js';
import commandsRoutes from './routes/commands.js';
import streamRoutes   from './routes/stream.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(__dirname, '../../../frontend');

/**
 * Create and start the Fastify server.
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {Engine} opts.engine
 * @returns {Promise<FastifyInstance>}
 */
export async function createServer({ port, engine }) {
  const fastify = Fastify({
    // Use our own logger; Fastify's built-in pino is duplicative
    logger: false,
    // Strict routing so /api/foo and /api/foo/ don't both hit the handler
    ignoreTrailingSlash: false,
  });

  // ---------- Central error handler ----------
  fastify.setErrorHandler((err, req, reply) => {
    // ENV_LOCKED is handled per-route (409). This catches uncaught throws.
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      dlarrLogger.error(
        `HTTP ${req.method} ${req.url} → ${status}: ${err.stack || err.message}`
      );
    } else {
      dlarrLogger.warn(
        `HTTP ${req.method} ${req.url} → ${status}: ${err.message}`
      );
    }
    reply.code(status).send({
      error: err.code ?? 'internal_error',
      message: err.message,
    });
  });

  fastify.setNotFoundHandler((req, reply) => {
    // API 404s return JSON; non-API 404s fall through to the SPA fallback below
    if (req.url.startsWith('/api/') || req.url === '/stream') {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.code(404).type('text/plain').send('Not Found');
  });

  // ---------- Routes ----------
  await fastify.register(settingsRoutes);
  await fastify.register(watchesRoutes,  { engine });
  await fastify.register(patternsRoutes);
  await fastify.register(arrsRoutes);
  await fastify.register(filesRoutes,    { engine });
  await fastify.register(commandsRoutes, { engine, bus });
  await fastify.register(streamRoutes);

  // ---------- Static frontend ----------
  if (existsSync(FRONTEND_DIR)) {
    try {
      const staticPlugin = await import('@fastify/static');
      await fastify.register(staticPlugin.default, {
        root: FRONTEND_DIR,
        prefix: '/',
        index: ['index.html'],
      });
      dlarrLogger.info(`Serving frontend from ${FRONTEND_DIR}`);
    } catch (err) {
      dlarrLogger.warn(
        `@fastify/static not installed; skipping frontend serving. ` +
        `Run "npm install @fastify/static" to enable. (${err.message})`
      );
    }
  } else {
    dlarrLogger.warn(`Frontend directory not found at ${FRONTEND_DIR}; API only`);
  }

  // ---------- Listen ----------
  await fastify.listen({ port, host: '0.0.0.0' });
  dlarrLogger.info(`Web server listening on :${port}`);

  return fastify;
}
