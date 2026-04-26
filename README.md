# ![icon](src/icons/icon-48.png) Google Docs Range Diffs Chrome extension

This extension improves the version history UI in Google Docs, adding
UI for diffs between a range of versions, and some other improvements.

## Usage

### Getting to Version history

1. Open a Google Doc in Chrome.
2. Open Version history in one of three ways:
   - Click the Version history icon ![icon](docs/images/docs-history-default.png) in the upper right corner.
     - If there are new changes, the icon shows ![icon](docs/images/docs-history-with-new.png).
       This opens a page with a diff of changes since you last opened the doc. Click **See full version history** to get to the full history.
   - Use the menu: **File → Version history → See version history**
   - Use the keyboard shortcut: **Ctrl+Alt+Shift+H**
3. Now you're in the modified **Version history** view.

> [!NOTE]
> Unfortunately, Version history is only visible in Google Docs if you have Editor access.

### Using Version history

* Use the **Diffs | Versions** control to select mode.
  - **Diffs**: View changes between two versions.
  - **Versions**: View the document at a specific version.

* Click a version to view the contents or changes in that version.

* Click **Diff full history** to view the full history as a diff.
  - This shows the final content as a diff from the initial version
    (which was either an empty doc or the initially imported snapshot).
  - For all content added, you can see who added it.

* Select specific ranges:
  1. Select one version.
  2. Select **Start here** or **End here** to set a range bound, expanding
     or shrinking the range.
  3. You'll see the changes made between the start and end versions.

### Other changes

The extension also includes some additional UI improvements.

* The `Show highlights` checkbox is replaced by the **Diffs | Versions** control, which is more intuitive and reliable.
* The awkward behavior where clicks on the timestamp open a rename text box is disabled.
  - Naming versions is still possible using actions in the three-dots menu.
* Fixes a Google Docs bug that breaks version navigation on large docs.
  - When loading diffs is slow, Google Docs silently switches into a sticky
    mode where it overrides `Show highlights` and loads versions instead of diffs.
  - See [`docs/fix-google-docs-start-version-bug.md`](docs/fix-google-docs-start-version-bug.md) for details.

## Installation

### Chrome extension

1. Clone this repo and install dependencies:
   ```bash
   git clone https://github.com/jshute96/GoogleDocsRangeDiffs.git
   cd GoogleDocsRangeDiffs
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. In Chrome:
   1. Open `chrome://extensions`.
   2. Enable **Developer mode**.
   3. Click **Load unpacked** and select the `dist/` directory.

## Development

### Building

```bash
npm install      # one-time setup
npm run build    # build extension in dist/
```

### Testing

Tests run against real Google Docs with a logged-in user.

#### Test setup

The tests interact with live Google Docs using the extension.
This requires you to log in, and to provide a test document with some
version history where you have Editor access. (Editor access is required to
see the history, but the tests don't make any edits.)

1. Install Playwright
   ```bash
   npx playwright install chromium
   ```
2. Create `testing/test_config.json` from the template and point
   `test_doc` at a Google Doc.
   ```bash
   cp testing/test_config.template.json testing/test_config.json
   # Then edit test_config.json and set test_doc.
   ```
3. Open the test browser and log in to Google once (the session
   persists across runs in the profile dir):
   ```bash
   scripts/open-browser-with-extension.sh https://docs.google.com
   ```

The automated tests use this browser. Its log-in state persists across
restarts. Some tests enable or disable the extension as needed.

For manual testing, `scripts/open-browser-without-extension.sh` will
open a parallel browser *without* the extension.

#### Running tests

```bash
npm run build                                # build
npm test                                     # all tests
npm test -- testing/tests/smoke.spec.ts      # one test file
```

#### Debugging in Chrome developer console

From the browser console on a Google Docs page:

- `showRevisions(start, end)` — set a revision range and show the diff
- `openVersionHistory()` — open the Version history panel programmatically

#### Interactive browser scripts

```bash
scripts/open-browser-with-extension.sh [url]      # Playwright Chromium + extension (port 9222)
scripts/open-browser-without-extension.sh [url]   # Playwright Chromium, no extension (port 9223)
```

Both use persistent profiles so Google login survives across runs.
Automated tests use the with-extension browser; the other script is for manual baseline testing.

### Code layout

- `src/` — Extension source (TypeScript) and `manifest.json`
- `dist/` — built extension (gitignored, loaded unpacked into Chrome)
- `scripts/` — build script, browser-opening scripts, inspection tools
- `testing/` — Playwright fixtures, helpers, and config for tests
- `testing/tests/` — Test cases
- `docs/` — design docs
- `docs/file-index.md` — description of all files in the project

## Privacy policy

See [`docs/privacy-policy.md`](docs/privacy-policy.md) — the extension does not collect, store, or transmit any data.
