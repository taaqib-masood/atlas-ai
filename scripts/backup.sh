#!/usr/bin/env bash
# Hot backup: WAL-checkpoint the SQLite DB, then copy. Also copies app.json in JSON mode.
# Usage: bash scripts/backup.sh   -> backups/app-<timestamp>.db(.json)
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${DATA_DIR:-./data}"
mkdir -p backups
TS=$(date +%Y%m%d-%H%M%S)

if [ -f "$DATA/app.db" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DATA/app.db" "PRAGMA wal_checkpoint(TRUNCATE);"
  else
    node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();" "$DATA/app.db"
  fi
  cp "$DATA/app.db" "backups/app-$TS.db"
  echo "SQLite backup written: backups/app-$TS.db"
fi
if [ -f "$DATA/app.json" ]; then
  cp "$DATA/app.json" "backups/app-$TS.json"
  echo "JSON backup written: backups/app-$TS.json"
fi
[ -z "$(ls -A backups 2>/dev/null)" ] && echo "No data files found yet — nothing to back up." || { echo "Latest backups:"; ls -1t backups | head -5; }
