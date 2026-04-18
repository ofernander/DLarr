// DLarr — Lidarr client (v1 API)
//
// https://lidarr.audio/docs/api/
// Relevant endpoints:
//   GET  /api/v1/system/status       health check + version string
//   POST /api/v1/command              { name: 'DownloadedAlbumsScan', path: '<dir>' }

import { ArrClient } from './base.js';

export class LidarrClient extends ArrClient {
  get type()        { return 'lidarr'; }
  get apiVersion()  { return 'v1'; }
  get scanCommand() { return 'DownloadedAlbumsScan'; }
}
