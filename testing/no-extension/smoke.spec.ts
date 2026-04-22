/**
 * Smoke tests: verify baseline Google Docs behavior without the extension.
 * Confirms extension-specific elements are NOT present.
 */

import { test, expect } from './fixtures';

test('Google Doc loads and version history has no extension UI', async ({ page }) => {
  await expect(page.locator('.dr-version-from-btn')).toHaveCount(0);
  await expect(page.locator('.dr-version-to-btn')).toHaveCount(0);
});
