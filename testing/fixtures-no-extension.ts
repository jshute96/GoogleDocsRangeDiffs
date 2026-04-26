/**
 * Playwright fixtures for live Google Docs tests WITHOUT the extension.
 *
 * Shares the with-extension browser (CDP port 9222) and disables the
 * extension via the chrome://extensions enable toggle for the duration of
 * this suite. One profile, one login — `npm test` runs the suites
 * sequentially so the two never fight over the toggle.
 *
 * Worker-scoped `_sharedContext` / `_sharedPage` share one tab across tests
 * in a worker — cuts runtime and avoids raising the browser window. The
 * built-in `context` / `page` fixtures are overridden to pipe them through.
 */

import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { CDP_PORT_EXTENSION, connectOverCDPWithGuidance, getTestConfig } from './test-env';
import { configureExtension } from './chrome-extensions';

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
      const browser = await connectOverCDPWithGuidance(
        CDP_PORT_EXTENSION,
        'open-browser-with-extension.sh',
        { launchIfMissing: true }
      );
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error('No browser context found — is the browser open?');
      // Make sure the extension is OFF for this suite. No-op if already off.
      await configureExtension(ctx, { enabled: false });
      await use(ctx);
      // Don't re-enable on teardown: the next suite's fixture will flip it
      // back on, and leaving it off if no further suite runs matches what
      // the user just asked for.
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
      // Always navigate fresh: if we inherited a tab the prior suite left on
      // the doc, its in-page state still reflects extension-on. A full goto
      // gives us a clean Docs load with the (now-disabled) extension absent.
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
