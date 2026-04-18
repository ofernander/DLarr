// DLarr — About page

import { api } from '../api.js';
import { el, clear, pageHeader } from '../components.js';

export function render(root) {
  clear(root);
  root.appendChild(pageHeader('About', 'DLarr — fast, one-way remote-to-local file sync with arr integration'));

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'col', style: { gap: '12px' } }, [
    el('div', {}, [
      el('strong', {}, 'Version: '),
      el('span', { id: 'about-version' }, '—'),
    ]),
    el('div', {}, [
      el('strong', {}, 'Uptime: '),
      el('span', { id: 'about-uptime' }, '—'),
    ]),
    el('div', {}, [
      el('strong', {}, 'SSE subscribers: '),
      el('span', { id: 'about-subs' }, '—'),
    ]),
    el('hr', { style: { border: 'none', borderTop: '1px solid var(--border)' } }),
    el('div', { class: 'muted' },
      'DLarr is an Apache-2.0 licensed open-source project. The design is inspired by seedsync but is an independent reimplementation in Node.js.'),
  ]));
  root.appendChild(card);

  api.getStatus().then(s => {
    document.getElementById('about-version').textContent = s.version;
    document.getElementById('about-uptime').textContent  = formatUptime(s.uptime_seconds);
    document.getElementById('about-subs').textContent    = String(s.sse_subscribers);
  }).catch(() => {});
}

function formatUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}
