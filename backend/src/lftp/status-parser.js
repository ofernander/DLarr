// DLarr — LFTP `jobs -v` parser
//
// LFTP output is meant for humans, not machines. Format varies between
// versions and between running vs queued jobs. The parser is therefore
// tolerant: it recognizes a handful of patterns, and returns what it could
// identify. Anything it can't parse is logged and skipped.
//
// Example output from `jobs -v` (simplified):
//
// [1] Running: mirror -c "sftp://remote/path" "/local/path/"
//         \transfer speed 1.2MB/s eta 3m
//         \-Transferring 3 of 10 files
//
// [2] Queue is stopped.
//     queue:
//       [0]  pget -c -n 4 "sftp://remote/file" -o "/local/file"
//
// Output structure we aim for:
// [
//   {
//     id: 1,
//     state: 'running',           // 'running' | 'queued'
//     type:  'mirror' | 'pget',
//     remotePath: '...',          // extracted from "sftp://..." arg
//     localPath:  '...',
//     speed:     1258291,         // bytes/sec, null if unknown
//     eta:       180,             // seconds remaining, null if unknown
//     progress:  0.45,            // 0..1, null if unknown
//     raw:       '<the original lines for debugging>'
//   },
//   ...
// ]
//
// This is a lossy parse — we extract what we can use and discard noise.
// The reconciler treats these as one input among several and doesn't
// trust any single value too much.

/**
 * Parse a human-friendly size string like "1.2M" or "500K" into bytes.
 * Returns null if unparseable.
 */
function parseSize(str) {
  if (!str) return null;
  const m = String(str).match(/^([\d.]+)\s*([KMGTP]?)([Bb]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }[unit] ?? 1;
  return Math.floor(n * mult);
}

/**
 * Parse an ETA string like "3m", "1h20m", "45s", "2d" into seconds.
 * Returns null if unparseable.
 */
function parseEta(str) {
  if (!str) return null;
  const s = String(str).trim();
  let total = 0;
  const re = /(\d+)\s*([dhms])/g;
  let m;
  let matched = false;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseInt(m[1], 10);
    const u = m[2];
    if (u === 'd') total += n * 86400;
    else if (u === 'h') total += n * 3600;
    else if (u === 'm') total += n * 60;
    else if (u === 's') total += n;
  }
  return matched ? total : null;
}

/**
 * Extract the first quoted string from a command line.
 * Used to pull remote/local paths out of mirror/pget invocations.
 */
function extractQuotedArgs(line) {
  const args = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    // Unescape backslash-escaped chars
    args.push(m[1].replace(/\\(.)/g, '$1'));
  }
  return args;
}

/**
 * Tokenize a command line starting after the given command keyword.
 * Splits on whitespace. Also strips trailing "-- stats..." suffix that
 * LFTP appends on status lines (e.g. "-- 955M/2.7G (35%) 97 MiB/s").
 *
 * Does NOT handle embedded spaces in paths. The primary quoted-arg
 * extraction covers that case when LFTP preserves quotes; if LFTP strips
 * quotes AND the path contains spaces, we'd truncate — known limitation.
 */
function tokenizeCommandLine(line, commandKeyword) {
  const idx = line.indexOf(commandKeyword);
  if (idx === -1) return [];
  const rest = line.slice(idx + commandKeyword.length).trim();
  const beforeStats = rest.split(/\s+--\s+/)[0];
  return beforeStats.split(/\s+/).filter(Boolean);
}

/**
 * Extract the non-flag positional args after a mirror/pget command keyword,
 * from a bare (unquoted) invocation line. Skips single-dash flags; treats
 * `-o` as consuming its next token (the pget destination value).
 */
function extractBareArgsAfterCommand(line, commandKeyword) {
  const tokens = tokenizeCommandLine(line, commandKeyword);
  const args = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (t === '-o') i++; // -o consumes the next token as its value
      continue;
    }
    args.push(t);
  }
  return args;
}

/**
 * Split a jobs -v output into job blocks.
 * A job block starts with a line matching /^\s*\[\d+\]/ and continues until
 * the next such line or end of input.
 */
function splitIntoJobBlocks(output) {
  const lines = output.split(/\r?\n/);
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(/^\s*\[(\d+)\]/);
    if (m) {
      if (current) blocks.push(current);
      current = { id: parseInt(m[1], 10), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
    // Lines before the first [N] marker are skipped (output preamble,
    // "Queue is stopped.", etc.)
  }
  if (current) blocks.push(current);

  return blocks;
}

/**
 * Parse a single job block into a structured record, or null if unrecognized.
 */
function parseJobBlock(block) {
  const first = block.lines[0] ?? '';
  const rest = block.lines.slice(1).join('\n');
  const fullText = block.lines.join('\n');

  // LFTP emits a `[N] queue (sftp://...) -- <speed>` meta-block at the top
  // of `jobs -v` output while a queue is active. It describes the queue
  // container, not an individual job — the real job(s) follow in their own
  // [M] blocks. Detect and skip so we don't treat it as unparsed.
  if (/^\s*\[\d+\]\s+queue\b/i.test(first)) {
    return { skip: true };
  }

  // Detect command type and state from the first line
  //   [1] Running: mirror -c "..." "..."
  //   [1] mirror `sftp://...' -- X bytes, Y eta (...)
  //   [1] pget -c "..." -o "..."
  //   [1] Queue is stopped.

  let type = null;
  let state = null;

  if (/\bmirror\b/i.test(first)) type = 'mirror';
  else if (/\bpget\b/i.test(first)) type = 'pget';

  if (/\bRunning\b/i.test(first) || /transfer|Transferring/i.test(fullText)) {
    state = 'running';
  } else if (/\bQueue\b/i.test(first) || block.lines.some(l => /^\s+queue:/i.test(l))) {
    state = 'queued';
  } else if (type) {
    // No explicit marker but we recognized a type — assume running
    state = 'running';
  }

  if (!type || !state) {
    return null;
  }

  // Try to extract paths. LFTP sometimes echoes our quoted paths back
  // unquoted in `jobs -v` output (e.g. `mirror -c /a/b /c/d` despite us
  // sending `mirror -c "/a/b" "/c/d"`). Try quoted first, then fall back
  // to bare-token parsing of the first line.
  const quoted = extractQuotedArgs(fullText);
  let remotePath = null;
  let localPath = null;
  if (type === 'mirror') {
    [remotePath, localPath] = quoted;
    if (!remotePath) {
      const paths = extractBareArgsAfterCommand(first, 'mirror');
      remotePath = paths[0] ?? null;
      localPath = paths[1] ?? null;
    }
  } else if (type === 'pget') {
    remotePath = quoted[0] ?? null;
    // find "-o" then next quoted
    const oIdx = fullText.indexOf('-o');
    if (oIdx !== -1) {
      const afterO = fullText.slice(oIdx);
      const afterQuoted = extractQuotedArgs(afterO);
      localPath = afterQuoted[0] ?? null;
    }
    if (!remotePath) {
      // Bare-arg pget: `pget -c <remote> -o <local>`
      const tokens = tokenizeCommandLine(first, 'pget');
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith('-')) {
          if (t === '-o') i++;
          continue;
        }
        remotePath = t;
        break;
      }
      if (!localPath) {
        const oi = tokens.indexOf('-o');
        if (oi !== -1 && tokens[oi + 1]) localPath = tokens[oi + 1];
      }
    }
  }

  // Speed: "1.2M/s" or "1258.3 KiB/s"
  let speed = null;
  const speedMatch = fullText.match(/([\d.]+\s*[KMGTP]?i?B?)\/s/i);
  if (speedMatch) speed = parseSize(speedMatch[1]);

  // ETA: "eta 3m", "eta: 1h30m", "1h30m remaining"
  let eta = null;
  const etaMatch = fullText.match(/eta[:\s]+([0-9dhms\s]+?)(?=\s|$|,|\))/i);
  if (etaMatch) eta = parseEta(etaMatch[1]);

  // Progress percentage: "(45%)"
  let progress = null;
  const pctMatch = fullText.match(/(\d+)%/);
  if (pctMatch) progress = Math.max(0, Math.min(1, parseInt(pctMatch[1], 10) / 100));

  return {
    id: block.id,
    state,
    type,
    remotePath,
    localPath,
    speed,
    eta,
    progress,
    raw: fullText,
  };
}

/**
 * Parse the full output of `jobs -v`.
 *
 * @param {string} output the raw output from LFTP after sending `jobs -v`
 * @returns {{ jobs: Array, unparsed: number }}
 *   jobs: successfully parsed jobs
 *   unparsed: count of job blocks that couldn't be interpreted
 */
export function parseJobs(output) {
  if (!output || !output.trim()) {
    return { jobs: [], unparsed: 0 };
  }

  const blocks = splitIntoJobBlocks(output);
  const jobs = [];
  let unparsed = 0;

  for (const block of blocks) {
    const parsed = parseJobBlock(block);
    if (parsed && parsed.skip) continue;
    if (parsed) jobs.push(parsed);
    else unparsed++;
  }

  return { jobs, unparsed };
}
