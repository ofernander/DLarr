// DLarr — Logs page
//
// Shows backend log events. On mount, fetches historical events from
// /api/logs and renders them; then subscribes to SSE for live updates.
// The backend LOG_LEVEL env var controls what's emitted at all — UI
// has no client-side filter.

import { api } from '../api.js';
import { subscribe } from '../app.js';
import {
  el, clear, pageHeader,
} from '../components.js';

const MAX_BUFFER   = 1000;
const RENDER_TAIL  = 500;
const BACKFILL_N   = 200;

export function render(root) {
  clear(root);

  const lines = [];
  let paused = false;
  let unsubscribe = null;

  const container = el('div', { class: 'log-container' });
  container.appendChild(el('div', { class: 'hint', style: { padding: '20px' } }, 'Loading…'));

  const pauseBtn = el('button', {
    class: 'btn btn-sm',
    onClick: () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      renderLines();
    },
  }, 'Pause');
  const clearBtn = el('button', {
    class: 'btn btn-sm',
    onClick: () => { lines.length = 0; renderLines(); },
  }, 'Clear');

  root.appendChild(pageHeader('Logs', 'Live event stream'));
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'toolbar' }, [
    el('div', { class: 'spacer' }),
    pauseBtn,
    clearBtn,
  ]));
  card.appendChild(container);
  root.appendChild(card);

  function renderLines() {
    clear(container);
    if (lines.length === 0) {
      container.appendChild(el('div', { class: 'hint', style: { padding: '20px' } },
        paused ? 'Paused.' : 'No log events yet.'));
      return;
    }
    for (const line of lines.slice(-RENDER_TAIL)) {
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

  // Fetch historical logs, then subscribe to live stream.
  (async () => {
    try {
      const res = await api.listLogs({ limit: BACKFILL_N });
      for (const entry of res.logs) {
        lines.push(entry);
      }
    } catch (err) {
      // Non-fatal — still show live stream.
      console.warn('Log backfill failed:', err.message);
    }
    renderLines();

    unsubscribe = subscribe((event) => {
      if (event.type !== 'log') return;
      if (paused) return;
      lines.push({
        level:     event.payload.level,
        message:   event.payload.message,
        timestamp: event.payload.timestamp ?? event.timestamp,
      });
      if (lines.length > MAX_BUFFER) lines.splice(0, lines.length - MAX_BUFFER);
      renderLines();
    });
  })();

  return () => { if (unsubscribe) unsubscribe(); };
}
