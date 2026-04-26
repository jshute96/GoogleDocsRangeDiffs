/**
 * Behavioral tests: clicking the expand / collapse arrow on a version
 * listitem.
 *
 * An arrow click is special compared to a body/date click:
 *  - Collapsed: the listitem represents the aggregated range of a whole
 *    sublist of sub-versions.
 *  - Expanded: the *same* listitem represents the narrow range of just its
 *    own single revision; Docs also injects sub-listitems for the siblings.
 *  - Clicking the arrow toggles expansion AND selects the containing
 *    listitem AND fires a fresh showrevision for the new range.
 *
 * The extension treats arrow clicks as `captureMode='both'` on the clicked
 * item — see the "Arrow expand/collapse: selection pass-through" and
 * "Arrow-burst capture" sections in docs/notes-on-google-docs.md. So the
 * end state after an arrow click should always be From=To on the target
 * revision, with overrides / displayed content reflecting the new range.
 *
 * Content checks:
 *  - After collapse, the displayed diff is compared to the content-chain
 *    sweep's recorded before/after for the target listitem (same as the
 *    other split specs). This is strong enough to catch a collapse that
 *    failed to restore the aggregated range.
 *  - After expand, `after` must still match the sweep's `after` (the
 *    parent revision's end state is unchanged — expand only narrows
 *    `start`). `before` can't be pinned to a recorder entry because
 *    sub-revisions aren't indexed there; we assert it's a non-trivial
 *    diff and differs from the collapsed `before`.
 *  - We deliberately do NOT assert `collapsedOverrides !== expandedOverrides`
 *    as a direct comparison: a listitem whose arrow exposes only a single
 *    sub-version has identical collapsed and expanded ranges. The content
 *    checks above catch the real regressions without this brittle edge.
 *
 * We cover the three prior states called out in the design notes, each
 * exercised through expand-then-collapse:
 *   1. Target is not currently the Docs-selected tile.
 *   2. Target IS selected, with From=To already on it.
 *   3. Target IS selected, but only as From (To is on a different item) —
 *      covers the "divergent range, then arrow pins both bounds" case.
 */

import { test, expect } from '../fixtures-extension';
import {
  clickFrom,
  clickListitem,
  extractDiffContents,
  getRangeState,
} from '../helpers-extension';
import {
  createRecorder,
  expectDiffContents,
  registerBeforeEachReset,
  registerContentChainSweep,
  type VersionRecorder,
} from '../version-range-shared';
import type { Page } from '@playwright/test';
import type { DiffResponseBuf } from '../helpers-extension';

const recorder = createRecorder();

registerBeforeEachReset();
// Records each listitem's natural aggregated (collapsed) before/after text.
// Arrow-collapse round-trips restore that exact range, so we can reuse the
// sweep to verify the diff text after every collapse. Expanded-state text is
// checked against the sweep's `after` only (see assertExpandedContents) since
// the sub-revision range's `before` isn't an entry in the sweep.
registerContentChainSweep(recorder);

// Defensive cleanup: if a test fails mid-way and leaves a listitem expanded,
// the next test could pick up a stale Collapse arrow via findExpandedArrowIdx.
// resetRange exits/re-enters VH which usually clears expansion state, but
// Docs' exact behavior on that isn't contractual — collapse any leftovers
// ourselves to be safe. Also runs after a normal successful test; a no-op
// collapse lookup just returns immediately.
test.afterEach(async ({ page }) => {
  const collapseBtn = page.locator(
    '[aria-label="Versions"] [role="listitem"] ' +
    'button[aria-label="Collapse detailed versions"]'
  );
  while (await collapseBtn.count()) {
    await collapseBtn.first().click();
    // Don't care about capture state here — we're just restoring layout
    // between tests, not asserting anything about the click's effect.
    await page.waitForFunction(
      () => !document.querySelector('.dr-pending-capture'),
      null,
      { timeout: 3000 }
    ).catch(() => { /* best-effort cleanup */ });
  }
});

/**
 * Index of the first listitem whose expand arrow is visible (i.e. the item
 * is currently collapsed and has sub-versions to expose). Returns -1 if no
 * such item exists.
 *
 * Options:
 *  - `excludeSelected`: skip the currently-selected tile (case 1 needs an
 *    unselected target so the click exercises the "not selected → select +
 *    expand" path).
 */
async function findCollapsedArrowIdx(
  page: Page,
  opts: { excludeSelected?: boolean } = {}
): Promise<number> {
  return page.evaluate((excludeSelected) => {
    const items = Array.from(
      document.querySelectorAll('[aria-label="Versions"] [role="listitem"]')
    );
    const isSel = (el: Element): boolean => {
      const c = (el as HTMLElement).className || '';
      return c.indexOf('SelectedTile') !== -1 && c.indexOf('UnselectedTile') === -1;
    };
    for (let i = 0; i < items.length; i++) {
      if (excludeSelected && isSel(items[i])) continue;
      if (items[i].querySelector('button[aria-label="Expand detailed versions"]')) return i;
    }
    return -1;
  }, !!opts.excludeSelected);
}

/**
 * Index of the listitem whose arrow now reads "Collapse" — i.e., the one we
 * just expanded. After expand, Docs injects sub-listitems but their arrows
 * stay as Expand; only the parent's flips to Collapse.
 */
async function findExpandedArrowIdx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('[aria-label="Versions"] [role="listitem"]')
    );
    for (let i = 0; i < items.length; i++) {
      if (items[i].querySelector('button[aria-label="Collapse detailed versions"]')) return i;
    }
    return -1;
  });
}

/**
 * Assert the displayed diff matches the *expanded* state of the target
 * listitem: `after` must equal the collapsed `after` (both ranges end at
 * the parent revision's final state — expand only narrows the `start`),
 * and `before` must be some intermediate state strictly newer than the
 * collapsed `before` (a point inside the sublist). We can't pin `before`
 * to a specific recorder entry because sub-revisions aren't indexed there.
 */
async function assertExpandedContents(
  page: Page,
  diffResponses: DiffResponseBuf,
  rec: VersionRecorder,
  targetIdx: number
): Promise<void> {
  expect(
    targetIdx,
    'expand-state content check requires target to be inside the sweep'
  ).toBeLessThan(rec.versions.length);
  const { before, after } = await extractDiffContents(page, diffResponses);
  expect(after, 'expanded after = collapsed after (same parent-revision end state)')
    .toBe(rec.versions[targetIdx].after);
  // `before` in expanded state is narrower than the collapsed `before` — a
  // mid-sublist state. Sanity-check that it's not equal to either endpoint
  // of the recorded chain for this item (the parent's `after` would mean a
  // no-op diff; the item-after-next's `after` would mean expand had no
  // effect on `before`).
  expect(before, 'expanded before != expanded after (non-empty diff)').not.toBe(after);
  if (targetIdx + 1 < rec.versions.length) {
    expect(
      before,
      'expanded before should differ from collapsed before (narrower start)'
    ).not.toBe(rec.versions[targetIdx + 1].after);
  }
}

/**
 * Click the expand-or-collapse arrow on the listitem at `idx`. Waits until
 * both the capture flow has settled AND the arrow-burst window has closed —
 * Docs fires two showrevisions per arrow click (the pre-expand fetch that it
 * then cancels, then the real post-expand fetch), and we want to observe
 * the final overrides, not the transient pre-expand ones.
 */
async function clickArrowAt(page: Page, idx: number): Promise<void> {
  await page
    .locator('[aria-label="Versions"] [role="listitem"]')
    .nth(idx)
    .locator(
      'button[aria-label="Expand detailed versions"], ' +
      'button[aria-label="Collapse detailed versions"]'
    )
    .click();
  await page.waitForFunction(
    () =>
      !document.body.dataset.drCaptureMode &&
      !document.body.dataset.drArrowBurst &&
      !document.querySelector('.dr-pending-capture'),
    null,
    { timeout: 5000 }
  );
}

test('arrow on unselected item: expand then collapse — From=To lands on target for each', async ({
  page,
  diffResponses,
}) => {
  const targetIdx = await findCollapsedArrowIdx(page, { excludeSelected: true });
  expect(
    targetIdx,
    'test doc needs at least one unselected revision with an expand arrow'
  ).toBeGreaterThanOrEqual(0);

  // --- Expand ---
  await clickArrowAt(page, targetIdx);
  const afterExpand = await getRangeState(page);
  expect(afterExpand.fromIdx, 'From lands on target after expand').toBe(targetIdx);
  expect(afterExpand.toIdx, 'To lands on target after expand').toBe(targetIdx);
  expect(afterExpand.selectedIdx, 'Docs made target the SelectedTile').toBe(targetIdx);
  const expandedOverrides = afterExpand.overrides;
  expect(expandedOverrides.start, 'overrides.start set').not.toBe('');
  expect(expandedOverrides.end, 'overrides.end set').not.toBe('');
  await assertExpandedContents(page, diffResponses, recorder, targetIdx);

  // --- Collapse ---
  const collapseIdx = await findExpandedArrowIdx(page);
  // Expansion inserts sub-listitems AFTER the parent, so the parent's index
  // shouldn't shift. Assert it explicitly (consistent with cases 2 and 3).
  expect(collapseIdx, 'collapsed-arrow item should be at the same index as before expand')
    .toBe(targetIdx);
  await clickArrowAt(page, collapseIdx);
  const afterCollapse = await getRangeState(page);
  expect(afterCollapse.fromIdx).toBe(collapseIdx);
  expect(afterCollapse.toIdx).toBe(collapseIdx);
  expect(afterCollapse.selectedIdx).toBe(collapseIdx);
  // Don't compare collapsed vs expanded overrides directly — a listitem whose
  // arrow exposes only a single sub-version has identical collapsed and
  // expanded ranges, which would fail a naive "differs" assertion. The
  // expectDiffContents call below is the real check: it verifies the full
  // recorded before/after for this listitem, which will fail if the collapse
  // click didn't actually restore the aggregated range.
  await expectDiffContents(page, diffResponses, recorder, collapseIdx, collapseIdx);
});

test('arrow on selected item with From=To: expand then collapse — From=To stays on target', async ({
  page,
  diffResponses,
}) => {
  // Put an arrow-bearing item into the "selected with From=To" state by
  // clicking its body first. We still look for one that isn't already the
  // selected tile from init capture, so the body click actually re-selects.
  const targetIdx = await findCollapsedArrowIdx(page, { excludeSelected: true });
  expect(targetIdx, 'test doc needs an unselected revision with an expand arrow')
    .toBeGreaterThanOrEqual(0);

  await clickListitem(page, targetIdx);
  const before = await getRangeState(page);
  expect(before.fromIdx).toBe(targetIdx);
  expect(before.toIdx).toBe(targetIdx);
  expect(before.selectedIdx).toBe(targetIdx);
  const naturalCollapsedOverrides = before.overrides;

  // --- Expand ---
  await clickArrowAt(page, targetIdx);
  const afterExpand = await getRangeState(page);
  expect(afterExpand.fromIdx, 'From stays on target after expand').toBe(targetIdx);
  expect(afterExpand.toIdx, 'To stays on target after expand').toBe(targetIdx);
  expect(afterExpand.selectedIdx).toBe(targetIdx);
  const expandedOverrides = afterExpand.overrides;
  expect(
    `${expandedOverrides.start}:${expandedOverrides.end}`,
    'expand should change the displayed range (sublist → single revision)'
  ).not.toBe(`${naturalCollapsedOverrides.start}:${naturalCollapsedOverrides.end}`);
  await assertExpandedContents(page, diffResponses, recorder, targetIdx);

  // --- Collapse ---
  const collapseIdx = await findExpandedArrowIdx(page);
  expect(collapseIdx).toBe(targetIdx);
  await clickArrowAt(page, collapseIdx);
  const afterCollapse = await getRangeState(page);
  expect(afterCollapse.fromIdx).toBe(targetIdx);
  expect(afterCollapse.toIdx).toBe(targetIdx);
  // Collapsing should round-trip back to the listitem's natural (aggregated)
  // range that we recorded before expanding.
  expect(afterCollapse.overrides.start).toBe(naturalCollapsedOverrides.start);
  expect(afterCollapse.overrides.end).toBe(naturalCollapsedOverrides.end);
  await expectDiffContents(page, diffResponses, recorder, targetIdx, targetIdx);
});

test('arrow on selected item with divergent From/To: expand then collapse — pins From=To on target', async ({
  page,
  diffResponses,
}) => {
  // Defensively verify the divergent-range precondition: the target must be
  // OLDER than the currently-selected tile so clickFrom(target) produces
  // target.start < selected.end (no tookBoth fallback — we want From=target,
  // To=0 and target remains selected after). `registerBeforeEachReset`
  // leaves item 0 selected and idx grows with age, so this holds as long as
  // findCollapsedArrowIdx(excludeSelected) returns something > 0. Explicit
  // check here protects us if the reset regime ever changes.
  const beforeSetup = await getRangeState(page);
  const targetIdx = await findCollapsedArrowIdx(page, { excludeSelected: true });
  expect(
    targetIdx,
    'test doc needs an unselected arrow item older than the currently-selected one'
  ).toBeGreaterThan(beforeSetup.selectedIdx);

  // Set up divergent state: click "From here" on the arrow target — Docs
  // selects the target (body click under the button) and the capture branch
  // moves From to it, while To stays on item 0 (from init capture). End
  // state: SelectedTile=target, From=target, To=0 (divergent since
  // targetIdx > 0).
  await clickFrom(page, targetIdx);
  const before = await getRangeState(page);
  expect(before.selectedIdx, 'target is now the SelectedTile').toBe(targetIdx);
  expect(before.fromIdx, 'From highlighted on target').toBe(targetIdx);
  expect(before.toIdx, 'To still on item 0 (divergent)').toBe(0);

  // --- Expand ---
  // Arrow click captures 'both' on the target, collapsing the divergent
  // range onto the target revision's new (narrow) range.
  await clickArrowAt(page, targetIdx);
  const afterExpand = await getRangeState(page);
  expect(afterExpand.fromIdx, 'From pinned to target by arrow-both capture').toBe(targetIdx);
  expect(afterExpand.toIdx, 'To pinned to target by arrow-both capture').toBe(targetIdx);
  expect(afterExpand.selectedIdx).toBe(targetIdx);
  const expandedOverrides = afterExpand.overrides;
  expect(expandedOverrides.start).not.toBe('');
  expect(expandedOverrides.end).not.toBe('');
  await assertExpandedContents(page, diffResponses, recorder, targetIdx);

  // --- Collapse ---
  const collapseIdx = await findExpandedArrowIdx(page);
  expect(collapseIdx).toBe(targetIdx);
  await clickArrowAt(page, collapseIdx);
  const afterCollapse = await getRangeState(page);
  expect(afterCollapse.fromIdx).toBe(targetIdx);
  expect(afterCollapse.toIdx).toBe(targetIdx);
  // expectDiffContents is the real collapse check — see case 1's matching
  // comment re: single-sub-version arrows making a direct overrides compare
  // unreliable.
  await expectDiffContents(page, diffResponses, recorder, targetIdx, targetIdx);
});
