/**
 * Behavioral tests: the Diffs|Versions mode toggle.
 *
 * Diffs mode is the default — From/To/Diff highlights, range-based showrevision.
 * Versions mode renders one revision at a time (no diff), no highlights.
 *
 * The sweep populates per-version diff contents in Diffs mode; the Versions
 * tests then flip into Versions mode and verify the displayed single-version
 * content equals each version's `after` (no `before`).
 */

import { test, expect } from './fixtures';
import {
  expectRange,
  expectOverrides,
  getRangeState,
  getMode,
  clickModeToggle,
  clickListitem,
  clickFrom,
  extractVersionContents,
} from './helpers';
import {
  createRecorder,
  registerBeforeEachReset,
  registerContentChainSweep,
  expectRangeAndContents,
} from './version-range-shared';

const recorder = createRecorder();

registerBeforeEachReset();
registerContentChainSweep(recorder);

test('default mode is diffs; toggle to versions clears highlights and overrides', async ({ page }) => {
  expect(await getMode(page)).toBe('diffs');
  // Diffs mode invariant: at least one button is highlighted.
  const before = await getRangeState(page);
  expect(before.fromIdx).toBeGreaterThanOrEqual(0);
  expect(before.toIdx).toBeGreaterThanOrEqual(0);

  await clickModeToggle(page, 'versions');

  expect(await getMode(page)).toBe('versions');
  // Versions mode invariant: no buttons highlighted.
  const after = await getRangeState(page);
  expect(after.fromIdx).toBe(-1);
  expect(after.toIdx).toBe(-1);
  expect(after.inBetweenIdxs).toEqual([]);
  // Overrides cleared so the rewrite branch is a no-op for Versions URLs.
  expect(after.overrides.start).toBe('');
  expect(after.overrides.end).toBe('');
});

test('toggle back to diffs re-applies From=To highlights on the selected version', async ({ page }) => {
  await clickModeToggle(page, 'versions');
  await clickModeToggle(page, 'diffs');

  expect(await getMode(page)).toBe('diffs');
  // Init-capture style restoration: From=To on the currently-selected version.
  const state = await getRangeState(page);
  expect(state.fromIdx).toBeGreaterThanOrEqual(0);
  expect(state.fromIdx).toBe(state.toIdx);
  expect(state.fromIdx).toBe(state.selectedIdx);
});

test('versions mode button visibility: Diff (unlit) on selected, End above, Start below', async ({ page }) => {
  // Move selection to a middle item so we can verify both above-and-below
  // visibility rules. Sweep ran in Diffs mode, so item N-1 was the last
  // clicked — beforeEach reset puts us back on item 0; click item 2 first.
  await clickListitem(page, 2);
  await clickModeToggle(page, 'versions');

  const visibility = await page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('[aria-label="Versions"] [role="listitem"]')
    );
    const selIdx = items.findIndex((it) => {
      const c = (it as HTMLElement).className || '';
      return c.indexOf('SelectedTile') !== -1 && c.indexOf('UnselectedTile') === -1;
    });
    const isVisible = (el: Element | null): boolean => {
      if (!el) return false;
      const cl = el.classList;
      // For dr-version-from-btn / dr-version-to-btn: visible unless dr-btn-hidden.
      // For dr-version-both-btn: visible only if dr-btn-shown.
      if (cl.contains('dr-version-both-btn')) return cl.contains('dr-btn-shown');
      return !cl.contains('dr-btn-hidden');
    };
    return items.map((it, i) => ({
      i,
      selected: i === selIdx,
      from: isVisible(it.querySelector('.dr-version-from-btn')),
      to: isVisible(it.querySelector('.dr-version-to-btn')),
      both: isVisible(it.querySelector('.dr-version-both-btn')),
      bothLit: !!it.querySelector('.dr-version-both-btn.dr-btn-highlighted'),
    }));
  });

  const sel = visibility.findIndex((v) => v.selected);
  expect(sel).toBe(2);
  for (const v of visibility) {
    if (v.i === sel) {
      expect(v, `selected row ${v.i}`).toMatchObject({ from: false, to: false, both: true, bothLit: false });
    } else if (v.i < sel) {
      expect(v, `row ${v.i} above selected`).toMatchObject({ from: false, to: true, both: false });
    } else {
      expect(v, `row ${v.i} below selected`).toMatchObject({ from: true, to: false, both: false });
    }
  }
});

test('versions mode: End here on newer revision builds range from selected.start to target.end', async ({ page, diffResponses }) => {
  // Special case: in Versions mode the selected item's `start` isn't known
  // (Versions URLs only carry `end`). Clicking End here on a newer revision
  // should switch to Diffs (which fetches start+end for the selected item)
  // and capture the target's end as To, producing a range `selected.start .. target.end`.
  await clickListitem(page, 2);
  await clickModeToggle(page, 'versions');
  expect(await getMode(page)).toBe('versions');

  // End here on item 0 (newer than selected item 2).
  await page
    .locator('[aria-label="Versions"] [role="listitem"]')
    .nth(0)
    .locator('.dr-version-to-btn')
    .click();
  // Wait for the resulting capture to settle. Two refetches happen: the
  // Diffs-mode toggle, then the target click. The final state has From on
  // item 2 and To on item 0.
  await page.waitForFunction(
    () => {
      const items = Array.from(document.querySelectorAll('[aria-label="Versions"] [role="listitem"]'));
      const fromHL = document.querySelector('.dr-version-from-btn.dr-btn-highlighted');
      const toHL = document.querySelector('.dr-version-to-btn.dr-btn-highlighted');
      if (!fromHL || !toHL) return false;
      const fromItem = fromHL.closest('[role="listitem"]');
      const toItem = toHL.closest('[role="listitem"]');
      return items.indexOf(fromItem!) === 2 && items.indexOf(toItem!) === 0;
    },
    null,
    { timeout: 5000 }
  );

  expect(await getMode(page)).toBe('diffs');
  await expectRangeAndContents(page, diffResponses, recorder, 2, 0);
});

test('versions mode: clicking each revision shows that revision\'s after content with empty before', async ({ page, diffResponses }) => {
  // Sweep ran in beforeEach (Diffs mode) — per-item ends + after content
  // are recorded in `recorder`. Switch to Versions and verify the displayed
  // single-version content for each item.
  await clickModeToggle(page, 'versions');
  expect(await getMode(page)).toBe('versions');

  const N = recorder.versions.length;
  expect(N).toBeGreaterThan(0);

  for (let i = 0; i < N; i++) {
    if (i > 0) {
      // Item 0 is selected by the toggle's initial refetch; clicking it
      // would no-op. For other items, click body to select; Docs fires
      // ?end=E (no start) and we don't intercept (Versions mode skips the
      // mousedown delegation).
      await clickListitem(page, i);
    }
    const expectedEnd = recorder.versionEnds[i];
    const { before, after } = await extractVersionContents(page, diffResponses, expectedEnd);
    expect(before, `item[${i}] versions-mode before should be empty`).toBe('');
    expect(after, `item[${i}] versions-mode after should match the diff sweep's after`).toBe(recorder.versions[i].after);
  }
});

test('versions mode: Start here on older revision builds range from target.start to selected.end', async ({ page, diffResponses }) => {
  // Selected is item 0 (init). Switching to Versions mode then clicking
  // "Start here" on item 3 (older) should produce a divergent range
  // anchored on the previously-selected revision: From=item3, To=item0.
  // The transition first captures item 0's natural start+end via
  // enterDiffsMode's toggle, then the target click sets From=item3.
  await clickModeToggle(page, 'versions');
  expect(await getMode(page)).toBe('versions');

  await clickFrom(page, 3);

  expect(await getMode(page)).toBe('diffs');
  await expectRangeAndContents(page, diffResponses, recorder, 3, 0);
});

test('versions mode invariant: no showrevision URL should have start=', async ({ page, diffResponses, logs }) => {
  // Switch to Versions, walk a few items, and verify that no `[DiffRange]
  // Versions mode invariant` warning fired and no recorded showrevision had
  // a start parameter while we were in Versions mode.
  await clickModeToggle(page, 'versions');
  diffResponses.clear();
  logs.clear();

  for (const i of [1, 2, 3]) {
    await clickListitem(page, i);
    const expectedEnd = recorder.versionEnds[i];
    await extractVersionContents(page, diffResponses, expectedEnd);
  }

  const offending = diffResponses.all().filter((e) => e.start !== undefined);
  expect(offending, 'no showrevision URLs should have start= while in Versions mode').toEqual([]);
  const warnings = logs.all().filter((l) => l.includes('Versions mode invariant'));
  expect(warnings, 'no Versions-mode invariant warnings should fire').toEqual([]);
});

test('Diff full history from versions mode: switches to diffs and spans full range', async ({ page, diffResponses, logs }) => {
  await clickModeToggle(page, 'versions');
  expect(await getMode(page)).toBe('versions');

  // The init-capture log we want is the one with concrete digits, not the
  // "no start" placeholder one that fires when the previous session left
  // Highlight changes off — that one carries `(mode=both)` too but the
  // start/end placeholders don't parse.
  const initLog = logs.all().find((l) => /orig request:\s*\d+\s*to\s*\d+\s*\(mode=both\)/.test(l));
  const initM = initLog?.match(/orig request:\s*(\d+)\s*to\s*(\d+)/);
  if (!initM) throw new Error('no init-capture orig request in logs');
  const maxRev = Number(initM[2]);

  await page.locator('.dr-full-history-btn').click();
  // Diff full history switches mode synchronously and fires a refetch — wait
  // for the refetch to land via overrides settling and a rewrite log.
  await page.waitForFunction(
    (expected) =>
      document.body.dataset.drMode === 'diffs' &&
      document.body.dataset.drOverrideStart === String(expected.start) &&
      document.body.dataset.drOverrideEnd === String(expected.end),
    { start: 1, end: maxRev },
    { timeout: 5000 }
  );

  expect(await getMode(page)).toBe('diffs');
  const state = await getRangeState(page);
  expect(state.itemCount).toBeGreaterThan(1);
  await expectRange(page, state.itemCount - 1, 0);
  await expectOverrides(page, 1, maxRev);
});
