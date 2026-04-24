/**
 * Behavioral tests: the From/To range-selection flow.
 *
 * Covers moving From, moving To (newer and older than current From),
 * collapsing a range via a plain listitem click, and the URL rewrite that
 * happens when inputs disagree with Docs' natural click-generated params.
 */

import { test, expect } from './fixtures';
import {
  expectOverrides,
  clickListitem,
  clickFrom,
  clickTo,
  lastRewroteRange,
} from './helpers';
import {
  createRecorder,
  registerBeforeEachReset,
  registerContentChainSweep,
  expectDiffContents,
  expectRangeAndContents,
} from './version-range-shared';

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

test('To on an item OLDER than current From: captures both bounds on click target', async ({ page, diffResponses }) => {
  await clickFrom(page, 2);
  await expectRangeAndContents(page, diffResponses, recorder, 2, 0);
  // Now click To on item 3 — older than From=2. The would-be range (2..3
  // by index means the "end" rev < "start" rev) is invalid, so the
  // interceptor takes both bounds from the click target (item 3).
  await clickTo(page, 3);
  await expectRangeAndContents(page, diffResponses, recorder, 3, 3);
});

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
