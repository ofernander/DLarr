// DLarr — Patterns page
//
// Two sections: global patterns, per-watch patterns. Create form at the top.

import { api } from '../api.js';
import {
  el, clear, chip, toast, confirmModal, pageHeader, empty, loading,
} from '../components.js';

export function render(root) {
  clear(root);

  let patterns = [];
  let watches = [];

  root.appendChild(pageHeader('Patterns', 'Auto-queue rules by filename'));
  const createHost = el('div');
  const listHost = el('div');
  root.appendChild(createHost);
  root.appendChild(listHost);
  listHost.appendChild(loading());

  async function load() {
    try {
      const [pRes, wRes] = await Promise.all([api.listPatterns(), api.listWatches()]);
      patterns = pRes.patterns;
      watches = wRes.watches;
      renderCreate();
      renderList();
    } catch (err) {
      clear(listHost);
      listHost.appendChild(empty('Failed to load', err.message));
    }
  }

  function renderCreate() {
    clear(createHost);
    const state = {
      scope: 'global',
      watch_id: '',
      kind: 'include',
      pattern: '',
      action: 'ignore',
    };

    const card = el('div', { class: 'card' });
    card.appendChild(el('h2', { class: 'card-title' }, 'Add pattern'));

    const scopeSel = el('select', {
      onChange: e => { state.scope = e.target.value; renderScopeField(); },
    }, [
      el('option', { value: 'global' }, 'Global'),
      el('option', { value: 'watch' }, 'Watch-specific'),
    ]);

    const watchSel = el('select', {
      onChange: e => { state.watch_id = e.target.value; },
    }, [
      el('option', { value: '' }, 'Select a watch…'),
      ...watches.map(w => el('option', { value: String(w.id) }, w.name)),
    ]);

    const scopeCell = el('div');
    function renderScopeField() {
      clear(scopeCell);
      scopeCell.appendChild(scopeSel);
      if (state.scope === 'watch') {
        scopeCell.appendChild(el('span', { style: { marginLeft: '8px' } }));
        scopeCell.appendChild(watchSel);
      }
    }
    renderScopeField();

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

    const actionCell = el('div');
    function renderActionField() {
      clear(actionCell);
      if (state.kind === 'exclude') actionCell.appendChild(actionSel);
      else actionCell.appendChild(el('span', { class: 'hint' }, 'n/a for includes'));
    }
    renderActionField();

    const patternInput = el('input', {
      type: 'text', placeholder: '*.mkv or fragment',
      onInput: e => { state.pattern = e.target.value; },
    });

    const form = el('div', { class: 'form-grid' }, [
      el('label', {}, 'Scope'), scopeCell,
      el('label', {}, 'Kind'), kindSel,
      el('label', {}, 'Pattern'), patternInput,
      el('label', {}, 'Action'), actionCell,
    ]);
    card.appendChild(form);
    card.appendChild(el('div', { class: 'row flex-end', style: { marginTop: '16px' } }, [
      el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          if (!state.pattern.trim()) { toast('Pattern cannot be empty', 'error'); return; }
          if (state.scope === 'watch' && !state.watch_id) { toast('Pick a watch', 'error'); return; }
          try {
            await api.createPattern({
              watch_id: state.scope === 'watch' ? Number(state.watch_id) : null,
              kind: state.kind,
              pattern: state.pattern.trim(),
              action: state.kind === 'exclude' ? state.action : null,
            });
            toast('Pattern added', 'success');
            patternInput.value = '';
            state.pattern = '';
            load();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Add'),
    ]));
    createHost.appendChild(card);
  }

  function renderList() {
    clear(listHost);
    const global = patterns.filter(p => p.watch_id == null);
    const byWatch = new Map();
    for (const p of patterns.filter(p => p.watch_id != null)) {
      if (!byWatch.has(p.watch_id)) byWatch.set(p.watch_id, []);
      byWatch.get(p.watch_id).push(p);
    }

    listHost.appendChild(renderSection('Global patterns', global));
    for (const w of watches) {
      const ps = byWatch.get(w.id) ?? [];
      listHost.appendChild(renderSection(`Watch: ${w.name}`, ps));
    }
  }

  function renderSection(title, list) {
    const card = el('div', { class: 'card' });
    card.appendChild(el('h2', { class: 'card-title' }, title));
    if (list.length === 0) {
      card.appendChild(el('p', { class: 'muted' }, 'No patterns.'));
      return card;
    }
    const tbody = el('tbody');
    card.appendChild(el('table', { class: 'table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Kind'),
        el('th', {}, 'Pattern'),
        el('th', {}, 'Action'),
        el('th', {}, ''),
      ])),
      tbody,
    ]));

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
                load();
              } catch (err) { toast(err.message, 'error'); }
            },
          }, 'Delete'),
        ]),
      ]));
    }
    return card;
  }

  load();
}
