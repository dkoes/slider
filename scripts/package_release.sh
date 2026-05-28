#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/package_release.sh <scp-destination> <public-base-url>

Example:
  scripts/package_release.sh user@bits.csb.pitt.edu:/var/www/html/slider_updates https://bits.csb.pitt.edu/slider_updates

Environment overrides:
  PYINSTALLER   PyInstaller command to run. Default: pyinstaller
  EXE_NAME      Base executable name. Default: slider
  RELEASE_DIR   Local release artifact directory. Default: release
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -ne 2 ]]; then
  usage
  exit $([[ $# -eq 2 ]] && echo 0 || echo 1)
fi

SCP_DESTINATION="$1"
PUBLIC_BASE_URL="${2%/}"
PYINSTALLER="${PYINSTALLER:-pyinstaller}"
EXE_NAME="${EXE_NAME:-slider}"
RELEASE_DIR="${RELEASE_DIR:-release}"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required." >&2
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required." >&2
  exit 1
fi

if ! command -v scp >/dev/null 2>&1; then
  echo "scp is required." >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
ARTIFACT_NAME="${EXE_NAME}-${VERSION}.exe"
ARTIFACT_PATH="${RELEASE_DIR}/${ARTIFACT_NAME}"
MANIFEST_PATH="${RELEASE_DIR}/latest.json"

echo "Building embedded slider assets..."
npm run build

echo "Packaging ${EXE_NAME}.exe with PyInstaller..."
"${PYINSTALLER}" --noconfirm --clean --onefile --name "${EXE_NAME}" build/slider_agent.py

mkdir -p "${RELEASE_DIR}"
cp "dist/${EXE_NAME}.exe" "${ARTIFACT_PATH}"

SHA256="$(sha256sum "${ARTIFACT_PATH}" | awk '{print $1}')"
DOWNLOAD_URL="${PUBLIC_BASE_URL}/${ARTIFACT_NAME}"

node -e '
const fs = require("fs");
const [manifestPath, version, url, sha256] = process.argv.slice(1);
fs.writeFileSync(manifestPath, JSON.stringify({ version, url, sha256 }, null, 2) + "\n");
' "${MANIFEST_PATH}" "${VERSION}" "${DOWNLOAD_URL}" "${SHA256}"

echo "Release artifact: ${ARTIFACT_PATH}"
echo "Manifest: ${MANIFEST_PATH}"
echo "Uploading to ${SCP_DESTINATION}..."
scp "${ARTIFACT_PATH}" "${MANIFEST_PATH}" "${SCP_DESTINATION}/"

echo "Uploaded ${ARTIFACT_NAME} and latest.json."
