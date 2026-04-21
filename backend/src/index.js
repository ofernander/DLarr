// DLarr — boot entry point
//
// Boot sequence:
//   1. Parse env vars
//   2. Resolve DATA_DIR (env or default)
//   3. Initialize DB + apply schema
//   4. Initialize logger (writes to file + events table + event bus)
//   5. Reconcile settings from env (Pattern B: env locks DB rows)
//   6. Reconcile arr instances from env
//   7. Log startup summary
//   8. Start engine (arr health always; sync engine if SSH configured)
//   9. Start Fastify web server
//  10. Install signal handlers for clean shutdown

import { parseEnv } from './config/env.js';
import { initDb, closeDb, getDb } from './db/db.js';
import { initLogger } from './logging/logger.js';
import { startRetention } from './logging/retention.js';
import { reconcileSettings, reconcileArrs } from './config/settings.js';
import { ensureKey } from './remote/keygen.js';
import { Engine } from './engine/engine.js';
import { createServer } from './web/server.js';
import { resolve } from 'node:path';

// -----------------------------------------------------------
// Boot
// -----------------------------------------------------------

async function boot() {
  // 1. Parse env
  const { settings, envSettingKeys, arrInstances, warnings } = parseEnv(process.env);

  // 2. Resolve DATA_DIR
  const dataDir = settings.DATA_DIR;

  // 3. Init DB
  initDb(dataDir);

  // 4. Init logger
  const logLevel = settings.LOG_LEVEL;
  const logDir = resolve(dataDir, 'logs');
  const logger = initLogger({ level: logLevel, logDir, stdout: true });

  logger.info('DLarr starting');
  logger.info(`Data directory: ${dataDir}`);
  logger.info(`Log level: ${logLevel}`);

  for (const w of warnings) logger.warn(w);

  // 5. Reconcile settings
  reconcileSettings(settings, envSettingKeys);
  logger.info(
    `Settings reconciled: ${envSettingKeys.length} env-locked, ` +
    `${Object.keys(settings).length - envSettingKeys.length} default-seeded`
  );

  // Auto-generate SSH key if user hasn't specified one
  try {
    ensureKey(dataDir, settings.SSH_KEY_PATH);
  } catch (err) {
    logger.error(`SSH key auto-generation failed: ${err.message}`);
    logger.info('Continuing without auto-generated key; SSH features may not work until resolved');
  }

  // Start events-table retention loop (depends on settings being populated)
  startRetention();

  // 6. Reconcile arrs
  const arrWarnings = reconcileArrs(arrInstances);
  for (const w of arrWarnings) logger.warn(w);
  if (arrInstances.length > 0) {
    logger.info(`Arr instances from env: ${arrInstances.map(a => `${a.name}(${a.type})`).join(', ')}`);
  } else {
    logger.info('No arr instances declared in env');
  }

  // 7. Summary
  const db = getDb();
  const counts = {
    settings: db.prepare(`SELECT COUNT(*) AS c FROM settings`).get().c,
    watches:  db.prepare(`SELECT COUNT(*) AS c FROM watches`).get().c,
    patterns: db.prepare(`SELECT COUNT(*) AS c FROM patterns`).get().c,
    arrs:     db.prepare(`SELECT COUNT(*) AS c FROM arr_instances`).get().c,
  };
  logger.info(
    `DB state: settings=${counts.settings} watches=${counts.watches} ` +
    `patterns=${counts.patterns} arrs=${counts.arrs}`
  );

  // 8. Start engine. engine.start() handles the SSH-incomplete case
  // internally (starts health checker, skips sync). Any other failure
  // we let propagate.
  const engine = new Engine();
  try {
    await engine.start();
    logger.info(engine.syncActive
      ? 'Engine online (sync + arr health)'
      : 'Engine online (arr health only; sync offline)'
    );
  } catch (err) {
    logger.error(`Engine failed to start: ${err.stack || err.message}`);
  }

  // 9. Start web server
  const webPort = settings.WEB_PORT;
  let server = null;
  try {
    server = await createServer({ port: webPort, engine });
  } catch (err) {
    logger.error(`Web server failed to start: ${err.stack || err.message}`);
    throw err; // web is not optional; fail hard
  }

  logger.info('Boot complete.');

  return { logger, engine, server };
}

// -----------------------------------------------------------
// Signal handling
// -----------------------------------------------------------

function installSignalHandlers({ logger, engine, server }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);

    if (server) {
      try { await server.close(); }
      catch (err) { logger.error(`Error closing server: ${err.message}`); }
    }
    try { await engine.stop(); }
    catch (err) { logger.error(`Error stopping engine: ${err.message}`); }
    try { closeDb(); }
    catch (err) { logger.error(`Error closing DB: ${err.message}`); }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.stack || err.message}`);
    shutdown('uncaughtException').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    logger.error(`Unhandled rejection: ${msg}`);
    shutdown('unhandledRejection').catch(() => process.exit(1));
  });
}

// -----------------------------------------------------------
// Go
// -----------------------------------------------------------

boot()
  .then((ctx) => {
    installSignalHandlers(ctx);
    // Fastify's listen keeps the event loop busy; no setInterval needed.
  })
  .catch((err) => {
    process.stderr.write(`[dlarr] boot failed: ${err.stack || err.message}\n`);
    process.exit(1);
  });
