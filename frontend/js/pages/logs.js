// DLarr — Logs page
//
// Tails the SSE log stream. Buffers in memory; filter by level.

import { subscribe } from '../app.js';
import {
  el, clear, pageHeader, loading,
} from '../components.js';

const MAX_BUFFER = 1000;

export function render(root) {
  clear(root);

  const lines = [];
  let level = 'info'; // minimum level shown
  let paused = false;
  let unsubscribe = null;

  const container = el('div', { class: 'log-container' });
  container.appendChild(el('div', { class: 'hint', style: { padding: '20px' } }, 'Waiting for log events…'));

  const levelSel = el('select', {
    onChange: (e) => { level = e.target.value; renderLines(); },
  }, [
    el('option', { value: 'info', selected: true }, 'info+'),
    el('option', { value: 'warn' }, 'warn+'),
    el('option', { value: 'error' }, 'error only'),
  ]);
  const pauseBtn = el('button', {
    class: 'btn btn-sm',
    onClick: () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    },
  }, 'Pause');
  const clearBtn = el('button', {
    class: 'btn btn-sm',
    onClick: () => { lines.length = 0; renderLines(); },
  }, 'Clear');

  root.appendChild(pageHeader('Logs', 'Live event stream'));
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'toolbar' }, [
    levelSel,
    el('div', { class: 'spacer' }),
    pauseBtn,
    clearBtn,
  ]));
  card.appendChild(container);
  root.appendChild(card);

  const severity = { debug: 0, info: 1, warn: 2, error: 3 };

  function renderLines() {
    clear(container);
    const threshold = severity[level] ?? 1;
    const filtered = lines.filter(l => (severity[l.level] ?? 0) >= threshold);
    if (filtered.length === 0) {
      container.appendChild(el('div', { class: 'hint', style: { padding: '20px' } },
        paused ? 'Paused.' : 'Waiting for log events…'));
      return;
    }
    for (const line of filtered.slice(-500)) {
      container.appendChild(renderLine(line));
    }
    container.scrollTop = container.scrollHeight;
  }

  function renderLine(line) {
    const ts = new Date(line.timestamp).toLocaleTimeString();
    return el('div', { class: 'log-line' }, [
      el('span', { class: 'log-ts' }, ts),
      el('span', { class: `log-level log-level-${line.level}` }, line.level),
      el('span', {}, line.message),
    ]);
  }

  unsubscribe = subscribe((event) => {
    if (event.type !== 'log') return;
    if (paused) return;
    lines.push({
      level: event.payload.level,
      message: event.payload.message,
      timestamp: event.payload.timestamp ?? event.timestamp,
    });
    if (lines.length > MAX_BUFFER) lines.splice(0, lines.length - MAX_BUFFER);
    renderLines();
  });

  return () => { if (unsubscribe) unsubscribe(); };
}
