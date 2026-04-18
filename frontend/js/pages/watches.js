// DLarr — Watches page
//
// List + create + edit + delete watches. Also manages arr-notification
// mappings per watch.

import { api } from '../api.js';
import { subscribe } from '../app.js';
import {
  el, clear, toast, confirmModal, pageHeader, empty, loading, formatRelative,
} from '../components.js';

export function render(root) {
  clear(root);

  let watches = [];
  let arrs = [];
  let editing = null; // null | {...} (null => creating new)
  let unsubscribe = null;

  const listHost = el('div');

  const newBtn = el('button', {
    class: 'btn btn-primary',
    onClick: () => openEditor(null),
  }, '+ New watch');

  root.appendChild(pageHeader(
    'Watches',
    'Directories to sync from your remote server',
    [newBtn]
  ));

  root.appendChild(listHost);
  listHost.appendChild(loading());

  async function load() {
    try {
      const [wRes, aRes] = await Promise.all([api.listWatches(), api.listArrs()]);
      watches = wRes.watches;
      arrs = aRes.arrs;
      renderList();
    } catch (err) {
      clear(listHost);
      listHost.appendChild(empty('Failed to load', err.message));
    }
  }

  function renderList() {
    clear(listHost);
    if (watches.length === 0) {
      listHost.appendChild(empty(
        'No watches yet',
        'Add a directory on your remote server to start syncing.',
        el('button', { class: 'btn btn-primary', onClick: () => openEditor(null) }, '+ New watch')
      ));
      return;
    }

    const card = el('div', { class: 'card' });
    const tbody = el('tbody');
    const table = el('table', { class: 'table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Name'),
        el('th', {}, 'Remote path'),
        el('th', {}, 'Local path'),
        el('th', {}, 'Enabled'),
        el('th', {}, 'Actions'),
      ])),
      tbody,
    ]);

    for (const w of watches) {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, el('div', {}, [
          el('div', {}, w.name),
          el('div', { class: 'hint' },
            `interval: ${w.scan_interval ?? 'default'}s · ` +
            `arrs: ${w.arr_instance_ids?.length ?? 0}`),
        ])),
        el('td', { class: 'mono truncate' }, w.remote_path),
        el('td', { class: 'mono truncate' }, w.local_path),
        el('td', {}, w.enabled ? 'Yes' : 'No'),
        el('td', { class: 'row' }, [
          el('button', { class: 'btn btn-sm', onClick: () => scanNow(w.id) }, 'Scan now'),
          el('button', { class: 'btn btn-sm', onClick: () => openEditor(w) }, 'Edit'),
          el('button', { class: 'btn btn-sm btn-ghost', onClick: () => remove(w) }, 'Delete'),
        ]),
      ]));
    }
    card.appendChild(table);
    listHost.appendChild(card);
  }

  async function scanNow(id) {
    try {
      await api.scanNow(id);
      toast('Scan triggered', 'success');
    } catch (err) {
      toast(`Scan failed: ${err.message}`, 'error');
    }
  }

  async function remove(w) {
    const ok = await confirmModal({
      title: `Delete "${w.name}"?`,
      body: 'This removes the watch and all tracked files. Local files on disk are NOT deleted.',
      confirmLabel: 'Delete watch',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteWatch(w.id);
      toast('Watch deleted', 'success');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openEditor(w) {
    editing = w ? { ...w } : null;
    clear(listHost);
    listHost.appendChild(renderEditor());
  }

  function renderEditor() {
    const isEdit = !!editing;
    const values = editing ?? {
      name: '', remote_path: '', local_path: '',
      scan_interval: '', enabled: true,
      auto_delete_remote_on_local_missing: false,
      missing_scan_threshold: 3,
      arr_instance_ids: [],
    };

    const state = {
      ...values,
      arr_instance_ids: new Set(values.arr_instance_ids ?? []),
    };

    const card = el('div', { class: 'card' });
    card.appendChild(el('h2', { class: 'card-title' }, isEdit ? `Edit watch: ${values.name}` : 'New watch'));

    const field = (label, input, hint) => {
      card.appendChild(el('div', { class: 'form-grid', style: { marginBottom: '12px' } }, [
        el('label', {}, label),
        input,
        hint ? el('div', { class: 'hint' }, hint) : null,
      ]));
    };

    const nameInput = el('input', {
      type: 'text', value: state.name,
      onInput: e => { state.name = e.target.value; },
    });
    const remoteInput = el('input', {
      type: 'text', value: state.remote_path, placeholder: '/absolute/remote/path',
      onInput: e => { state.remote_path = e.target.value; },
    });
    const localInput = el('input', {
      type: 'text', value: state.local_path, placeholder: '/absolute/local/path',
      onInput: e => { state.local_path = e.target.value; },
    });
    const intervalInput = el('input', {
      type: 'number', min: 5, value: state.scan_interval ?? '',
      placeholder: 'default',
      onInput: e => { state.scan_interval = e.target.value ? Number(e.target.value) : null; },
    });
    const enabledInput = el('input', {
      type: 'checkbox', checked: state.enabled,
      onChange: e => { state.enabled = e.target.checked; },
    });
    const autoDeleteInput = el('input', {
      type: 'checkbox', checked: state.auto_delete_remote_on_local_missing,
      onChange: e => { state.auto_delete_remote_on_local_missing = e.target.checked; },
    });
    const thresholdInput = el('input', {
      type: 'number', min: 1, value: state.missing_scan_threshold,
      onInput: e => { state.missing_scan_threshold = Number(e.target.value); },
    });

    field('Name', nameInput, 'Unique label for this watch');
    field('Remote path', remoteInput);
    field('Local path', localInput, 'Destination on this machine (should be a mounted volume).');
    field('Scan interval (s)', intervalInput, 'Leave empty to use the global default.');
    field('Enabled', enabledInput);
    field('Delete remote on local missing', autoDeleteInput,
      'When a downloaded file is missing locally for N scans, delete the remote copy. Guardrailed by destination-readable check.');
    field('Missing-scan threshold', thresholdInput,
      'Number of consecutive missing scans required before the delete fires.');

    // Arr mapping
    if (arrs.length > 0) {
      const arrWrap = el('div', { class: 'col', style: { marginTop: '8px' } });
      arrWrap.appendChild(el('div', { class: 'muted', style: { fontSize: '13px', fontWeight: 500 } },
        'Notify these arrs on download complete:'));
      for (const a of arrs) {
        const cb = el('input', {
          type: 'checkbox',
          checked: state.arr_instance_ids.has(a.id),
          onChange: e => {
            if (e.target.checked) state.arr_instance_ids.add(a.id);
            else state.arr_instance_ids.delete(a.id);
          },
        });
        arrWrap.appendChild(el('label', {
          style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 400 },
        }, [cb, `${a.name} (${a.type})`]));
      }
      card.appendChild(arrWrap);
    }

    const submitBtn = el('button', {
      class: 'btn btn-primary',
      onClick: () => submit(state, isEdit),
    }, isEdit ? 'Save' : 'Create watch');
    const cancelBtn = el('button', {
      class: 'btn',
      onClick: () => { editing = null; renderList(); },
    }, 'Cancel');

    card.appendChild(el('div', { class: 'row flex-end', style: { marginTop: '20px' } }, [cancelBtn, submitBtn]));
    return card;
  }

  async function submit(state, isEdit) {
    const payload = {
      name: state.name.trim(),
      remote_path: state.remote_path.trim(),
      local_path: state.local_path.trim(),
      scan_interval: state.scan_interval || null,
      enabled: state.enabled,
      auto_delete_remote_on_local_missing: state.auto_delete_remote_on_local_missing,
      missing_scan_threshold: state.missing_scan_threshold,
    };
    if (!payload.name || !payload.remote_path || !payload.local_path) {
      toast('Name, remote path, and local path are required', 'error');
      return;
    }
    try {
      let id;
      if (isEdit) {
        await api.updateWatch(editing.id, payload);
        id = editing.id;
      } else {
        const res = await api.createWatch(payload);
        id = res.watch.id;
      }
      await api.setWatchArrs(id, [...state.arr_instance_ids]);
      toast(isEdit ? 'Watch updated' : 'Watch created', 'success');
      editing = null;
      load();
    } catch (err) {
      toast(`Save failed: ${err.message}`, 'error');
    }
  }

  // Live updates
  unsubscribe = subscribe((event) => {
    if (event.type === 'watch-update' && !editing) load();
  });

  load();

  return () => {
    if (unsubscribe) unsubscribe();
  };
}
