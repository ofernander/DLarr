// DLarr — LFTP process wrapper
//
// Long-lived LFTP subprocess controlled via stdin/stdout. LFTP is an
// interactive shell, not a real programmatic interface, so our protocol
// is:
//   1. write a command to stdin
//   2. read stdout until we see a sentinel we injected after the command
//   3. return everything between the command echo and the sentinel
//
// The sentinel technique matters: LFTP's prompt is configurable and
// unreliable across versions. Instead of matching the default prompt,
// we send the real command followed by `echo '<UUID>'` and match on the
// UUID. This is version-independent and immune to prompt changes.
//
// One command at a time: callers must await the current command before
// issuing another. A simple internal queue serializes concurrent calls.
//
// On LFTP death or unexpected exit, all pending calls reject and the
// instance is unusable — higher layers must create a new one. This mirrors
// the "process is alive" discipline from seedsync.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  setCommand,
  jobsCommand,
  queueCommand,
  killCommand,
  queueDeleteCommand,
  exitCommand,
} from './commands.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * LFTP wrapper. Emits:
 *   'exit'  (code, signal) — LFTP process exited
 *   'error' (err)          — unexpected condition
 */
export class Lftp extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host   SFTP host
   * @param {number} opts.port
   * @param {string} opts.user
   * @param {string} [opts.password] required if not using key
   * @param {boolean} opts.useKey
   * @param {string} [opts.lftpPath='lftp'] path to lftp binary (for tests)
   * @param {Logger} [opts.logger]
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.logger = opts.logger ?? null;
    this.proc = null;
    this.alive = false;

    // Serialization queue: { command, resolve, reject, timeoutMs }
    // Named `_cmdQueue` (not `queue`) to avoid shadowing the public `queue()`
    // method defined on the prototype. Own-properties win over prototype
    // methods at lookup time — if this were named `queue`, callers doing
    // `lftp.queue(...)` would hit "this.lftp.queue is not a function".
    this._cmdQueue = [];
    this.busy = false;

    // Accumulating buffers for the current command
    this._stdoutBuf = '';
    this._stderrBuf = '';
  }

  /**
   * Spawn the LFTP process and apply boot-time settings.
   *
   * @param {object} settings  mapping of LFTP settings -> values
   *   see design §8 for the canonical list of keys we apply
   */
  async start(settings = {}) {
    if (this.alive) return;

    const { host, port, user, password, useKey } = this.opts;
    const lftpPath = this.opts.lftpPath ?? 'lftp';

    // Build the args. We connect via sftp:// URL and pass user via -u.
    // Password auth embeds the password in the user spec the way seedsync did.
    // Key auth leaves the password empty and relies on ssh-agent / key path
    // via sftp:connect-program (set further down).
    const userSpec = useKey ? user : `${user},${password ?? ''}`;
    const args = [
      '-p', String(port),
      '-u', userSpec,
      `sftp://${host}`,
    ];

    this._log('debug', `Spawning lftp ${args.join(' ')}`);
    this.proc = spawn(lftpPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.alive = true;

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => this._onStderr(chunk));

    this.proc.on('exit', (code, signal) => {
      this.alive = false;
      this._log(code === 0 ? 'debug' : 'warn', `lftp exited code=${code} signal=${signal}`);
      this._failPendingWith(new Error(`lftp exited (code=${code}, signal=${signal})`));
      this.emit('exit', code, signal);
    });

    this.proc.on('error', (err) => {
      this.alive = false;
      this._log('error', `lftp process error: ${err.message}`);
      this._failPendingWith(err);
      this.emit('error', err);
    });

    // Apply boot settings. `sftp:auto-confirm` first so the initial connect
    // doesn't block on a host-key prompt.
    const bootSettings = {
      'sftp:auto-confirm':                'yes',
      'cmd:at-exit':                      '"kill all"',
      'cmd:queue-parallel':               settings.LFTP_NUM_PARALLEL_JOBS,
      'mirror:parallel-transfer-count':   settings.LFTP_NUM_PARALLEL_FILES_PER_JOB,
      'pget:default-n':                   settings.LFTP_NUM_CONNECTIONS_PER_FILE,
      'mirror:use-pget-n':                settings.LFTP_NUM_CONNECTIONS_PER_DIR_FILE,
      'net:connection-limit':             settings.LFTP_MAX_TOTAL_CONNECTIONS,
      'xfer:use-temp-file':               settings.LFTP_USE_TEMP_FILE ? 'yes' : 'no',
      'xfer:temp-file-name':              '"*.lftp"',
      'net:limit-rate':                   settings.LFTP_RATE_LIMIT ?? '0',
    };

    for (const [k, v] of Object.entries(bootSettings)) {
      if (v === undefined || v === null) continue;
      await this.runCommand(setCommand(k, v));
    }

    this._log('info', `LFTP started and configured (sftp://${host}:${port})`);
  }

  /**
   * Send a command and return its output (stdout between command and sentinel).
   *
   * @param {string} command
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<string>}
   */
  runCommand(command, opts = {}) {
    if (!this.alive) {
      return Promise.reject(new Error('lftp is not running'));
    }
    return new Promise((resolve, reject) => {
      this._cmdQueue.push({
        command,
        timeoutMs: opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        resolve,
        reject,
      });
      this._drainQueue();
    });
  }

  /**
   * Queue a transfer (pget for file, mirror for directory).
   */
  async queue({ remotePath, localPath, isDir }) {
    return this.runCommand(queueCommand({ remotePath, localPath, isDir }));
  }

  /**
   * Poll `jobs -v` and return the raw output. The parser lives in status-parser.js.
   */
  async jobs() {
    return this.runCommand(jobsCommand());
  }

  /**
   * Kill a running job by id.
   */
  async kill(jobId) {
    return this.runCommand(killCommand(jobId));
  }

  /**
   * Remove a queued (not-yet-running) job.
   */
  async queueDelete(jobId) {
    return this.runCommand(queueDeleteCommand(jobId));
  }

  /**
   * Graceful shutdown: `exit` command, then kill if still alive after grace period.
   */
  async stop({ graceMs = 3000 } = {}) {
    if (!this.alive) return;

    try {
      // Best effort: send exit and ignore the response (LFTP closes stdout on exit)
      this.proc.stdin.write(exitCommand() + '\n');
    } catch { /* ignore */ }

    const exited = await Promise.race([
      new Promise((resolve) => this.proc.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);

    if (!exited && this.alive) {
      this._log('warn', 'lftp did not exit gracefully; sending SIGTERM');
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }

  // -----------------------------------------------------------
  // Internal: command queue and sentinel-based output reading
  // -----------------------------------------------------------

  _drainQueue() {
    if (this.busy) return;
    const item = this._cmdQueue.shift();
    if (!item) return;
    this.busy = true;

    const sentinel = `__DLARR_${randomUUID().replace(/-/g, '')}__`;
    item.sentinel = sentinel;
    item.stdout = '';
    item.stderr = '';

    item._timeout = setTimeout(() => {
      this._log('warn', `lftp command timed out: ${item.command}`);
      item.reject(new Error(`lftp command timed out after ${item.timeoutMs}ms: ${item.command}`));
      this._advanceAfter(item);
    }, item.timeoutMs);

    // Attach item to the current wait state
    this._activeItem = item;

    // Write the command followed by an echo-sentinel. When we see the sentinel
    // on stdout we know everything above it was the command's output.
    try {
      this.proc.stdin.write(`${item.command}\n`);
      this.proc.stdin.write(`!echo ${sentinel}\n`);
    } catch (err) {
      clearTimeout(item._timeout);
      item.reject(err);
      this._advanceAfter(item);
    }
  }

  _advanceAfter(item) {
    if (this._activeItem === item) {
      this._activeItem = null;
      this._stdoutBuf = '';
      this._stderrBuf = '';
    }
    this.busy = false;
    this._drainQueue();
  }

  _onStdout(chunk) {
    const text = chunk.toString('utf-8');
    this._stdoutBuf += text;

    const item = this._activeItem;
    if (!item) {
      // Output with no active command — log and discard
      this._log('debug', `lftp unsolicited stdout: ${text.slice(0, 200)}`);
      this._stdoutBuf = '';
      return;
    }

    const idx = this._stdoutBuf.indexOf(item.sentinel);
    if (idx === -1) return; // sentinel not arrived yet, keep buffering

    // Extract everything before the sentinel line. The line containing the
    // sentinel itself is the `!echo` output; strip it entirely.
    let output = this._stdoutBuf.slice(0, idx);

    // Remove the last newline before sentinel and also trim any trailing
    // prompt artifacts. LFTP's prompt may or may not appear; we don't care
    // — sentinel is authoritative.
    output = output.replace(/\r?\n?$/, '');

    clearTimeout(item._timeout);
    item.resolve(output);
    this._advanceAfter(item);
  }

  _onStderr(chunk) {
    const text = chunk.toString('utf-8');
    this._stderrBuf += text;
    // LFTP writes informational messages to stderr too. Log at debug.
    this._log('debug', `lftp stderr: ${text.trim()}`);

    // Authentication failures show up here. Surface them to the active item
    // if present, via logging. The active command will still time out or
    // return normal output — stderr doesn't participate in sentinel matching.
  }

  _failPendingWith(err) {
    if (this._activeItem) {
      clearTimeout(this._activeItem._timeout);
      this._activeItem.reject(err);
      this._activeItem = null;
    }
    while (this._cmdQueue.length > 0) {
      const item = this._cmdQueue.shift();
      item.reject(err);
    }
    this.busy = false;
  }

  _log(level, msg) {
    if (this.logger) this.logger[level]?.(msg);
  }
}
