# GoogleDocsDiffRange Chrome extension

This extension adds diff-between-versions functionality to Google Docs.

## Usage

1. Open a Google Doc in Chrome.
2. Open Version History: **File → Version history → See version history**
   (or press **Ctrl+Alt+Shift+H**).
3. The extension adds **Start revision** / **End revision** fields and a
   **View diff** button above the versions list.
4. Each version gets **From here** / **To here** buttons:
   - Click **From here** on an older version to set the start of your range.
   - Click **To here** on a newer version to set the end.
   - The diff updates to show changes across the selected range.
   - Selected endpoints highlight in solid blue; versions between them
     highlight in light blue.
5. You can also type revision numbers directly into the text fields and
   click **View diff**.
6. Switching the dropdown (e.g., "All versions" → "Named versions") resets
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

```bash
npm test             # run Playwright e2e tests
npm run test:headed  # same, with a visible browser
```

## Layout

- `src/` — Extension source (TypeScript + plain JS) and `manifest.json`
- `dist/` — built extension (gitignored, loaded unpacked into Chrome)
- `scripts/build.mjs` — build script (cleans `dist/`, copies icons and
  manifest, runs `tsc`)
- `tests/e2e/` — Playwright tests
- `tests/fixtures/extension.ts` — fixture that loads the extension and
  exposes its service worker
- `docs/` — design docs and the file index
