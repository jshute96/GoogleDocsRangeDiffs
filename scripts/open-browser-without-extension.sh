#!/usr/bin/env bash
#
# Open Playwright's bundled Chromium WITHOUT the extension loaded.
# Uses a persistent profile so Google login sessions survive across runs.
#
# Uses Playwright's Chromium (not system Chrome) so the cookie encryption
# is compatible with automated Playwright tests.
#
# Usage:
#   scripts/open-browser-without-extension.sh              # opens about:blank
#   scripts/open-browser-without-extension.sh <url>        # custom URL
#
# Prerequisites:
#   npm install
#   npx playwright install chromium

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="$PROJECT_DIR/.chrome-no-extension-profile"
URL="${1:-about:blank}"

# Find Playwright's bundled Chromium (Linux path)
CHROME=$(find ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)
if [[ -z "$CHROME" ]]; then
  echo "Error: Playwright's bundled Chromium not found." >&2
  echo "Install it with: npx playwright install chromium" >&2
  exit 1
fi

echo "Opening Chromium at $URL (no extension)"
echo "Binary:  $CHROME"
echo "Profile: $PROFILE_DIR"
echo ""

exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port=9223 \
  "$URL"
