/**
 * Behavioral tests: the Start/End range-selection flow (formerly
 * "From here" / "To here" — labels changed; CSS classes and internal
 * mode keys keep their original 'from' / 'to' names).
 *
 * Covers moving the start endpoint, moving the end endpoint inward,
 * collapsing a range via a plain listitem click, per-row button
 * visibility under a distinct range, the single-button "Diff"
 * state when From=To, and the URL rewrite that happens when inputs
 * disagree with Docs' natural click-generated params.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures-extension';
import {
  expectOverrides,
  clickListitem,
  clickFrom,
  clickTo,
  lastRewroteRange,
} from '../helpers-extension';
import {
  createRecorder,
  registerBeforeEachReset,
  registerContentChainSweep,
  expectDiffContents,
  expectRangeAndContents,
} from '../version-range-shared';

const recorder = createRecorder();

registerBeforeEachReset();
registerContentChainSweep(recorder);

test('From on older item: range spans From..existing-To', async ({ page, diffResponses }) => {
  // Init capture leaves From=0, To=0. Clicking From on item 3 moves only
  // the From highlight (the existing To bound is still valid).
  await clickFrom(page, 3);
  await expectRangeAndContents(page, diffResponses, recorder, 3, 0);
});

test('To on newer item after a valid From: moves only the To highlight', async ({ page, diffResponses }) => {
  await clickFrom(page, 3);
  await expectRangeAndContents(page, diffResponses, recorder, 3, 0);
  // To on an item newer than From (lower index but still > From's new-end)
  // — actually item 2 is between From=3 and current To=0, so to-click on
  // it moves the To endpoint inward.
  await clickTo(page, 2);
  await expectRangeAndContents(page, diffResponses, recorder, 3, 2);
});

// Note: the old "To on an item OLDER than current From → both bounds
// collapse to click target" case used to live here. The new button-
// visibility rule hides "End here" on items at or below the From
// endpoint, so the click is no longer user-reachable. The underlying
// tookBoth fallback in the interceptor remains (defense-in-depth for
// other code paths); the equivalent user outcome (collapse to an older
// item) is now reached via a plain listitem click — covered by the
// "clicking an item ... resets to from=to" test below.

test('with a range selected, clicking an item (inside or outside) resets to from=to', async ({ page, diffResponses }) => {
  await clickFrom(page, 3);
  await clickTo(page, 0);
  await expectRangeAndContents(page, diffResponses, recorder, 3, 0);

  // Click an item inside the range → both bounds collapse to that item.
  await clickListitem(page, 2);
  await expectRangeAndContents(page, diffResponses, recorder, 2, 2);

  // Rebuild the range, then click an item outside it.
  await clickFrom(page, 3);
  await clickTo(page, 1);
  await expectRangeAndContents(page, diffResponses, recorder, 3, 1);
  await clickListitem(page, 0);
  await expectRangeAndContents(page, diffResponses, recorder, 0, 0);

  // Rebuild, click on one of the endpoints (the From item) — should also
  // collapse to that item.
  await clickFrom(page, 2);
  await clickTo(page, 0);
  await expectRangeAndContents(page, diffResponses, recorder, 2, 0);
  await clickListitem(page, 2);
  await expectRangeAndContents(page, diffResponses, recorder, 2, 2);
});

test('click on already-selected listitem: highlights stay on target', async ({ page, diffResponses }) => {
  // captureForSelected forces a fresh showrevision when the user clicks
  // From/To/Diff on the already-selected tile. The current mechanism is
  // toggling Docs' "Highlight changes" checkbox twice — SelectedTile
  // doesn't move during that, so highlights staying on the target is the
  // direct consequence.
  //
  // (Historical: an older click-away-then-back trick clicked a neighbor,
  // which moved SelectedTile and required restoreBothOnSelectedIfFlagged
  // to pin the anchor. This test originally guarded that pin; under the
  // toggle mechanism the anchoring is mechanism-free, but the test still
  // covers the user-visible invariant: the right item ends up highlighted.)
  //
  // Scenario: clickFrom(3) selects item 3 (range 3..0, divergent). Then
  // clickListitem(3) routes through captureForSelected(item3, 'both'):
  // tookBoth=true, rangeChanged=true → drBothOnSelected=1 set, refetch
  // fires via the checkbox toggle. Highlights must end up on item 3.
  await clickFrom(page, 3);
  await expectRangeAndContents(page, diffResponses, recorder, 3, 0);
  await clickListitem(page, 3);
  await expectRangeAndContents(page, diffResponses, recorder, 3, 3);
});

test('URL rewrite: setting From=item[2], To=item[0] sends start=item2.start, end=item0.end', async ({ page, logs, diffResponses }) => {
  // Discover the natural (start, end) range of the first few items.
  // Item 0 is already SelectedTile from init capture — clicking it wouldn't
  // fire a new showrevision — so read its range from the init-capture log.
  // For items 1+, click each and read the "orig request" line.
  const count = Math.min(4, await page.locator('[aria-label="Versions"] [role="listitem"]').count());
  const ranges: Array<{ start: number; end: number }> = [];
  const initLog = logs.all().find((l) => l.includes('orig request') && l.includes('mode=both'));
  const initM = initLog?.match(/orig request:\s*(\d+)\s*to\s*(\d+)/);
  if (!initM) throw new Error('no init-capture orig request in logs');
  ranges[0] = { start: Number(initM[1]), end: Number(initM[2]) };
  for (let i = 1; i < count; i++) {
    const before = logs.all().length;
    await clickListitem(page, i);
    const after = logs.all().slice(before);
    const m = after
      .map((l) => l.match(/orig request:\s*(\d+)\s*to\s*(\d+)/))
      .reverse()
      .find((x) => x);
    if (!m) throw new Error(`no orig request for item ${i}`);
    ranges[i] = { start: Number(m[1]), end: Number(m[2]) };
  }

  // The measurement loop above left From=To at the last clicked item
  // (index 3). Under the new hiding rules, "Start here" is hidden on every
  // item at or above that From endpoint (i <= hi), so clickFrom(2) would
  // hit a hidden button. Reset to From=To=0 first so the rest of the test
  // starts from a state where item 2's Start button is visible.
  await clickListitem(page, 0);

  // Now set From=2, To=0. Range bounds should be start=ranges[2].start,
  // end=ranges[0].end. The "rewrote to" log after the To click tells us
  // what got sent to Docs.
  await clickFrom(page, 2);
  // After From(2) alone: newStart = ranges[2].start; newEnd stays at the
  // current (ranges[0].end from init capture) since ranges[2].start <
  // ranges[0].end, so no take-both fallback.
  await clickTo(page, 0);
  const rewritten = lastRewroteRange(logs.all());
  // A rewrite happens when inputs disagree with the URL's natural params.
  // After our capture flow, inputs are (ranges[2].start, ranges[0].end).
  expect(rewritten, 'saw at least one rewrite').not.toBeNull();
  expect(rewritten!.start).toBe(ranges[2].start);
  expect(rewritten!.end).toBe(ranges[0].end);

  // Overrides should match the expected bounds too.
  await expectOverrides(page, ranges[2].start, ranges[0].end);
  // Content check: From=2..To=0 — after = newest (idx 0), before = idx 3's after.
  await expectDiffContents(page, diffResponses, recorder, 2, 0);
});

/**
 * Read the visibility (`display` != 'none') of each per-row button by index.
 * Returns a terse shape the tests can assert against directly.
 */
async function readButtonVisibility(
  page: Page
): Promise<Array<{ start: boolean; end: boolean; diff: boolean }>> {
  return page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('[aria-label="Versions"] [role="listitem"]')
    );
    const vis = (el: Element | null): boolean => !!el && getComputedStyle(el).display !== 'none';
    return items.map((it) => ({
      start: vis(it.querySelector('.dr-version-from-btn')),
      end: vis(it.querySelector('.dr-version-to-btn')),
      diff: vis(it.querySelector('.dr-version-both-btn')),
    }));
  });
}

test('From=To (init state): Diff is the only visible button on the endpoint', async ({ page }) => {
  // Init capture lands From=To on item 0. That row should display ONLY the
  // "Diff" button; "Start here" and "End here" are hidden there since
  // clicking either on the single-point endpoint would be a no-op.
  const vis = await readButtonVisibility(page);
  expect(vis[0], 'item 0 (From=To endpoint)').toEqual({ start: false, end: false, diff: true });
  // Every other row is "below" the single-point range (older) — only
  // "Start here" makes sense (extends the range downward). "End here" and
  // "Diff" are hidden.
  for (let i = 1; i < vis.length; i++) {
    expect(vis[i], `item ${i} (below single-point range)`).toEqual({ start: true, end: false, diff: false });
  }
});

test('Distinct range: endpoints hide the opposite button, in-between shows both, outside shows only the one that grows', async ({ page }) => {
  // Build a distinct range From=3, To=1 (spans indices 1..3).
  await clickFrom(page, 3);
  await clickTo(page, 1);
  const vis = await readButtonVisibility(page);

  // i < lo=1 (items above the range, newer than To): only "End here" grows
  // the range upward. "Start here" is hidden.
  expect(vis[0], 'item 0 (above range)').toEqual({ start: false, end: true, diff: false });
  // i == lo=1 (To endpoint): "Start here" hidden (would collapse), "End
  // here" stays visible (highlighted).
  expect(vis[1], 'item 1 (To endpoint)').toEqual({ start: false, end: true, diff: false });
  // lo < i < hi (strictly inside): both visible — these shrink the range.
  expect(vis[2], 'item 2 (inside range)').toEqual({ start: true, end: true, diff: false });
  // i == hi=3 (From endpoint): "End here" hidden, "Start here" visible.
  expect(vis[3], 'item 3 (From endpoint)').toEqual({ start: true, end: false, diff: false });
  // i > hi=3 (older than From): only "Start here" extends the range
  // downward.
  for (let i = 4; i < vis.length; i++) {
    expect(vis[i], `item ${i} (below range)`).toEqual({ start: true, end: false, diff: false });
  }
  // The Diff button is hidden on every row while the range is distinct.
  expect(vis.every((v) => !v.diff), 'no Diff button on distinct range').toBe(true);
});

test('Diff button follows From=To as it moves: click a new item, Diff shows there', async ({ page }) => {
  // Start state: From=To=0. clickListitem(2) sets From=To=2 via the
  // listitem mousedown 'both' capture. The Diff button should migrate to item 2.
  await clickListitem(page, 2);
  const vis = await readButtonVisibility(page);
  expect(vis[2], 'new From=To endpoint').toEqual({ start: false, end: false, diff: true });
  // No other row has the Diff button visible.
  for (let i = 0; i < vis.length; i++) {
    if (i === 2) continue;
    expect(vis[i].diff, `item ${i} has no Diff button`).toBe(false);
  }
});
