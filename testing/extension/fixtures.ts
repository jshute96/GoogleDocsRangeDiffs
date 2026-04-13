/**
 * Playwright fixtures for live Google Docs tests WITH the extension loaded.
 *
 * Connects to a running browser via CDP (port 9222) that was opened with
 * scripts/open-browser-with-extension.sh. The browser must be running and
 * logged in to Google before tests start.
 */

import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { CDP_PORT_EXTENSION, getTestConfig } from '../test-env';

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  /** Returns a live service worker handle (re-resolves each call). */
  getServiceWorker: () => Promise<Worker>;
  /** The test doc URL from test_config.json. */
  testDocUrl: string;
};

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${CDP_PORT_EXTENSION}`
    );
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('No browser context found — is the browser open?');
    await use(ctx);
    // Don't close — it's the user's interactive browser session.
  },

  getServiceWorker: async ({ context }, use) => {
    const get = async () => {
      for (const candidate of context.serviceWorkers()) {
        try {
          await candidate.evaluate(() => true);
          return candidate;
        } catch {
          // stale handle
        }
      }
      const sw = await context.waitForEvent('serviceworker', { timeout: 5000 });
      await sw.evaluate(() => true);
      return sw;
    };
    await use(get);
  },

  extensionId: async ({ getServiceWorker }, use) => {
    const sw = await getServiceWorker();
    const id = new URL(sw.url()).host;
    await use(id);
  },

  testDocUrl: async ({}, use) => {
    const config = getTestConfig();
    await use(config.test_doc);
  },
});

export { expect } from '@playwright/test';
