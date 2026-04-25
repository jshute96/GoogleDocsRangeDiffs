#!/usr/bin/env node
//
// Create a new Google Doc via docs.new, then drive a set of already-running
// Chrome browsers (connected over CDP) to produce a version history by
// rewriting its contents many times from randomly chosen browsers.
//
// Usage:
//   scripts/make-doc-with-versions.mjs --ports 9222,9223 \
//       [--name "Version history test"] [--delay 30] [--count 10] \
//       [--share_to alice@example.com,bob@example.com] \
//       [--doc https://docs.google.com/document/d/<id>/edit]
//
// Point --ports at browsers that are logged in as different Google accounts
// to produce a multi-user version history: the first browser creates the
// doc, then shares it with the signed-in account of each additional
// browser (auto-detected from the "You need access" page), and each edit
// is attributed to the account on the browser that made it.
//
// --doc takes the URL of an existing doc to continue appending versions to,
// rather than creating a new one. It cannot be combined with --name (the
// existing doc keeps its current title). Sharing with other browsers and
// extra --share_to recipients still applies, in case the doc is not yet
// shared with them.
//
// --delay controls the gap between successive edits. Google Docs collapses
// rapid edits by the same user into a single version, and also collapses
// consecutive edits by multiple users into a combined expandable item, so
// delays are necessary to produce multiple visible revisions in the
// version-history UI.
//
// --share_to takes an optional comma-separated list of additional users to
// grant editor access to. These users don't need to correspond to any
// running browser; they're just added to the share list. Users auto-detected
// via "You need access" pages on the --ports browsers are always shared with
// regardless of this flag.
//
// Each browser must already be running with --remote-debugging-port=<port>
// (see scripts/open-browser-with-extension.sh and
// scripts/display-browser-ports.sh to find ports).

import { chromium } from "playwright";
import { parseArgs } from "node:util";

const USAGE = `Usage: scripts/make-doc-with-versions.mjs --ports P[,P...]
       [--name NAME | --doc URL] [--delay SECONDS] [--count N]
       [--share_to EMAIL[,EMAIL...]]`;

const { values } = parseArgs({
  options: {
    name:      { type: "string" },
    doc:       { type: "string" },
    ports:     { type: "string" },
    delay:     { type: "string", default: "30" },
    count:     { type: "string", default: "10" },
    share_to:  { type: "string" },
    help:      { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.ports) {
  console.error("Error: --ports is required (comma-separated list of debugging ports)");
  console.error(USAGE);
  process.exit(1);
}
if (values.doc && values.name) {
  console.error("Error: --doc and --name cannot be combined (--doc keeps the existing doc's title)");
  console.error(USAGE);
  process.exit(1);
}

const existingDocUrl = values.doc;
const name  = values.name ?? "Version history test";
const ports = values.ports.split(",").map(s => Number(s.trim())).filter(Boolean);
const delay = Number(values.delay);
const count = Number(values.count);
const extraShareEmails = (values.share_to ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (ports.length < 1) {
  console.error("--ports must list at least one port");
  process.exit(1);
}
if (existingDocUrl && !/\/document\/d\//.test(existingDocUrl)) {
  console.error("Error: --doc must be a Google Docs URL (containing /document/d/<id>/)");
  process.exit(1);
}

function fail(msg, err) {
  console.error("ERROR: " + msg + (err ? ` (${err.message})` : ""));
  process.exit(1);
}

async function connect(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return browser.contexts()[0];
}

async function waitForEditor(page) {
  // Wait until the Docs canvas editor is present and the title bar is live.
  await page.waitForSelector(".kix-appview-editor", { timeout: 60_000 });
  await page.waitForSelector(".docs-title-input", { timeout: 60_000 });
  // Give Docs a moment to finish initial layout so the first keystrokes land.
  await page.waitForTimeout(1500);
}

async function setDocTitle(page, title) {
  await page.locator(".docs-title-input").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
}

async function replaceContent(page, text) {
  // Click into the editor body, then select-all + delete + type.
  await page.locator(".kix-appview-editor").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

// Open the doc URL in a page. Returns either { state: "open" } once the
// editor is visible, or { state: "needsAccess", email } if the browser is
// signed in as an account that lacks access (so we can share with it).
async function openOrNeedsAccess(page, url) {
  await page.goto(url);
  const editor = page.locator(".kix-appview-editor").first();
  const needsAccess = page.getByRole("heading", { name: /You need access/i }).first();
  await Promise.race([
    editor.waitFor({ state: "visible", timeout: 60_000 }),
    needsAccess.waitFor({ state: "visible", timeout: 60_000 }),
  ]);
  if (await needsAccess.isVisible().catch(() => false)) {
    // The "You're signed in as" chip shows the account email. Grab the
    // first email address we find on the page.
    const email = await page.evaluate(() => {
      const m = (document.body.innerText || "").match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
      return m ? m[0] : null;
    });
    return { state: "needsAccess", email };
  }
  return { state: "open" };
}

// Share the doc from `firstPage` with `emails`. Handles both share-UI
// variants (legacy iframe vs. newer inline dialog) and the autocomplete
// popup that can cover the Notify checkbox after committing a chip.
async function shareWith(firstPage, emails) {
  // Top-right toolbar Share button. Its aria-label starts "Share. ".
  await firstPage.getByRole("button", { name: /^Share\. / }).first().click();

  // The share UI renders in one of two variants depending on the
  // account/experiment cohort:
  //   (a) Inside an iframe at /drivesharing/driveshare (legacy).
  //   (b) As an inline dialog on the top-level page (newer).
  // Poll briefly for the iframe; if it never attaches, use the page.
  let root = firstPage;
  for (let i = 0; i < 10; i++) {
    const n = await firstPage.locator('iframe[src*="/drivesharing/driveshare"]').count();
    if (n > 0) {
      root = firstPage.frameLocator('iframe[src*="/drivesharing/driveshare"]');
      break;
    }
    await firstPage.waitForTimeout(300);
  }

  const input = root.getByLabel(/Add people/i).first();
  await input.waitFor({ state: "visible", timeout: 30_000 });

  for (const email of emails) {
    await input.click();
    await firstPage.keyboard.type(email);
    // Commit the chip. Enter also works when a suggestion dropdown is open.
    await firstPage.keyboard.press("Enter");
  }

  // After committing the last chip the autocomplete suggestions popup can
  // linger and cover the Notify checkbox / Share button. Click the share
  // dialog's own title to dismiss the popup: clicking inside the dialog
  // closes the popup without risking a click-outside that would trip
  // Docs' "Discard unsaved changes?" confirmation.
  await root.getByRole("heading", { name: /^Share / }).first().click();

  // "Notify people" appears only after at least one recipient is added,
  // and is checked by default. Uncheck so Docs does not send email.
  const notify = root.getByRole("checkbox", { name: /Notify people/i });
  try {
    await notify.waitFor({ state: "visible", timeout: 5000 });
    if (await notify.isChecked().catch(() => false)) {
      await notify.uncheck();
    }
  } catch { /* no Notify checkbox (e.g. link-only share) — ignore */ }

  // Primary button: "Send" when Notify is on, "Share" when off, or still
  // "Done" if recipients somehow did not register.
  await root.getByRole("button", { name: /^(Send|Share|Done)$/ }).last().click();

  // Let the share call complete before reloading other browsers.
  await firstPage.waitForTimeout(3000);
}

// 1. Connect to each browser (one context per port).
const ctxs = [];
for (const port of ports) {
  try {
    ctxs.push(await connect(port));
  } catch (e) {
    fail(`Could not connect to browser on port ${port}`, e);
  }
}

// 2-5. In the first browser: either create a new doc (rename it, write
// counter=0) or open the existing doc passed via --doc.
const first = ctxs[0];
const firstPage = await first.newPage();
let docUrl;
let counter = 0;
if (existingDocUrl) {
  try {
    const result = await openOrNeedsAccess(firstPage, existingDocUrl);
    if (result.state !== "open") {
      fail(`First browser on port ${ports[0]} does not have access to ${existingDocUrl}` +
           (result.email ? ` (signed in as ${result.email})` : ""));
    }
    await waitForEditor(firstPage);
    docUrl = firstPage.url();
  } catch (e) {
    fail(`Failed to open existing doc on port ${ports[0]} (landed at ${firstPage.url()})`, e);
  }
} else {
  try {
    await firstPage.goto("https://docs.new");
    // docs.new redirects to /document/d/<id>/edit once the doc is created.
    // If the user is not logged in we land on an accounts page instead, and
    // this wait times out — treat that as a creation failure.
    await firstPage.waitForURL(/\/document\/d\//, { timeout: 60_000 });
    await waitForEditor(firstPage);
    await setDocTitle(firstPage, name);
    docUrl = firstPage.url();
  } catch (e) {
    fail(`Failed to create new doc on port ${ports[0]} (landed at ${firstPage.url()})`, e);
  }

  try {
    await replaceContent(firstPage, `counter ${counter}`);
  } catch (e) {
    fail(`Failed to write initial content on port ${ports[0]}`, e);
  }
}

console.log(`Doc URL: ${docUrl}`);

// 6. Open the doc URL in the other browsers. Each browser will either
// (a) open the editor directly, or (b) hit a "You need access" page
// because it is signed in as a different Google account than the creator.
const pages = [firstPage];
const pendingAccess = []; // { port, page, email }
for (let i = 1; i < ctxs.length; i++) {
  const port = ports[i];
  const p = await ctxs[i].newPage();
  try {
    const result = await openOrNeedsAccess(p, docUrl);
    if (result.state === "open") {
      await waitForEditor(p);
      pages.push(p);
    } else {
      if (!result.email) {
        fail(`Browser on port ${port} needs access but no email was found on the page (landed at ${p.url()})`);
      }
      pendingAccess.push({ port, page: p, email: result.email });
    }
  } catch (e) {
    fail(`Failed to open doc on port ${port} (landed at ${p.url()})`, e);
  }
}

// 6a. Share the doc from the first browser. Share with both (a) accounts
// that hit the "You need access" page in other browsers, and (b) any extra
// emails supplied via --share_to. Dedupe so we don't send the same email
// twice. Reload the pending-access pages afterwards so they pick up edit
// access.
const pendingEmails = pendingAccess.map(x => x.email);
const allShareEmails = Array.from(new Set([...pendingEmails, ...extraShareEmails]));
if (allShareEmails.length > 0) {
  console.log(`Sharing doc with ${allShareEmails.join(", ")}`);

  try {
    await shareWith(firstPage, allShareEmails);
  } catch (e) {
    fail(`Failed to share doc with ${allShareEmails.join(", ")}`, e);
  }

  if (pendingAccess.length > 0) {
    // Give the share grant a moment to propagate to the other browsers
    // server-side before we reload (without this the reload sometimes still
    // lands on the "You need access" page).
    await new Promise(r => setTimeout(r, 1000));

    for (const { port, page } of pendingAccess) {
      try {
        await page.reload();
        await page.waitForURL(/\/document\/d\//, { timeout: 60_000 });
        await waitForEditor(page);
        pages.push(page);
      } catch (e) {
        fail(`Doc still not accessible on port ${port} after sharing (landed at ${page.url()})`, e);
      }
    }
  }
}

// 7. Edit loop.
console.log("Adding versions");

for (let i = 0; i < count; i++) {
  const idx = Math.floor(Math.random() * pages.length);
  counter++;
  await replaceContent(pages[idx], `counter ${counter}`);
  await new Promise(r => setTimeout(r, delay * 1000));
}

console.log(`Added ${count} versions`);
process.exit(0);
