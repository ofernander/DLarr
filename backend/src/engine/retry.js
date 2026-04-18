// DLarr — retry policy + error categorization
//
// Determines when and how to retry failed transfers, and categorizes raw
// error messages into the reason codes listed in design §8.5.

const REASON_PATTERNS = [
  { code: 'auth_failed',       matchers: [/login incorrect/i, /authentication failed/i, /permission denied \(publickey/i] },
  { code: 'permission_denied', matchers: [/permission denied/i, /access denied/i] },
  { code: 'file_not_found',    matchers: [/no such file/i, /file not found/i, /not accessible/i] },
  { code: 'disk_full',         matchers: [/no space left/i, /disk full/i, /quota exceeded/i] },
  { code: 'connection_lost',   matchers: [/connection refused/i, /connection reset/i, /connection closed/i, /host is down/i, /network is unreachable/i, /connection timed out/i, /broken pipe/i, /lost connection/i] },
  { code: 'lftp_error',        matchers: [/\blftp\b/i] },
];

/**
 * Categorize a raw error message/string into a reason code.
 * Returns 'unknown' if nothing matches.
 *
 * @param {string|Error} err
 * @returns {string}
 */
export function categorizeError(err) {
  const text = err instanceof Error ? (err.stack || err.message) : String(err ?? '');
  for (const { code, matchers } of REASON_PATTERNS) {
    if (matchers.some(re => re.test(text))) return code;
  }
  return 'unknown';
}

/**
 * Backoff schedule for retries. Index is retry_count BEFORE this attempt.
 * Index 0 → first retry after the original failure, etc.
 * Capped at the last value for retries beyond the array length.
 *
 * Matches design §8.5: 30s → 1m → 2m → 5m → 10m.
 */
const BACKOFF_SCHEDULE_MS = [
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
];

/**
 * How long to wait before retrying, given how many retries have already
 * occurred. Always returns the last value in the schedule for out-of-range
 * indices.
 */
export function backoffMsForRetry(retryCount) {
  const idx = Math.min(retryCount, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx];
}

/**
 * Decide whether a failed file should be retried now, retried later, or
 * moved to ERROR state.
 *
 * @param {object} file  row from `files` table. Needs:
 *   - retry_count (integer)
 *   - last_state_change_at (ISO timestamp string; we treat it as "last failure" time)
 * @param {number} maxRetries  global DLARR_MAX_RETRIES setting
 * @param {Date}   now         current time (injected for testability)
 * @returns {'retry_now' | 'wait' | 'exhausted'}
 */
export function retryDecision(file, maxRetries, now = new Date()) {
  if (file.retry_count >= maxRetries) return 'exhausted';

  const backoff = backoffMsForRetry(file.retry_count);
  const lastChange = file.last_state_change_at
    ? new Date(file.last_state_change_at).getTime()
    : 0;
  const readyAt = lastChange + backoff;

  return now.getTime() >= readyAt ? 'retry_now' : 'wait';
}
