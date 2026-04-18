// DLarr — arr client registry
//
// Maps arr type strings to their concrete client classes. Adding a new
// arr type in the future = add a file + register it here + add to the
// UI's type dropdown.
//
// Usage:
//   import { clientForRow } from './registry.js';
//   const client = clientForRow(arrInstanceRow);  // returns SonarrClient/etc
//   await client.testConnection();

import { SonarrClient } from './sonarr.js';
import { RadarrClient } from './radarr.js';
import { LidarrClient } from './lidarr.js';

const CLIENT_CLASSES = {
  sonarr: SonarrClient,
  radarr: RadarrClient,
  lidarr: LidarrClient,
};

/**
 * Supported arr types. Used by the UI to populate the type dropdown and
 * by env parsing (env.js ARR_TYPES) for validation.
 */
export const SUPPORTED_TYPES = Object.keys(CLIENT_CLASSES);

/**
 * Instantiate the appropriate client class from an arr_instances row.
 *
 * @param {object} row  from arr_instances table
 * @returns {ArrClient}
 * @throws if the row's type is unknown
 */
export function clientForRow(row) {
  const Cls = CLIENT_CLASSES[row.type];
  if (!Cls) {
    throw new Error(`Unknown arr type "${row.type}" for instance "${row.name}"`);
  }
  return new Cls({
    name:   row.name,
    url:    row.url,
    apiKey: row.api_key,
    dir:    row.dir,
  });
}

/**
 * Check whether a given type string is supported.
 */
export function isSupportedType(type) {
  return Object.prototype.hasOwnProperty.call(CLIENT_CLASSES, type);
}
