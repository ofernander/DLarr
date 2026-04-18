# DLarr — Dockerfile
#
# Single-stage for simplicity. Node 22 bookworm-slim base. Installs:
#   - lftp        — the transfer engine
#   - openssh-client — for SSH/SFTP
#   - python3     — to execute the remote scanner (runs on the REMOTE, not here,
#                   but we bundle python3 locally too in case anyone wants to
#                   invoke dlarr_scan.py manually for debugging)
#   - ca-certificates — for HTTPS to arrs
#   - build-essential + python3-dev — better-sqlite3 needs these to compile
#
# better-sqlite3 requires native compilation on install. build-essential +
# python3-dev provide gcc + headers. We could use a multi-stage build to
# drop them from the final image, but that complicates the lftp + ssh
# requirement. For a self-hosted tool the extra ~200MB is a non-issue.
#
# Entry: node backend/src/index.js
# Default env: DLARR_DATA_DIR=/config, DLARR_WEB_PORT=8800

FROM node:22-bookworm-slim

# Runtime + build deps in one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
      lftp \
      openssh-client \
      python3 \
      ca-certificates \
      build-essential \
      python3-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install JS deps. Copy package.json first so npm install is cached when
# only source changes. package.json lives at the repo root.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy app source (backend + remote script + frontend)
COPY backend/  ./backend/
COPY remote/   ./remote/
COPY frontend/ ./frontend/

ENV DLARR_DATA_DIR=/config \
    DLARR_WEB_PORT=8800 \
    NODE_ENV=production

VOLUME ["/config"]
EXPOSE 8800

# Use exec form so SIGTERM reaches Node directly, not via a shell.
CMD ["node", "backend/src/index.js"]
