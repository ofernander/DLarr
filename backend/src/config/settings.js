// DLarr — settings module
//
// Manages the settings and arr_instances tables, implementing Pattern B:
// env vars seed/override DB values and lock UI fields when present.
//
// Booting flow (called from index.js):
//   1. parseEnv()       → env.js returns parsed settings + arr instances
//   2. reconcileSettings() → write env values into DB as env_locked=1
//   3. reconcileArrs()  → upsert arr_instances, mark env-defined ones env_locked=1
//
// Runtime flow:
//   - get(key) / getAll() → read current values (UI + engine consume these)
//   - set(key, value)     → throws if env_locked; otherwise updates DB
//
// The DB is the runtime source of truth. Env is the seed/override.

import { getDb } from '../db/db.js';

// ============================================================
// Settings (scalar config)
// ============================================================

/**
 * Reconcile env-derived settings with the DB.
 *
 * For each key in `envSettings`:
 *   - UPSERT value, env_locked=1
 * For every other key in settings table:
 *   - If previously env_locked but no longer in env, flip env_locked=0
 *     (DB retains the last known env value as the editable default)
 *
 * @param {object} envSettings   merged values from env (every schema key if defaulted in)
 * @param {string[]} envKeys     subset of keys that came from actual env vars
 */
export function reconcileSettings(envSettings, envKeys) {
  const db = getDb();
  const envKeySet = new Set(envKeys);

  const upsert = db.prepare(`
    INSERT INTO settings (key, value, env_locked, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value      = excluded.value,
      env_locked = excluded.env_locked,
      updated_at = CURRENT_TIMESTAMP
  `);

  const unlock = db.prepare(`
    UPDATE settings
    SET env_locked = 0, updated_at = CURRENT_TIMESTAMP
    WHERE key = ? AND env_locked = 1
  `);

  const seedDefault = db.prepare(`
    INSERT INTO settings (key, value, env_locked, updated_at)
    VALUES (?, ?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO NOTHING
  `);

  const tx = db.transaction(() => {
    // 1. Write env-supplied keys as env_locked=1
    for (const key of envKeys) {
      const value = envSettings[key];
      upsert.run(key, serialize(value), 1);
    }

    // 2. Seed defaults for keys NOT supplied by env (only if row doesn't exist)
    for (const [key, value] of Object.entries(envSettings)) {
      if (envKeySet.has(key)) continue;
      seedDefault.run(key, serialize(value));
    }

    // 3. Unlock any previously-env-locked keys that are no longer in env
    const prevEnvLocked = db.prepare(
      `SELECT key FROM settings WHERE env_locked = 1`
    ).all();
    for (const row of prevEnvLocked) {
      if (!envKeySet.has(row.key)) {
        unlock.run(row.key);
      }
    }
  });

  tx();
}

/**
 * Get a single setting's value (deserialized to its logical type).
 * Returns undefined if the key doesn't exist.
 */
export function get(key) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? deserialize(key, row.value) : undefined;
}

/**
 * Get all settings as a flat object { key: value, ... }.
 * Values are deserialized to their logical types.
 */
export function getAll() {
  const db = getDb();
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const out = {};
  for (const r of rows) {
    out[r.key] = deserialize(r.key, r.value);
  }
  return out;
}

/**
 * Get all settings with metadata (for the UI to render env-locked state).
 */
export function getAllWithMeta() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT key, value, env_locked, updated_at FROM settings`
  ).all();
  return rows.map(r => ({
    key:        r.key,
    value:      deserialize(r.key, r.value),
    envLocked:  r.env_locked === 1,
    updatedAt:  r.updated_at,
  }));
}

/**
 * Set a setting via the UI/API. Throws if env_locked.
 */
export function set(key, value) {
  const db = getDb();
  const row = db.prepare(
    `SELECT env_locked FROM settings WHERE key = ?`
  ).get(key);

  if (row && row.env_locked === 1) {
    const err = new Error(`Setting "${key}" is locked by environment variable DLARR_${key}`);
    err.code = 'ENV_LOCKED';
    throw err;
  }

  db.prepare(`
    INSERT INTO settings (key, value, env_locked, updated_at)
    VALUES (?, ?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value      = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, serialize(value));
}

// ============================================================
// Arr instances
// ============================================================

/**
 * Reconcile env-declared arr instances with the DB.
 *
 * For each env-declared arr (identified by name):
 *   - UPSERT, env_locked=1
 * For arrs previously env_locked but no longer in env:
 *   - Flip env_locked=0 (user can now edit/delete via UI)
 *
 * UI-created arrs (env_locked=0) are untouched unless their name collides
 * with an incoming env-declared one, in which case the env wins and a
 * warning is returned.
 *
 * @param {Array} envArrs  instances from env.js parseEnv().arrInstances
 * @returns {string[]} warnings to log
 */
export function reconcileArrs(envArrs) {
  const db = getDb();
  const warnings = [];

  const upsert = db.prepare(`
    INSERT INTO arr_instances (name, type, url, api_key, dir, env_locked)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      type       = excluded.type,
      url        = excluded.url,
      api_key    = excluded.api_key,
      dir        = excluded.dir,
      env_locked = 1
  `);

  const unlock = db.prepare(`
    UPDATE arr_instances SET env_locked = 0 WHERE name = ?
  `);

  const envNameSet = new Set(envArrs.map(a => a.name));

  const tx = db.transaction(() => {
    // Check for name collisions with existing UI-created (unlocked) arrs
    for (const arr of envArrs) {
      const existing = db.prepare(
        `SELECT env_locked FROM arr_instances WHERE name = ?`
      ).get(arr.name);
      if (existing && existing.env_locked === 0) {
        warnings.push(
          `Arr instance "${arr.name}" was UI-created but is now also declared in env; env takes over (now env-locked)`
        );
      }
      upsert.run(arr.name, arr.type, arr.url, arr.apiKey, arr.dir);
    }

    // Unlock previously env-locked arrs that are no longer in env
    const prevLocked = db.prepare(
      `SELECT name FROM arr_instances WHERE env_locked = 1`
    ).all();
    for (const row of prevLocked) {
      if (!envNameSet.has(row.name)) {
        unlock.run(row.name);
      }
    }
  });

  tx();
  return warnings;
}

// ============================================================
// Serialization helpers
// ============================================================
// SQLite stores TEXT for the value column. We normalize bool→'0'/'1',
// numbers → string, strings as-is. Deserialization uses the parser schema
// to coerce back (via env.js SETTINGS_SCHEMA).

import { SETTINGS_SCHEMA } from './env.js';

function serialize(value) {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number')  return String(value);
  if (value === null || value === undefined) return null;
  return String(value);
}

function deserialize(key, raw) {
  if (raw === null || raw === undefined) return undefined;
  const schema = SETTINGS_SCHEMA[key];
  if (!schema) return raw; // unknown key, pass through as string

  switch (schema.type) {
    case 'int':    return Number.parseInt(raw, 10);
    case 'bool':   return raw === '1' || raw === 'true';
    case 'string':
    case 'enum':
    default:       return raw;
  }
}
