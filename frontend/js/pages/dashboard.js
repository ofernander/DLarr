// DLarr — Dashboard page
//
// Primary file list with live updates over SSE. Filters: search, state, watch.
// Row actions: queue, stop, retry, delete local, delete remote.
//
// Presence chip: each row shows a two-pill indicator (Remote / Local) derived
// from the file's on_remote and on_local columns. Filled = present, outlined
// = absent. Workflow state (queued, downloading, etc.) is a separate chip.

import { api } from '../api.js';
import { subscribe } from '../app.js';
import {
  el, clear, chip, toast, confirmModal, pageHeader, empty, loading,
  formatBytes,
} from '../components.js';

export function render(root) {
  clear(root);

  let files = [];
  let watches = [];
  let filter = { search: '', state: '', watch_id: '' };
  let unsubscribe = null;

  const tbody = el('tbody');
  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'File'),
      el('th', {}, 'Watch'),
      el('th', {}, 'Presence'),
      el('th', {}, 'State'),
      el('th', { class: 'num' }, 'Size'),
      el('th', {}, 'Actions'),
    ])),
    tbody,
  ]);

  const countsBar = el('div', { class: 'dash-stats' });

  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Search filename…',
    onInput: (e) => { filter.search = e.target.value; renderRows(); },
  });
  const stateSelect = el('select', {
    onChange: (e) => { filter.state = e.target.value; renderRows(); },
  }, [
    el('option', { value: '' }, 'All states'),
    ...['seen', 'queued', 'downloading', 'downloaded', 'ignored', 'error']
      .map(s => el('option', { value: s }, s)),
  ]);
  const watchSelect = el('select', {
    onChange: (e) => { filter.watch_id = e.target.value; renderRows(); },
  }, [el('option', { value: '' }, 'All watches')]);

  root.appendChild(pageHeader('Files', 'Synced from your remote servers'));
  root.appendChild(countsBar);

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'toolbar' }, [
    searchInput,
    stateSelect,
    watchSelect,
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-sm', onClick: () => load() }, 'Refresh'),
  ]));
  card.appendChild(table);
  root.appendChild(card);

  tbody.appendChild(el('tr', {}, el('td', { colspan: 6 }, loading())));

  async function load() {
    try {
      const [filesRes, watchesRes, statusRes] = await Promise.all([
        api.listFiles({ limit: 200 }),
        api.listWatches(),
        api.getStatus(),
      ]);
      files = filesRes.files;
      watches = watchesRes.watches;
      updateWatchOptions();
      updateCounts(statusRes.counts.files);
      renderRows();
    } catch (err) {
      clear(tbody);
      tbody.appendChild(el('tr', {}, el('td', { colspan: 6 }, empty('Failed to load files', err.message))));
    }
  }

  function updateWatchOptions() {
    const current = watchSelect.value;
    clear(watchSelect);
    watchSelect.appendChild(el('option', { value: '' }, 'All watches'));
    for (const w of watches) {
      watchSelect.appendChild(el('option', { value: String(w.id) }, w.name));
    }
    watchSelect.value = current;
  }

  function updateCounts(counts) {
    clear(countsBar);
    const entries = [
      ['Queued',      counts.queued],
      ['Downloading', counts.downloading],
      ['Downloaded',  counts.downloaded],
      ['Errors',      counts.error],
    ];
    for (const [label, value] of entries) {
      countsBar.appendChild(el('div', { class: 'dash-stat' }, [
        el('div', { class: 'dash-stat-label' }, label),
        el('div', { class: 'dash-stat-value' }, String(value ?? 0)),
      ]));
    }
  }

  function renderRows() {
    const watchById = new Map(watches.map(w => [w.id, w.name]));
    const filtered = files.filter(f => {
      if (filter.search && !f.remote_path.toLowerCase().includes(filter.search.toLowerCase())) return false;
      if (filter.state && f.state !== filter.state) return false;
      if (filter.watch_id && String(f.watch_id) !== filter.watch_id) return false;
      return true;
    });

    clear(tbody);
    if (filtered.length === 0) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: 6 }, empty('No files', 'Try adjusting filters, or create a watch.'))));
      return;
    }

    for (const f of filtered) {
      tbody.appendChild(renderRow(f, watchById));
    }
  }

  function presenceChip(f) {
    const onRemote = f.on_remote === 1 || f.on_remote === true;
    const onLocal  = f.on_local  === 1 || f.on_local  === true;
    return el('span', {
      class: 'presence',
      title: `Remote: ${onRemote ? 'yes' : 'no'} · Local: ${onLocal ? 'yes' : 'no'}`,
    }, [
      el('span', { class: `presence-pill ${onRemote ? 'on' : 'off'}` }, 'Remote'),
      el('span', { class: `presence-pill ${onLocal  ? 'on' : 'off'}` }, 'Local'),
    ]);
  }

  function renderRow(f, watchById) {
    const state = f.state;
    const actions = renderActions(f);
    return el('tr', {}, [
      el('td', {}, el('div', {}, [
        el('div', { class: 'truncate', style: { maxWidth: '380px' } }, f.remote_path),
        f.last_error_message
          ? el('div', { class: 'hint', style: { color: 'var(--danger)' } },
              `${f.last_error_reason ?? 'error'}: ${f.last_error_message}`)
          : null,
      ])),
      el('td', {}, watchById.get(f.watch_id) ?? `#${f.watch_id}`),
      el('td', {}, presenceChip(f)),
      el('td', {}, chip(state, state)),
      el('td', { class: 'num nowrap' }, formatBytes(f.remote_size)),
      el('td', { class: 'row' }, actions),
    ]);
  }

  function renderActions(f) {
    const btns = [];
    const add = (label, fn, kind = 'btn btn-sm btn-ghost') =>
      btns.push(el('button', { class: kind, onClick: fn }, label));

    const onRemote = f.on_remote === 1 || f.on_remote === true;
    const onLocal  = f.on_local  === 1 || f.on_local  === true;

    // Queue: only makes sense when the file is on the remote and we're not
    // already actively working on it
    if (onRemote && ['seen', 'error'].includes(f.state)) {
      add('Queue', () => runAction(f.id, 'fileQueue', 'Queued'));
    }
    if (['queued', 'downloading'].includes(f.state)) {
      add('Stop', () => runAction(f.id, 'fileStop', 'Stopped'));
    }
    if (f.state === 'error' || (f.retry_count > 0 && f.state === 'seen')) {
      add('Retry', () => runAction(f.id, 'fileRetry', 'Retry scheduled'));
    }

    // Delete buttons gated on presence, not state
    if (onLocal) {
      add('Delete local', async () => {
        const ok = await confirmModal({
          title: 'Delete local copy?',
          body: `Delete ${f.remote_path} from the local filesystem. This cannot be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) runAction(f.id, 'fileDeleteLocal', 'Local delete complete');
      });
    }
    if (onRemote) {
      add('Delete remote', async () => {
        const ok = await confirmModal({
          title: 'Delete remote copy?',
          body: `Delete ${f.remote_path} from the remote server via SSH. This cannot be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) runAction(f.id, 'fileDeleteRemote', 'Remote delete complete');
      });
    }
    return btns;
  }

  async function runAction(id, method, successMsg) {
    try {
      await api[method](id);
      toast(successMsg, 'success');
    } catch (err) {
      toast(`Action failed: ${err.message}`, 'error');
    }
  }

  // Live updates
  unsubscribe = subscribe((event) => {
    if (event.type === 'file-update') {
      const incoming = event.payload;
      if (incoming.deleted) {
        files = files.filter(f => f.id !== incoming.id);
      } else {
        const idx = files.findIndex(f => f.id === incoming.id);
        if (idx >= 0) files[idx] = incoming;
        else files.unshift(incoming);
      }
      renderRows();
      // Don't refetch counts on every file-update — poll /api/status every 30s instead
    }
  });

  load();

  return () => {
    if (unsubscribe) unsubscribe();
  };
}
