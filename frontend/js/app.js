// DLarr — app shell
//
// Responsibilities:
//   - Hash-based router (no build step, no history API juggling)
//   - Single SSE connection to /stream, dispatches events to subscribers
//   - Syncs nav-bar active state + sync-status indicator
//   - Handles mobile nav burger toggle
//
// Pages are lazy-imported on first navigation.

import { api } from './api.js';
import { toast } from './components.js';

// --- Event bus (in-page, for SSE fanout to pages) ----------------

const subscribers = new Set();
export function subscribe(handler) {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}
function emit(event) {
  for (const h of subscribers) {
    try { h(event); } catch (err) { console.error('subscriber threw:', err); }
  }
}

// --- SSE connection -----------------------------------------------

let es = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

function connectStream() {
  try {
    es = new EventSource('/stream');
  } catch (err) {
    console.error('EventSource construction failed:', err);
    scheduleReconnect();
    return;
  }

  es.onopen = () => {
    reconnectDelay = 1000;
    setSyncDot('ok', 'connected');
  };

  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      emit(event);
    } catch (err) {
      console.warn('SSE parse error:', err);
    }
  };

  es.onerror = () => {
    setSyncDot('unreachable', 'disconnected');
    if (es) { es.close(); es = null; }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    connectStream();
  }, reconnectDelay);
}

function setSyncDot(status, label) {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-label');
  if (dot) dot.dataset.status = status;
  if (lbl) lbl.textContent = label;
}

// --- Router -------------------------------------------------------

const routes = {
  dashboard: () => import('./pages/dashboard.js'),
  watches:   () => import('./pages/watches.js'),
  patterns:  () => import('./pages/patterns.js'),
  arrs:      () => import('./pages/arrs.js'),
  settings:  () => import('./pages/settings.js'),
  logs:      () => import('./pages/logs.js'),
};

let currentCleanup = null;

async function render() {
  const hash = window.location.hash || '#/dashboard';
  const routeName = hash.replace(/^#\//, '').split('/')[0] || 'dashboard';
  const loader = routes[routeName] ?? routes.dashboard;

  // Update nav active state
  document.querySelectorAll('.nav-items a').forEach(a => {
    a.classList.toggle('active', a.dataset.route === routeName);
  });

  // Close mobile nav after navigation
  document.querySelector('.nav-items')?.classList.remove('open');

  // Teardown previous page
  if (currentCleanup) {
    try { currentCleanup(); } catch (err) { console.error('cleanup threw:', err); }
    currentCleanup = null;
  }

  const main = document.getElementById('app');
  main.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading…</p></div>';

  try {
    const mod = await loader();
    currentCleanup = mod.render(main) ?? null;
  } catch (err) {
    console.error('Route render failed:', err);
    main.innerHTML = '';
    main.appendChild(renderError(err));
  }
}

function renderError(err) {
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `
    <h2 class="card-title">Something went wrong</h2>
    <p class="muted">${escapeHtml(err.message || 'Unknown error')}</p>
    <pre class="mono" style="white-space: pre-wrap; margin-top: 12px;">${escapeHtml(err.stack || '')}</pre>
  `;
  return div;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- Status badge ------------------------------------------------

async function refreshStatus() {
  try {
    const status = await api.getStatus();
    if (status.sync_active) {
      setSyncDot('ok', 'sync active');
    } else if (status.arr_health_active) {
      setSyncDot('auth_failed', 'sync offline');
    } else {
      setSyncDot('unknown', 'offline');
    }
  } catch {
    // Connection errors are already handled by the SSE dot state;
    // don't overwrite with a stale status.
  }
}

// --- Boot --------------------------------------------------------

function init() {
  // Hash router
  window.addEventListener('hashchange', render);

  // Nav burger
  document.getElementById('nav-burger')?.addEventListener('click', () => {
    document.querySelector('.nav-items')?.classList.toggle('open');
  });

  // SSE + initial status
  connectStream();
  refreshStatus();
  setInterval(refreshStatus, 30000);

  // Respond to SSE status + log events so the dot reflects live state
  subscribe((event) => {
    if (event.type === 'status') {
      refreshStatus();
    }
  });

  // First render
  render();
}

// Fire on DOMContentLoaded or immediately if already parsed
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Expose toast globally for convenience (some pages use it at module load)
window.dlarrToast = toast;
