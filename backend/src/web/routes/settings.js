// DLarr — /api/settings routes
//
// GET  /api/settings        → list with metadata (env-locked flag)
// PATCH /api/settings/:key  → update; 409 if env_locked
//
// SSH password is never returned to the UI (response field appears but value
// is always masked). The UI treats this as a write-only field.

import { readFileSync, existsSync } from 'node:fs';
import { getAllWithMeta, set as setSetting, get as getSetting } from '../../config/settings.js';
import { publishSettingsUpdate } from '../events.js';
import { defaultKeyPath } from '../../remote/keygen.js';

const SECRET_KEYS = new Set(['SSH_PASSWORD']);

function maskSecrets(list) {
  return list.map(row => {
    if (SECRET_KEYS.has(row.key)) {
      return { ...row, value: row.value ? '***' : '' };
    }
    return row;
  });
}

export default async function settingsRoutes(fastify) {
  fastify.get('/api/settings', async () => {
    return { settings: maskSecrets(getAllWithMeta()) };
  });

  fastify.patch('/api/settings/:key', async (req, reply) => {
    const { key } = req.params;
    const body = req.body ?? {};

    if (!('value' in body)) {
      return reply.code(400).send({ error: 'Request body must contain "value"' });
    }

    try {
      setSetting(key, body.value);
    } catch (err) {
      if (err.code === 'ENV_LOCKED') {
        return reply.code(409).send({
          error: 'env_locked',
          message: err.message,
        });
      }
      throw err;
    }

    publishSettingsUpdate({ key });

    return { ok: true, key };
  });

  fastify.get('/api/ssh-public-key', async () => {
    const userKeyPath = getSetting('SSH_KEY_PATH');
    if (userKeyPath) return { publicKey: null };
    const dataDir = getSetting('DATA_DIR');
    const pubPath = defaultKeyPath(dataDir) + '.pub';
    if (!existsSync(pubPath)) return { publicKey: null };
    return { publicKey: readFileSync(pubPath, 'utf8').trim() };
  });
}
