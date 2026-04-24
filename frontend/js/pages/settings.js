// DLarr — Settings page
//
// Grouped settings editor. Env-locked keys render disabled with a lock chip.

import { api } from '../api.js';
import {
  el, clear, toast, confirmModal, pageHeader, empty, loading,
} from '../components.js';

const GROUPS = [
  { title: 'Remote server (SSH)', keys: [
    'SSH_HOST', 'SSH_PORT', 'SSH_USER', 'SSH_PASSWORD',
    'SSH_KEY_PATH', 'SSH_USE_KEY',
  ]},
  { title: 'LFTP tuning', keys: [
    'LFTP_NUM_PARALLEL_JOBS',
    'LFTP_NUM_PARALLEL_FILES_PER_JOB',
    'LFTP_NUM_CONNECTIONS_PER_FILE',
    'LFTP_NUM_CONNECTIONS_PER_DIR_FILE',
    'LFTP_MAX_TOTAL_CONNECTIONS',
    'LFTP_USE_TEMP_FILE',
    'LFTP_RATE_LIMIT',
  ]},
  { title: 'Scanner & retries', keys: [
    'DEFAULT_SCAN_INTERVAL_SECS',
    'REMOTE_SCAN_SCRIPT_PATH',
    'MAX_RETRIES',
    'ARR_HEALTH_CHECK_INTERVAL_SECS',
    'ARR_NOTIFY_MAX_RETRIES',
  ]},
  { title: 'Server', keys: ['WEB_PORT', 'LOG_LEVEL', 'DATA_DIR'] },
];

const BOOL_KEYS  = new Set(['SSH_USE_KEY', 'LFTP_USE_TEMP_FILE']);
const INT_KEYS   = new Set([
  'SSH_PORT', 'WEB_PORT',
  'LFTP_NUM_PARALLEL_JOBS', 'LFTP_NUM_PARALLEL_FILES_PER_JOB',
  'LFTP_NUM_CONNECTIONS_PER_FILE', 'LFTP_NUM_CONNECTIONS_PER_DIR_FILE',
  'LFTP_MAX_TOTAL_CONNECTIONS',
  'DEFAULT_SCAN_INTERVAL_SECS', 'MAX_RETRIES',
  'ARR_HEALTH_CHECK_INTERVAL_SECS', 'ARR_NOTIFY_MAX_RETRIES',
]);
const SECRET_KEYS = new Set(['SSH_PASSWORD']);
const ENUM_OPTIONS = { LOG_LEVEL: ['debug', 'info', 'warn', 'error'] };

export function render(root) {
  clear(root);

  let byKey = new Map();

  root.appendChild(pageHeader(
    'Settings',
    'Connection, performance, and behavior',
    [el('button', {
      class: 'btn',
      onClick: async () => {
        const ok = await confirmModal({
          title: 'Restart server?',
          body: 'The process will exit. The container will restart it automatically; expect a brief disconnect.',
          confirmLabel: 'Restart',
        });
        if (!ok) return;
        try {
          await api.restartServer();
          toast('Restart requested', 'success');
        } catch (err) { toast(err.message, 'error'); }
      },
    }, 'Restart server')]
  ));

  const host = el('div');
  root.appendChild(host);
  host.appendChild(loading());

  async function load() {
    try {
      const [res, keyRes] = await Promise.all([
        api.listSettings(),
        api.getSshPublicKey(),
      ]);
      byKey = new Map(res.settings.map(s => [s.key, s]));
      renderGroups(keyRes.publicKey ?? null);
    } catch (err) {
      clear(host);
      host.appendChild(empty('Failed to load', err.message));
    }
  }

  function renderGroups(publicKey) {
    clear(host);
    for (const g of GROUPS) {
      host.appendChild(renderGroup(g, publicKey));
    }
  }

  function renderGroup(g, publicKey) {
    const card = el('div', { class: 'card' });
    card.appendChild(el('h2', { class: 'card-title' }, g.title));
    const grid = el('div', { class: 'form-grid' });
    for (const key of g.keys) {
      const meta = byKey.get(key);
      if (!meta) continue;
      grid.appendChild(renderRow(key, meta));
    }
    if (g.title === 'Remote server (SSH)' && publicKey) {
      const label = el('label', {}, 'SSH_PUBLIC_KEY');
      const input = el('input', {
        type: 'text',
        value: publicKey,
        readOnly: true,
        style: { cursor: 'text' },
      });
      grid.appendChild(el('div', { style: { display: 'contents' } }, [label, input]));
    }
    card.appendChild(grid);
    return card;
  }

  function renderRow(key, meta) {
    const label = el('label', {}, [key]);

    const input = renderInput(key, meta);
    return el('div', { style: { display: 'contents' } }, [label, input]);
  }

  function renderInput(key, meta) {
    const disabled = meta.envLocked;
    const save = async (value) => {
      try {
        await api.updateSetting(key, value);
        toast('Saved', 'success');
      } catch (err) {
        if (err.code === 'env_locked') toast('This setting is locked by env', 'warning');
        else toast(err.message, 'error');
      }
    };

    if (BOOL_KEYS.has(key)) {
      const input = el('input', {
        type: 'checkbox',
        checked: meta.value === true,
        disabled,
        onChange: (e) => save(e.target.checked),
      });
      return input;
    }

    if (ENUM_OPTIONS[key]) {
      const sel = el('select', {
        disabled,
        onChange: (e) => save(e.target.value),
      }, ENUM_OPTIONS[key].map(opt => el('option', {
        value: opt,
        selected: opt === meta.value || null,
      }, opt)));
      return sel;
    }

    const type = SECRET_KEYS.has(key) ? 'password' : (INT_KEYS.has(key) ? 'number' : 'text');
    const placeholder = SECRET_KEYS.has(key) && meta.value === '***'
      ? 'leave empty to keep existing'
      : '';
    const input = el('input', {
      type,
      value: SECRET_KEYS.has(key) ? '' : (meta.value ?? ''),
      placeholder,
      disabled,
      onChange: (e) => {
        let v = e.target.value;
        if (SECRET_KEYS.has(key) && v === '') return; // ignore empty
        if (INT_KEYS.has(key)) v = Number(v);
        save(v);
      },
    });
    return input;
  }

  load();
}
