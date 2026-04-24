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
  extractDiffContents,
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
  type DiffContents,
  type DiffResponseBuf,
} from './helpers';
import type { Page } from '@playwright/test';

// Diff contents for listitems [0..N-1], populated by the content-chain sweep
// test at the top of this file. Module-scoped so later tests (run serially on
// the same worker) can compare their extracted contents against the recorded
// per-version state.
//
// SERIAL-ONLY: do not add fullyParallel or test.describe.parallel to this file.
// Tests depend on execution order (sweep runs first, populates the array;
// later tests read it). Parallelizing would leave readers with an empty array
// and produce either silent passes or confusing failures.
const recordedVersions: DiffContents[] = [];
let recordedItemCount = 0;

/**
 * Assert the currently-displayed diff's before/after text matches the versions
 * recorded by the sweep. `fromIdx` and `toIdx` are listitem indexes (0 = newest).
 *   - `after` should equal the state at the To version = recordedVersions[toIdx].after.
 *   - `before` should equal the state at the version just older than From. That's
 *     recordedVersions[fromIdx + 1].after, or '' if From is already the oldest.
 *
 * Fails loudly if the sweep hasn't populated the recording (e.g., if this test
 * was run in isolation or somebody reordered the file), or if the requested
 * indexes are beyond what the sweep covered — a silent no-op would mask real
 * regressions as "passing" tests. The sweep covers listitems 0..min(10,N)-1.
 */
async function expectDiffContents(
  page: Page,
  diffResponses: DiffResponseBuf,
  fromIdx: number,
  toIdx: number
): Promise<void> {
  if (!recordedVersions.length) {
    throw new Error(
      'expectDiffContents: recordedVersions is empty — the content-chain sweep ' +
      'must run before any test that calls this helper. Run the full spec (not ' +
      'just the one test), and keep the sweep early in the file.'
    );
  }
  const { before, after } = await extractDiffContents(page, diffResponses);
  if (toIdx >= recordedVersions.length) {
    throw new Error(
      `expectDiffContents: toIdx=${toIdx} is beyond the sweep size ` +
      `(${recordedVersions.length}). Widen the sweep or pick a lower index.`
    );
  }
  expect(after, `after(idx=${toIdx})`).toBe(recordedVersions[toIdx].after);
  if (fromIdx + 1 >= recordedItemCount) {
    // From is the oldest version; nothing exists before it.
    expect(before, `before(From=oldest idx=${fromIdx})`).toBe('');
  } else if (fromIdx + 1 < recordedVersions.length) {
    expect(before, `before(From+1=${fromIdx + 1})`).toBe(recordedVersions[fromIdx + 1].after);
  } else {
    throw new Error(
      `expectDiffContents: fromIdx+1=${fromIdx + 1} is beyond the sweep size ` +
      `(${recordedVersions.length}) but isn't the oldest item (itemCount=${recordedItemCount}). ` +
      'Widen the sweep or pick a lower From index.'
    );
  }
}

/**
 * Default assertion after a selection change: verify both the range UI (From/To
 * highlights + in-between) and the displayed diff contents match the listitem
 * indexes. Use this for the common case. Use `expectRange` on its own for
 * intermediate / dynamic states where content isn't checkable (e.g., after a
 * dropdown switch where Docs picks the selected item).
 */
async function expectRangeAndContents(
  page: Page,
  diffResponses: DiffResponseBuf,
  fromIdx: number,
  toIdx: number
): Promise<void> {
  await expectRange(page, fromIdx, toIdx);
  await expectDiffContents(page, diffResponses, fromIdx, toIdx);
}

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

// This sweep MUST run early — later tests rely on the recorded versions.
// Playwright runs tests within a file in declaration order; we keep this
// second (after the shallowest init-state check) so later content
// assertions have data to compare against.
test('content chain: for each of the first up to 10 versions, before(i) matches after(i+1)', async ({
  page,
  diffResponses,
}) => {
  const initState = await getRangeState(page);
  recordedItemCount = initState.itemCount;
  const N = Math.min(10, initState.itemCount);
  expect(N).toBeGreaterThan(0);

  recordedVersions.length = 0;

  for (let i = 0; i < N; i++) {
    if (i > 0) {
      // Item 0 is already selected from the beforeEach reset — clicking it
      // wouldn't fire a showrevision. For i>=1 we need to click so the diff
      // refetches.
      await clickListitem(page, i);
    }
    const contents = await extractDiffContents(page, diffResponses);
    recordedVersions.push(contents);
  }

  // Chain invariant: listitem[i]'s before (state immediately older than i) must
  // equal listitem[i+1]'s after (state at the next-older version).
  for (let i = 0; i < N - 1; i++) {
    expect(
      recordedVersions[i].before,
      `recordedVersions[${i}].before should match recordedVersions[${i + 1}].after`
    ).toBe(recordedVersions[i + 1].after);
  }

  // Sanity: the newest version's `after` is the current doc content — it must
  // be non-empty. (Everything else is allowed empty: older listitems can
  // describe an era when the doc was still blank, before content was first
  // added.)
  expect(recordedVersions[0].after, 'newest version after should be non-empty').not.toBe('');

  // Sanity: out of the captured versions, at least 5 should represent a real
  // text change (before !== after). Catches a parser/extension bug that would
  // collapse every version to a no-op diff. Individual versions can look like
  // no-ops if they only changed formatting, so we don't require every version
  // to differ. The threshold is calibrated for the 10-version sweep.
  if (N >= 10) {
    const textChanged = recordedVersions.filter((v) => v.before !== v.after).length;
    expect(textChanged, 'versions with real text change (before !== after)').toBeGreaterThanOrEqual(5);
  }
});

test('click an unselected version: selects it, From+To land on it', async ({ page, diffResponses }) => {
  await clickListitem(page, 2);
  const state = await getRangeState(page);
  expect(state.selectedIdx).toBe(2);
  await expectRangeAndContents(page, diffResponses, 2, 2);
});

test('click the date/label captures range and does NOT open rename', async ({ page, diffResponses }) => {
  await clickDateLabel(page, 1);
  const state = await getRangeState(page);
  expect(state.selectedIdx).toBe(1);
  // Rename activation is suppressed: the textarea should not be the focused
  // element. (Rename stays reachable via the three-dots menu.)
  const activeIsTextarea = await page.evaluate(
    () => document.activeElement?.tagName === 'TEXTAREA'
  );
  expect(activeIsTextarea).toBe(false);
  await expectRangeAndContents(page, diffResponses, 1, 1);
});

test('From on older item: range spans From..existing-To', async ({ page, diffResponses }) => {
  // Init capture leaves From=0, To=0. Clicking From on item 3 moves only
  // the From highlight (the existing To bound is still valid).
  await clickFrom(page, 3);
  await expectRangeAndContents(page, diffResponses, 3, 0);
});

test('To on newer item after a valid From: moves only the To highlight', async ({ page, diffResponses }) => {
  await clickFrom(page, 3);
  await expectRangeAndContents(page, diffResponses, 3, 0);
  // To on an item newer than From (lower index but still > From's new-end)
  // — actually item 2 is between From=3 and current To=0, so to-click on
  // it moves the To endpoint inward.
  await clickTo(page, 2);
  await expectRangeAndContents(page, diffResponses, 3, 2);
});

test('To on an item OLDER than current From: captures both bounds on click target', async ({ page, diffResponses }) => {
  await clickFrom(page, 2);
  await expectRangeAndContents(page, diffResponses, 2, 0);
  // Now click To on item 3 — older than From=2. The would-be range (2..3
  // by index means the "end" rev < "start" rev) is invalid, so the
  // interceptor takes both bounds from the click target (item 3).
  await clickTo(page, 3);
  await expectRangeAndContents(page, diffResponses, 3, 3);
});

test('with a range selected, clicking an item (inside or outside) resets to from=to', async ({ page, diffResponses }) => {
  await clickFrom(page, 3);
  await clickTo(page, 0);
  await expectRangeAndContents(page, diffResponses, 3, 0);

  // Click an item inside the range → both bounds collapse to that item.
  await clickListitem(page, 2);
  await expectRangeAndContents(page, diffResponses, 2, 2);

  // Rebuild the range, then click an item outside it.
  await clickFrom(page, 3);
  await clickTo(page, 1);
  await expectRangeAndContents(page, diffResponses, 3, 1);
  await clickListitem(page, 0);
  await expectRangeAndContents(page, diffResponses, 0, 0);

  // Rebuild, click on one of the endpoints (the From item) — should also
  // collapse to that item.
  await clickFrom(page, 2);
  await clickTo(page, 0);
  await expectRangeAndContents(page, diffResponses, 2, 0);
  await clickListitem(page, 2);
  await expectRangeAndContents(page, diffResponses, 2, 2);
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

test('Diff full history (item[0] already selected): spans full list, item[0] stays selected', async ({ page, logs, diffResponses }) => {
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
  // Full history: before is empty (rev 0 had nothing), after matches the
  // newest recorded version.
  const { before: diffBefore, after: diffAfter } = await extractDiffContents(page, diffResponses);
  expect(diffBefore).toBe('');
  // Sweep must have run first; loud failure if not — matches expectDiffContents' ethos.
  if (!recordedVersions.length) {
    throw new Error('recordedVersions is empty — the content-chain sweep must run before this test.');
  }
  expect(diffAfter).toBe(recordedVersions[0].after);
});

test('Diff full history (item[0] not selected): spans full list, item[0] becomes selected', async ({ page, logs, diffResponses }) => {
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
  const { before: diffBefore, after: diffAfter } = await extractDiffContents(page, diffResponses);
  expect(diffBefore).toBe('');
  // Sweep must have run first; loud failure if not — matches expectDiffContents' ethos.
  if (!recordedVersions.length) {
    throw new Error('recordedVersions is empty — the content-chain sweep must run before this test.');
  }
  expect(diffAfter).toBe(recordedVersions[0].after);
});

test('clicking the oldest version: before content is empty', async ({ page, diffResponses }) => {
  const state = await getRangeState(page);
  const n = state.itemCount;
  expect(n).toBeGreaterThan(0);
  await clickListitem(page, n - 1);
  await expectRange(page, n - 1, n - 1);
  const { before } = await extractDiffContents(page, diffResponses);
  expect(before).toBe('');
});

test('From=oldest, To=second-oldest: before empty, after non-empty', async ({ page, diffResponses }) => {
  const state = await getRangeState(page);
  const n = state.itemCount;
  expect(n).toBeGreaterThan(1);
  await clickFrom(page, n - 1);
  await clickTo(page, n - 2);
  await expectRange(page, n - 1, n - 2);
  const { before, after } = await extractDiffContents(page, diffResponses);
  expect(before).toBe('');
  expect(after.length).toBeGreaterThan(0);
});

test('URL rewrite: setting From=item[2], To=item[0] sends start=item2.start, end=item0.end', async ({ page, logs, diffResponses }) => {
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
  // Content check: From=2..To=0 — after = newest (idx 0), before = idx 3's after.
  await expectDiffContents(page, diffResponses, 2, 0);
});
