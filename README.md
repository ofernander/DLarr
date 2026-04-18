# DLarr

Fast, LFTP-driven, one-way remote-to-local file sync with a web UI, pattern-based auto-queueing, multi-watch support, and native Sonarr / Radarr / Lidarr integration. Built for pulling from seedboxes to local media servers.

## Quick start

```bash
# Clone
git clone <repo> dlarr && cd dlarr

# Copy the compose example and edit it
cp docker-compose.example.yml docker-compose.yml
$EDITOR docker-compose.yml

# Build and run
docker compose up -d --build

# Open the UI
open http://localhost:8800
```

On first launch, DLarr boots with no watches and no arrs. Configure SSH credentials in **Settings** (or via env vars — see `docker-compose.example.yml`), then add a watch in **Watches**.

## Configuration

Two layers:
- **Environment variables** (prefix `DLARR_`) — seed and *lock* UI fields. See `docker-compose.example.yml` for the full list.
- **UI** — everything env-configurable plus watches, patterns, and per-watch arr-notification mappings.

Env-locked fields are shown disabled in the UI with a lock marker. To change them, edit env and restart.

## Architecture

- Node.js 22 + Fastify + better-sqlite3
- Long-lived LFTP subprocess for transfers, controlled via stdin with a UUID-sentinel output-framing scheme
- SSH / SFTP via `ssh2` for remote scans, the scan script install, and remote deletes
- Server-Sent Events for live UI updates
- Vanilla HTML / CSS / JS frontend (no framework, no build step)
- Python 3 scan script scp'd to the remote on first scan, md5-checked thereafter

See `docs/design.md` for the full design spec.

## Data & logs

- `/config` (Docker volume) holds the SQLite DB at `dlarr.db` and rotating log files in `logs/dlarr.log` (10 MB × 5 backups). The web UI's Logs page tails the live stream via SSE.

## Limitations (v1)

- One-way pull only. No bidirectional sync, no upload.
- No authentication. Run behind a trusted reverse proxy or on a private network.
- No archive extraction.
- No per-watch bandwidth sub-pools (global LFTP pool only).

## Remote requirements

- **Python 3.6+** on the seedbox (required for the scan script). DLarr checks this on first scan and fails with a clear error in the Logs page if it's missing or too old.
- SSH/SFTP access with either password or key auth

## License

Apache-2.0.
