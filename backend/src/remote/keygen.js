// DLarr — SSH key auto-generation
//
// On boot, ensure an ed25519 keypair exists at <DATA_DIR>/.ssh/id_ed25519.
// If the user has set SSH_KEY_PATH explicitly, they're providing their own
// key — we don't touch it and don't generate anything.
//
// The generated key has no passphrase (container-local automation, not
// interactive use). Directory is created with 0700, private key with 0600,
// public key with 0644 — matching ssh-keygen's own defaults.
//
// Shells out to ssh-keygen (installed via openssh-client in Dockerfile).
// Easier than pulling in a JS crypto library and wrestling with OpenSSH
// key format encoding.

import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { logger } from '../logging/logger.js';

/**
 * Default on-disk location for the auto-generated key, relative to DATA_DIR.
 * Exported so engine.js can fall back to this when SSH_KEY_PATH is unset.
 */
export function defaultKeyPath(dataDir) {
  return resolve(dataDir, '.ssh', 'id_ed25519');
}

/**
 * Ensure a usable SSH key exists. Returns the path to the private key
 * that callers should use (generated path, or null if user has overridden).
 *
 * - If userKeyPath is truthy, the user has set SSH_KEY_PATH. We don't
 *   generate or modify anything and return null (caller uses the user's
 *   path as-is).
 * - Otherwise, if the default key already exists, return its path.
 * - Otherwise, generate a new ed25519 keypair and return its path.
 *
 * @param {string} dataDir       absolute path to DATA_DIR
 * @param {string|undefined} userKeyPath  user-supplied SSH_KEY_PATH, if any
 * @returns {string|null}  path to the generated key, or null if user-supplied
 */
export function ensureKey(dataDir, userKeyPath) {
  if (userKeyPath) {
    logger.debug(`SSH_KEY_PATH is set by user (${userKeyPath}); skipping auto-generation`);
    return null;
  }

  const keyPath = defaultKeyPath(dataDir);
  if (existsSync(keyPath)) {
    logger.debug(`SSH key already present at ${keyPath}`);
    return keyPath;
  }

  // Ensure <DATA_DIR>/.ssh exists with 0700
  const sshDir = resolve(dataDir, '.ssh');
  try {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    // mkdirSync honors `mode` only if it creates the dir; fix perms if it existed
    chmodSync(sshDir, 0o700);
  } catch (err) {
    logger.error(`Failed to create ${sshDir}: ${err.message}`);
    throw err;
  }

  // Generate via ssh-keygen
  //   -t ed25519          key type
  //   -f <path>           output path
  //   -N ""               no passphrase
  //   -C "dlarr@<host>"   comment for identification in authorized_keys
  //   -q                  quiet
  const comment = `dlarr@${process.env.HOSTNAME || 'container'}`;
  logger.info(`Generating new ed25519 SSH key at ${keyPath}`);
  const result = spawnSync(
    'ssh-keygen',
    ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', comment, '-q'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  if (result.error) {
    throw new Error(`ssh-keygen failed to launch: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || '(no stderr)';
    throw new Error(`ssh-keygen exited ${result.status}: ${stderr}`);
  }

  // ssh-keygen sets its own perms but be defensive
  try {
    chmodSync(keyPath, 0o600);
    chmodSync(`${keyPath}.pub`, 0o644);
  } catch (err) {
    logger.warn(`Could not set perms on generated key: ${err.message}`);
  }

  logger.info(`SSH key generated. Public key: ${keyPath}.pub`);
  return keyPath;
}
