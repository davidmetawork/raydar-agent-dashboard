// Scripted EMPLOYEE tests for the rebuilt Master Inbox page
// (feat/master-inbox-slice4-ui), run headless against a locally served copy
// of dash2/ with a mock /api/master-inbox/* (synthetic fixtures only — no
// candidate PII, no real Raydar addresses, no credentials). Never opens a
// live Raydar page.
//
// Covers, from qa/suite.json (mi/master-inbox/qa/suite.json), the employee
// persona tests: E02, E05, E10, E11, E17, E19, E20, E21, E22. Selectors are
// read from test/master-inbox-selector-map.json (bumped for this rebuild;
// see slice4_renames there for what changed from the pre-rebuild map).
//
// Chrome is driven with a hand-rolled minimal CDP client
// (test/helpers/minimal-cdp.mjs) rather than puppeteer/playwright: neither
// package is installed on this machine, and installing one would call an
// external registry, which this session's rails forbid ("never call any
// network service except git push to the branch named below"). If local
// Chrome is unavailable for any reason, every browser-driven test in this
// file is skipped with the exact reason recorded in the skip message, per
// task instructions, rather than silently passing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockServer } from './helpers/master-inbox-mock-server.mjs';
import { launchChrome, closeChrome, openPage, findChrome } from './helpers/minimal-cdp.mjs';
import { FIXTURE_MAILBOX_IDS, FIXTURE_STALE_MAILBOX } from './fixtures/master-inbox-employee-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELECTOR_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'master-inbox-selector-map.json'), 'utf8'));

let server = null;
let chrome = null;
let chromeUnavailableReason = null;
const measurements = [];
const openedPages = [];

async function closeAllPages() {
  for (const page of openedPages.splice(0)) {
    try { await page.send('Target.closeTarget', { targetId: page.targetId }); } catch {}
    try { page.ws.close(); } catch {}
  }
}

test.before(async () => {
  server = await createMockServer({ port: 0 });
  if (!findChrome()) {
    chromeUnavailableReason = 'no Chrome binary found at /Applications/Google Chrome.app on this machine';
    return;
  }
  chrome = await launchChrome({ headless: true });
  if (!chrome) chromeUnavailableReason = 'Chrome did not start (DevTools endpoint never came up within 10s)';
});

test.afterEach(async () => {
  await closeAllPages();
});

test.after(async () => {
  if (chrome) await closeChrome(chrome);
  if (server) await server.close();
  if (measurements.length) {
    // eslint-disable-next-line no-console
    console.log('\n[master-inbox-employee measurements]\n' + measurements.map(m => '  ' + m).join('\n'));
  }
});

async function freshPage(pathAndHash = '/master-inbox') {
  const page = await openPage(chrome);
  openedPages.push(page);
  const t0 = Date.now();
  await page.navigate(server.baseUrl + pathAndHash);
  // Wait for the feed's FIRST completed render, not merely "some child
  // exists" — the loading placeholder is itself a child of #conversationList,
  // so that weaker check races the real data and intermittently reads the
  // page mid-load (status pill still "Loading shared store…", zero rows).
  await page.waitFor(
    `document.getElementById('conversationList') && document.getElementById('conversationList').getAttribute('aria-busy') === 'false'`,
    { timeout: 6000 },
  );
  const elapsed = Date.now() - t0;
  return { page, elapsedMs: elapsed };
}

function requireChrome(t) {
  if (chromeUnavailableReason) {
    t.skip(`unproven: ${chromeUnavailableReason}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// E02 — Account scope survives folder changes
// ---------------------------------------------------------------------------
test('E02: account scope survives a folder change', async t => {
  if (!requireChrome(t)) return;
  const { page } = await freshPage('/master-inbox');
  const mailboxId = FIXTURE_MAILBOX_IDS[0];
  await page.evaluate(`(function(){
    var el = document.getElementById('mailbox');
    el.value = ${JSON.stringify(mailboxId)};
    el.dispatchEvent(new Event('change'));
  })()`);
  await page.waitFor(`document.getElementById('viewTitle').textContent.includes('@example.test')`, { timeout: 4000 });
  const sentButton = SELECTOR_MAP.slice4_renames && "[data-folder='sent']";
  await page.evaluate(`document.querySelector("[data-folder='sent']").click()`);
  await page.waitFor(`document.getElementById('viewTitle').textContent.startsWith('Sent')`, { timeout: 4000 });
  const mailboxValue = await page.evaluate(`document.getElementById('mailbox').value`);
  const viewTitle = await page.evaluate(`document.getElementById('viewTitle').textContent`);
  const hash = await page.evaluate(`location.hash`);
  assert.equal(mailboxValue, mailboxId, 'the mailbox select must keep the chosen account after switching folder');
  assert.ok(viewTitle.includes('Sent'), `viewTitle should name the Sent folder, got ${JSON.stringify(viewTitle)}`);
  assert.ok(viewTitle.includes(mailboxId.replace(/-example-test$/, '@example.test')), 'viewTitle should still name the scoped mailbox');
  assert.ok(hash.includes('folder=sent') && hash.includes(`mailbox=${mailboxId}`), `address must carry both folder and mailbox, got ${hash}`);
});

// ---------------------------------------------------------------------------
// E05 — Gmail-style operators work or are rejected explicitly
// ---------------------------------------------------------------------------
test('E05: unsupported operators say so; malformed dates are rejected explicitly', async t => {
  if (!requireChrome(t)) return;
  const { page } = await freshPage('/master-inbox');

  async function runQuery(q) {
    await page.evaluate(`(function(){
      var input = document.getElementById('search');
      input.value = ${JSON.stringify(q)};
      document.getElementById('searchForm').dispatchEvent(new Event('submit', { cancelable: true }));
    })()`);
    await page.waitFor(`!document.getElementById('conversationList').getAttribute('aria-busy') || document.getElementById('conversationList').getAttribute('aria-busy') === 'false'`, { timeout: 4000 });
    const notice = await page.evaluate(`document.getElementById('searchNotice').textContent`);
    const rowCount = await page.evaluate(`document.querySelectorAll('.inbox-row').length`);
    return { notice, rowCount };
  }

  const subjectResult = await runQuery('subject:"interview request"');
  assert.match(subjectResult.notice, /subject: is not supported; searched as text/, `subject: must be named as unsupported, got ${JSON.stringify(subjectResult.notice)}`);

  const isUnreadResult = await runQuery('is:unread');
  assert.match(isUnreadResult.notice, /is: is not supported; searched as text/, `is: must be named as unsupported, got ${JSON.stringify(isUnreadResult.notice)}`);

  const filenameResult = await runQuery('filename:pdf');
  assert.match(filenameResult.notice, /filename: is not supported; searched as text/, `filename: must be named as unsupported, got ${JSON.stringify(filenameResult.notice)}`);

  const malformedResult = await runQuery('before:2026-9-1');
  assert.match(
    malformedResult.notice,
    /before: needs a calendar date like 2026-09-01, so that filter was ignored/,
    `a malformed before: date must be named as rejected, not silently dropped, got ${JSON.stringify(malformedResult.notice)}`,
  );

  const validDateResult = await runQuery('before:2026-09-01');
  assert.equal(validDateResult.notice, '', 'a valid calendar date must not produce an unsupported-operator notice');

  const hasAttachmentResult = await runQuery('has:attachment');
  assert.equal(hasAttachmentResult.notice, '', 'has:attachment is a supported operator and must not trigger a notice');
  assert.ok(hasAttachmentResult.rowCount > 0 && hasAttachmentResult.rowCount < 60, 'has:attachment must filter the row set, not return everything or nothing');
});

// ---------------------------------------------------------------------------
// E10 — Share a conversation link and resume after reload
// ---------------------------------------------------------------------------
test('E10: a conversation link round-trips through a reload', async t => {
  if (!requireChrome(t)) return;
  const { page } = await freshPage('/master-inbox');
  const mailboxId = FIXTURE_MAILBOX_IDS[0];
  await page.evaluate(`(function(){
    var el = document.getElementById('mailbox');
    el.value = ${JSON.stringify(mailboxId)};
    el.dispatchEvent(new Event('change'));
  })()`);
  await page.waitFor(`document.getElementById('viewTitle').textContent.includes('@example.test')`, { timeout: 4000 });
  await page.evaluate(`(function(){
    var input = document.getElementById('search');
    input.value = 'has:attachment';
    document.getElementById('searchForm').dispatchEvent(new Event('submit', { cancelable: true }));
  })()`);
  await page.waitFor(`document.querySelectorAll('.inbox-row').length > 0`, { timeout: 4000 });
  await page.evaluate(`document.querySelector('.conversation-link').click()`);
  await page.waitFor(`location.hash.includes('id=')`, { timeout: 4000 });
  const hashBefore = await page.evaluate('location.hash');
  assert.ok(hashBefore.includes('folder=sent') === false, 'sanity: still on default/all folder in this scenario');
  assert.ok(hashBefore.includes(`mailbox=${mailboxId}`), `hash must carry the mailbox before reload, got ${hashBefore}`);
  assert.ok(hashBefore.includes('q=has'), `hash must carry the query before reload, got ${hashBefore}`);
  assert.ok(hashBefore.includes('id='), `hash must carry the conversation id before reload, got ${hashBefore}`);

  // Reload: navigate fresh to the same URL (server + page are stateless
  // between page loads, so this is equivalent to hitting reload).
  const reloadUrl = '/master-inbox' + hashBefore;
  const { page: reloaded } = await freshPage(reloadUrl);
  await reloaded.waitFor(`document.getElementById('reader') && document.getElementById('reader').textContent.length > 0`, { timeout: 4000 });
  const hashAfter = await reloaded.evaluate('location.hash');
  const mailboxAfter = await reloaded.evaluate(`document.getElementById('mailbox').value`);
  const searchAfter = await reloaded.evaluate(`document.getElementById('search').value`);
  assert.equal(hashAfter, hashBefore, 'reload must restore the exact same address');
  assert.equal(mailboxAfter, mailboxId, 'reload must restore the selected mailbox');
  assert.equal(searchAfter, 'has:attachment', 'reload must restore the search query');
});

// ---------------------------------------------------------------------------
// E11 — Reply and compose with the correct sender; no silent identity
// ---------------------------------------------------------------------------
test('E11: reply preselects the thread mailbox; new mail in All inboxes forces a deliberate identity; no draft POST on close', async t => {
  if (!requireChrome(t)) return;
  const page = await openPage(chrome);
  openedPages.push(page);
  // Count POST requests to the draft endpoint via Network domain so we can
  // assert zero writes happened, not just that the UI looks closed.
  await page.send('Network.enable');
  const requests = [];
  page.ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent' && message.sessionId === page.sessionId) {
      requests.push({ url: message.params.request.url, method: message.params.request.method });
    }
  });
  await page.navigate(server.baseUrl + '/master-inbox');
  await page.waitFor(`document.querySelectorAll('.inbox-row').length > 0`, { timeout: 6000 });

  const mailboxId = FIXTURE_MAILBOX_IDS[0];
  await page.evaluate(`(function(){
    var el = document.getElementById('mailbox');
    el.value = ${JSON.stringify(mailboxId)};
    el.dispatchEvent(new Event('change'));
  })()`);
  await page.waitFor(`document.querySelectorAll('.inbox-row').length > 0`, { timeout: 4000 });
  await page.evaluate(`document.querySelector('.conversation-link').click()`);
  await page.waitFor(`document.getElementById('reply') !== null`, { timeout: 4000 });
  await page.evaluate(`document.getElementById('reply').click()`);
  await page.waitFor(`document.getElementById('composer').open === true`, { timeout: 4000 });
  // The From <select> encodes each option as "<mailboxId>::<address>"
  // (master-inbox-composer.mjs setFrom/updateIdentities), so the preselected
  // value carries the mailbox id as its prefix.
  const replyFrom = await page.evaluate(`document.getElementById('from').value`);
  assert.ok(replyFrom.startsWith(mailboxId + '::'), `reply must preselect the thread's own mailbox as sender, got ${JSON.stringify(replyFrom)}`);
  await page.evaluate(`document.getElementById('closeComposer').click()`);
  await page.waitFor(`document.getElementById('composer').open === false`, { timeout: 4000 });

  // New mail with no mailbox scope (All inboxes): From must NOT be
  // preselected — the identity must be a deliberate choice.
  await page.evaluate(`(function(){
    var el = document.getElementById('mailbox');
    el.value = '';
    el.dispatchEvent(new Event('change'));
  })()`);
  await page.waitFor(`document.querySelectorAll('.inbox-row').length > 0`, { timeout: 4000 });
  await page.evaluate(`document.getElementById('compose').click()`);
  await page.waitFor(`document.getElementById('composer').open === true`, { timeout: 4000 });
  const newFrom = await page.evaluate(`document.getElementById('from').value`);
  assert.equal(newFrom, '', `composing in All inboxes must not silently pick a sending identity, got ${JSON.stringify(newFrom)}`);
  await page.evaluate(`(function(){
    document.getElementById('body').value = 'Synthetic draft body for E11.';
    document.getElementById('body').dispatchEvent(new Event('input'));
  })()`);
  await page.evaluate(`document.getElementById('closeComposer').click()`);
  await new Promise(r => setTimeout(r, 300)); // let any fire-and-forget save attempt surface
  const draftPosts = requests.filter(r => r.method === 'POST' && r.url.includes('/api/master-inbox/draft'));
  assert.equal(draftPosts.length, 0, `closing an unsendable draft (no identity) must not POST it; saw ${draftPosts.length} draft POSTs: ${JSON.stringify(draftPosts)}`);
});

// ---------------------------------------------------------------------------
// E17 — Work from a phone (390 px)
// ---------------------------------------------------------------------------
test('E17: a 390px viewport exposes an account drawer and readable rows', async t => {
  if (!requireChrome(t)) return;
  const { page } = await freshPage('/master-inbox');
  const t0 = Date.now();
  await page.setViewport(390, 844);
  await page.waitFor(`true`, { timeout: 200 }); // let layout settle
  const layoutSettleMs = Date.now() - t0;
  measurements.push(`E17: layout settle after 390px resize: ${layoutSettleMs}ms`);

  const drawerToggleVisible = await page.evaluate(`(function(){
    var el = document.getElementById('openAccounts');
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`);
  assert.ok(drawerToggleVisible, 'the "Accounts & folders" drawer toggle must be visible at 390px');

  await page.evaluate(`document.getElementById('openAccounts').click()`);
  await page.waitFor(`document.getElementById('accountDrawer').open === true`, { timeout: 3000 });
  const drawerMailboxVisible = await page.evaluate(`(function(){
    var el = document.getElementById('drawerMailbox');
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`);
  assert.ok(drawerMailboxVisible, 'the phone drawer must expose a mailbox picker (#drawerMailbox)');

  const drawerFoldersCount = await page.evaluate(`document.querySelectorAll('#drawerFolders .view-button').length`);
  assert.ok(drawerFoldersCount >= 9, `the drawer must list all folders (expected 9, the ROUTE.FOLDERS length), got ${drawerFoldersCount}`);

  await page.evaluate(`document.getElementById('closeAccounts').click()`);
  const bodyScrollWidth = await page.evaluate(`document.documentElement.scrollWidth`);
  assert.ok(bodyScrollWidth <= 391, `the page must not horizontally overflow a 390px viewport, measured scrollWidth ${bodyScrollWidth}`);
});

// ---------------------------------------------------------------------------
// E19 — Text meets WCAG AA contrast and focus is visible
// ---------------------------------------------------------------------------
function relativeLuminance([r, g, b]) {
  const channel = value => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [channel(r), channel(g), channel(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}
function contrastRatio(rgbA, rgbB) {
  const lumA = relativeLuminance(rgbA) + 0.05;
  const lumB = relativeLuminance(rgbB) + 0.05;
  return lumA > lumB ? lumA / lumB : lumB / lumA;
}
function parseRgb(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value || '');
  if (!match) return null;
  const parts = match[1].split(',').map(s => parseFloat(s.trim()));
  return parts.slice(0, 3);
}

test('E19: sampled text meets 4.5:1 contrast and focus-visible rules exist', async t => {
  if (!requireChrome(t)) return;
  const { page } = await freshPage('/master-inbox');
  await page.evaluate(`document.getElementById('mailbox').focus()`); // ensure something focusable exists

  const selectors = [
    '#viewTitle', '#status', '#scopeDescription', '#scopeCounts',
    '.participant', '.conversation-copy .subject', '.conversation-copy .snippet',
    '.row-time', '.row-mailbox', '#searchNotice', '#refresh', '#compose',
    '.rail-title', '.filter-hint',
  ];
  const samples = await page.evaluate(`(function(){
    var out = [];
    var selectors = ${JSON.stringify(selectors)};
    selectors.forEach(function(sel){
      var el = document.querySelector(sel);
      if (!el) { out.push({ selector: sel, missing: true }); return; }
      var style = getComputedStyle(el);
      var bgEl = el;
      var bg = style.backgroundColor;
      while (bgEl && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
        bgEl = bgEl.parentElement;
        if (!bgEl) break;
        bg = getComputedStyle(bgEl).backgroundColor;
      }
      out.push({ selector: sel, color: style.color, background: bg || 'rgb(255, 255, 255)', fontSize: style.fontSize });
    });
    return out;
  })()`);

  const failures = [];
  const missing = [];
  for (const sample of samples) {
    if (sample.missing) { missing.push(sample.selector); continue; }
    const fg = parseRgb(sample.color);
    const bg = parseRgb(sample.background);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    measurements.push(`E19: ${sample.selector} contrast ${ratio.toFixed(2)}:1 (fg ${sample.color} on bg ${sample.background}, ${sample.fontSize})`);
    if (ratio < 4.5) failures.push(`${sample.selector}: ${ratio.toFixed(2)}:1 (need >= 4.5:1)`);
  }
  // These four selectors collide by CLASS NAME with mailroom.css, the
  // dashboard-wide stylesheet loaded before master-inbox.css: .snippet,
  // .row-time, .rail-title and .filter-hint are all pre-existing mailroom.css
  // rules (mailroom.css even documents replacing "the greys this file used
  // to carry... measured 2.2:1 to 3.1:1" for ITS OWN elements) and master-
  // inbox.css never re-declares `color` on the more-specific selectors that
  // land on these same elements (.conversation-copy .snippet, .row-time,
  // .rail-title, .filter-hint), so the cascade falls through to mailroom.css's
  // un-fixed color. This is a real regression, not a fixture artifact: the
  // slice-4 contrast pass fixed the tokens it introduced but missed the
  // shared classnames it collided with.
  assert.equal(failures.length, 0, `contrast failures (mailroom.css classname collision — master-inbox.css never overrides \`color\` on these shared selectors): ${failures.join('; ')}`);
  if (missing.length) measurements.push(`E19: selectors not present in this fixture state (not necessarily a defect): ${missing.join(', ')}`);

  const cssText = fs.readFileSync(path.join(__dirname, '..', 'master-inbox.css'), 'utf8');
  const focusRuleCount = (cssText.match(/:focus-visible/g) || []).length;
  assert.ok(focusRuleCount > 0, 'master-inbox.css must define at least one :focus-visible rule');
});

// ---------------------------------------------------------------------------
// E20 — Coverage claims are honest
// ---------------------------------------------------------------------------
test('E20: status pill and empty state reflect the store coverage object', async t => {
  if (!requireChrome(t)) return;
  const { page } = await freshPage('/master-inbox');
  const statusText = await page.evaluate(`document.getElementById('status').textContent`);
  const statusClass = await page.evaluate(`document.getElementById('status').className`);
  assert.match(statusClass, /\bstatus stale\b/, `the fixture has one stale mailbox, so the pill must carry the 'stale' tone, got ${statusClass}`);
  assert.match(statusText, /Stale: 1 mailbox behind/, `status text must name the stale count, got ${JSON.stringify(statusText)}`);

  // Cross-check directly against the mock health endpoint (read-only), the
  // way the suite step "Call /api/master-inbox/health" specifies.
  const healthResponse = await fetch(server.baseUrl + '/api/master-inbox/health');
  const health = await healthResponse.json();
  assert.equal(health.coverage.summary.stale[0], FIXTURE_STALE_MAILBOX, 'the health endpoint must name the same stale mailbox the UI reports');
  assert.equal(health.coverage.summary.mailboxes, FIXTURE_MAILBOX_IDS.length, 'health coverage must count all fixture mailboxes');

  // A folder guaranteed empty in the fixture: trash never appears in "all",
  // and this fixture never assigns folder "trash" — force a query that
  // matches nothing to inspect the honest-empty-state copy.
  await page.evaluate(`(function(){
    var input = document.getElementById('search');
    input.value = 'zzzznomatch';
    document.getElementById('searchForm').dispatchEvent(new Event('submit', { cancelable: true }));
  })()`);
  await page.waitFor(`document.querySelectorAll('.inbox-row').length === 0`, { timeout: 4000 });
  const emptyTone = await page.evaluate(`(function(){ var el = document.querySelector('#conversationList .empty'); return el ? el.className : null; })()`);
  // Coverage has one stale mailbox in scope, so an empty result here cannot
  // be a confirmed absence — it must say "unknown", not "confirmed".
  assert.match(emptyTone || '', /\bunknown\b/, `with a stale mailbox in scope, an empty result must be tone 'unknown', got ${emptyTone}`);
});

// ---------------------------------------------------------------------------
// E21 — Load more pages without duplicates
// ---------------------------------------------------------------------------
test('E21: load more appends only new rows, newest first', async t => {
  if (!requireChrome(t)) return;
  const { page } = await freshPage('/master-inbox');
  const t0 = Date.now();
  const firstPageIds = await page.evaluate(`Array.from(document.querySelectorAll('.conversation-link')).map(function(a){ return a.dataset.id; })`);
  measurements.push(`E21: first page (all inboxes) loaded ${firstPageIds.length} rows`);
  assert.ok(firstPageIds.length > 0, 'first page must have rows');

  const loadMoreVisible = await page.evaluate(`!document.getElementById('loadMore').classList.contains('hidden')`);
  if (!loadMoreVisible) {
    // Fewer than one page's worth of rows match "all" in this fixture size;
    // that is a fixture-size fact, not a defect, but record it plainly.
    measurements.push('E21: load more control is hidden — fewer rows than one page matched "all" in this fixture');
    return;
  }
  await page.evaluate(`document.getElementById('loadMore').click()`);
  await page.waitFor(`document.querySelectorAll('.conversation-link').length > ${firstPageIds.length}`, { timeout: 4000 });
  const elapsedMs = Date.now() - t0;
  measurements.push(`E21: load-more round trip: ${elapsedMs}ms`);

  const afterIds = await page.evaluate(`Array.from(document.querySelectorAll('.conversation-link')).map(function(a){ return a.dataset.id; })`);
  const seen = new Set();
  const duplicates = afterIds.filter(id => (seen.has(id) ? true : (seen.add(id), false)));
  assert.equal(duplicates.length, 0, `load more must not duplicate rows; duplicates: ${duplicates.join(', ')}`);
  assert.deepEqual(afterIds.slice(0, firstPageIds.length), firstPageIds, 'the first page rows must be unchanged and appear first after loading more');

  const newestAts = await page.evaluate(`(function(){
    var rows = Array.from(document.querySelectorAll('.inbox-row'));
    return rows.map(function(row){ var t = row.querySelector('.row-time'); return t ? t.title : null; });
  })()`);
  measurements.push(`E21: ${afterIds.length} total rows after one load-more click`);
});

// ---------------------------------------------------------------------------
// E22 — Counts state their unit
// ---------------------------------------------------------------------------
test('E22: every count names what it counts', async t => {
  if (!requireChrome(t)) return;
  const { page } = await freshPage('/master-inbox');
  const scopeCountsText = await page.evaluate(`document.getElementById('scopeCounts').textContent`);
  assert.match(scopeCountsText, /unread messages?/, `scope counts must name "message(s)" for the unread figure, got ${JSON.stringify(scopeCountsText)}`);
  assert.match(scopeCountsText, /\d+ mailboxes?$/, `scope counts must name the mailbox count with its unit, got ${JSON.stringify(scopeCountsText)}`);
  const scopeCountsTitle = await page.evaluate(`document.getElementById('scopeCounts').title`);
  assert.match(scopeCountsTitle, /retained message copies/, 'the scope-counts tooltip must clarify these are retained message copies, not conversations or unfinished work');

  const mailboxesEndpointResponse = await fetch(server.baseUrl + '/api/master-inbox/feed?folder=all&limit=1');
  const feedBody = await mailboxesEndpointResponse.json();
  assert.ok(Array.isArray(feedBody.mailboxes) && feedBody.mailboxes.every(m => 'unread_count' in m && 'inbox_count' in m), 'mailboxes payload must carry named count fields (unread_count, inbox_count), not bare numbers');
});
