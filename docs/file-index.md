# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `TODO.md` | Post-merge tasks: TS conversion, icons, tests, options page |
| `package.json` | Node project manifest, scripts, devDependencies |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `.gitignore` | Git ignore rules |

## Claude Commands (`.claude/commands/`)

| File | Description |
|------|-------------|
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — codereview then commit + push if clean |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | Manifest V3 config: permissions, content scripts, service worker |
| `src/types.d.ts` | Global type declarations: Window extensions, service worker globals |
| `src/background.ts` | Service worker — handles `injectRevisionInterceptor` message, loads `background-injected.js` |
| `src/background-injected.ts` | MAIN world functions: XHR/fetch interceptor, `showRevisions()`, `openVersionHistory()` |
| `src/content-revisions.ts` | Content script: injects revision override UI and From/To buttons into Version History |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons and manifest, then runs `tsc` |
| `scripts/open-browser-with-extension.sh` | Opens Playwright Chromium with extension loaded, persistent profile |
| `scripts/open-browser-without-extension.sh` | Opens Playwright Chromium without extension, persistent profile |
| `scripts/inspect-revision-history.mjs` | Connects to running browsers via CDP, takes screenshots, dumps extension DOM |

## Tests (`testing/`)

| File | Description |
|------|-------------|
| `testing/test-env.ts` | Shared test env: paths, CDP port constants, test config loader |
| `testing/extension/playwright.config.ts` | Playwright config for live tests with extension |
| `testing/extension/fixtures.ts` | Fixtures: connects via CDP to extension browser, provides service worker |
| `testing/extension/smoke.spec.ts` | Smoke test: opens a Google Doc with extension, checks injection |
| `testing/no-extension/playwright.config.ts` | Playwright config for live tests without extension |
| `testing/no-extension/fixtures.ts` | Fixtures: connects via CDP to no-extension browser |
| `testing/no-extension/smoke.spec.ts` | Smoke test: opens a Google Doc without extension as baseline |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `notes-on-google-docs.md` | Google Docs DOM structure, event handling, network requests, extension architecture |
| `notes-on-testing.md` | Testing setup, Google login challenges, what works (connectOverCDP) and what doesn't |
