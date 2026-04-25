# DLarr -> DownLoadarr

LFTP based seedbox focused download client inspired by the infamous SeedSync re-written with *arr support.

## docker-compose.yml

```yaml
services:
  dlarr:
    image: ghcr.io/ofernander/dlarr:latest
    container_name: dlarr
    restart: unless-stopped
    ports:
      - "8800:8800"
    volumes:
      - ./data:/config
      - /path/on/host/downloads:/downloads
    environment:
      - TZ=UTC
      - DLARR_SSH_HOST=seedbox_address_url
      - DLARR_SSH_PORT=22
      - DLARR_SSH_USER=your_user
      - DLARR_SSH_USE_KEY=true
      # - DLARR_SSH_PASSWORD=your_password

      # - DLARR_RADARR_1_NAME=radarr-main
      # - DLARR_RADARR_1_URL=http://radarr:7878
      # - DLARR_RADARR_1_API_KEY=<api key>
      # - DLARR_RADARR_1_DIR=/movies

      # - DLARR_SONARR_1_NAME=sonarr-main
      # - DLARR_SONARR_1_URL=http://sonarr:8989
      # - DLARR_SONARR_1_API_KEY=<api key>
      # - DLARR_SONARR_1_DIR=/tv

      # - DLARR_LIDARR_1_NAME=lidarr-main
      # - DLARR_LIDARR_1_URL=http://lidarr:8686
      # - DLARR_LIDARR_1_API_KEY=<api key>
      # - DLARR_LIDARR_1_DIR=/music
```

## Configuration/ENV Variables  

### SSH settings

| Variable | Type | Default | Description |
|---|---|---|---|
| `DLARR_SSH_HOST` | string | — | Seedbox hostname or IP |
| `DLARR_SSH_PORT` | int | `22` | SSH port |
| `DLARR_SSH_USER` | string | — | SSH username |
| `DLARR_SSH_PASSWORD` | string | — | SSH password (leave unset to use key auth) |
| `DLARR_SSH_USE_KEY` | bool | `false` | Use SSH key auth instead of password |
| `DLARR_SSH_KEY_PATH` | string | — | Path to a custom private key. If unset, DLarr auto-generates one at `/config/.ssh/id_ed25519` |

### Web & logging

| Variable | Type | Default | Description |
|---|---|---|---|
| `DLARR_WEB_PORT` | int | `8800` | Port the web UI listens on |
| `DLARR_LOG_LEVEL` | enum | `info` | Log verbosity: `debug` \| `info` \| `warn` \| `error` |
| `DLARR_DATA_DIR` | string | `/config` | Where the SQLite DB and logs are stored |
| `DLARR_EVENTS_RETENTION_ROWS` | int | `10000` | Max log rows retained in the DB |

### LFTP tuning

| Variable | Type | Default | Description |
|---|---|---|---|
| `DLARR_LFTP_NUM_PARALLEL_JOBS` | int | `2` | Concurrent transfer jobs |
| `DLARR_LFTP_NUM_PARALLEL_FILES_PER_JOB` | int | `4` | Files per job in parallel |
| `DLARR_LFTP_NUM_CONNECTIONS_PER_FILE` | int | `4` | Connections per file |
| `DLARR_LFTP_NUM_CONNECTIONS_PER_DIR_FILE` | int | `4` | Connections per directory file |
| `DLARR_LFTP_MAX_TOTAL_CONNECTIONS` | int | `16` | Hard cap on total LFTP connections |
| `DLARR_LFTP_USE_TEMP_FILE` | bool | `true` | Download to a `.lftp` temp file, rename on completion |
| `DLARR_LFTP_RATE_LIMIT` | string | `0` | Bandwidth cap — `0` = unlimited, or e.g. `10M` |

### Scanner & retries

| Variable | Type | Default | Description |
|---|---|---|---|
| `DLARR_DEFAULT_SCAN_INTERVAL_SECS` | int | `30` | How often watches are scanned (seconds) |
| `DLARR_REMOTE_SCAN_SCRIPT_PATH` | string | `/tmp/dlarr_scan.py` | Where the scan script is installed on the remote |
| `DLARR_MAX_RETRIES` | int | `5` | Transfer retry attempts before marking a file failed |
| `DLARR_ARR_HEALTH_CHECK_INTERVAL_SECS` | int | `120` | How often arr reachability is checked (seconds) |
| `DLARR_ARR_NOTIFY_MAX_RETRIES` | int | `3` | Retry attempts for arr rescan notifications |

### Arr instances

Arr instances are declared with numbered env vars starting at 1, contiguous per type. All four fields are required per instance.

| Variable | Description |
|---|---|
| `DLARR_RADARR_<N>_NAME` | Display name |
| `DLARR_RADARR_<N>_URL` | Base URL (e.g. `http://radarr:7878`) |
| `DLARR_RADARR_<N>_API_KEY` | API key |
| `DLARR_RADARR_<N>_DIR` | This is your local path same as "Remote mappings in *arr instance" |

Replace `RADARR` with `SONARR` or `LIDARR` for those types. Example for two Sonarr instances:

```env
DLARR_SONARR_1_NAME=sonarr-main
DLARR_SONARR_1_URL=http://sonarr:8989
DLARR_SONARR_1_API_KEY=abc123
DLARR_SONARR_1_DIR=/tv

DLARR_SONARR_2_NAME=sonarr-anime
DLARR_SONARR_2_URL=http://sonarr-anime:8989
DLARR_SONARR_2_API_KEY=def456
DLARR_SONARR_2_DIR=/anime
```


## Remote requirements

- **Python 3.6+** on the seedbox (required for the scan script). DLarr checks this on first scan and fails with a clear error in the Logs page if it's missing or too old.
- SSH/SFTP access with either password or key auth

## License

GPL 3.0
