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
 * Build a `queue 'pget -c "<remote>" -o "<parentDir>/"'` for a single file,
 * or `queue 'mirror -c "<remote>" "<parentDir>/"'` for a directory.
 *
 * Both LFTP commands take a PARENT DIRECTORY as the destination:
 *   - pget -o writes the file into the given directory using the remote basename
 *   - mirror creates a subdirectory named after SRC's basename inside DEST
 *     and syncs into it
 *
 * Passing a file path to pget -o silently no-ops.
 * Passing the target path itself to mirror causes double-nesting
 * (e.g. /downloads/foo/foo/ instead of /downloads/foo/).
 *
 * Solution: strip basename in both cases to get the parent directory.
 *
 * @param {object} opts
 * @param {string} opts.remotePath  absolute remote file/dir path
 * @param {string} opts.localPath   absolute local target path (file or dir)
 * @param {boolean} opts.isDir      true if mirror, false if pget
 */
export function queueCommand({ remotePath, localPath, isDir }) {
  const rp = `"${escapePathForLftp(remotePath)}"`;

  // Both commands want the parent directory as DEST.
  const localDir = dirname(localPath);
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
