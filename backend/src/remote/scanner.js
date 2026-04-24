// DLarr — remote scanner
//
// Uses SSH to list a remote directory tree via dlarr_scan.py.
//
// Install flow (first scan per boot, or on script-hash mismatch):
//   1. Verify the remote has python3 >= 3.6 on PATH (one-time per boot)
//   2. Compute local md5 of dlarr_scan.py
//   3. SSH md5sum the remote copy
//   4. If mismatch or absent, scp the new copy
//
// Scan flow:
//   1. SSH exec `python3 <remote_script_path> <watch.remote_path>`
//   2. Parse stdout as JSON
//   3. Return the parsed tree
//
// Callers (scheduler) are responsible for scheduling. This module is
// stateless beyond two boolean "verified this boot" flags.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, uploadFile, shellQuote } from './ssh.js';
import { logger } from '../logging/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default location of the scan script in the repo. The DLARR_DATA_DIR and
// container layout may override this via the `scriptLocalPath` arg to
// RemoteScanner constructor.
const DEFAULT_LOCAL_SCRIPT_PATH = resolve(__dirname, '../../../remote/dlarr_scan.py');

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 5;

/**
 * Thrown when the remote doesn't have a usable python3. Carries a
 * user-facing message so the logger output tells the user what to do.
 */
export class PythonCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PythonCheckError';
    this.code = 'python_check_failed';
  }
}

/**
 * Compute md5 hex digest of a local file.
 */
function md5File(path) {
  const buf = readFileSync(path);
  return createHash('md5').update(buf).digest('hex');
}

/**
 * RemoteScanner — stateful holder for a connection config + script paths.
 *
 * Usage:
 *   const scanner = new RemoteScanner({
 *     sshConfig: { host, port, user, password/keyPath, useKey },
 *     scriptLocalPath: '/app/remote/dlarr_scan.py',
 *     scriptRemotePath: '/tmp/dlarr_scan.py',
 *   });
 *   const tree = await scanner.scan('/remote/watch/path');
 */
export class RemoteScanner {
  constructor({ sshConfig, scriptLocalPath, scriptRemotePath }) {
    if (!sshConfig) throw new Error('RemoteScanner requires sshConfig');
    if (!scriptRemotePath) throw new Error('RemoteScanner requires scriptRemotePath');

    this.sshConfig = sshConfig;
    this.scriptLocalPath = scriptLocalPath ?? DEFAULT_LOCAL_SCRIPT_PATH;
    this.scriptRemotePath = scriptRemotePath;

    if (!existsSync(this.scriptLocalPath)) {
      throw new Error(`Local scan script not found at ${this.scriptLocalPath}`);
    }

    this._localMd5 = md5File(this.scriptLocalPath);
    this._scriptVerified = false;
    this._pythonVerified = false;
  }

  /**
   * Verify the remote has python3 >= MIN_PYTHON_MAJOR.MIN_PYTHON_MINOR on PATH.
   * One-shot per boot (cached via _pythonVerified).
   *
   * Throws PythonCheckError with an actionable message on failure — the
   * scheduler's catch block will log it at warn, which also reaches the UI
   * via the SSE log stream so the user sees a clear, non-cryptic error.
   */
  async ensurePythonAvailable() {
    if (this._pythonVerified) return;

    let res;
    try {
      res = await exec(this.sshConfig, 'python3 --version 2>&1');
    } catch (err) {
      throw new Error(`SSH connection failed: ${err.message}`);
    }

    if (res.code !== 0) {
      const out = (res.stdout.toString('utf-8') + res.stderr.toString('utf-8')).trim();
      throw new PythonCheckError(
        `Remote has no usable python3 on PATH (exit code ${res.code}${out ? `: ${out}` : ''}). ` +
        `DLarr requires python3 ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}+ on the remote. ` +
        `Install it and retry.`
      );
    }

    const out = (res.stdout.toString('utf-8') + res.stderr.toString('utf-8')).trim();
    const match = out.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
    if (!match) {
      throw new PythonCheckError(
        `Could not parse remote python3 version from output: "${out}". ` +
        `DLarr requires python3 ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}+.`
      );
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < MIN_PYTHON_MAJOR || (major === MIN_PYTHON_MAJOR && minor < MIN_PYTHON_MINOR)) {
      throw new PythonCheckError(
        `Remote python3 version ${major}.${minor} is too old. ` +
        `DLarr requires python3 ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}+. ` +
        `Upgrade python3 on the remote and retry.`
      );
    }

    logger.info(`Remote python3 version ok: ${major}.${minor}`);
    this._pythonVerified = true;
  }

  /**
   * Ensure the remote has the correct version of dlarr_scan.py.
   * Run once per boot; cheap to re-call since it short-circuits after success.
   */
  async ensureScriptInstalled() {
    if (this._scriptVerified) return;

    // Gate on python3 availability first — if python3 is missing or too old,
    // installing the script is pointless and would produce confusing syntax
    // errors later.
    await this.ensurePythonAvailable();

    const remotePath = this.scriptRemotePath;
    const localMd5 = this._localMd5;

    // Check remote md5
    let remoteMd5 = null;
    try {
      const quoted = shellQuote(remotePath);
      const res = await exec(
        this.sshConfig,
        `test -f ${quoted} && md5sum ${quoted} | awk '{print $1}' || echo MISSING`
      );
      const out = res.stdout.toString('utf-8').trim();
      if (out && out !== 'MISSING') {
        remoteMd5 = out;
      }
    } catch (err) {
      logger.warn(`Remote md5 check failed: ${err.message}; will attempt install anyway`);
    }

    if (remoteMd5 === localMd5) {
      logger.debug(`Remote scan script up to date (md5=${localMd5})`);
      this._scriptVerified = true;
      return;
    }

    // Install (or reinstall)
    logger.info(`Installing scan script to remote:${remotePath} (local md5=${localMd5})`);
    await uploadFile(this.sshConfig, this.scriptLocalPath, remotePath);

    // Ensure executable (chmod +x). Not strictly needed since we invoke via
    // python3, but harmless and future-proofs if we shebang-invoke.
    try {
      await exec(this.sshConfig, `chmod +x ${shellQuote(remotePath)}`);
    } catch (err) {
      logger.warn(`chmod +x on remote script failed: ${err.message}`);
    }

    this._scriptVerified = true;
  }

  /**
   * Scan a remote directory tree.
   *
   * @param {string} remotePath absolute path on the remote to scan
   * @returns {Promise<Array>} array of file nodes (design §7 format)
   */
  async scan(remotePath) {
    await this.ensureScriptInstalled();

    const cmd = `python3 ${shellQuote(this.scriptRemotePath)} ${shellQuote(remotePath)}`;
    let res = await exec(this.sshConfig, cmd);

    if (res.code !== 0) {
      const stderr = res.stderr.toString('utf-8').trim();
      const looksLikeMissing = stderr.includes('No such file or directory') ||
                               stderr.includes("can't open file");
      if (looksLikeMissing) {
        logger.warn('Remote scan script missing; reinstalling and retrying');
        this.invalidateScriptCache();
        await this.ensureScriptInstalled();
        res = await exec(this.sshConfig, cmd);
      }
      if (res.code !== 0) {
        const stderr2 = res.stderr.toString('utf-8').trim();
        throw new Error(
          `Remote scan exited with code ${res.code}${stderr2 ? `: ${stderr2}` : ''}`
        );
      }
    }

    const stdout = res.stdout.toString('utf-8').trim();
    if (!stdout) {
      // Empty result (empty directory) is valid
      return [];
    }

    try {
      return JSON.parse(stdout);
    } catch (err) {
      // Preserve a snippet of the output for debugging, but don't dump it all
      const snippet = stdout.length > 300 ? stdout.slice(0, 300) + '…' : stdout;
      throw new Error(`Remote scan returned invalid JSON: ${err.message}; output="${snippet}"`);
    }
  }

  /**
   * Reset the verified flags. Called on reconnect after an error
   * to force re-checks next scan.
   */
  invalidateScriptCache() {
    this._scriptVerified = false;
    this._pythonVerified = false;
  }
}
