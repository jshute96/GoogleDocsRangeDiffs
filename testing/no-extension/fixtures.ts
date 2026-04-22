/**
 * Playwright fixtures for live Google Docs tests WITHOUT the extension.
 *
 * Connects to a running browser via CDP (port 9223) that was opened with
 * scripts/open-browser-without-extension.sh. The browser must be running
 * and logged in to Google before tests start.
 *
 * Worker-scoped `_sharedContext` / `_sharedPage` share one tab across tests
 * in a worker — cuts runtime and avoids raising the browser window. The
 * built-in `context` / `page` fixtures are overridden to pipe them through.
 */

import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { CDP_PORT_NO_EXTENSION, getTestConfig } from '../test-env';

type TestFixtures = {
  context: BrowserContext;
  page: Page;
};

type WorkerFixtures = {
  _sharedContext: BrowserContext;
  _sharedPage: Page;
  /** The test doc URL from test_config.json. */
  testDocUrl: string;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  _sharedContext: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${CDP_PORT_NO_EXTENSION}`
      );
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error('No browser context found — is the browser open?');
      await use(ctx);
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
      // Reuse a disposable tab (about:blank or already on Docs) rather
      // than creating a new one — `newPage` via CDP's `Target.createTarget`
      // activates the new tab and raises the OS window. If no such tab
      // exists we fall back to `newPage` and accept one raise, rather
      // than navigating away from something the user cares about.
      const origin = new URL(testDocUrl).origin;
      const reusable = _sharedContext.pages().find((p) => {
        const u = p.url();
        return u === 'about:blank' || u === '' || u.startsWith(origin);
      });
      const page = reusable ?? (await _sharedContext.newPage());
      await page.goto(testDocUrl, { waitUntil: 'domcontentloaded' });
      // Docs never reaches networkidle; settle via an explicit wait.
      await page.waitForTimeout(4000);
      // Click the toolbar clock button to open version history. Mirrors
      // the extension suite's approach — avoids the keyboard-shortcut path
      // that would require bringing the window to front.
      await page.locator('#docs-revisions-appbarbutton').click();
      await page.waitForSelector('[aria-label="Versions"] [role="listitem"]', {
        timeout: 15_000,
      });
      await use(page);
      // Don't close: we don't own the tab — it's the user's interactive
      // browser. Leave it where the tests left off.
    },
    { scope: 'worker' },
  ],

  context: async ({ _sharedContext }, use) => {
    await use(_sharedContext);
  },
  page: async ({ _sharedPage }, use) => {
    await use(_sharedPage);
  },
});

export { expect } from '@playwright/test';
