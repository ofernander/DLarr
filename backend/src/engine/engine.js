// DLarr — engine orchestrator
//
// Owns the lifecycle of the LFTP process, RemoteScanner, Dispatcher,
// Scheduler, and arr HealthChecker. One Engine instance per process.
//
// Lifecycle:
//   const engine = new Engine();
//   await engine.start();   // spawns LFTP, starts scheduler, starts health checker
//   await engine.stop();    // graceful shutdown
//
// If LFTP dies unexpectedly, the engine logs it and stops the scheduler.
// Automatic LFTP restart is deferred — if LFTP dies it usually means
// something bigger is wrong, and the container orchestrator will restart us.
//
// The arr HealthChecker runs regardless of LFTP state — users can verify
// their arr configs before a valid SSH config is in place.

import { Lftp } from '../lftp/lftp.js';
import { RemoteScanner } from '../remote/scanner.js';
import { Dispatcher } from './dispatcher.js';
import { Scheduler } from './scheduler.js';
import { HealthChecker } from '../arrs/health.js';
import { getLogger, logger } from '../logging/logger.js';
import { get as getSetting, getAll as getAllSettings } from '../config/settings.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build the SSH config object that ssh.js and RemoteScanner expect,
 * sourced from settings.
 */
function buildSshConfig() {
  return {
    host:     getSetting('SSH_HOST'),
    port:     getSetting('SSH_PORT'),
    user:     getSetting('SSH_USER'),
    password: getSetting('SSH_PASSWORD'),
    keyPath:  getSetting('SSH_KEY_PATH'),
    useKey:   getSetting('SSH_USE_KEY'),
  };
}

/**
 * Validate that required SSH settings are present. Throws with a helpful
 * message listing what's missing.
 */
function validateSshConfig(cfg) {
  const missing = [];
  if (!cfg.host) missing.push('SSH_HOST');
  if (!cfg.port) missing.push('SSH_PORT');
  if (!cfg.user) missing.push('SSH_USER');
  if (cfg.useKey && !cfg.keyPath) missing.push('SSH_KEY_PATH (useKey=true)');
  if (!cfg.useKey && !cfg.password) missing.push('SSH_PASSWORD (useKey=false)');
  if (missing.length) {
    throw new Error(
      `SSH configuration incomplete: missing ${missing.join(', ')}. ` +
      `Set the corresponding DLARR_* env vars or configure via the UI.`
    );
  }
}

export class Engine {
  constructor() {
    this.lftp = null;
    this.remoteScanner = null;
    this.dispatcher = null;
    this.scheduler = null;
    this.healthChecker = null;
    this._started = false;
    this._syncStarted = false; // specifically tracks whether LFTP/scheduler are running
  }

  async start() {
    if (this._started) return;

    // Arr health checker runs regardless of SSH state so users can verify
    // arr connectivity before completing SSH config.
    const healthIntervalSecs = getSetting('ARR_HEALTH_CHECK_INTERVAL_SECS') ?? 120;
    this.healthChecker = new HealthChecker({ intervalSecs: healthIntervalSecs });
    this.healthChecker.start();

    // Sync engine requires SSH
    const sshConfig = buildSshConfig();
    try {
      validateSshConfig(sshConfig);
    } catch (err) {
      logger.error(`Sync engine not started: ${err.message}`);
      logger.info('Running with sync offline. Arr health checks still active.');
      this._started = true;
      return;
    }

    // --- LFTP ---
    this.lftp = new Lftp({
      host:     sshConfig.host,
      port:     sshConfig.port,
      user:     sshConfig.user,
      password: sshConfig.password,
      useKey:   sshConfig.useKey,
      logger:   getLogger(),
    });

    this.lftp.on('exit', (code, signal) => {
      logger.error(`LFTP died unexpectedly (code=${code}, signal=${signal})`);
      if (this.scheduler) this.scheduler.stop().catch(() => {});
    });

    await this.lftp.start(getAllSettings());

    // --- Remote scanner ---
    const scriptLocalPath = resolve(__dirname, '../../../remote/dlarr_scan.py');
    const scriptRemotePath = getSetting('REMOTE_SCAN_SCRIPT_PATH');
    this.remoteScanner = new RemoteScanner({
      sshConfig,
      scriptLocalPath,
      scriptRemotePath,
    });

    // --- Dispatcher ---
    this.dispatcher = new Dispatcher({ lftp: this.lftp, sshConfig });

    // --- Scheduler ---
    this.scheduler = new Scheduler({
      remoteScanner: this.remoteScanner,
      lftp: this.lftp,
      dispatcher: this.dispatcher,
      getSetting: getSetting,
    });
    this.scheduler.start();

    this._started = true;
    this._syncStarted = true;
    logger.info('Engine started');
  }

  async stop() {
    if (!this._started) return;
    logger.info('Engine stopping');

    if (this.healthChecker) {
      await this.healthChecker.stop();
    }
    if (this.scheduler) {
      await this.scheduler.stop();
    }
    if (this.lftp) {
      await this.lftp.stop();
    }

    this._started = false;
    this._syncStarted = false;
    logger.info('Engine stopped');
  }

  /**
   * Expose force-scan for the web layer to call.
   */
  forceScan(watchId) {
    if (this.scheduler) this.scheduler.forceScan(watchId);
  }

  /**
   * Whether the sync portion of the engine is running (LFTP alive, scheduler
   * ticking). If false, only arr health checks are active.
   */
  get syncActive() {
    return this._syncStarted && this.lftp?.alive === true;
  }
}
