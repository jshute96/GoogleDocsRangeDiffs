/**
 * Reproduction of the Google Docs slow-diff "version-only fallback" bug.
 *
 * Observed behavior on real Docs (large doc with many revisions):
 *   1. When a `/showrevision` request that includes `start=` (the diff view)
 *      takes longer than ~2s to return, Docs internally flips into a
 *      "version-only" state.
 *   2. From that point on Docs auto-fires a follow-up `/showrevision` with
 *      only `end=` and renders the result as a single-revision view (no
 *      diff annotations) — even though the "Highlight changes" checkbox
 *      remains visibly checked.
 *   3. State is sticky: every subsequent version click also fires
 *      `/showrevision?...&end=N` (no `start`).
 *   4. Toggling "Highlight changes" XORs the relationship between
 *      checkbox and behavior — the checkbox starts producing the
 *      "wrong" kind of fetch relative to its visible state.
 *   5. A second slow diff flips the polarity back to consistent with
 *      the checkbox.
 *
 * These tests don't load the extension — they observe Docs directly so
 * we can document the exact failure mode our extension needs to work
 * around. They inject a setTimeout-based delay around `XMLHttpRequest.send`
 * / `window.fetch` to simulate a slow network for one targeted request.
 *
 * Test order matters: Tests are run in the file's listed order in a
 * single worker (no parallelism). The page is shared so we have to be
 * mindful of state leaking between tests, hence the diagnostic test
 * below runs first and acts as a soft smoke check.
 */

import { test, expect, type Page } from '@playwright/test';
import { test as fixtureTest } from './fixtures';
import {
  armOneShotShowRevisionDelay,
  captureShowRevisions,
  clickListitem,
  getHighlightChangesChecked,
  toggleHighlightChanges,
  waitForShowRevisionMatching,
  type ShowRevisionBuf,
  type ShowRevisionResponse,
} from './helpers';

// Re-export the fixture-bound `test` so each test in this file shares
// the worker-scoped page from `./fixtures`.
const t = fixtureTest;

function fmt(r: ShowRevisionResponse): string {
  return (r.start ?? '?') + '..' + r.end + (r.isDiff ? '/diff' : '/version');
}

/**
 * Click a different listitem each time we're called — Docs no-ops on a
 * click of the already-selected item, so a fixed index would only
 * produce a refetch on the first call. Cycle through a small set,
 * avoiding the oldest version (which has no older revision to diff
 * against and would return a single-version response even with start=).
 */
let cycleIdx = 1;
const NON_OLDEST_INDICES = [1, 2, 3, 4];
async function clickNextListitem(page: Page): Promise<number> {
  const i = NON_OLDEST_INDICES[cycleIdx % NON_OLDEST_INDICES.length];
  cycleIdx++;
  await clickListitem(page, i);
  return i;
}

/**
 * Toggle Highlight changes once, wait for its async refetch to land in
 * the buffer, and return the response that landed. The wait is
 * essential: Docs' checkbox change handler fires showrevision ~300ms
 * after the click, asynchronously — without the wait, a follow-up
 * click would race with this auto-refetch.
 */
async function toggleAndAwait(
  page: Page,
  buf: ShowRevisionBuf,
  timeoutMs = 8000
): Promise<ShowRevisionResponse> {
  const startCount = buf.all().length;
  await toggleHighlightChanges(page);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all = buf.all();
    if (all.length > startCount) return all[all.length - 1];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('toggleAndAwait: no response in ' + timeoutMs + 'ms');
}

/**
 * Diagnostic walkthrough: prove our network-injection works, prove we
 * can distinguish diff from version responses, then trigger the bug
 * and watch its sticky / XOR behavior. Each phase logs its observation
 * so failures point at the exact phase that broke.
 *
 * This is one big test on purpose — the bug + healing protocol is
 * stateful enough that splitting into N tests makes inter-test ordering
 * fragile. A single sequenced walkthrough is easier to reason about
 * than five isolated ones with cleanup hooks.
 */
t('docs slow-diff fallback walkthrough', async ({ page }) => {
  test.setTimeout(120_000);

  // Reload the doc to drop any in-memory polarity state left by a
  // previous run. The shared CDP browser persists tabs across `npm test`
  // invocations, so without an explicit reload we may inherit an
  // inverted-polarity session and the baseline phases would observe
  // the wrong behavior. Clear storage too — Docs caches some session
  // state in IndexedDB that would otherwise survive a reload.
  await page.evaluate(async () => {
    try { sessionStorage.clear(); } catch {}
    try { localStorage.clear(); } catch {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.locator('#docs-revisions-appbarbutton').click();
  await page.waitForSelector('[aria-label="Versions"] [role="listitem"]', {
    timeout: 15_000,
  });
  // Reset cycle index so each test run starts at a predictable item.
  cycleIdx = 1;

  const buf = captureShowRevisions(page);

  // -------------------------------------------------------------------
  // Phase 1: baseline — checked Highlight changes produces start+diff.
  // -------------------------------------------------------------------
  // The fixture left us with a session where Highlight changes is
  // typically checked. If not, toggle it and let the refetch settle.
  let checked = await getHighlightChangesChecked(page);
  expect(checked, 'Highlight changes checkbox not found').not.toBeNull();
  if (checked === false) {
    await toggleAndAwait(page, buf);
    checked = await getHighlightChangesChecked(page);
    expect(checked).toBe(true);
  }

  buf.clear();
  const idxA = await clickNextListitem(page);
  const respA = await waitForShowRevisionMatching(buf, () => true, 8000);
  console.log('[phase1] checked + click idx=' + idxA + ' → ' + fmt(respA));
  expect(respA.start, 'phase1: checked → URL has start=').toBeDefined();
  expect(respA.isDiff, 'phase1: checked → response is a diff').toBe(true);

  // -------------------------------------------------------------------
  // Phase 2: baseline — unchecked Highlight changes produces no-start /
  // version-only response.
  // -------------------------------------------------------------------
  await toggleAndAwait(page, buf);
  checked = await getHighlightChangesChecked(page);
  expect(checked).toBe(false);

  buf.clear();
  const idxB = await clickNextListitem(page);
  const respB = await waitForShowRevisionMatching(buf, () => true, 8000);
  console.log('[phase2] unchecked + click idx=' + idxB + ' → ' + fmt(respB));
  expect(respB.start, 'phase2: unchecked → URL has no start=').toBeUndefined();
  expect(respB.isDiff, 'phase2: unchecked response carries no diff annotations').toBe(false);

  // Restore checkbox to checked baseline before triggering the bug.
  await toggleAndAwait(page, buf);
  expect(await getHighlightChangesChecked(page)).toBe(true);

  // -------------------------------------------------------------------
  // Phase 3: trigger the bug. With checkbox checked, arm a 3s delay on
  // the next start+ showrevision and click a different version. Expect
  // Docs to abandon the slow request and fall back to a no-start fetch.
  // -------------------------------------------------------------------
  // Use 5s — Docs' threshold appears to be ~2s but isn't deterministic;
  // a generous delay makes the bug fire reliably across machines.
  await armOneShotShowRevisionDelay(page, 5000);
  buf.clear();
  const idxC = await clickNextListitem(page);
  // Wait for any response with end matching the click target. The slow
  // start+ response may eventually arrive too — what we need is *that*
  // a no-start response also arrives. Allow 20s to outlast the 5s
  // delay plus Docs' own retry.
  const fallback = await waitForShowRevisionMatching(
    buf,
    (r) => r.start === undefined,
    20000
  );
  console.log('[phase3] bug click idx=' + idxC + ' fallback → ' + fmt(fallback));
  expect(fallback.start).toBeUndefined();
  expect(fallback.isDiff).toBe(false);
  expect(await getHighlightChangesChecked(page)).toBe(true);

  // -------------------------------------------------------------------
  // Phase 4: stickiness — subsequent clicks (with checkbox still
  // checked) should also produce no-start responses.
  // -------------------------------------------------------------------
  buf.clear();
  const idxD = await clickNextListitem(page);
  const respD = await waitForShowRevisionMatching(buf, () => true, 8000);
  console.log('[phase4] sticky click idx=' + idxD + ' → ' + fmt(respD));
  expect(respD.start, 'phase4: sticky bug → no-start URL on subsequent clicks').toBeUndefined();
  expect(respD.isDiff).toBe(false);

  // -------------------------------------------------------------------
  // Phase 5: XOR — toggling the checkbox flips the polarity. Now
  // unchecked + bug-state = "show diffs" (URL has start, body has diff).
  // -------------------------------------------------------------------
  const toggleResp = await toggleAndAwait(page, buf);
  console.log('[phase5] post-toggle (now unchecked) refetch → ' + fmt(toggleResp));
  expect(await getHighlightChangesChecked(page)).toBe(false);
  buf.clear();
  const idxE = await clickNextListitem(page);
  const respE = await waitForShowRevisionMatching(buf, () => true, 8000);
  console.log('[phase5] XOR click idx=' + idxE + ' → ' + fmt(respE));
  expect(
    respE.start,
    'phase5: XOR — unchecked + bug-state should produce start= URLs'
  ).toBeDefined();
  expect(respE.isDiff, 'phase5: XOR — start= response carries diff annotations').toBe(true);

  // The polarity heals on its own only via another slow-diff event.
  // We don't try to assert that here — the test's job is to prove the
  // failure modes our extension's fix has to navigate. The session is
  // left in an inverted-polarity state; subsequent tests in the worker
  // will need to reload the doc if they care.
});
