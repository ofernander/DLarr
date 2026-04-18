// DLarr — pattern matcher
//
// Decides for each scanned file whether it should be queued, ignored, or
// have its remote copy deleted, based on the patterns configured for its
// watch (plus global patterns).
//
// Matching rules (design §8-ish, consolidated from the auto_queue.py in
// the seedsync reference):
//   - Case-insensitive
//   - A pattern matches if EITHER:
//       - the pattern string is a substring of the filename, OR
//       - fnmatch-style glob against the filename
//   - Patterns apply only to the top-level file/dir name inside the watch
//     (not the full recursive tree). Child files are handled by LFTP's
//     mirror when we queue the parent directory.
//   - Precedence: exclude wins over include.
//   - If NO include pattern exists at all (neither global nor watch-scoped),
//     the default behavior is INCLUDE ALL — all files are candidates for
//     queueing unless matched by an exclude. This matches seedsync's
//     "patterns_only=false" default.
//   - If include patterns DO exist, a file must match at least one include
//     to be queued. Files not matching any include are simply ignored
//     (state stays `seen`, no action).
//
// Returned decision:
//   { action: 'queue' | 'ignore' | 'delete_remote', patternId: number | null }
//
// patternId references the pattern row that decided the outcome, or null
// if the decision came from the default rule.

/**
 * Lowercase + trimmed string compare helper.
 */
function lc(s) {
  return String(s ?? '').toLowerCase();
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: *, ?, [set], and literal characters. No extended globs.
 */
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*')       re += '.*';
    else if (c === '?')  re += '.';
    else if (c === '[') {
      // bracket expression — pass through up to closing ]
      let j = i + 1;
      while (j < glob.length && glob[j] !== ']') j++;
      if (j < glob.length) {
        re += glob.slice(i, j + 1);
        i = j;
      } else {
        re += '\\[';
      }
    }
    else if ('.+^$()|\\{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Does the pattern match the filename?
 * Returns true if either the pattern is a substring of the filename or
 * the pattern is a glob that matches the whole filename.
 */
export function matchPattern(pattern, filename) {
  const lp = lc(pattern);
  const lf = lc(filename);
  if (!lp || !lf) return false;

  if (lf.includes(lp)) return true;

  try {
    return globToRegex(lp).test(lf);
  } catch {
    return false;
  }
}

/**
 * Apply the full pattern set to a filename.
 *
 * @param {string} filename  top-level name in the watch (file or dir)
 * @param {Array}  patterns  rows from the `patterns` table whose scope
 *                           matches this file (global + watch-scoped).
 *                           Each row: { id, kind, pattern, action }
 * @returns {{ action: 'queue'|'ignore'|'delete_remote', patternId: number|null }}
 */
export function decide(filename, patterns) {
  const includes = [];
  const excludes = [];
  for (const p of patterns) {
    if (p.kind === 'include')       includes.push(p);
    else if (p.kind === 'exclude')  excludes.push(p);
  }

  // Excludes have priority
  for (const p of excludes) {
    if (matchPattern(p.pattern, filename)) {
      const action = p.action === 'delete_remote' ? 'delete_remote' : 'ignore';
      return { action, patternId: p.id };
    }
  }

  // If no include patterns exist, default to queue (include-all)
  if (includes.length === 0) {
    return { action: 'queue', patternId: null };
  }

  // With include patterns, require a match
  for (const p of includes) {
    if (matchPattern(p.pattern, filename)) {
      return { action: 'queue', patternId: p.id };
    }
  }

  return { action: 'ignore', patternId: null };
}

// Exported for testing the glob conversion
export const _test = { globToRegex };
