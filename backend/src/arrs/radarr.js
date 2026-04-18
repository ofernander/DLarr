// DLarr — Radarr client (v3 API)
//
// https://radarr.video/docs/api/
// Relevant endpoints:
//   GET  /api/v3/system/status       health check + version string
//   POST /api/v3/command              { name: 'DownloadedMoviesScan', path: '<dir>' }

import { ArrClient } from './base.js';

export class RadarrClient extends ArrClient {
  get type()        { return 'radarr'; }
  get apiVersion()  { return 'v3'; }
  get scanCommand() { return 'DownloadedMoviesScan'; }
}
