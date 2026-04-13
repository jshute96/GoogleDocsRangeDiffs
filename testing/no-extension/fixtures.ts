/**
 * Playwright fixtures for live Google Docs tests WITHOUT the extension.
 *
 * Connects to a running browser via CDP (port 9223) that was opened with
 * scripts/open-browser-without-extension.sh. The browser must be running
 * and logged in to Google before tests start.
 */

import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { CDP_PORT_NO_EXTENSION, getTestConfig } from '../test-env';

type NoExtensionFixtures = {
  context: BrowserContext;
  /** The test doc URL from test_config.json. */
  testDocUrl: string;
};

export const test = base.extend<NoExtensionFixtures>({
  context: async ({}, use) => {
    const browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${CDP_PORT_NO_EXTENSION}`
    );
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('No browser context found — is the browser open?');
    await use(ctx);
  },

  testDocUrl: async ({}, use) => {
    const config = getTestConfig();
    await use(config.test_doc);
  },
});

export { expect } from '@playwright/test';
