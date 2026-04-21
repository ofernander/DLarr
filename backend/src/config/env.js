// DLarr — environment variable parsing
//
// Parses every DLARR_* env var defined in design §5. Returns a structured
// object separating individual settings from indexed arr instances. Does
// NOT write to the database — that's the settings module's job.
//
// Parsing is strict: values that don't fit their type produce warnings and
// fall back to the default (or undefined, which the caller treats as
// "not set, use DB/default"). Indexed arr instances with missing required
// fields are rejected outright.

/**
 * Known scalar env vars with their types and defaults.
 * Default of `undefined` means "unset, use DB value or built-in default".
 */
const SETTINGS_SCHEMA = {
  // Infrastructure
  SSH_HOST:              { type: 'string',  default: undefined },
  SSH_PORT:              { type: 'int',     default: 22 },
  SSH_USER:              { type: 'string',  default: undefined },
  SSH_PASSWORD:          { type: 'string',  default: undefined },
  SSH_KEY_PATH:          { type: 'string',  default: undefined },
  SSH_USE_KEY:           { type: 'bool',    default: false },
  WEB_PORT:              { type: 'int',     default: 8800 },
  LOG_LEVEL:             { type: 'enum',    default: 'info', values: ['debug', 'info', 'warn', 'error'] },
  DATA_DIR:              { type: 'string',  default: '/config' },

  // LFTP tuning
  LFTP_NUM_PARALLEL_JOBS:              { type: 'int',  default: 2 },
  LFTP_NUM_PARALLEL_FILES_PER_JOB:     { type: 'int',  default: 4 },
  LFTP_NUM_CONNECTIONS_PER_FILE:       { type: 'int',  default: 4 },
  LFTP_NUM_CONNECTIONS_PER_DIR_FILE:   { type: 'int',  default: 4 },
  LFTP_MAX_TOTAL_CONNECTIONS:          { type: 'int',  default: 16 },
  LFTP_USE_TEMP_FILE:                  { type: 'bool', default: true },
  LFTP_RATE_LIMIT:                     { type: 'string', default: '0' },

  // Scanner & retry
  DEFAULT_SCAN_INTERVAL_SECS:       { type: 'int',    default: 30 },
  REMOTE_SCAN_SCRIPT_PATH:          { type: 'string', default: '/tmp/dlarr_scan.py' },
  MAX_RETRIES:                      { type: 'int',    default: 5 },
  ARR_HEALTH_CHECK_INTERVAL_SECS:   { type: 'int',    default: 120 },
  ARR_NOTIFY_MAX_RETRIES:           { type: 'int',    default: 3 },

  // Log retention
  EVENTS_RETENTION_ROWS:            { type: 'int',    default: 10000 },
};

const ARR_TYPES = ['RADARR', 'SONARR', 'LIDARR'];
const ARR_FIELDS = ['NAME', 'URL', 'API_KEY', 'DIR'];

// Collect warnings during parse; caller logs them after logger is ready
const parseWarnings = [];

function warn(msg) {
  parseWarnings.push(msg);
}

function parseBool(raw) {
  const v = String(raw).toLowerCase().trim();
  if (['true', '1', 'yes', 'on'].includes(v))  return true;
  if (['false', '0', 'no', 'off', ''].includes(v)) return false;
  return null; // signal bad value
}

function parseInt10(raw) {
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function parseValue(key, raw, schema) {
  switch (schema.type) {
    case 'string':
      return raw;

    case 'int': {
      const n = parseInt10(raw);
      if (n === null) {
        warn(`DLARR_${key}="${raw}" is not a valid integer; using default ${schema.default}`);
        return schema.default;
      }
      return n;
    }

    case 'bool': {
      const b = parseBool(raw);
      if (b === null) {
        warn(`DLARR_${key}="${raw}" is not a valid boolean; using default ${schema.default}`);
        return schema.default;
      }
      return b;
    }

    case 'enum': {
      if (!schema.values.includes(raw)) {
        warn(`DLARR_${key}="${raw}" must be one of ${schema.values.join('|')}; using default ${schema.default}`);
        return schema.default;
      }
      return raw;
    }

    default:
      return raw;
  }
}

/**
 * Parse scalar settings from the environment.
 * Returns a flat object { KEY: value } including only keys that were actually
 * set in env (so callers can distinguish "env_locked" from "use default").
 */
function parseSettingsFromEnv(env) {
  const out = {};
  for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
    const envKey = `DLARR_${key}`;
    const raw = env[envKey];
    if (raw === undefined || raw === '') continue;
    out[key] = parseValue(key, raw, schema);
  }
  return out;
}

/**
 * Parse indexed arr instances from the environment.
 * Scans DLARR_<TYPE>_<N>_<FIELD> patterns, with N starting at 1 and
 * required to be contiguous. On a gap, stops scanning that type with
 * a warning. Incomplete instances (missing any required field) are rejected.
 *
 * Returns an array of { type, index, name, url, apiKey, dir } objects.
 */
function parseArrsFromEnv(env) {
  const instances = [];
  const seenNames = new Set();

  for (const type of ARR_TYPES) {
    let i = 1;
    while (true) {
      // Check if ANY field for this index exists
      const rawByField = {};
      let anyPresent = false;
      for (const field of ARR_FIELDS) {
        const envKey = `DLARR_${type}_${i}_${field}`;
        const v = env[envKey];
        if (v !== undefined && v !== '') {
          rawByField[field] = v;
          anyPresent = true;
        }
      }

      if (!anyPresent) {
        // No fields present at this index — contiguous scan ends here
        break;
      }

      // Validate completeness
      const missing = ARR_FIELDS.filter(f => !(f in rawByField));
      if (missing.length > 0) {
        warn(`DLARR_${type}_${i}_* instance incomplete: missing ${missing.join(', ')}; instance rejected`);
        i++;
        continue;
      }

      // Validate name uniqueness
      const name = rawByField.NAME;
      if (seenNames.has(name)) {
        warn(`DLARR_${type}_${i}_NAME="${name}" duplicates another arr name; instance rejected`);
        i++;
        continue;
      }
      seenNames.add(name);

      instances.push({
        type:   type.toLowerCase(),
        index:  i,
        name,
        url:    rawByField.URL,
        apiKey: rawByField.API_KEY,
        dir:    rawByField.DIR,
      });

      i++;
    }
  }

  return instances;
}

/**
 * Apply built-in defaults for scalar settings not present in env.
 * Returns a complete settings object (every SETTINGS_SCHEMA key populated).
 */
function applyDefaults(envSettings) {
  const out = {};
  for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
    if (key in envSettings) {
      out[key] = envSettings[key];
    } else if (schema.default !== undefined) {
      out[key] = schema.default;
    }
  }
  return out;
}

/**
 * Main entry point. Parses the full DLARR_* environment and returns:
 *   {
 *     settings:        merged values (env overrides + defaults),
 *     envSettingKeys:  keys that came from env (these become env_locked),
 *     arrInstances:    array of parsed arr configs,
 *     warnings:        any parse-time warnings to log,
 *   }
 *
 * @param {NodeJS.ProcessEnv} env - usually process.env
 */
export function parseEnv(env = process.env) {
  parseWarnings.length = 0; // reset between calls

  const envSettings   = parseSettingsFromEnv(env);
  const envSettingKeys = Object.keys(envSettings);
  const settings      = applyDefaults(envSettings);
  const arrInstances  = parseArrsFromEnv(env);

  return {
    settings,
    envSettingKeys,
    arrInstances,
    warnings: [...parseWarnings],
  };
}

// Exported for tests and for callers that need schema introspection
export { SETTINGS_SCHEMA, ARR_TYPES, ARR_FIELDS };
