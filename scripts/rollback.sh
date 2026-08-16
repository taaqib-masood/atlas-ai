#!/usr/bin/env bash
# Rollback: restore a known-good database AND (optionally) a previous release tag.
# Usage: bash scripts/rollback.sh [git-tag] [backup-file]
#   - code-only rollback:  bash scripts/rollback.sh v1.2.0
#   - data + code rollback: bash scripts/rollback.sh v1.2.0 backups/app-20260811-020000.db
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-}"
BACKUP="${2:-}"

if [ -n "$BACKUP" ]; then
  bash scripts/restore.sh "$BACKUP"
else
  echo "No backup file given — skipping data restore (code-only rollback)."
fi

if [ -n "$TAG" ]; then
  git tag -l | grep -qx "$TAG" || { echo "Tag '$TAG' not found. Existing tags:" >&2; git tag -l >&2; exit 1; }
  echo "Checking out $TAG… (stash any uncommitted changes first: git stash)"
  git checkout "$TAG"
fi

echo "Restarting…"
pkill -f "node server.js" 2>/dev/null || true
sleep 1
nohup node server.js > data/server.log 2>&1 &
sleep 2
curl -s localhost:3000/healthz && echo && echo "Rollback complete. Verify a category page, a tool page, and a login round-trip."
