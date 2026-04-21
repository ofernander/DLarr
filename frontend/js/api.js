// DLarr — API client
//
// Thin wrappers around the backend JSON endpoints. Every function returns
// the parsed JSON body on 2xx, or throws an Error with a useful message
// on non-2xx. Callers catch and display via toast.

async function request(method, url, body) {
  const opts = {
    method,
    headers: { 'Accept': 'application/json' },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  let data = null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { /* ignore */ }
  } else {
    try { data = await res.text(); } catch { /* ignore */ }
  }

  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.message) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = data?.error;
    err.data = data;
    throw err;
  }

  return data;
}

const GET    = (url)       => request('GET',    url);
const POST   = (url, body) => request('POST',   url, body ?? {});
const PATCH  = (url, body) => request('PATCH',  url, body);
const PUT    = (url, body) => request('PUT',    url, body);
const DELETE = (url)       => request('DELETE', url);

export const api = {
  // Status / server
  getStatus:        () => GET('/api/status'),
  restartServer:    () => POST('/api/server/restart'),

  // Settings
  listSettings:     () => GET('/api/settings'),
  updateSetting:    (key, value) => PATCH(`/api/settings/${encodeURIComponent(key)}`, { value }),

  // Watches
  listWatches:      () => GET('/api/watches'),
  createWatch:      (data) => POST('/api/watches', data),
  updateWatch:      (id, data) => PATCH(`/api/watches/${id}`, data),
  deleteWatch:      (id) => DELETE(`/api/watches/${id}`),
  scanNow:          (id) => POST(`/api/watches/${id}/scan-now`),
  setWatchArrs:     (id, arr_instance_ids) => PUT(`/api/watches/${id}/arr-notifications`, { arr_instance_ids }),

  // Patterns
  listPatterns:     (params) => {
    const q = new URLSearchParams(params).toString();
    return GET(`/api/patterns${q ? '?' + q : ''}`);
  },
  createPattern:    (data) => POST('/api/patterns', data),
  deletePattern:    (id) => DELETE(`/api/patterns/${id}`),

  // Arrs
  listArrs:         () => GET('/api/arrs'),
  createArr:        (data) => POST('/api/arrs', data),
  updateArr:        (id, data) => PATCH(`/api/arrs/${id}`, data),
  deleteArr:        (id) => DELETE(`/api/arrs/${id}`),
  testArr:          (id) => POST(`/api/arrs/${id}/test`),

  // Files
  listFiles:        (params) => {
    const q = new URLSearchParams(params).toString();
    return GET(`/api/files${q ? '?' + q : ''}`);
  },
  fileQueue:        (id) => POST(`/api/files/${id}/queue`),
  fileStop:         (id) => POST(`/api/files/${id}/stop`),
  fileRetry:        (id) => POST(`/api/files/${id}/retry`),
  fileDismiss:      (id) => POST(`/api/files/${id}/dismiss`),
  fileDeleteLocal:  (id) => POST(`/api/files/${id}/delete-local`),
  fileDeleteRemote: (id) => POST(`/api/files/${id}/delete-remote`),
  fileArrHistory:   (id) => GET(`/api/files/${id}/arr-notifications`),

  // Logs
  listLogs:         (params) => {
    const q = new URLSearchParams(params).toString();
    return GET(`/api/logs${q ? '?' + q : ''}`);
  },
};
