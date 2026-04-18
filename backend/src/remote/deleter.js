// DLarr — remote file deleter
//
// Deletes a file or directory tree on the remote via `rm -rf` over SSH.
// Used for:
//   - User-triggered "Delete Remote" action
//   - Auto-delete exclude pattern action
//   - Delete-on-disappear feature (per-watch opt-in)
//
// Safety: the caller is responsible for validating the path belongs to a
// known watch. This module does not second-guess the path — if you pass
// "/" it will try to `rm -rf /`, which is why the caller must validate.
// That validation happens at the command dispatcher / web handler layer.

import { exec, shellQuote } from './ssh.js';

/**
 * Delete a remote path. Succeeds if the path doesn't exist.
 *
 * @param {object} sshConfig  SSH connection config
 * @param {string} remotePath absolute path on the remote
 * @returns {Promise<void>}
 * @throws if the SSH command fails or `rm` exits non-zero
 */
export async function deleteRemotePath(sshConfig, remotePath) {
  if (!remotePath || typeof remotePath !== 'string') {
    throw new Error('deleteRemotePath: remotePath must be a non-empty string');
  }

  // Extra paranoia: refuse obviously-dangerous paths. Not a complete check —
  // the real protection is caller-side path validation — but it catches
  // obvious bugs where an empty or root path slips through.
  const trimmed = remotePath.trim();
  if (trimmed === '/' || trimmed === '' || trimmed === '.' || trimmed === '..') {
    throw new Error(`deleteRemotePath: refusing to delete dangerous path "${remotePath}"`);
  }

  const cmd = `rm -rf -- ${shellQuote(remotePath)}`;
  const res = await exec(sshConfig, cmd);

  if (res.code !== 0) {
    const stderr = res.stderr.toString('utf-8').trim();
    throw new Error(
      `Remote delete failed (code ${res.code})${stderr ? `: ${stderr}` : ''}`
    );
  }
}
