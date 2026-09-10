import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { contacts, contactLabel, displayText, logicalMessages, replyDefaults, normalizedRoute, routeAddress, parseRoute, feedQuery, rowParticipant, splitQuotedText, attachmentStatus, createSaveQueue, createSendRequest, requestGate } from '../master-inbox-model.mjs';

test('participant parsing keeps provider JSON out of labels and decodes text safely', () => {
  assert.deepEqual(contacts('{"name":"Alex Example","address":"alex@example.test"}'), [{ name: 'Alex Example', address: 'alex@example.test' }]);
  assert.equal(contactLabel('[{"name":"Alex &amp; Team","address":"alex@example.test"}]'), 'Alex & Team');
  assert.equal(displayText('&lt;script&gt;'), '<script>');
  assert.equal(rowParticipant({ last_direction: 'outbound', latest_to: [{ name: 'Candidate', address: 'candidate@example.test' }], participant_text: 'David' }), 'Candidate');
});

test('account, folder, filters and selected conversation survive route serialization', () => {
  const route = normalizedRoute({ folder: 'sent', mailbox: 'noah', q: 'subject:"Role & team"', subject: 'Interview', id: 'id-opaque', after: '2026-09-01', read: 'unread' });
  assert.deepEqual(parseRoute(routeAddress(route)), route);
  const nextFolder = normalizedRoute({ ...route, folder: 'drafts', id: '' });
  assert.equal(nextFolder.mailbox, 'noah');
  assert.equal(feedQuery(nextFolder).get('mailbox'), 'noah');
  assert.equal(feedQuery(nextFolder).get('subject'), 'Interview');
  assert.equal(parseRoute('conversation=legacy-id').id, 'legacy-id');
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
  assert.equal(attachmentStatus({ state: 'pending' }), 'Importing'); assert.equal(attachmentStatus({ state: 'available', downloadAvailable: false }), 'Unavailable'); assert.equal(attachmentStatus({ state: 'available', downloadAvailable: true }), 'Available');
});

test('superseded search and thread reads cannot update the current result', () => { const gate = requestGate(); const old = gate.begin(); const next = gate.begin(); assert.equal(old.current(), false); assert.equal(old.signal.aborted, true); assert.equal(next.current(), true); gate.cancel(); assert.equal(next.current(), false); });

test('draft save queue serializes revision updates and recovers after a failed save', async () => {
  const events = []; let revision = 0; const enqueue = createSaveQueue(async operation => { events.push('start:' + operation); const current = revision; await Promise.resolve(); if (operation === 'fail') throw new Error('conflict'); revision = current + 1; events.push('saved:' + revision); return revision; });
  const first = enqueue('a'); const second = enqueue('b'); assert.deepEqual(await Promise.all([first, second]), [1, 2]); await assert.rejects(enqueue('fail')); assert.equal(await enqueue('c'), 3); assert.deepEqual(events.slice(0, 4), ['start:a', 'saved:1', 'start:b', 'saved:2']);
});

test('mailbox UI uses an inert sandbox preview and preserves explicitly excluded workflows', async () => {
  const source = await readFile(new URL('../master-inbox.mjs', import.meta.url), 'utf8'); const html = await readFile(new URL('../master-inbox.html', import.meta.url), 'utf8'); const composer = await readFile(new URL('../master-inbox-composer.mjs', import.meta.url), 'utf8');
  assert.match(source, /document\.createElement\('template'\)/); assert.match(source, /frame\.setAttribute\('sandbox', ''\)/); assert.doesNotMatch(source, /history\.replaceState/); assert.match(source, /RaydarNav\.open/); assert.match(html, /id="accountDrawer"/); assert.match(composer, /clientKey: state\.clientKey/); assert.match(composer, /await persist\(true\)/); assert.doesNotMatch(html, /Assigned to me|Add internal comment|Complete conversation/);
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
