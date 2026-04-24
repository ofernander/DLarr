// DLarr — small reusable components
//
// Functions that build DOM nodes. Intentionally minimal — no framework,
// no VDOM. Pages call these to compose their views.

// --- DOM helpers ---------------------------------------------------

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class')         node.className = v;
    else if (k === 'dataset')  Object.assign(node.dataset, v);
    else if (k === 'style')    Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    }
    else if (k === 'html')     node.innerHTML = v;
    else if (v === true)       node.setAttribute(k, '');
    else                       node.setAttribute(k, String(v));
  }
  if (!Array.isArray(children)) children = [children];
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// --- Formatting ---------------------------------------------------

export function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

export function formatSpeed(n) {
  if (n == null) return '—';
  return formatBytes(n) + '/s';
}

export function formatEta(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function formatTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function formatRelative(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

// --- Chip ---------------------------------------------------------

export function chip(text, kind) {
  const cls = kind ? `chip chip-${kind}` : 'chip';
  return el('span', { class: cls }, text);
}

// --- Toasts -------------------------------------------------------

const TOAST_DURATION_MS = 4000;

export function toast(message, kind = 'info') {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const node = el('div', { class: `toast toast-${kind}` }, message);
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity 200ms';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, TOAST_DURATION_MS);
}

// --- Confirm modal ------------------------------------------------

export function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-host');
    if (!host) { resolve(false); return; }

    const onCancel = () => { close(false); };
    const onConfirm = () => { close(true); };
    function close(value) {
      host.setAttribute('aria-hidden', 'true');
      clear(host);
      document.removeEventListener('keydown', keyHandler);
      resolve(value);
    }
    function keyHandler(e) {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    }

    const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('h3', { class: 'modal-title' }, title),
      el('p',  { class: 'modal-body' }, body),
      el('div', { class: 'modal-footer' }, [
        el('button', { class: 'btn', onClick: onCancel }, 'Cancel'),
        el('button', {
          class: danger ? 'btn btn-danger' : 'btn btn-primary',
          onClick: onConfirm,
        }, confirmLabel),
      ]),
    ]);

    clear(host);
    host.appendChild(dialog);
    host.setAttribute('aria-hidden', 'false');

    // Click outside dialog to cancel
    host.addEventListener('click', (e) => {
      if (e.target === host) close(false);
    }, { once: true });

    document.addEventListener('keydown', keyHandler);
  });
}

// --- Page header --------------------------------------------------

export function pageHeader(title, subtitle, actions = []) {
  if (!actions.length) return el('div', {});
  const btn = actions[0];
  btn.style.width = '100%';
  btn.style.justifyContent = 'center';
  btn.style.marginBottom = '20px';
  return el('div', {}, [btn]);
}

// --- Empty state --------------------------------------------------

export function empty(title, body, action) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-title' }, title),
    body ? el('div', { class: 'hint' }, body) : null,
    action ? el('div', { style: { marginTop: '16px' } }, action) : null,
  ]);
}

// --- Loading ------------------------------------------------------

export function loading(msg = 'Loading…') {
  return el('div', { class: 'loading' }, [
    el('div', { class: 'spinner' }),
    el('p', {}, msg),
  ]);
}
