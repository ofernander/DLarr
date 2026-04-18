// DLarr — Arrs page
//
// List + create + edit + delete + test arr instances.
// Env-locked rows show a lock marker and disabled edit/delete.

import { api } from '../api.js';
import { subscribe } from '../app.js';
import {
  el, clear, toast, confirmModal, pageHeader, empty, loading, formatRelative,
} from '../components.js';

const TYPES = ['sonarr', 'radarr', 'lidarr'];

export function render(root) {
  clear(root);

  let arrs = [];
  let editing = null;
  let unsubscribe = null;

  root.appendChild(pageHeader(
    'Arrs',
    'Media manager instances for rescan notifications',
    [el('button', { class: 'btn btn-primary', onClick: () => openEditor(null) }, '+ New arr')]
  ));

  const listHost = el('div');
  root.appendChild(listHost);
  listHost.appendChild(loading());

  async function load() {
    try {
      const res = await api.listArrs();
      arrs = res.arrs;
      renderList();
    } catch (err) {
      clear(listHost);
      listHost.appendChild(empty('Failed to load', err.message));
    }
  }

  function renderList() {
    clear(listHost);
    if (arrs.length === 0) {
      listHost.appendChild(empty(
        'No arrs configured',
        'Add a Sonarr/Radarr/Lidarr instance to receive rescan notifications.',
        el('button', { class: 'btn btn-primary', onClick: () => openEditor(null) }, '+ New arr')
      ));
      return;
    }

    const card = el('div', { class: 'card' });
    const tbody = el('tbody');
    card.appendChild(el('table', { class: 'table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, ''),
        el('th', {}, 'Name'),
        el('th', {}, 'Type'),
        el('th', {}, 'URL'),
        el('th', {}, 'Last check'),
        el('th', {}, 'Actions'),
      ])),
      tbody,
    ]));

    for (const a of arrs) {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, el('span', { class: 'status-dot', dataset: { status: a.last_status } })),
        el('td', {}, el('div', {}, [
          el('div', {}, [
            a.name,
            a.env_locked ? el('span', { class: 'chip', style: { marginLeft: '8px' } }, '🔒 env') : null,
          ]),
          a.last_status_msg ? el('div', { class: 'hint' }, a.last_status_msg) : null,
        ])),
        el('td', {}, a.type),
        el('td', { class: 'mono truncate' }, a.url),
        el('td', { class: 'hint' }, formatRelative(a.last_check_at)),
        el('td', { class: 'row' }, [
          el('button', { class: 'btn btn-sm', onClick: () => testArr(a.id) }, 'Test'),
          el('button', {
            class: 'btn btn-sm',
            disabled: a.env_locked || null,
            onClick: () => openEditor(a),
          }, 'Edit'),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            disabled: a.env_locked || null,
            onClick: () => remove(a),
          }, 'Delete'),
        ]),
      ]));
    }
    listHost.appendChild(card);
  }

  async function testArr(id) {
    try {
      const res = await api.testArr(id);
      toast(res.ok ? `OK (v${res.version})` : `Failed: ${res.error}`, res.ok ? 'success' : 'warning');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function remove(a) {
    const ok = await confirmModal({
      title: `Delete arr "${a.name}"?`,
      body: 'This removes the arr and its notification history. Watches that linked to it will be updated.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteArr(a.id);
      toast('Arr deleted', 'success');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openEditor(a) {
    editing = a ? { ...a } : null;
    clear(listHost);
    listHost.appendChild(renderEditor());
  }

  function renderEditor() {
    const isEdit = !!editing;
    const state = editing ?? { name: '', type: 'sonarr', url: '', api_key: '', dir: '' };

    const card = el('div', { class: 'card' });
    card.appendChild(el('h2', { class: 'card-title' }, isEdit ? `Edit arr: ${state.name}` : 'New arr'));

    const field = (label, input, hint) => card.appendChild(el('div', {
      class: 'form-grid', style: { marginBottom: '12px' },
    }, [
      el('label', {}, label),
      input,
      hint ? el('div', { class: 'hint' }, hint) : null,
    ]));

    const nameInput = el('input', { type: 'text', value: state.name, onInput: e => state.name = e.target.value });
    const typeSel = el('select', { onChange: e => state.type = e.target.value },
      TYPES.map(t => el('option', { value: t, selected: t === state.type || null }, t)));
    const urlInput = el('input', { type: 'text', value: state.url, placeholder: 'http://host:port', onInput: e => state.url = e.target.value });
    const apiKeyInput = el('input', {
      type: 'password',
      placeholder: isEdit ? 'Leave empty to keep existing' : 'API key',
      onInput: e => state.api_key = e.target.value,
    });
    const dirInput = el('input', {
      type: 'text', value: state.dir,
      placeholder: '/path/the/arr/sees',
      onInput: e => state.dir = e.target.value,
    });

    field('Name', nameInput);
    field('Type', typeSel);
    field('URL', urlInput, 'Base URL of the arr instance, e.g. http://radarr:7878');
    field('API key', apiKeyInput, isEdit ? 'Leave empty to keep existing value.' : undefined);
    field('Rescan dir', dirInput, 'Path the arr sees for this watch\'s downloads.');

    card.appendChild(el('div', { class: 'row flex-end', style: { marginTop: '16px' } }, [
      el('button', { class: 'btn', onClick: () => { editing = null; load(); } }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onClick: () => submit(state, isEdit) }, isEdit ? 'Save' : 'Create arr'),
    ]));

    return card;
  }

  async function submit(state, isEdit) {
    if (!state.name.trim()) { toast('Name required', 'error'); return; }
    if (!state.url.trim()) { toast('URL required', 'error'); return; }
    if (!state.dir.trim()) { toast('Rescan dir required', 'error'); return; }
    if (!isEdit && !state.api_key) { toast('API key required', 'error'); return; }

    const payload = {
      name: state.name.trim(),
      type: state.type,
      url:  state.url.trim(),
      dir:  state.dir.trim(),
    };
    if (state.api_key) payload.api_key = state.api_key;

    try {
      if (isEdit) {
        await api.updateArr(editing.id, payload);
      } else {
        await api.createArr(payload);
      }
      toast(isEdit ? 'Saved' : 'Created', 'success');
      editing = null;
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  unsubscribe = subscribe((event) => {
    if (event.type === 'arr-update' && !editing) load();
  });

  load();

  return () => {
    if (unsubscribe) unsubscribe();
  };
}
