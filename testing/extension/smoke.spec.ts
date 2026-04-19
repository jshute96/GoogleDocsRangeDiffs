/**
 * Smoke tests: verify the extension injects its UI into Google Docs
 * version history.
 */

import { test, expect } from './fixtures';
import { openDocAndVersionHistory } from './helpers';

test('extension injects revision UI into version history', async ({ context, testDocUrl }) => {
  const page = await openDocAndVersionHistory(context, testDocUrl);
  try {
    const fromButtons = page.locator('.dr-version-from-btn');
    const toButtons = page.locator('.dr-version-to-btn');
    expect(await fromButtons.count()).toBeGreaterThan(0);
    expect(await toButtons.count()).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});
