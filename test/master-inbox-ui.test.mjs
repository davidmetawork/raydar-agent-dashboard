import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contacts, contactLabel, displayText, logicalMessages, replyDefaults, parseFilters, composeQuery, feedQuery, rowParticipant, externalParticipant, splitQuotedText, attachmentStatus, createSaveQueue, createSendRequest, requestGate } from '../master-inbox-model.mjs';

/* EVERY file this suite reads from source is named in THIS block and nowhere
   else. When the page moves again, only these constants move; the assertions
   below keep pointing at whatever they name. (Slice 1's rule, carried through
   the split: the one-file page became five files, so the constant became a
   block.) */
const PAGE_SOURCE = '../master-inbox.mjs';
const SHELL_SOURCE = '../master-inbox.html';
const STYLE_SOURCE = '../master-inbox.css';
const COMPOSER_SOURCE = '../master-inbox-composer.mjs';
const MODEL_SOURCE = '../master-inbox-model.mjs';
const ROUTE_SOURCE = '../master-inbox-route.js';
const DASHBOARD_SHELL_SOURCE = '../index.html';
const FEED_PROXY_SOURCE = '../api/master-inbox/feed.mjs';
const DOWNLOAD_PROXY_SOURCE = '../api/master-inbox/_lib/download.mjs';
const DRAFT_ATTACHMENT_PROXY_SOURCE = '../api/master-inbox/draft-attachment.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const page = read(PAGE_SOURCE);
const shell = read(SHELL_SOURCE);
const style = read(STYLE_SOURCE);
const composer = read(COMPOSER_SOURCE);
const model = read(MODEL_SOURCE);
const route = read(ROUTE_SOURCE);
const dashboard = read(DASHBOARD_SHELL_SOURCE);
const feedProxy = read(FEED_PROXY_SOURCE);
const download = read(DOWNLOAD_PROXY_SOURCE);
const draftAttachmentProxy = read(DRAFT_ATTACHMENT_PROXY_SOURCE);

// ---------------------------------------------------------------- behaviour

test('participant parsing keeps provider JSON out of labels and decodes text safely', () => {
  assert.deepEqual(contacts('{"name":"Alex Example","address":"alex@example.test"}'), [{ name: 'Alex Example', address: 'alex@example.test' }]);
  assert.equal(contactLabel('[{"name":"Alex &amp; Team","address":"alex@example.test"}]'), 'Alex & Team');
  assert.equal(displayText('&lt;script&gt;'), '<script>');
  assert.equal(rowParticipant({ last_direction: 'outbound', latest_to: [{ name: 'Candidate', address: 'candidate@example.test' }], participant_text: 'David' }), 'Candidate');
});

test('a Sent row names the person outside the company, and says nothing when there is none', () => {
  const own = ['david@example.test', 'recruiting@example.test', 'noah@example.test'];
  const row = { last_direction: 'outbound', latest_from: [{ address: 'recruiting@example.test' }], latest_to: [{ name: 'Alex Example', address: 'alex@example.test' }], participant_text: '[{"address":"david@example.test"}]' };
  assert.equal(externalParticipant(row, own), 'Alex Example');
  // Best effort, and honest about it: an internal-only thread has no outside
  // person, so the caller falls back to the recorded label.
  assert.equal(externalParticipant({ latest_to: [{ address: 'NOAH@example.test' }], participant_text: '' }, own), '');
});

test('every filter is written as an operator the store parses, and survives the round trip', () => {
  const query = 'from:"Alex Example" to:david@example.test after:2026-09-01 before:2026-09-09 label:unread has:attachment interview notes';
  const filters = parseFilters(query);
  assert.equal(filters.from, 'Alex Example');
  assert.equal(filters.to, 'david@example.test');
  assert.equal(filters.after, '2026-09-01');
  assert.equal(filters.unread, true);
  assert.equal(filters.hasAttachment, true);
  assert.equal(filters.text, 'interview notes');
  assert.equal(composeQuery(filters), query);
  assert.deepEqual(parseFilters(composeQuery(filters)), filters);
});

test('the panel never owns an operator the store does not have, and never invents a parameter', () => {
  // subject: and filename: are not operators in the store; they stay in the
  // text so the search notice can say they were searched as text.
  const filters = parseFilters('subject:Role filename:resume.pdf cc:someone@example.test from:alex@example.test');
  assert.equal(filters.text, 'subject:Role filename:resume.pdf cc:someone@example.test');
  assert.equal(filters.from, 'alex@example.test');
  // A malformed date is not a filter; it is left in the text for the store to
  // report rather than silently dropped.
  assert.equal(parseFilters('after:last-tuesday').after, '');
  assert.equal(parseFilters('after:last-tuesday').text, 'after:last-tuesday');
  // The feed request carries only the five parameters the store parses.
  const params = feedQuery({ folder: 'sent', mailbox: 'noah', q: 'from:alex@example.test' }, 'cursor-value');
  assert.deepEqual([...params.keys()].sort(), ['cursor', 'folder', 'limit', 'mailbox', 'q']);
  assert.equal(params.get('q'), 'from:alex@example.test');
});

test('RFC-identical copies are grouped for reading while preserving every copy', () => {
  const messages = [{ id: 'copy-a', mailbox_id: 'a', rfc_message_id: '<one@example.test>', internal_date: '2026-09-08T10:00:00Z' }, { id: 'copy-b', mailbox_id: 'b', rfc_message_id: '<one@example.test>', internal_date: '2026-09-08T10:00:00Z' }, { id: 'copy-c', mailbox_id: 'a', rfc_message_id: '<two@example.test>', internal_date: '2026-09-08T11:00:00Z' }];
  const grouped = logicalMessages(messages); assert.equal(grouped.length, 2); assert.equal(grouped[0].copies.length, 2); assert.equal(messages.length, 3);
});
const mailbox = { principal: 'david@example.test', visible_addresses: ['david@example.test', 'recruiting@example.test'] };

test('Reply honors incoming Reply-To and the alias that received the message', () => {
  const reply = replyDefaults({ direction: 'inbound', from_json: [{ address: 'notifications@example.test' }], reply_to_json: [{ name: 'Candidate', address: 'candidate@example.test' }], to_json: [{ address: 'recruiting@example.test' }], cc_json: [{ address: 'noah@example.test' }], rfc_message_id: '<parent@example.test>', references_header: ['<older@example.test>'], subject: 'Role' }, mailbox);
  assert.equal(reply.from, 'recruiting@example.test'); assert.deepEqual(reply.to, [{ name: 'Candidate', address: 'candidate@example.test' }]); assert.deepEqual(reply.cc, []); assert.equal(reply.inReplyTo, '<parent@example.test>');
});

test('Reply All removes only this sending mailbox aliases, deduplicates, and excludes Bcc', () => {
  const reply = replyDefaults({ direction: 'inbound', from_json: [{ address: 'candidate@example.test' }], to_json: [{ address: 'recruiting@example.test' }, { address: 'noah@example.test' }], cc_json: [{ address: 'DAVID@example.test' }, { address: 'Noah@example.test' }, { address: 'candidate@example.test' }], bcc_json: [{ address: 'secret@example.test' }] }, mailbox, 'reply-all');
  assert.deepEqual(reply.to.map(item => item.address), ['candidate@example.test']); assert.deepEqual(reply.cc.map(item => item.address), ['noah@example.test']); assert.deepEqual(reply.bcc, []);
});

test('replying to an outbound last message targets the original recipients, not the sender', () => {
  const reply = replyDefaults({ direction: 'outbound', from_json: [{ address: 'david@example.test' }], to_json: [{ address: 'candidate@example.test' }], cc_json: [{ address: 'noah@example.test' }], subject: 'Re: Role' }, mailbox, 'reply-all');
  assert.equal(reply.from, 'david@example.test'); assert.equal(reply.to[0].address, 'candidate@example.test'); assert.equal(reply.cc[0].address, 'noah@example.test'); assert.equal(reply.subject, 'Re: Role');
});

test('quoted history remains recoverable and attachment presence is separate from readiness', () => {
  const original = 'Thanks, Tuesday works.\n\nOn Monday David wrote:\n> Older text\n> More'; const parts = splitQuotedText(original); assert.equal(parts.body + '\n' + parts.quoted, original);
  assert.equal(attachmentStatus({ state: 'pending' }), 'Importing'); assert.equal(attachmentStatus({ state: 'blocked' }), 'Blocked'); assert.equal(attachmentStatus({ state: 'available', downloadAvailable: false }), 'Unavailable'); assert.equal(attachmentStatus({ state: 'available', downloadAvailable: true }), 'Available');
});

test('superseded search and thread reads cannot update the current result', () => { const gate = requestGate(); const old = gate.begin(); const next = gate.begin(); assert.equal(old.current(), false); assert.equal(old.signal.aborted, true); assert.equal(next.current(), true); gate.cancel(); assert.equal(next.current(), false); });

test('draft save queue serializes revision updates and recovers after a failed save', async () => {
  const events = []; let revision = 0; const enqueue = createSaveQueue(async operation => { events.push('start:' + operation); const current = revision; await Promise.resolve(); if (operation === 'fail') throw new Error('conflict'); revision = current + 1; events.push('saved:' + revision); return revision; });
  const first = enqueue('a'); const second = enqueue('b'); assert.deepEqual(await Promise.all([first, second]), [1, 2]); await assert.rejects(enqueue('fail')); assert.equal(await enqueue('c'), 3); assert.deepEqual(events.slice(0, 4), ['start:a', 'saved:1', 'start:b', 'saved:2']);
});

test('an uncertain send repeats the exact saved revision and key without another draft save', async () => {
  let saves = 0; const calls = [];
  const request = createSendRequest({ prepare: async () => ({ id: 'draft-one', revision: ++saves, scheduled_for: '2026-09-10T10:00:00Z' }), makeKey: () => 'send-key', submit: async payload => { calls.push({ ...payload }); if (calls.length === 1) throw Object.assign(new Error('lost_response'), { status: 503 }); return { id: 'send-one', state: 'held', replay: true }; } });
  await assert.rejects(request.run()); assert.equal(request.pending.revision, 1);
  assert.deepEqual(await request.run(), { id: 'send-one', state: 'held', replay: true });
  assert.equal(saves, 1); assert.deepEqual(calls[0], calls[1]); assert.equal(request.pending, null);
});

test('a definite pre-send rejection lets the user correct and save the draft again', async () => {
  let saves = 0;
  const request = createSendRequest({ prepare: async () => ({ id: 'draft-one', revision: ++saves }), makeKey: () => 'key-' + saves, submit: async () => { if (saves === 1) throw Object.assign(new Error('rejected'), { code: 'from_identity_unavailable', status: 409 }); return { id: 'send-two', state: 'held' }; } });
  await assert.rejects(request.run()); assert.equal(request.pending, null); assert.deepEqual(await request.run(), { id: 'send-two', state: 'held' }); assert.equal(saves, 2);
});

test('a malformed success response keeps the send key for confirmation', async () => {
  const request = createSendRequest({ prepare: async () => ({ id: 'draft-one', revision: 1 }), makeKey: () => 'fixed-key', submit: async () => ({}) });
  await assert.rejects(request.run(), error => error.code === 'send_response_unconfirmed'); assert.equal(request.pending.idempotencyKey, 'fixed-key');
});

// ------------------------------------------------------------ page contract

test('mailbox UI uses an inert sandbox preview and preserves explicitly excluded workflows', () => {
  assert.match(page, /document\.createElement\('template'\)/);
  assert.match(page, /frame\.setAttribute\('sandbox', ''\)/);
  assert.doesNotMatch(page, /history\.replaceState/);
  assert.match(page, /RaydarNav\.open/);
  assert.match(shell, /id="accountDrawer"/);
  assert.match(composer, /clientKey: state\.clientKey/);
  assert.match(composer, /await persist\(true\)/);
  assert.doesNotMatch(shell, /Assigned to me|Add internal comment|Complete conversation/);
});

test('the page states coverage from the store and never composes a freshness claim of its own', () => {
  assert.match(page, /ROUTE\.coverageSummary\(state\.coverage/);
  assert.match(page, /ROUTE\.emptyStateText\(state\.coverage\)/);
  assert.match(page, /ROUTE\.searchNotice\(state\.parsed\)/);
  assert.match(page, /state\.parsed = data\.query \|\| null/);
  assert.match(page, /state\.coverage = data\.coverage \|\| null/);
  assert.doesNotMatch(page, /'Shared store current'|"Shared store current"/);
  assert.match(shell, /id="status"/);
  assert.match(shell, /id="searchNotice"/);
  // Counts carry their unit, and say what the unit means.
  assert.match(page, /unread \$\{unread === 1 \? 'message' : 'messages'\}/);
  assert.match(page, /retained message copies in the shared store/);
});

test('routing has exactly one implementation, and the page loads it before it runs', () => {
  assert.match(shell, /<script src="\/master-inbox-route\.js"><\/script>/);
  assert.ok(shell.indexOf('src="/master-inbox-route.js"') < shell.indexOf('src="/master-inbox.mjs"'), 'the route module must be loaded before the page module');
  assert.match(page, /const ROUTE = window\.MasterInboxRoute/);
  assert.match(route, /window\.MasterInboxRoute = api/);
  assert.match(route, /globalThis\.MasterInboxRoute = api/);
  assert.match(route, /module\.exports = api/);
  // The model must not grow a second route parser.
  assert.doesNotMatch(model, /export function (?:parseRoute|routeAddress|normalizedRoute)/);
});

test('the standalone page gates on a Raydar session before it reads any mail', () => {
  assert.match(shell, /id="gate"/);
  assert.match(shell, /id="gsi"/);
  assert.match(page, /window\.RaydarAuth\?\.session\(\)/);
  assert.match(page, /if \(session\?\.authenticated\) return boot\(\)/);
  assert.match(page, /google\.accounts\.id\.renderButton/);
  // The Google script is fetched only when the gate is shown: inside the shell
  // iframe the session already exists, so a static tag would be a third-party
  // request on every page view that can never be used.
  assert.doesNotMatch(shell, /accounts\.google\.com/);
  assert.match(page, /script\.src = 'https:\/\/accounts\.google\.com\/gsi\/client'/);
});

test('the composer can always be dismissed and offers no route the service does not implement', () => {
  // Main's dropped assertion 4, restored in behavioural form: leaving is
  // unconditional, so a draft that cannot be saved (no verified From) still
  // has a way out.
  assert.match(shell, /id="discardDraft"/);
  assert.match(shell, /id="keepEditing"/);
  assert.match(composer, /function discard\(\)/);
  assert.match(composer, /\$\('discardDraft'\)\.onclick = discard/);
  assert.match(composer, /return offerDiscard\('This draft cannot be saved without a sending address\.'\)/);
  // The service supports prepare and commit only, over POST only.
  assert.doesNotMatch(composer, /action: 'copy'/);
  assert.doesNotMatch(composer, /action: 'remove'/);
  assert.doesNotMatch(composer, /draft-attachment\?id=/);
  assert.match(draftAttachmentProxy, /if \(req\.method !== "POST"\)/);
  // The READER is the other call site: it must not build a draft-attachment
  // URL either, or the two drift apart again (the composer link was removed
  // once while fileView kept constructing one).
  assert.doesNotMatch(page, /draft-attachment/);
  assert.match(page, /'\/api\/master-inbox\/attachment\?id='/);
});

test('an attachment download relays the service bytes and never invents a 502', () => {
  assert.match(download, /res\.status\(200\)\.send\(Buffer\.from\(await response\.arrayBuffer\(\)\)\)/);
  assert.doesNotMatch(download, /response\.ok \? 502/);
  assert.doesNotMatch(download, /redirect=1/);
  assert.match(download, /url\.protocol !== "https:"/);
});

test('the feed proxy keeps an explicit allowlist and passes coverage through untouched', () => {
  assert.match(feedProxy, /const FEED_PARAMS = \["q", "mailbox", "folder", "cursor", "limit"\];/);
  assert.match(feedProxy, /params\.set\("strict", "1"\)/);
  assert.match(feedProxy, /\{ \.\.\.feed\.body, configured: true/);
  assert.doesNotMatch(feedProxy, /coverage:/);
});

test('the undo control outlives the hold it belongs to', () => {
  // A seven-second toast must never dismiss the control for a ten-second hold.
  assert.match(page, /function toast\(message, label, handler, duration = label \? 0 : 7000\)/);
  assert.match(page, /Send held · \$\{left\}s remaining to undo/);
  assert.match(page, /receiptTimer = setInterval\(tick, 250\)/);
  // The hold instant is the service's, never a number this page picked.
  assert.match(page, /Date\.parse\(data\.undoUntil \|\| data\.holdUntil \|\| ''\)/);
  assert.match(composer, /Immediate sends include a 10-second undo hold/);
  assert.match(shell, /id="scheduleTimezone"/);
  assert.match(composer, /'Scheduling time zone: ' \+ zone/);
});

// ------------------------------------------------------------------- layout

test('rows are bounded, non-overlapping and reachable, and the list is a real list', () => {
  // The modern equivalents of main's four layout guards: a three-column row
  // grid whose middle column can shrink, a single-pane collapse, and the
  // embedded full-height app.
  assert.match(style, /\.conversation-link\{[^}]*display:grid/);
  assert.match(style, /\.conversation-copy\{min-width:0\}/);
  assert.match(style, /\.participant\{[^}]*text-overflow:ellipsis/);
  assert.match(style, /@media\(max-width:980px\)\{\.reading \.mail-panes\{display:block\}\.reading \.message-list\{display:none\}/);
  assert.match(style, /\.mail-panes\{display:block/);
  assert.match(style, /\.reading \.mail-panes\{display:grid/);
  // Semantics: a screen reader gets a list of rows with one name each.
  assert.match(page, /host\.setAttribute\('role', 'list'\)/);
  assert.match(page, /item\.setAttribute\('role', 'listitem'\)/);
  assert.match(page, /link\.setAttribute\('aria-label'/);
});

test('the phone layout keeps the account controls reachable at 390px', () => {
  assert.match(style, /@media\(max-width:700px\)\{[^@]*\.drawer-toggle\{display:block/);
  assert.match(style, /\.account-drawer\{width:min\(340px,calc\(100% - 20px\)\)/);
  assert.match(shell, /id="openAccounts"/);
  assert.match(shell, /id="drawerMailbox"/);
});

test('no metadata is rendered below the contrast or size floor', () => {
  // Every text colour is a token, and the tokens are the ones measured.
  assert.match(style, /--mi-meta:#5f594f/);
  assert.doesNotMatch(style, /#9b9185|#968b80|#b6a8c9|#89769d|#9b8a78|#978674/);
  assert.doesNotMatch(style, /font-size:9px/);
  assert.match(style, /\.conversation-link:focus-visible\{outline:2px solid var\(--violet\)/);
});

test('the dashboard shell keeps its newer routes and points at the rebuilt inbox', () => {
  assert.match(dashboard, /id="tab-status-v2"/);
  assert.match(dashboard, /frameSrc\("\/submissions-v2","submissions"\)/);
  assert.match(dashboard, /frameSrc\("\/review","review"\)/);
  assert.match(dashboard, /id="master-inbox-frame"[^>]*height:calc\(100vh - 24px\)/);
  assert.match(dashboard, /frameSrc\("\/master-inbox","master-inbox"\)\+"&v=20260910-slice4"/);
});

test('the reader keeps the stable control ids the QA contract addresses', () => {
  // qa/selector-map.json's forbidden_on_real_mail list names these ids: a
  // scripted run avoids them so it cannot archive, export or cancel real mail.
  // A rebuild that drops the ids disarms that guard silently, so the ids are
  // asserted here rather than trusted.
  for (const id of ['backList', 'reply', 'replyAll', 'editDraft', 'continueDraft', 'cancelScheduled', 'archiveAction', 'forward', 'print']) {
    assert.match(page, new RegExp(`, '${id}'\\)`), `the reader toolbar must keep #${id}`);
  }
  assert.match(page, /download\.id = 'exportMessage'/);
  for (const id of ['bulkRead', 'bulkArchive', 'saveDraft', 'send', 'schedule', 'reportProblem', 'compose', 'refresh', 'search', 'loadMore']) {
    assert.ok(shell.includes(`id="${id}"`), `the shell must keep #${id}`);
  }
});

test('the list announces its one-sentence summary, not all fifty rows', () => {
  // A polite live region wrapping #conversationList makes a screen reader read
  // every row's participant, subject, snippet, time and mailbox after each
  // feed load, refresh, filter change and Load more. #listSummary already
  // holds the sentence a reader actually wants, so that is the live region.
  assert.doesNotMatch(shell, /id="conversationList"[^>]*aria-live/);
  assert.match(shell, /id="listSummary" role="status"/);
  assert.match(shell, /id="conversationList"[^>]*aria-busy/);
  assert.match(page, /setAttribute\('role', 'list'\)/);
});
