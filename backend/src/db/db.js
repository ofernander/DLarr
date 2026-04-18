// DLarr — SQLite wrapper
//
// Opens the DB file, applies the schema on first boot, and exposes the
// connection for use by other modules. The connection is a singleton
// because better-sqlite3 is synchronous and cheap to share.
//
// Migrations: schema.sql uses CREATE TABLE IF NOT EXISTS, so new columns
// on existing tables won't land on existing DBs. We run a lightweight
// `PRAGMA table_info` check + ALTER TABLE for specific known-new columns.
// This is safer than a numbered-migration system while the schema is
// small and additive.

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

let dbInstance = null;

/**
 * Initialize the database. Creates the data directory if needed, opens
 * the SQLite file, applies schema, sets pragmas, runs additive migrations.
 *
 * @param {string} dataDir - absolute path to data directory (env DLARR_DATA_DIR)
 * @returns {Database} the better-sqlite3 database instance
 */
export function initDb(dataDir) {
  if (dbInstance) {
    return dbInstance;
  }

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = resolve(dataDir, 'dlarr.db');
  const db = new Database(dbPath);

  // Performance + safety pragmas
  db.pragma('journal_mode = WAL');     // WAL mode for concurrent reads
  db.pragma('synchronous = NORMAL');   // faster than FULL, safe with WAL
  db.pragma('foreign_keys = ON');      // enforce FK constraints

  // Apply schema (idempotent — uses CREATE TABLE IF NOT EXISTS)
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);

  // Additive column migrations for existing DBs. Safe to run every boot.
  runAdditiveMigrations(db);

  dbInstance = db;
  return db;
}

/**
 * Idempotently add new columns that were introduced after the initial
 * schema was deployed. Each entry: { table, column, ddl }.
 * Each ddl must be an ALTER TABLE ADD COLUMN statement safe to run against
 * a pre-existing table (i.e. provide DEFAULT so existing rows get values).
 */
function runAdditiveMigrations(db) {
  const migrations = [
    {
      table: 'files',
      column: 'on_remote',
      ddl: `ALTER TABLE files ADD COLUMN on_remote INTEGER NOT NULL DEFAULT 0`,
    },
    {
      table: 'files',
      column: 'on_local',
      ddl: `ALTER TABLE files ADD COLUMN on_local INTEGER NOT NULL DEFAULT 0`,
    },
  ];

  for (const m of migrations) {
    const columns = db.prepare(`PRAGMA table_info(${m.table})`).all();
    if (columns.some(c => c.name === m.column)) continue;
    db.exec(m.ddl);
  }
}

/**
 * Get the current database instance. Throws if initDb() hasn't been called.
 */
export function getDb() {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return dbInstance;
}

/**
 * Close the database connection. Safe to call multiple times.
 */
export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
