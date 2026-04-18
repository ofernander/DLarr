// DLarr — LFTP command string builders
//
// Builds the exact command strings we send to LFTP via stdin. Centralized
// here so the quoting rules are in one place and the LFTP wrapper stays
// focused on process management.
//
// LFTP's shell-within-a-shell quoting is fiddly. `queue` takes a single
// argument that is itself a command line, so we have to:
//   - wrap the inner command in single quotes
//   - escape any single quotes inside paths
//   - wrap paths in double quotes (LFTP handles spaces that way)
//   - escape any double quotes in paths

import { dirname } from 'node:path';

/**
 * Escape a path for inclusion inside LFTP's double-quoted argument.
 */
function escapePathForLftp(path) {
  return String(path)
    .replace(/\\/g, '\\\\')   // backslash first
    .replace(/"/g, '\\"');    // then doublequotes
}

/**
 * Escape single quotes for the outer 'queue ...' wrapper.
 * Turn each ' into '\'' (close quote, escaped quote, reopen quote).
 */
function escapeSingleQuoted(s) {
  return String(s).replace(/'/g, `'\\''`);
}

/**
 * Build a `set <n> <value>` command.
 */
export function setCommand(name, value) {
  return `set ${name} ${value}`;
}

/**
 * Build a `queue 'pget -c "<remote>" -o "<localDir>/"'` for a single file,
 * or `queue 'mirror -c "<remote>" "<localDir>/"'` for a directory.
 *
 * Important: both `pget -o` and `mirror`'s target argument expect a
 * DIRECTORY path (with trailing slash), not a file path. Passing a file
 * path here causes LFTP to silently no-op — no error, no transfer.
 * LFTP derives the destination filename from the remote path.
 *
 * For files: localPath is the target file (e.g. /downloads/foo.mkv),
 * so we strip the basename to get the containing directory (/downloads).
 *
 * For dirs: localPath is the target directory (e.g. /downloads/.config),
 * which is what we want — mirror will create it and sync into it.
 *
 * @param {object} opts
 * @param {string} opts.remotePath  absolute remote file/dir path
 * @param {string} opts.localPath   absolute local destination (file path for
 *                                  single file, target dir for mirror)
 * @param {boolean} opts.isDir      true if mirror, false if pget
 */
export function queueCommand({ remotePath, localPath, isDir }) {
  const rp = `"${escapePathForLftp(remotePath)}"`;

  const localDir = isDir
    ? localPath.replace(/\/+$/, '')  // mirror target: the dir itself
    : dirname(localPath);             // pget target:   containing dir
  const lp = `"${escapePathForLftp(localDir)}/"`;

  const inner = isDir
    ? `mirror -c ${rp} ${lp}`
    : `pget -c ${rp} -o ${lp}`;

  return `queue '${escapeSingleQuoted(inner)}'`;
}

/**
 * Build a `kill <job_id>` command for running jobs.
 */
export function killCommand(jobId) {
  return `kill ${Number(jobId)}`;
}

/**
 * Build a `queue --delete <job_id>` command for queued-but-not-running jobs.
 */
export function queueDeleteCommand(jobId) {
  return `queue --delete ${Number(jobId)}`;
}

/**
 * Build the standard `jobs -v` status poll command.
 */
export function jobsCommand() {
  return 'jobs -v';
}

/**
 * Build an `exit` command.
 */
export function exitCommand() {
  return 'exit';
}

// Exported for testing the escape helpers if we ever add tests
export const _test = { escapePathForLftp, escapeSingleQuoted };
