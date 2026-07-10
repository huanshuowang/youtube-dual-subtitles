#!/usr/bin/env bash
# Build a minimal zip for release. Only include files Chrome needs to run the
# extension after the user unzips it and loads the folder.
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

cp manifest.json content.js inject.js i18n.js overlay.css popup.html popup.js \
   "${STAGE_DIR}/"
cp icons/icon16.png icons/icon48.png icons/icon128.png "${STAGE_DIR}/icons/"
cp -R _locales "${STAGE_DIR}/_locales"

( cd dist && zip -r -q "${OUT_NAME}.zip" "${OUT_NAME}" )

# Chrome Web Store upload: same files, but manifest.json must sit at the
# zip root (no wrapping folder).
UPLOAD_ZIP="dist/${OUT_NAME}-upload.zip"
( cd "${STAGE_DIR}" && zip -r -q "../${OUT_NAME}-upload.zip" . )
rm -rf "${STAGE_DIR}"

SIZE=$(du -h "${ZIP_PATH}" | cut -f1)
echo "Wrote ${ZIP_PATH} (${SIZE})"
SIZE=$(du -h "${UPLOAD_ZIP}" | cut -f1)
echo "Wrote ${UPLOAD_ZIP} (${SIZE})"
