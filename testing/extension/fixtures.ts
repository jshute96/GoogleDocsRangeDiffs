/**
 * Playwright fixtures for live Google Docs tests WITH the extension loaded.
 *
 * Connects to a running browser via CDP (port 9222) that was opened with
 * scripts/open-browser-with-extension.sh. The browser must be running and
 * logged in to Google before tests start.
 *
 * Worker-scoped `_sharedContext` / `_sharedPage` / `logs` intentionally share
 * one tab across all tests in a worker — cuts runtime and avoids repeatedly
 * raising the browser window. The built-in test-scoped `context` / `page`
 * fixtures are overridden to hand out the shared instances. Tests reset
 * state via `resetRange` in `beforeEach` rather than re-navigating.
 */

import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { CDP_PORT_EXTENSION, getTestConfig } from '../test-env';
import {
  findReusableTab,
  openDocAndVersionHistory,
  parseShowRevisionBody,
  reloadExtension,
  type DiffResponseBuf,
  type DiffResponseEntry,
} from './helpers';

/** Accessor for the shared console-log buffer. */
export interface DiffRangeLogBuffer {
  /** Snapshot of all `[DiffRange]` lines captured so far. */
  all(): string[];
  /** Discard the buffer; use in `beforeEach` so each test sees only its own logs. */
  clear(): void;
}

type TestFixtures = {
  /** Overridden built-in: returns the worker-scoped shared context. */
  context: BrowserContext;
  /** Overridden built-in: returns the worker-scoped shared page. */
  page: Page;
};

type WorkerFixtures = {
  _sharedContext: BrowserContext;
  _sharedPage: Page;
  extensionId: string;
  /** Returns a live service worker handle (re-resolves each call). */
  getServiceWorker: () => Promise<Worker>;
  /** The test doc URL from test_config.json. */
  testDocUrl: string;
  /** Shared [DiffRange] console-log buffer. */
  logs: DiffRangeLogBuffer;
  /** Shared buffer of parsed `showrevision` responses, newest last. */
  diffResponses: DiffResponseBuf;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  _sharedContext: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${CDP_PORT_EXTENSION}`
      );
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error('No browser context found — is the browser open?');
      await use(ctx);
      // Don't close — it's the user's interactive browser session.
    },
    { scope: 'worker' },
  ],

  getServiceWorker: [
    async ({ _sharedContext }, use) => {
      const get = async () => {
        for (const candidate of _sharedContext.serviceWorkers()) {
          try {
            await candidate.evaluate(() => true);
            return candidate;
          } catch {
            // stale handle
          }
        }
        const sw = await _sharedContext.waitForEvent('serviceworker', { timeout: 5000 });
        await sw.evaluate(() => true);
        return sw;
      };
      await use(get);
    },
    { scope: 'worker' },
  ],

  extensionId: [
    async ({ getServiceWorker }, use) => {
      const sw = await getServiceWorker();
      const id = new URL(sw.url()).host;
      await use(id);
    },
    { scope: 'worker' },
  ],

  testDocUrl: [
    async ({}, use) => {
      const config = getTestConfig();
      await use(config.test_doc);
    },
    { scope: 'worker' },
  ],

  _sharedPage: [
    async ({ _sharedContext, testDocUrl }, use) => {
      // Reload the extension exactly once per worker so it picks up a
      // freshly built dist/ from `pretest`. This opens chrome://extensions
      // in a temporary tab — the one per-worker window-raise we tolerate.
      await reloadExtension(_sharedContext);
      // Reuse an existing tab if one looks disposable (about:blank or
      // already on Docs) — `newPage` raises the OS window because CDP's
      // `Target.createTarget` activates the new tab. We only steal a tab
      // that's clearly safe to repurpose; otherwise we accept one raise.
      const reusePage = findReusableTab(_sharedContext.pages(), testDocUrl);
      const page = await openDocAndVersionHistory(_sharedContext, testDocUrl, reusePage);
      await use(page);
      // Don't close: if we reused an existing tab, it belongs to the
      // user's interactive browser. Leave it where tests left off.
    },
    { scope: 'worker' },
  ],

  logs: [
    async ({ _sharedPage }, use) => {
      const buf: string[] = [];
      _sharedPage.on('console', (msg) => {
        const t = msg.text();
        if (t.includes('[DiffRange]')) buf.push(t);
      });
      await use({
        all: () => buf.slice(),
        clear: () => {
          buf.length = 0;
        },
      });
    },
    // `auto: true` so the listener attaches as soon as the worker starts up
    // — otherwise a test that doesn't destructure `logs` can fire showrevisions
    // (via `beforeEach` → `resetRange`) that we then fail to record.
    { scope: 'worker', auto: true },
  ],

  diffResponses: [
    async ({ _sharedPage }, use) => {
      const buf: DiffResponseEntry[] = [];
      _sharedPage.on('response', (resp) => {
        const url = resp.url();
        if (!/\/showrevision\?/.test(url)) return;
        const sp = new URL(url).searchParams;
        const startStr = sp.get('start');
        const endStr = sp.get('end');
        if (!startStr || !endStr) return;
        const start = Number(startStr);
        const end = Number(endStr);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;
        // Read body async; Playwright allows async handlers.
        resp.text().then((body) => {
          try {
            const contents = parseShowRevisionBody(body);
            buf.push({ start, end, contents });
          } catch {
            // Ignore parse failures — malformed body (e.g., non-JSON error
            // response) shouldn't break tests that aren't inspecting diff text.
          }
        }).catch(() => { /* response aborted — nothing to record */ });
      });
      await use({
        all: () => buf.slice(),
        clear: () => {
          buf.length = 0;
        },
      });
    },
    // `auto: true` so this listener attaches at worker start, not lazily on
    // first destructure — the content-chain sweep is the first test that reads
    // diff responses but it needs to see the resetRange-triggered init-capture
    // response from its own `beforeEach`, which fires before the fixture would
    // otherwise initialize.
    { scope: 'worker', auto: true },
  ],

  // Pipe the worker-scoped shared instances through to the built-in names so
  // tests can use the familiar `{ context, page }` destructure.
  context: async ({ _sharedContext }, use) => {
    await use(_sharedContext);
  },
  page: async ({ _sharedPage }, use) => {
    await use(_sharedPage);
  },
});

export { expect } from '@playwright/test';
