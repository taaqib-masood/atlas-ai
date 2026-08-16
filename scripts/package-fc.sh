#!/usr/bin/env bash
# Package the app for Aliyun FC 3.0 (nodejs20 built-in runtime).
# Produces dist/atlas-fc.zip with index.js at the zip root (required by FC).
# FC note: use STORAGE=json + DATA_DIR=/tmp/atlas (no node:sqlite on nodejs20).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/atlas-fc.zip
STAGE=$(mktemp -d)
cp -R server.js index.js package.json lib public "$STAGE/"
# server.js is a local convenience; FC ignores it, but keep it for parity.
(cd "$STAGE" && zip -qr "$OLDPWD/dist/atlas-fc.zip" .)
rm -rf "$STAGE"
echo "Package: dist/atlas-fc.zip"
unzip -l dist/atlas-fc.zip | head -20
echo "Size: $(du -h dist/atlas-fc.zip | cut -f1) (limit 50 MB)"
