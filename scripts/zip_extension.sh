#!/bin/bash

# Make a zip file for distributing the extension.
#
# Default output:           /tmp/GoogleDocsRangeDiffs.zip
# With --release VERSION:   /tmp/GoogleDocsRangeDiffs-vVERSION.zip
#
# The versioned name is used by scripts/release.sh so downloaded release
# artifacts are self-identifying.

set -e

usage() {
  cat <<EOF
Usage: scripts/zip_extension.sh [--release VERSION] [--help]

Builds the extension and zips dist/ for distribution.

Options:
  --release VERSION   Tag the zip with VERSION
                      (/tmp/GoogleDocsRangeDiffs-vVERSION.zip).
                      Default is /tmp/GoogleDocsRangeDiffs.zip.
  --help              Show this help and exit.
EOF
}

VERSION=""
case "${1:-}" in
  "")          ;;
  --release)
    if [[ -z "${2:-}" ]]; then
      echo "--release requires a VERSION argument" >&2
      usage >&2
      exit 2
    fi
    VERSION="$2"
    ;;
  -h|--help)   usage; exit 0 ;;
  *)           echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

if [[ -n "$VERSION" ]]; then
  TARGET="/tmp/GoogleDocsRangeDiffs-v${VERSION}.zip"
else
  TARGET="/tmp/GoogleDocsRangeDiffs.zip"
fi

npm run build

rm -f "$TARGET"
cd dist && zip -r "$TARGET" .

echo
echo "Made zip file in $TARGET"
