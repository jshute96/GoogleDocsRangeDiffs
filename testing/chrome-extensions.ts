/**
 * Helpers that drive the chrome://extensions page to manage our extension
 * during tests — used by both the extension and no-extension fixtures.
 *
 * Lives at the testing/ root rather than inside extension/ so the
 * no-extension fixture doesn't have to import from a sibling suite.
 */

import { type BrowserContext, type Page } from '@playwright/test';

/** Manifest `name` of the extension under test — used to find its card on chrome://extensions. */
const EXTENSION_NAME = 'Google Docs Range Diffs';

/**
 * Open chrome://extensions, ensure dev-mode is on (the reload button and
 * the per-item shadow internals only render when it is), run `fn`, then
 * close the page in a `finally`.
 */
async function withExtensionsPage<T>(
  context: BrowserContext,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    await page.waitForTimeout(1000);
    const devModeOk = await page.evaluate(() => {
      const mgr = document.querySelector('extensions-manager') as HTMLElement | null;
      const toolbar = mgr?.shadowRoot?.querySelector('extensions-toolbar') as HTMLElement | null;
      const devToggle = toolbar?.shadowRoot?.querySelector('#devMode') as HTMLElement | null;
      if (!devToggle) return false;
      if (devToggle.getAttribute('aria-pressed') !== 'true') devToggle.click();
      return true;
    });
    if (!devModeOk) {
      throw new Error('chrome://extensions: dev-mode toggle not found (Chrome shadow-DOM rename?)');
    }
    await page.waitForTimeout(500);
    return await fn(page);
  } finally {
    await page.close();
  }
}

interface ConfigureOptions {
  /** Desired enabled state of the extension. */
  enabled: boolean;
  /**
   * If `enabled` is true, also click the dev-mode reload button after
   * ensuring it's on — picks up a freshly built `dist/`. Ignored when
   * `enabled` is false (a disabled extension has nothing to reload).
   */
  reload?: boolean;
}

/**
 * Configure our extension's enabled state (and optionally reload it) in a
 * single chrome://extensions visit. Combining the two operations keeps the
 * extension fixture's worker setup to one transient tab — CDP's
 * `Target.createTarget` raises the OS window each time, so fewer is better.
 *
 * No-op for `enabled` if the extension is already in the requested state.
 * The reload click always fires when `enabled: true, reload: true`, since
 * `pretest` rebuilt `dist/` and we want the new build picked up.
 */
export async function configureExtension(
  context: BrowserContext,
  options: ConfigureOptions
): Promise<void> {
  await withExtensionsPage(context, async (page) => {
    const result = await page.evaluate(({ extensionName, want, doReload }) => {
      const mgr = document.querySelector('extensions-manager') as HTMLElement | null;
      const itemList = mgr?.shadowRoot?.querySelector('extensions-item-list') as HTMLElement | null;
      const items = itemList?.shadowRoot?.querySelectorAll('extensions-item') || [];
      for (const item of Array.from(items) as HTMLElement[]) {
        const name = item.shadowRoot?.querySelector('#name')?.textContent?.trim();
        if (name !== extensionName) continue;
        const toggle = item.shadowRoot?.querySelector('#enableToggle') as HTMLElement | null;
        if (!toggle) return { status: 'no-toggle' as const };
        const isOn = toggle.hasAttribute('checked');
        let toggled = false;
        if (isOn !== want) {
          toggle.click();
          toggled = true;
        }
        let reloaded = false;
        if (want && doReload) {
          const btn = item.shadowRoot?.querySelector('#dev-reload-button') as HTMLElement | null;
          if (!btn) return { status: 'no-reload-button' as const };
          btn.click();
          reloaded = true;
        }
        return { status: 'ok' as const, toggled, reloaded };
      }
      return { status: 'not-found' as const };
    }, { extensionName: EXTENSION_NAME, want: options.enabled, doReload: !!options.reload });

    if (result.status !== 'ok') {
      throw new Error(`configureExtension(${options.enabled}, reload=${!!options.reload}): ${result.status}`);
    }
    // Settle: a freshly toggled-on extension needs a beat for its service
    // worker to come up; the reload click needs a beat before the page
    // is closed (closing a chrome://extensions tab mid-reload sometimes
    // aborts the operation in older Chrome builds).
    if (result.toggled || result.reloaded) {
      await page.waitForTimeout(1500);
    }
  });
}
