// DLarr — /api/version route
//
// Exposes version + repository URL from package.json so the frontend
// can render them without a build step.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = resolve(__dirname, '../../../../package.json');

let cached = null;
function loadPackage() {
  if (cached) return cached;
  try {
    const raw = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
    const pkg = JSON.parse(raw);
    cached = {
      version:    pkg.version ?? 'unknown',
      repository: typeof pkg.repository === 'string'
        ? pkg.repository
        : pkg.repository?.url ?? null,
    };
  } catch {
    cached = { version: 'unknown', repository: null };
  }
  return cached;
}

export default async function versionRoutes(fastify) {
  fastify.get('/api/version', async () => loadPackage());
}
