# ![icon](src/icons/icon-48.png) GoogleDocsDiffRange Chrome extension

This extension adds diff-between-versions functionality to Google Docs.

## Usage

1. Open a Google Doc in Chrome.
2. Open Version History: **File → Version history → See version history**
   (or press **Ctrl+Alt+Shift+H**).
3. Each version gets **From here** / **To here** buttons:
   - Click **From here** on an older version to set the start of your range.
   - Click **To here** on a newer version to set the end.
   - The diff updates to show changes across the selected range.
   - Selected endpoints highlight in solid blue; versions between them
     highlight in light blue.
4. Click **Diff full history** above the versions list to diff from the
   first revision to the newest — equivalent to **From here** on the oldest
   version and **To here** on the newest in one click.
5. Switching the dropdown (e.g., "All versions" → "Named versions") resets
   the range selection.

### Console API

From the browser console on a Google Docs page:

- `showRevisions(start, end)` — set a revision range and show the diff
- `openVersionHistory()` — open the Version History panel programmatically

## Installation

### Chrome extension

1. Clone this repo and install dependencies:
   ```bash
   git clone https://github.com/jshute96/GoogleDocsDiffRange.git
   cd GoogleDocsDiffRange
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. In Chrome: open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, and select the `dist/` directory.

## Development setup

```bash
npm install
npx playwright install chromium
```

## Building

```bash
npm run build        # one-shot build into dist/
npm run watch        # rebuild on TS changes
```

## Testing

Tests run against real Google Docs with a logged-in user.

### Setup

1. Build the extension: `npm run build`
2. Open browsers and log in to Google (sessions persist across runs):
   ```bash
   scripts/open-browser-with-extension.sh https://docs.google.com
   scripts/open-browser-without-extension.sh https://docs.google.com
   ```
3. Keep the browsers open — tests connect to them via CDP.

### Running tests

With both browsers open and logged in:

```bash
npm test                     # all tests (extension + no-extension in parallel)
npm run test:extension       # only tests with the extension loaded
npm run test:no-extension    # only tests without the extension (baseline)
```

### Interactive browser scripts

```bash
scripts/open-browser-with-extension.sh [url]      # Playwright Chromium + extension (port 9222)
scripts/open-browser-without-extension.sh [url]   # Playwright Chromium, no extension (port 9223)
```

Both use persistent profiles so Google login survives across runs.
Tests connect to these browsers via Chrome DevTools Protocol.

## Layout

- `src/` — Extension source (TypeScript) and `manifest.json`
- `dist/` — built extension (gitignored, loaded unpacked into Chrome)
- `scripts/` — build script, browser-opening scripts, inspection tools
- `testing/` — Playwright test suites (extension and no-extension)
- `docs/` — design docs
- `docs/file-index.md` — description of all files in the project
