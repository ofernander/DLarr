// DLarr — arr client base class and HTTP helpers
//
// Defines the `ArrClient` abstract interface that Sonarr/Radarr/Lidarr
// clients implement. Also provides a tolerant HTTP helper that handles
// the commonalities:
//   - API-key header
//   - Reasonable timeouts
//   - JSON parsing with graceful error messages
//   - Consistent error shape
//
// Subclasses define:
//   - apiVersion: 'v3' | 'v1' | ...
//   - scanCommand: 'DownloadedMoviesScan' | 'DownloadedEpisodesScan' | ...
//
// The base class handles testConnection() and notifyDownloadComplete() in
// terms of those, since every arr uses the same shape for those endpoints.

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Raised by arr HTTP calls. `code` is a short categorization:
 *   'unreachable'  — network/DNS/timeout/connection refused
 *   'auth_failed'  — 401/403 from the arr
 *   'bad_response' — 2xx but body not as expected
 *   'http_error'   — other non-2xx
 *   'unknown'      — catch-all
 */
export class ArrError extends Error {
  constructor(message, code = 'unknown', cause = null) {
    super(message);
    this.name = 'ArrError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Perform an HTTP request with a timeout, returning either parsed JSON
 * (if response body is JSON) or raw text. Throws ArrError on any failure.
 *
 * @param {string} url
 * @param {object} opts
 * @param {string} opts.method        'GET' | 'POST'
 * @param {string} opts.apiKey
 * @param {object} [opts.body]        JSON body to send (POST only)
 * @param {number} [opts.timeoutMs]
 */
export async function arrFetch(url, { method, apiKey, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const headers = {
    'X-Api-Key': apiKey,
    'Accept':    'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new ArrError(`Request timed out after ${timeoutMs}ms`, 'unreachable', err);
    }
    throw new ArrError(`Network error: ${err.message}`, 'unreachable', err);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ArrError(`Auth failed (HTTP ${res.status})`, 'auth_failed');
  }
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new ArrError(
      `HTTP ${res.status}${text ? `: ${truncate(text, 200)}` : ''}`,
      'http_error'
    );
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch (err) {
      throw new ArrError(`Invalid JSON in response: ${err.message}`, 'bad_response', err);
    }
  }

  // Some arr endpoints (e.g. /system/status on older versions) may return
  // plain text. Return as string; caller decides if that's OK.
  return await safeReadText(res);
}

async function safeReadText(res) {
  try { return (await res.text()).trim(); }
  catch { return ''; }
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/**
 * Abstract base class for all arr clients.
 *
 * Subclasses must set in their constructor or as static properties:
 *   this.apiVersion  = 'v3' | 'v1' | ...
 *   this.scanCommand = 'DownloadedMoviesScan' | ...
 */
export class ArrClient {
  /**
   * @param {object} opts
   * @param {string} opts.name    human-readable label
   * @param {string} opts.url     base URL (e.g. http://radarr:7878)
   * @param {string} opts.apiKey
   * @param {string} opts.dir     path the arr should rescan
   */
  constructor({ name, url, apiKey, dir }) {
    if (!url)    throw new Error('ArrClient: url is required');
    if (!apiKey) throw new Error('ArrClient: apiKey is required');
    this.name = name;
    this.url = url.replace(/\/+$/, ''); // strip trailing slash
    this.apiKey = apiKey;
    this.dir = dir;
  }

  get apiVersion()  { throw new Error('Subclass must define apiVersion'); }
  get scanCommand() { throw new Error('Subclass must define scanCommand'); }
  get type()        { throw new Error('Subclass must define type'); }

  /**
   * Hit /system/status to confirm the arr is reachable and the API key works.
   * Returns { ok: true, version: '...' } or throws ArrError.
   */
  async testConnection() {
    const url = `${this.url}/api/${this.apiVersion}/system/status`;
    const body = await arrFetch(url, { method: 'GET', apiKey: this.apiKey });
    // Most modern arrs return a JSON object with a `version` field.
    const version = (body && typeof body === 'object' && typeof body.version === 'string')
      ? body.version
      : 'unknown';
    return { ok: true, version };
  }

  /**
   * Tell the arr to rescan its configured dir.
   * Returns { ok: true } on success, throws ArrError on failure.
   */
  async notifyDownloadComplete() {
    if (!this.dir) {
      throw new ArrError(
        `Arr "${this.name}" has no configured dir; cannot notify`,
        'bad_response'
      );
    }
    const url = `${this.url}/api/${this.apiVersion}/command`;
    await arrFetch(url, {
      method: 'POST',
      apiKey: this.apiKey,
      body: { name: this.scanCommand, path: this.dir },
    });
    return { ok: true };
  }
}
