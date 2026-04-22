// DLarr — Watches page
//
// Merged page: list + create + edit + delete watches, manage arr-notification
// mappings per watch, AND manage patterns (both global and per-watch).
//
// Layout:
//   [Global patterns card]     ← top: list + create + delete globals
//   [Watches list]             ← below: table of watches with Edit/Delete/Scan
//   [Watch editor (on demand)] ← opens when creating or editing a watch;
//                                includes "Patterns for this watch" section
//                                at the bottom (only active on existing watches).

import { api } from '../api.js';
import { subscribe } from '../app.js';
import {
  el, clear, chip, toast, confirmModal, pageHeader, empty, loading,
} from '../components.js';

export function render(root) {
  clear(root);

  let watches = [];
  let arrs = [];
  let globalPatterns = [];
  let editing = null; // null | {...}
  let unsubscribe = null;

  const globalPatternsHost = el('div');
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
  root.appendChild(globalPatternsHost);
  root.appendChild(listHost);

  globalPatternsHost.appendChild(loading());
  listHost.appendChild(loading());

  async function load() {
    try {
      const [wRes, aRes, pRes] = await Promise.all([
        api.listWatches(),
        api.listArrs(),
        api.listPatterns({ scope: 'global' }),
      ]);
      watches = wRes.watches;
      arrs = aRes.arrs;
      globalPatterns = pRes.patterns;
      renderGlobalPatterns();
      if (!editing) renderList();
    } catch (err) {
      clear(globalPatternsHost);
      clear(listHost);
      listHost.appendChild(empty('Failed to load', err.message));
    }
  }

  // -----------------------------------------------------------
  // Global patterns
  // -----------------------------------------------------------

  function renderGlobalPatterns() {
    clear(globalPatternsHost);
    const card = el('div', { class: 'card' });
    card.appendChild(el('h2', { class: 'card-title' }, 'Global patterns'));
    card.appendChild(el('p', { class: 'hint', style: { marginTop: '-8px', marginBottom: '12px' } },
      'Apply to every watch. Per-watch patterns are managed inside each watch.'));

    card.appendChild(renderPatternCreateForm(null));
    card.appendChild(renderPatternList(globalPatterns));
    globalPatternsHost.appendChild(card);
  }

  /**
   * Create-pattern form. If watchId is null → global pattern. Otherwise →
   * pattern for that specific watch.
   */
  function renderPatternCreateForm(watchId) {
    const state = { kind: 'include', pattern: '', action: 'ignore' };

    const kindSel = el('select', {
      onChange: e => { state.kind = e.target.value; renderActionField(); },
    }, [
      el('option', { value: 'include' }, 'Include'),
      el('option', { value: 'exclude' }, 'Exclude'),
    ]);

    const actionSel = el('select', {
      onChange: e => { state.action = e.target.value; },
    }, [
      el('option', { value: 'ignore' }, 'ignore'),
      el('option', { value: 'delete_remote' }, 'delete_remote'),
    ]);

    const patternInput = el('input', {
      type: 'text', placeholder: '*.mkv or fragment',
      onInput: e => { state.pattern = e.target.value; },
    });

    const actionCell = el('div');
    function renderActionField() {
      clear(actionCell);
      if (state.kind === 'exclude') actionCell.appendChild(actionSel);
      else actionCell.appendChild(el('span', { class: 'hint' }, 'n/a for includes'));
    }
    renderActionField();

    const addBtn = el('button', {
      class: 'btn btn-primary btn-sm',
      onClick: async () => {
        if (!state.pattern.trim()) { toast('Pattern cannot be empty', 'error'); return; }
        try {
          await api.createPattern({
            watch_id: watchId,
            kind: state.kind,
            pattern: state.pattern.trim(),
            action: state.kind === 'exclude' ? state.action : null,
          });
          toast('Pattern added', 'success');
          patternInput.value = '';
          state.pattern = '';
          if (watchId == null) {
            const pRes = await api.listPatterns({ scope: 'global' });
            globalPatterns = pRes.patterns;
            renderGlobalPatterns();
          } else {
            // Re-render the editor's pattern list
            renderWatchPatternsInto(editing._watchPatternsHost, editing.id);
          }
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, 'Add');

    return el('div', { class: 'form-grid', style: { marginBottom: '12px' } }, [
      el('label', {}, 'Kind'), kindSel,
      el('label', {}, 'Pattern'), patternInput,
      el('label', {}, 'Action'), actionCell,
      el('label', {}, ''), el('div', { class: 'row flex-end' }, [addBtn]),
    ]);
  }

  function renderPatternList(list) {
    if (list.length === 0) {
      return el('p', { class: 'muted', style: { margin: 0 } }, 'No patterns.');
    }
    const tbody = el('tbody');
    const table = el('table', { class: 'table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Kind'),
        el('th', {}, 'Pattern'),
        el('th', {}, 'Action'),
        el('th', {}, ''),
      ])),
      tbody,
    ]);
    for (const p of list) {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, chip(p.kind, p.kind === 'include' ? 'downloaded' : 'error')),
        el('td', { class: 'mono' }, p.pattern),
        el('td', {}, p.action ?? '—'),
        el('td', { class: 'row flex-end' }, [
          el('button', {
            class: 'btn btn-sm btn-ghost',
            onClick: async () => {
              const ok = await confirmModal({
                title: 'Delete pattern?',
                body: `${p.kind}: ${p.pattern}`,
                confirmLabel: 'Delete',
                danger: true,
              });
              if (!ok) return;
              try {
                await api.deletePattern(p.id);
                toast('Deleted', 'success');
                if (p.watch_id == null) {
                  const pRes = await api.listPatterns({ scope: 'global' });
                  globalPatterns = pRes.patterns;
                  renderGlobalPatterns();
                } else if (editing) {
                  renderWatchPatternsInto(editing._watchPatternsHost, editing.id);
                }
              } catch (err) { toast(err.message, 'error'); }
            },
          }, 'Delete'),
        ]),
      ]));
    }
    return table;
  }

  /**
   * Fetch this watch's patterns and render into the given host element.
   */
  async function renderWatchPatternsInto(host, watchId) {
    if (!host) return;
    clear(host);
    try {
      const pRes = await api.listPatterns({ watch_id: watchId });
      host.appendChild(renderPatternList(pRes.patterns));
    } catch (err) {
      host.appendChild(empty('Failed to load patterns', err.message));
    }
  }

  // -----------------------------------------------------------
  // Watches list
  // -----------------------------------------------------------

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

  // -----------------------------------------------------------
  // Watch editor
  // -----------------------------------------------------------

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

    // -------- Per-watch patterns section --------
    const patternsSection = el('div', { style: { marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border)' } });
    patternsSection.appendChild(el('h3', { class: 'card-title', style: { fontSize: '15px' } }, 'Patterns for this watch'));
    patternsSection.appendChild(el('p', { class: 'hint', style: { marginTop: '-4px', marginBottom: '12px' } },
      'Apply only to this watch. Combined with global patterns at scan time.'));

    if (isEdit) {
      patternsSection.appendChild(renderPatternCreateForm(editing.id));
      const listHost2 = el('div');
      patternsSection.appendChild(listHost2);
      editing._watchPatternsHost = listHost2;
      renderWatchPatternsInto(listHost2, editing.id);
    } else {
      patternsSection.appendChild(el('p', { class: 'muted' },
        'Save the watch first, then add patterns specific to it.'));
    }
    card.appendChild(patternsSection);

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
