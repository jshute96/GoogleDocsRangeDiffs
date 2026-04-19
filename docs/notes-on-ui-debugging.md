# Notes on UI Debugging with Playwright

Practical lessons from driving the live extension browser via Playwright +
CDP. Complements `notes-on-testing.md` (which covers the authored test
suite); this file is for interactive one-off debug scripts.

Put all such scripts in `tmp/` (gitignored).

## Connecting to the live browser

The two helper scripts launch Chromium with persistent profiles:

```bash
scripts/open-browser-with-extension.sh https://docs.google.com
scripts/open-browser-without-extension.sh https://docs.google.com
```

In a Node script, connect over CDP:

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes('docs.google.com/document'));
if (!page) page = await ctx.newPage();
```

- `contexts()[0]` — the persistent profile's default context.
- Reuse an existing page by URL rather than opening a new one — a fresh
  page bypasses whatever interactive state the user has.
- **Don't call `browser.close()`** — it would close the user's interactive
  session. Close pages you opened; leave the rest alone.

## Reloading the extension after code changes

The unpacked extension doesn't hot-reload. After `npm run build`:

- **Best path:** drive `chrome://extensions` and click the per-extension
  reload button.
  - Enable dev mode first: `extensions-manager` → `extensions-toolbar`
    → `#devMode` (three nested shadow roots).
  - Reload button: `extensions-manager` → `extensions-item-list` →
    `extensions-item` → `#dev-reload-button` (also all in shadow DOM).

- **Risky path:** `sw.evaluate(() => chrome.runtime.reload())`. Sometimes
  leaves the extension disabled/unloaded (no service worker, no content
  script on reload). If that happens, relaunch the browser.

- Service worker handles can be absent if the SW is idle. Wake it by
  loading a page that triggers the content script's
  `chrome.runtime.sendMessage`; then `ctx.serviceWorkers()[0]` returns.

After reloading the extension, **also reload the docs page** so the
content script re-injects.

## Simulating user interactions

- **Closure/MDC div-buttons** (e.g.,
  `.docs-revisions-chromecover-titlebar-button-back`) don't fire on
  `element.click()` from `page.evaluate`. Their handlers expect real mouse
  events. Use Playwright's `elementHandle.click()` (or
  `page.locator(...).click()`) — it dispatches a trusted click.
- Programmatic `element.click()` *does* work on version listitems (per
  `notes-on-google-docs.md`) — behavior is per-element.
- Keyboard shortcut for Version History:
  `page.keyboard.press('Control+Alt+Shift+KeyH')`. It opens the panel. If
  the panel is already open, Docs may do an internal re-render (the
  chromecover detaches and reattaches within one MutationObserver batch).

## Probing DOM state at precise moments

Post-hoc `page.evaluate` runs *after* the event of interest — too late to
snapshot transient state. Instead, instrument inside the page and log
synchronously at the event:

```js
await page.evaluate(() => {
  const t0 = performance.now();
  const log = (s) => console.log('[probe t=' + Math.round(performance.now() - t0) + 'ms] ' + s);

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (typeof url === 'string' && url.includes('/showrevision?')) {
      log('XHR start=' + url.match(/[?&]start=(\d+)/)?.[1] +
          ' selectedIdx=' + [...document.querySelectorAll('[aria-label="Versions"] [role="listitem"]')]
            .findIndex(it => /SelectedTile(?!.*Unselected)/.test(it.className)));
    }
    return origOpen.call(this, method, url, ...rest);
  };
});
```

- Wrap XHR/fetch from the probe — the snapshot captures DOM at the exact
  request moment, before the response changes anything.
- Log via `console.log`; capture from Node via `page.on('console', …)`.
- **Attach `page.on('console', …)` BEFORE any action that generates logs
  you care about.** Reloading the page after attaching is fine; attaching
  after a reload misses the initial load logs.
- Substring-match your tags carefully: `text.includes('[probe]')`
  will *not* match `'[probe t=0ms]'`. Use `'[probe t='` or similar.

## Observing DOM changes you'd otherwise miss

- **Docs can detach-and-reattach the same element within a single
  MutationObserver batch.** After the batch, `querySelector` still sees
  the element — so polling reports it as continuously present. To catch
  these transitions, iterate `MutationRecord.addedNodes` /
  `removedNodes` directly in the observer callback.
- **Hidden ≠ removed.** The chromecover (`.docs-revisions-chromecover-content`)
  persists in the DOM after the user exits version history — only its
  parent's `display` flips to `none`. Element presence isn't a reliable
  "panel open" signal.

## Identifying the source of visual styling

When inspecting what puts a visual effect on an element:

- **Outlines, borders, and `box-shadow` are all distinct.** Google's
  Gm3WizCard focus ring is a `box-shadow` on a `<span>` child, class
  `...Gm3WizCard-card__focusring`. Looking only at `border` missed it.
- Walk the element *and its descendants* and log computed
  `border`/`outline`/`boxShadow` on each. Halo-style effects are usually
  on a dedicated child element (a ripple, focus ring, or overlay span).
- Blue `rgb(26, 115, 232)` is our extension's primary (on
  `.dr-btn-highlighted`). Blue `rgb(0, 99, 155)` is Google's Gm3Wiz
  focus ring. Knowing the exact RGB tells you whose rule you're looking
  at.

## Restart the browser when in doubt

If the extension stops running, the service worker won't spawn, or the
profile seems confused after a bad reload: kill the Chromium process and
re-run `scripts/open-browser-with-extension.sh`. The persistent profile
preserves Google login, so the cost is low.

```bash
pgrep -af "chrome.*load-extension"   # find it
kill <pid>
scripts/open-browser-with-extension.sh https://docs.google.com
```
