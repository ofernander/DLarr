// DLarr — logger
//
// Three user-visible levels (info, warn, error) plus debug for file-only.
// Every event at or above the active level is written to:
//   1. the rotating file log at <DATA_DIR>/logs/dlarr.log
//   2. the events table (so the UI log page can page through history)
//   3. the in-process event bus (so SSE clients see it live)
// stdout mirror is enabled so `docker logs` shows output in real time.
//
// The logger is created once at boot and exported as a singleton via
// initLogger(). All subsequent callers import { logger } from this module.
//
// The event bus is imported lazily inside _writeBus to avoid a circular
// dependency at module load time (events.js doesn't depend on logger, but
// other modules that use logger might be imported by events.js in the future).

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../db/db.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_BACKUPS    = 5;

let loggerInstance = null;

class Logger {
  /**
   * @param {object} opts
   * @param {string} opts.level   one of 'debug' | 'info' | 'warn' | 'error'
   * @param {string} opts.logDir  absolute path to log directory
   * @param {boolean} opts.stdout mirror to process.stdout
   */
  constructor({ level, logDir, stdout = true }) {
    this.level = level;
    this.logDir = logDir;
    this.logPath = resolve(logDir, 'dlarr.log');
    this.stdout = stdout;

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    this._insertEvent = null;
    this._publishLog = null;
  }

  setLevel(level) {
    if (LEVELS[level] === undefined) return;
    this.level = level;
  }

  shouldLog(level) {
    return LEVELS[level] >= LEVELS[this.level];
  }

  debug(msg, ctx) { this._log('debug', msg, ctx); }
  info(msg, ctx)  { this._log('info',  msg, ctx); }
  warn(msg, ctx)  { this._log('warn',  msg, ctx); }
  error(msg, ctx) { this._log('error', msg, ctx); }

  /**
   * @param {string} level
   * @param {string} msg
   * @param {object} [ctx] - optional { watchId, fileId, arrId }
   */
  _log(level, msg, ctx = {}) {
    if (!this.shouldLog(level)) return;

    const ts = new Date().toISOString();
    const line = this._format(ts, level, msg, ctx);

    this._writeFile(line);

    if (this.stdout) {
      const stream = level === 'error' ? process.stderr : process.stdout;
      stream.write(line + '\n');
    }

    this._writeEvent(level, msg, ctx);

    // Debug messages are file-only per design §11 — never surface in UI
    if (level !== 'debug') {
      this._writeBus(level, msg, ctx, ts);
    }
  }

  _format(ts, level, msg, ctx) {
    const parts = [ts, level.toUpperCase().padEnd(5), msg];
    const meta = [];
    if (ctx.watchId) meta.push(`watch=${ctx.watchId}`);
    if (ctx.fileId)  meta.push(`file=${ctx.fileId}`);
    if (ctx.arrId)   meta.push(`arr=${ctx.arrId}`);
    if (meta.length) parts.push(`[${meta.join(' ')}]`);
    return parts.join(' ');
  }

  _writeFile(line) {
    try {
      this._rotateIfNeeded();
      appendFileSync(this.logPath, line + '\n', 'utf-8');
    } catch (err) {
      if (this.stdout) {
        process.stderr.write(`[logger] file write failed: ${err.message}\n`);
      }
    }
  }

  _rotateIfNeeded() {
    if (!existsSync(this.logPath)) return;
    const size = statSync(this.logPath).size;
    if (size < MAX_LOG_SIZE_BYTES) return;

    for (let i = MAX_LOG_BACKUPS; i >= 1; i--) {
      const src = i === 1 ? this.logPath : `${this.logPath}.${i - 1}`;
      const dst = `${this.logPath}.${i}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* ignore */ }
      }
    }
  }

  _writeEvent(level, msg, ctx) {
    try {
      if (!this._insertEvent) {
        const db = getDb();
        this._insertEvent = db.prepare(`
          INSERT INTO events (level, watch_id, file_id, arr_id, message)
          VALUES (?, ?, ?, ?, ?)
        `);
      }
      this._insertEvent.run(
        level,
        ctx.watchId ?? null,
        ctx.fileId ?? null,
        ctx.arrId ?? null,
        msg
      );
    } catch {
      // DB not ready or closed; silent skip is intentional
    }
  }

  _writeBus(level, msg, ctx, ts) {
    try {
      // Lazy-import to break potential circular deps
      if (!this._publishLog) {
        const events = require_web_events();
        this._publishLog = events?.publishLog ?? null;
      }
      if (this._publishLog) {
        this._publishLog({ level, message: msg, timestamp: ts, ctx });
      }
    } catch {
      // Bus not ready or failing; silent skip
    }
  }
}

// Lazy dynamic require-ish. Using an async import would make _log async,
// which we don't want, so we resolve the module synchronously via a cache
// populated on first access. Because ESM doesn't have synchronous dynamic
// imports, we import eagerly at top-of-file BUT guard access in case the
// module graph fails. This is simple and works because events.js has no
// runtime dependency on logger.
import * as webEvents from '../web/events.js';
function require_web_events() {
  return webEvents;
}

/**
 * Initialize the global logger. Must be called after DB init if you want
 * events-table logging to work from the first call.
 *
 * @param {object} opts see Logger ctor
 * @returns {Logger}
 */
export function initLogger(opts) {
  loggerInstance = new Logger(opts);
  return loggerInstance;
}

/**
 * Access the initialized logger. Throws if initLogger() wasn't called.
 */
export function getLogger() {
  if (!loggerInstance) {
    throw new Error('Logger not initialized. Call initLogger() first.');
  }
  return loggerInstance;
}

// Convenience re-export for callers who want a bare `logger`.
export const logger = new Proxy({}, {
  get(_target, prop) {
    return getLogger()[prop];
  },
});
