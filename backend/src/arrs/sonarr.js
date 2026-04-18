// DLarr — Sonarr client (v3 API)
//
// https://sonarr.tv/docs/api/
// Relevant endpoints:
//   GET  /api/v3/system/status       health check + version string
//   POST /api/v3/command              { name: 'DownloadedEpisodesScan', path: '<dir>' }

import { ArrClient } from './base.js';

export class SonarrClient extends ArrClient {
  get type()        { return 'sonarr'; }
  get apiVersion()  { return 'v3'; }
  get scanCommand() { return 'DownloadedEpisodesScan'; }
}
