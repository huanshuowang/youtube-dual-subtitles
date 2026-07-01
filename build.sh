#!/usr/bin/env bash
# Build a minimal zip for release. Only the files Chrome actually needs plus
# LICENSE and README. Skips docs/, .gitignore, and anything under .git/.
set -euo pipefail

cd "$(dirname "$0")"

OUT_NAME="youtube-dual-subtitles"
STAGE_DIR="dist/${OUT_NAME}"
ZIP_PATH="dist/${OUT_NAME}.zip"

VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' manifest.json \
  | sed 's/.*"\([^"]*\)"$/\1/')
echo "Building ${OUT_NAME} v${VERSION}"

rm -rf dist
mkdir -p "${STAGE_DIR}/icons"

cp manifest.json content.js inject.js overlay.css popup.html popup.js LICENSE README.md \
   "${STAGE_DIR}/"
cp icons/icon16.png icons/icon48.png icons/icon128.png "${STAGE_DIR}/icons/"

( cd dist && zip -r -q "${OUT_NAME}.zip" "${OUT_NAME}" )
rm -rf "${STAGE_DIR}"

SIZE=$(du -h "${ZIP_PATH}" | cut -f1)
echo "Wrote ${ZIP_PATH} (${SIZE})"
