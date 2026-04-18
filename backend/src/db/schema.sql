-- DLarr SQLite schema
-- Applied idempotently on boot via CREATE TABLE IF NOT EXISTS.
-- Schema changes that require data transformation belong in migrations/.

-- Enable foreign key enforcement (off by default in SQLite)
PRAGMA foreign_keys = ON;

-- ============================================================
-- settings: key/value config store with env-lock flag (Pattern B)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  env_locked  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- watches: remote directories DLarr polls and syncs from
-- ============================================================
CREATE TABLE IF NOT EXISTS watches (
  id                                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                                 TEXT    NOT NULL UNIQUE,
  remote_path                          TEXT    NOT NULL,
  local_path                           TEXT    NOT NULL,
  scan_interval                        INTEGER,
  enabled                              INTEGER NOT NULL DEFAULT 1,
  auto_delete_remote_on_local_missing  INTEGER NOT NULL DEFAULT 0,
  missing_scan_threshold               INTEGER NOT NULL DEFAULT 3,
  created_at                           TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- patterns: include/exclude rules for auto-queueing
-- watch_id NULL = global pattern applied to all watches
-- ============================================================
CREATE TABLE IF NOT EXISTS patterns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id    INTEGER,
  kind        TEXT    NOT NULL CHECK (kind IN ('include', 'exclude')),
  pattern     TEXT    NOT NULL,
  action      TEXT    CHECK (action IS NULL OR action IN ('queue', 'ignore', 'delete_remote')),
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (watch_id) REFERENCES watches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_patterns_watch ON patterns(watch_id);

-- ============================================================
-- arr_instances: registered arr apps (Sonarr/Radarr/Lidarr/...)
-- ============================================================
CREATE TABLE IF NOT EXISTS arr_instances (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL UNIQUE,
  type             TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  api_key          TEXT    NOT NULL,
  dir              TEXT    NOT NULL,
  env_locked       INTEGER NOT NULL DEFAULT 0,
  last_status      TEXT    NOT NULL DEFAULT 'unknown' CHECK (last_status IN ('ok', 'unreachable', 'auth_failed', 'unknown')),
  last_status_msg  TEXT,
  last_check_at    TEXT,
  created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- watch_arr_notifications: per-watch opt-in for arr notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS watch_arr_notifications (
  watch_id         INTEGER NOT NULL,
  arr_instance_id  INTEGER NOT NULL,
  PRIMARY KEY (watch_id, arr_instance_id),
  FOREIGN KEY (watch_id)        REFERENCES watches(id)       ON DELETE CASCADE,
  FOREIGN KEY (arr_instance_id) REFERENCES arr_instances(id) ON DELETE CASCADE
);

-- ============================================================
-- files: tracked remote files and their local state
--
-- State model:
--   - `state` column tracks DLarr's workflow state (what it's doing/did).
--   - `on_remote` / `on_local` are presence bits refreshed every scan
--     (where does the file physically exist *right now*).
--   - `deleted_remote` / `deleted_local` remain in the CHECK constraint
--     for backward compatibility with existing data, but are not written
--     by any current code path. Presence bits replace them.
-- ============================================================
CREATE TABLE IF NOT EXISTS files (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id                   INTEGER NOT NULL,
  remote_path                TEXT    NOT NULL,
  local_path                 TEXT    NOT NULL,
  is_dir                     INTEGER NOT NULL DEFAULT 0,
  remote_size                INTEGER,
  local_size                 INTEGER,
  on_remote                  INTEGER NOT NULL DEFAULT 0,
  on_local                   INTEGER NOT NULL DEFAULT 0,
  state                      TEXT    NOT NULL DEFAULT 'seen' CHECK (state IN (
                                 'seen', 'queued', 'downloading', 'downloaded',
                                 'ignored', 'deleted_local', 'deleted_remote',
                                 'error', 'dismissed'
                             )),
  remote_modified_at         TEXT,
  first_seen_at              TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_state_change_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  downloaded_at              TEXT,
  matched_pattern_id         INTEGER,
  retry_count                INTEGER NOT NULL DEFAULT 0,
  last_error_reason          TEXT,
  last_error_message         TEXT,
  consecutive_missing_scans  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(watch_id, remote_path),
  FOREIGN KEY (watch_id)           REFERENCES watches(id)  ON DELETE CASCADE,
  FOREIGN KEY (matched_pattern_id) REFERENCES patterns(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_files_watch_state ON files(watch_id, state);
CREATE INDEX IF NOT EXISTS idx_files_state       ON files(state);

-- ============================================================
-- arr_notifications: history of notify attempts for debugging
-- ============================================================
CREATE TABLE IF NOT EXISTS arr_notifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id          INTEGER NOT NULL,
  arr_instance_id  INTEGER NOT NULL,
  attempted_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  succeeded        INTEGER NOT NULL DEFAULT 0,
  attempt_count    INTEGER NOT NULL DEFAULT 1,
  error_message    TEXT,
  FOREIGN KEY (file_id)         REFERENCES files(id)         ON DELETE CASCADE,
  FOREIGN KEY (arr_instance_id) REFERENCES arr_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_arr_notifications_file ON arr_notifications(file_id);

-- ============================================================
-- events: log event table (UI-facing log stream + debugging)
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  level      TEXT    NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  watch_id   INTEGER,
  file_id    INTEGER,
  arr_id     INTEGER,
  message    TEXT    NOT NULL,
  FOREIGN KEY (watch_id) REFERENCES watches(id)       ON DELETE SET NULL,
  FOREIGN KEY (file_id)  REFERENCES files(id)         ON DELETE SET NULL,
  FOREIGN KEY (arr_id)   REFERENCES arr_instances(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
