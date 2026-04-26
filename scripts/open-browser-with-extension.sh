#!/usr/bin/env bash
#
# Open a browser with the GoogleDocsRangeDiffs extension loaded.
# Uses Playwright's bundled Chromium (system Chrome dropped --load-extension).
#
# The browser uses a persistent profile so Google login sessions survive
# across runs. Log in once, then reuse the session for manual testing.
#
# Usage:
#   scripts/open-browser-with-extension.sh              # opens about:blank
#   scripts/open-browser-with-extension.sh <url>        # custom URL
#
# Prerequisites:
#   npm install
#   npx playwright install chromium
#   npm run build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="$PROJECT_DIR/.chrome-extension-profile"
EXTENSION_DIR="$PROJECT_DIR/dist"
URL="${1:-about:blank}"

# Ensure the extension is built
if [[ ! -d "$EXTENSION_DIR" || ! -f "$EXTENSION_DIR/manifest.json" ]]; then
  echo "Extension not built. Run: npm run build" >&2
  exit 1
fi

# Find Playwright's bundled Chromium
CHROME=$(find ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)
if [[ -z "$CHROME" ]]; then
  echo "Error: Playwright's bundled Chromium not found." >&2
  echo "Install it with: npx playwright install chromium" >&2
  exit 1
fi

echo "Opening Chromium with extension at $URL"
echo "Binary:    $CHROME"
echo "Profile:   $PROFILE_DIR"
echo "Extension: $EXTENSION_DIR"
echo ""

exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port=9222 \
  --disable-extensions-except="$EXTENSION_DIR" \
  --load-extension="$EXTENSION_DIR" \
  "$URL"
