#!/usr/bin/env bash
# Restore a database backup. Stops the running server, replaces data/, restarts hint.
# Usage: bash scripts/restore.sh backups/app-20260811-020000.db
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${DATA_DIR:-./data}"
BACKUP="${1:-}"
if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
  echo "Usage: bash scripts/restore.sh <backup-file>" >&2
  echo "Available backups:" >&2
  ls -1 backups 2>/dev/null | head -10 || true
  exit 1
fi

echo "Stopping running server (if any)…"
pkill -f "node server.js" 2>/dev/null || true
sleep 1

mkdir -p "$DATA"
case "$BACKUP" in
  *.json)
    cp "$BACKUP" "$DATA/app.json"
    rm -f "$DATA/app.db" "$DATA/app.db-wal" "$DATA/app.db-shm"
    echo "Restored JSON store from $BACKUP"
    ;;
  *.db)
    cp "$BACKUP" "$DATA/app.db"
    rm -f "$DATA/app.db-wal" "$DATA/app.db-shm"
    echo "Restored SQLite store from $BACKUP"
    ;;
  *)
    echo "Unrecognized backup extension (expected .db or .json)" >&2
    exit 1
    ;;
esac

echo "Start the app with:  node server.js   (or: systemctl start atlas-ai)"
echo "Verify: curl -s localhost:3000/healthz"
