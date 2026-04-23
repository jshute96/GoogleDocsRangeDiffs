#!/usr/bin/env bash
#
# Open a labeled "Port NNNN" tab in every running Chrome/Chromium that was
# launched with --remote-debugging-port=<port>, so you can visually tell
# overlapping browsers apart.
#
# Usage:
#   scripts/display-browser-ports.sh
#
# Prerequisites:
#   npm install   # Playwright is used to drive each browser over CDP

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Discover debugging ports from process cmdlines. Covers the "=" form
# Chrome/Chromium actually uses; ephemeral "=0" ports won't be found here
# (use .../DevToolsActivePort for those).
mapfile -t PORTS < <(
  pgrep -af 'remote-debugging-port=' \
    | grep -oP 'remote-debugging-port=\K\d+' \
    | sort -un
)

if [[ ${#PORTS[@]} -eq 0 ]]; then
  echo "No Chrome instances with --remote-debugging-port=<port> found." >&2
  exit 1
fi

echo "Found ports: ${PORTS[*]}"

# Join with commas for the Node child. (Avoids quoting surprises vs. argv.)
PORTS_CSV="${PORTS[*]}"
PORTS_CSV="${PORTS_CSV// /,}"

cd "$PROJECT_DIR"
PORTS="$PORTS_CSV" node --input-type=module -e '
import { chromium } from "playwright";

const ports = process.env.PORTS.split(",").map(Number);
for (const port of ports) {
  try {
    const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    const html =
      "<!doctype html><title>Port " + port + "</title>" +
      "<h1>Remote debugging port: " + port + "</h1>";
    await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html));
    console.log("Labeled port " + port);
  } catch (e) {
    console.error("Failed for port " + port + ": " + e.message);
  }
}
// Exit explicitly; do not call browser.close() (see
// docs/notes-on-ui-debugging.md on leaving the users session alone).
process.exit(0);
'
