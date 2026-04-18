// DLarr — SSH wrapper
//
// Thin wrapper around ssh2 for two use cases:
//   1. exec() — run a shell command on the remote, return stdout/stderr/code
//   2. uploadFile() — scp a local file to a remote path
//
// Connections are short-lived (one per operation) to keep things simple.
// If SSH throughput becomes a bottleneck we can pool connections, but for
// a scan loop that runs every 30s that's premature.
//
// Authentication supports both key-based and password-based login. Key
// takes precedence if both are configured.

import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 180_000;

/**
 * Normalize SSH connection config from our settings format to ssh2's format.
 *
 * @param {object} cfg
 * @param {string} cfg.host
 * @param {number} cfg.port
 * @param {string} cfg.user
 * @param {string} [cfg.password]
 * @param {string} [cfg.keyPath]
 * @param {boolean} cfg.useKey
 */
function buildConnectOptions(cfg) {
  const opts = {
    host:     cfg.host,
    port:     cfg.port,
    username: cfg.user,
    readyTimeout: 20_000,
  };

  if (cfg.useKey) {
    if (!cfg.keyPath) {
      throw new Error('SSH useKey=true but no keyPath configured');
    }
    try {
      opts.privateKey = readFileSync(cfg.keyPath);
    } catch (err) {
      throw new Error(`Failed to read SSH key at ${cfg.keyPath}: ${err.message}`);
    }
  } else {
    if (!cfg.password) {
      throw new Error('SSH useKey=false but no password configured');
    }
    opts.password = cfg.password;
  }

  return opts;
}

/**
 * Connect, run operation, disconnect. Wraps the callback-heavy ssh2 API
 * in a single Promise.
 */
function withConnection(cfg, operation) {
  return new Promise((resolvePromise, rejectPromise) => {
    const client = new Client();
    let settled = false;

    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* ignore */ }
      if (err) rejectPromise(err);
      else     resolvePromise(result);
    };

    client.on('error', (err) => settle(err));
    client.on('ready', () => {
      operation(client, settle);
    });

    try {
      client.connect(buildConnectOptions(cfg));
    } catch (err) {
      settle(err);
    }
  });
}

/**
 * Execute a shell command on the remote.
 *
 * @param {object} cfg     SSH connection config (see buildConnectOptions)
 * @param {string} command shell command to execute
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] max execution time, default 60s
 * @returns {Promise<{ stdout: Buffer, stderr: Buffer, code: number|null, signal: string|null }>}
 */
export function exec(cfg, command, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  return withConnection(cfg, (client, done) => {
    const timer = setTimeout(() => {
      done(new Error(`SSH exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return done(err);
      }

      const stdoutChunks = [];
      const stderrChunks = [];
      let exitCode = null;
      let exitSignal = null;

      stream.on('data', (chunk) => stdoutChunks.push(chunk));
      stream.stderr.on('data', (chunk) => stderrChunks.push(chunk));

      stream.on('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
      });

      stream.on('close', () => {
        clearTimeout(timer);
        done(null, {
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          code:   exitCode,
          signal: exitSignal,
        });
      });
    });
  });
}

/**
 * Upload a local file to a remote path via SFTP.
 * Overwrites any existing file at the destination.
 *
 * @param {object} cfg        SSH connection config
 * @param {string} localPath  absolute path on local filesystem
 * @param {string} remotePath absolute path on remote filesystem
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<void>}
 */
export function uploadFile(cfg, localPath, remotePath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;

  return withConnection(cfg, (client, done) => {
    const timer = setTimeout(() => {
      done(new Error(`SSH upload timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client.sftp((err, sftp) => {
      if (err) {
        clearTimeout(timer);
        return done(err);
      }

      sftp.fastPut(localPath, remotePath, (err2) => {
        clearTimeout(timer);
        if (err2) done(err2);
        else      done(null);
      });
    });
  });
}

/**
 * Quote a shell argument safely for POSIX shells.
 * Use this when building shell commands to send via exec().
 *
 * Strategy: wrap in single quotes and escape embedded single quotes by
 * closing the quote, inserting a literal single-quote, and reopening.
 */
export function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}
