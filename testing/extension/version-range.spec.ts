/**
 * Behavioral tests for the Version History range UI.
 *
 * Drives a real Google Docs document through the extension's From/To range
 * selection flow, asserting at each step that overrides, highlights, and
 * range fill match expectations.
 *
 * Requires a browser opened by scripts/open-browser-with-extension.sh with
 * the user logged into Google, and testing/test_config.json pointing at a
 * doc with ≥4 versions in history.
 *
 * Tests share a single page across the whole run (see `fixtures.ts`).
 * `beforeEach` resets state via `resetRange`, which exits + re-enters
 * version history — cheap, and triggers a fresh init-capture so every
 * test starts with item[0] selected and From/To collapsed on it.
 */

import { test, expect } from './fixtures';
import {
  getRangeState,
  expectRange,
  expectOverrides,
  clickListitem,
  clickFrom,
  clickTo,
  clickDateLabel,
  clickDiffFullHistory,
  exitVersionHistory,
  reenterVersionHistory,
  switchDropdown,
  lastRewroteRange,
  resetRange,
} from './helpers';

test.beforeEach(async ({ page, logs }) => {
  // Clear logs BEFORE the reset so the init-capture entries from this reset
  // are the only ones the test sees.
  logs.clear();
  await resetRange(page);
});

test('initial entry: first item selected with From/To highlighted', async ({ page }) => {
  const state = await getRangeState(page);
  expect(state.itemCount).toBeGreaterThan(0);
  expect(state.selectedIdx).toBe(0);
  await expectRange(page, 0, 0);
  // Init capture should have populated overrides from the first version's
  // natural start/end.
  expect(state.overrides.start).toMatch(/^\d+$/);
  expect(state.overrides.end).toMatch(/^\d+$/);
});

test('click an unselected version: selects it, From+To land on it', async ({ page }) => {
  await clickListitem(page, 2);
  const state = await getRangeState(page);
  expect(state.selectedIdx).toBe(2);
  await expectRange(page, 2, 2);
});

test('click the date/label captures range and does NOT open rename', async ({ page }) => {
  await clickDateLabel(page, 1);
  const state = await getRangeState(page);
  expect(state.selectedIdx).toBe(1);
  await expectRange(page, 1, 1);
  // Rename activation is suppressed: the textarea should not be the focused
  // element. (Rename stays reachable via the three-dots menu.)
  const activeIsTextarea = await page.evaluate(
    () => document.activeElement?.tagName === 'TEXTAREA'
  );
  expect(activeIsTextarea).toBe(false);
});

test('From on older item: range spans From..existing-To', async ({ page }) => {
  // Init capture leaves From=0, To=0. Clicking From on item 3 moves only
  // the From highlight (the existing To bound is still valid).
  await clickFrom(page, 3);
  await expectRange(page, 3, 0);
});

test('To on newer item after a valid From: moves only the To highlight', async ({ page }) => {
  await clickFrom(page, 3);
  await expectRange(page, 3, 0);
  // To on an item newer than From (lower index but still > From's new-end)
  // — actually item 2 is between From=3 and current To=0, so to-click on
  // it moves the To endpoint inward.
  await clickTo(page, 2);
  await expectRange(page, 3, 2);
});

test('To on an item OLDER than current From: captures both bounds on click target', async ({ page }) => {
  await clickFrom(page, 2);
  await expectRange(page, 2, 0);
  // Now click To on item 3 — older than From=2. The would-be range (2..3
  // by index means the "end" rev < "start" rev) is invalid, so the
  // interceptor takes both bounds from the click target (item 3).
  await clickTo(page, 3);
  await expectRange(page, 3, 3);
});

test('with a range selected, clicking an item (inside or outside) resets to from=to', async ({ page }) => {
  await clickFrom(page, 3);
  await clickTo(page, 0);
  await expectRange(page, 3, 0);

  // Click an item inside the range → both bounds collapse to that item.
  await clickListitem(page, 2);
  await expectRange(page, 2, 2);

  // Rebuild the range, then click an item outside it.
  await clickFrom(page, 3);
  await clickTo(page, 1);
  await expectRange(page, 3, 1);
  await clickListitem(page, 0);
  await expectRange(page, 0, 0);

  // Rebuild, click on one of the endpoints (the From item) — should also
  // collapse to that item.
  await clickFrom(page, 2);
  await clickTo(page, 0);
  await expectRange(page, 2, 0);
  await clickListitem(page, 2);
  await expectRange(page, 2, 2);
});

test('dropdown switch (to Named, then back to All) gives a clean selected range', async ({ page }) => {
  await clickListitem(page, 2);
  await expectRange(page, 2, 2);

  // After switching views, Docs picks whatever version it considers default
  // for that view (often the currently-viewed one if it's in the new list,
  // else the first one). What the extension must guarantee: one item is
  // SelectedTile, and From+To are both highlighted on it.
  await switchDropdown(page, 'named');
  const named = await getRangeState(page);
  expect(named.itemCount).toBeGreaterThan(0);
  expect(named.selectedIdx).toBeGreaterThanOrEqual(0);
  await expectRange(page, named.selectedIdx, named.selectedIdx);

  await switchDropdown(page, 'all');
  const all = await getRangeState(page);
  expect(all.selectedIdx).toBeGreaterThanOrEqual(0);
  await expectRange(page, all.selectedIdx, all.selectedIdx);
});

test('reselecting the current dropdown option still resets and re-inits', async ({ page }) => {
  await clickListitem(page, 2);
  await expectRange(page, 2, 2);
  // Reselect All versions — same option; still triggers the dropdown
  // click handler's reset + init-capture.
  await switchDropdown(page, 'all');
  const s = await getRangeState(page);
  expect(s.selectedIdx).toBeGreaterThanOrEqual(0);
  await expectRange(page, s.selectedIdx, s.selectedIdx);
});

test('exit and re-enter Version History: first item selected, From/To re-armed', async ({ page }) => {
  // Move the range off index 0 so we can detect re-entry truly re-inits.
  await clickListitem(page, 2);
  await expectRange(page, 2, 2);

  await exitVersionHistory(page);
  await reenterVersionHistory(page);

  const state = await getRangeState(page);
  expect(state.selectedIdx).toBe(0);
  await expectRange(page, 0, 0);
});

test('Diff full history (item[0] already selected): spans full list, item[0] stays selected', async ({ page, logs }) => {
  // Fresh open (via beforeEach reset): item[0] is SelectedTile via init capture.
  const before = await getRangeState(page);
  expect(before.selectedIdx).toBe(0);
  const n = before.itemCount;
  expect(n).toBeGreaterThan(1);

  // Pull the doc's max revision out of the init-capture "orig request" log
  // (item[0]'s natural end = doc's latest revision).
  const initLog = logs.all().find((l) => l.includes('orig request') && l.includes('capturing both'));
  const initM = initLog?.match(/orig request:\s*(\d+)\s*to\s*(\d+)/);
  if (!initM) throw new Error('no init-capture orig request in logs');
  const maxRev = Number(initM[2]);

  await clickDiffFullHistory(page);

  // Range spans from oldest (item[n-1]) to newest (item[0]).
  await expectRange(page, n - 1, 0);
  // item[0] remains Docs-selected (click-away-then-back).
  const after = await getRangeState(page);
  expect(after.selectedIdx).toBe(0);
  // Overrides reflect the full range: start=1, end=maxRev.
  await expectOverrides(page, 1, maxRev);
  // The outgoing URL was rewritten to the same range.
  const rewritten = lastRewroteRange(logs.all());
  expect(rewritten).not.toBeNull();
  expect(rewritten!.start).toBe(1);
  expect(rewritten!.end).toBe(maxRev);
});

test('Diff full history (item[0] not selected): spans full list, item[0] becomes selected', async ({ page, logs }) => {
  const initLog = logs.all().find((l) => l.includes('orig request') && l.includes('capturing both'));
  const initM = initLog?.match(/orig request:\s*(\d+)\s*to\s*(\d+)/);
  if (!initM) throw new Error('no init-capture orig request in logs');
  const maxRev = Number(initM[2]);

  // Move selection off item[0].
  await clickListitem(page, 2);
  const mid = await getRangeState(page);
  expect(mid.selectedIdx).toBe(2);
  const n = mid.itemCount;

  await clickDiffFullHistory(page);

  await expectRange(page, n - 1, 0);
  const after = await getRangeState(page);
  expect(after.selectedIdx).toBe(0);
  await expectOverrides(page, 1, maxRev);
  const rewritten = lastRewroteRange(logs.all());
  expect(rewritten).not.toBeNull();
  expect(rewritten!.start).toBe(1);
  expect(rewritten!.end).toBe(maxRev);
});

test('URL rewrite: setting From=item[2], To=item[0] sends start=item2.start, end=item0.end', async ({ page, logs }) => {
  // Discover the natural (start, end) range of the first few items.
  // Item 0 is already SelectedTile from init capture — clicking it wouldn't
  // fire a new showrevision — so read its range from the init-capture log.
  // For items 1+, click each and read the "orig request" line.
  const count = Math.min(4, await page.locator('[aria-label="Versions"] [role="listitem"]').count());
  const ranges: Array<{ start: number; end: number }> = [];
  const initLog = logs.all().find((l) => l.includes('orig request') && l.includes('capturing both'));
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
});
