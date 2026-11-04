import assert from "node:assert/strict";
import test from "node:test";

import {
  findProtectedSubmitLink,
  parseProtectedNote,
  parseProtectedSubject,
  protectedSubmitLink,
  scanProtectedNotes,
  watchUnsentProtectedSubs,
} from "../api/paraai/_lib/outreach-protected.mjs";
import { protectedSubCopy } from "../api/paraai/_lib/outreach-copy.mjs";
import { attachProtectedSubs, protectedSubMatch } from "../api/paraai/_lib/outreach.mjs";

const REQ = "cprotectedreq0000000000001";
const CTAR = "cprotectedctar000000000001";
const ROLE = "cprotectedrole000000000001";
const SUBMIT = `https://www.paraform.com/company/acme/${ROLE}/recruit/submit_candidate?single_submission=true&from_submission_request=true&candidate_to_approved_role_id=${CTAR}&submission_request_id=${REQ}`;
// How Gmail delivers it: wrapped, with the inner URL's ?, & and = encoded.
const WRAPPED = `https://www.google.com/url?q=${encodeURIComponent(SUBMIT)}&amp;sa=D&amp;source=editors`;
const DMARC_PASS = "mx.google.com; dkim=pass header.i=@paraform-com.20260707.gappssmtp.com header.s=20260707; spf=pass smtp.mailfrom=staff@paraform.com; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=paraform.com";

const header = (name, value) => ({ name, value });
function note({
  id = "msg-1",
  from = "Paraform Staff <staff.member@paraform.com>",
  subject = "Rating-protected sub: Jane Doe → Acme",
  html = `<div>Jane looks great for <a href="https://www.paraform.com/role/${ROLE}">this role</a>. <a href="${WRAPPED}">Submit here</a></div>`,
  auth = DMARC_PASS,
  internalDate = Date.parse("2026-11-04T16:44:07Z"),
} = {}) {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(internalDate),
    payload: {
      mimeType: "text/html",
      headers: [header("From", from), header("Subject", subject), header("Authentication-Results", auth)],
      body: { data: Buffer.from(html, "utf8").toString("base64url") },
    },
  };
}

test("the protected submit link is read through Gmail's wrapper and needs every marker", () => {
  const link = protectedSubmitLink(WRAPPED);
  assert.equal(link.requestId, REQ);
  assert.equal(link.ctarId, CTAR);
  assert.equal(link.roleId, ROLE);
  assert.equal(link.submitUrl, SUBMIT);
  assert.equal(protectedSubmitLink(SUBMIT.replace("from_submission_request=true", "from_submission_request=false")), null);
  assert.equal(protectedSubmitLink(SUBMIT.replace(/&submission_request_id=[^&]+/, "")), null);
  assert.equal(protectedSubmitLink(SUBMIT.replace("www.paraform.com", "paraform.com.evil.example")), null);
  assert.equal(protectedSubmitLink(`https://www.paraform.com/role/${ROLE}`), null);
  assert.equal(findProtectedSubmitLink(`plain text <${SUBMIT}> trailing`)?.requestId, REQ);
});

test("the subject gives the candidate and the company", () => {
  assert.deepEqual(parseProtectedSubject("Rating-protected sub: Jane Doe → Acme"), { candidateName: "Jane Doe", companyName: "Acme" });
  assert.deepEqual(parseProtectedSubject("Re: Rating-protected sub: Jane Doe -> Acme AI"), { candidateName: "Jane Doe", companyName: "Acme AI" });
  assert.deepEqual(parseProtectedSubject("[Action Required] Something"), {});
});

test("a note counts from ANY authenticated Paraform sender, never from anyone else", () => {
  const record = parseProtectedNote(note()).record;
  assert.equal(record.requestId, REQ);
  assert.equal(record.candidateName, "Jane Doe");
  assert.equal(record.companyName, "Acme");
  assert.equal(record.sender, "staff.member@paraform.com");
  assert.equal(record.noteThreadId, "thread-msg-1");
  assert.equal(record.receivedAt, "2026-11-04T16:44:07.000Z");
  // Someone new at Paraform, no name in the subject: still a protected sub.
  const other = parseProtectedNote(note({ from: "new.person@paraform.com", subject: "Quick one" })).record;
  assert.equal(other.requestId, REQ);
  assert.equal(other.sender, "new.person@paraform.com");
  // Not Paraform: ignored entirely.
  assert.equal(parseProtectedNote(note({ from: "someone@gmail.com" })), null);
  // Paraform in the From header but DMARC did not pass: flagged, never trusted.
  assert.equal(parseProtectedNote(note({ auth: "mx.google.com; dkim=fail; dmarc=fail header.from=paraform.com" })).unparsed.reason, "auth");
  // Talks about a protected sub but the link changed shape: flagged, not dropped.
  assert.ok(parseProtectedNote(note({ html: "<div>Protected sub for Jane, link soon</div>" })).unparsed);
  // Paraform's ordinary notices are none of this.
  assert.equal(parseProtectedNote(note({ subject: "[Action Required] Review", html: `<a href="https://www.paraform.com/role/${ROLE}">Role</a>` })), null);
});

function memoryStore() {
  const subs = new Map();
  const seen = new Set();
  const meta = new Map();
  let slot = true;
  return {
    subs, seen, meta,
    closeSlot: () => { slot = false; },
    store: {
      acquireSlot: async () => slot,
      claimMeta: async (field) => (meta.has(field) ? false : (meta.set(field, "x"), true)),
      getMeta: async () => Object.fromEntries(meta),
      list: async () => [...subs.values()],
      markSeen: async (id) => { seen.add(id); },
      seenIds: async () => new Set(seen),
      save: async (row) => { subs.set(row.requestId, row); },
    },
  };
}

test("the scan stores new notes once, reads each message once, and learns senders quietly on its first run", async () => {
  const memory = memoryStore();
  const messages = new Map([["msg-1", note()]]);
  const reads = [];
  const alerts = [];
  const options = {
    mailbox: "david@raydar.xyz",
    searchImpl: async () => [...messages.keys()].map((id) => ({ id })),
    getMessageImpl: async (_mailbox, id) => { reads.push(id); return messages.get(id); },
    notifyImpl: async (text) => { alerts.push(text); return true; },
    store: memory.store,
  };
  const first = await scanProtectedNotes(options);
  assert.equal(first.scanned, true);
  assert.deepEqual(first.added, [REQ]);
  assert.equal(first.subs.get(REQ).submitUrl, SUBMIT);
  assert.deepEqual(alerts, [], "the first run seeds the known senders without paging");
  // A new Paraform sender after the seed pages once.
  const req2 = "cprotectedreq0000000000002";
  messages.set("msg-2", note({ id: "msg-2", from: "new.person@paraform.com", html: `<a href="${SUBMIT.replace(REQ, req2)}">submit here</a>` }));
  messages.set("msg-3", note({ id: "msg-3", html: "<div>protected sub, but no link</div>" }));
  const second = await scanProtectedNotes(options);
  assert.deepEqual(second.added, [req2]);
  assert.deepEqual(reads, ["msg-1", "msg-3", "msg-2"], "a message already seen is never read again (oldest first)");
  assert.equal(alerts.length, 2);
  assert.match(alerts[1], /new Paraform sender .*new\.person@paraform\.com/);
  assert.match(alerts[0], /NOT handled/);
  // Not due: no Gmail call at all, but the stored subs still come back.
  memory.closeSlot();
  const third = await scanProtectedNotes({ ...options, searchImpl: async () => { throw new Error("must not search"); } });
  assert.equal(third.scanned, false);
  assert.equal(third.subs.size, 2);
});

test("a protected sub still unemailed an hour after its note pages once, saying why", async () => {
  const now = Date.parse("2026-11-04T18:00:00Z");
  const subs = new Map([
    ["a", { requestId: "a", receivedAt: "2026-11-04T16:00:00Z", submitUrl: "https://x/a", candidateName: "Jane Doe", companyName: "Acme" }],
    ["b", { requestId: "b", receivedAt: "2026-11-04T16:00:00Z", submitUrl: "https://x/b" }],
    ["c", { requestId: "c", receivedAt: "2026-11-04T17:30:00Z", submitUrl: "https://x/c" }],
    ["d", { requestId: "d", receivedAt: "2026-11-04T16:00:00Z", submitUrl: "https://x/d" }],
    ["e", { requestId: "e", receivedAt: "2026-10-01T16:00:00Z", submitUrl: "https://x/e" }],
  ]);
  const claimed = new Set();
  const alerts = [];
  const run = () => watchUnsentProtectedSubs({
    subs,
    history: [{ id: "b", status: "submitted" }, { id: "d", status: "pending", reachedOut: false }],
    states: [{ matches: { d: { sentAt: "2026-11-04T16:10:00Z" } } }],
    now,
    claimImpl: async (field) => (claimed.has(field) ? false : (claimed.add(field), true)),
    notifyImpl: async (text) => { alerts.push(text); return true; },
  });
  const flagged = await run();
  assert.deepEqual(flagged.map((row) => row.requestId), ["a", "b"], "not the fresh note, the sent one, or the old one");
  assert.match(alerts[0], /Jane Doe → Acme .*does not show this request/);
  assert.match(alerts[1], /as submitted/);
  assert.deepEqual(await run(), [], "each sub pages once, ever");
  // Notes from before the switch-on, and requests this tick just sent, never page.
  claimed.clear();
  const later = await watchUnsentProtectedSubs({
    subs,
    history: [],
    sentThisTick: ["b"],
    notBeforeMs: Date.parse("2026-11-04T15:00:00Z"),
    now,
    claimImpl: async () => true,
  });
  assert.deepEqual(later.map((row) => row.requestId), ["a", "d"], "d: no states were passed this time");
  const beforeSwitchOn = await watchUnsentProtectedSubs({
    subs, history: [], notBeforeMs: Date.parse("2026-11-04T17:00:00Z"), now, claimImpl: async () => true,
  });
  assert.deepEqual(beforeSwitchOn, []);
});

test("protected copy says interview request, nothing untrue, and no role-details line", () => {
  const input = { firstName: "Jane", roleName: "Founding Engineer", companyName: "Acme", roleUrl: "https://www.paraform.com/share/acme/r1" };
  const fresh = protectedSubCopy(input);
  assert.equal(fresh.subject, "1st Round - Interview Request @ Acme 🎉");
  assert.equal(fresh.text, [
    "Hey Jane,", "", "Hope you are doing well!", "",
    "You have a new interview request for the Founding Engineer @ Acme (https://www.paraform.com/share/acme/r1) role.", "",
    "Based on your background, I think you could be a really strong fit, and I'd love to put you forward for a first-round conversation with the team.", "",
    "Would you be interested? Let me know!", "", "Thanks,",
  ].join("\n"));
  assert.doesNotMatch(fresh.html, /hybrid|days a week|redacted|Founder|digest/i);
  assert.match(protectedSubCopy({ ...input, signatureFollows: false }).html, /Thanks,<br>David/);
  const later = protectedSubCopy({ ...input, existingConversation: true });
  assert.equal(later.subject, null);
  assert.match(later.text, /^Hey Jane,\n\nAnother interview request just came in for the Founding Engineer @ Acme \(.+\) role\. I think your background could be a really strong fit\.\n\nWould you be interested in me putting you forward\? Let me know!\n\nThanks,\nDavid$/);
});

test("only the rows a note names are marked protected", () => {
  const subs = new Map([[REQ, { requestId: REQ, submitUrl: SUBMIT, receivedAt: "2026-11-04T16:44:07.000Z", sender: "x@paraform.com" }]]);
  const rows = attachProtectedSubs([{ id: REQ }, { id: "other" }], subs);
  assert.equal(rows[0].protectedSub.submitUrl, SUBMIT);
  assert.equal(rows[1].protectedSub, undefined);
  assert.deepEqual(attachProtectedSubs([{ id: "x" }], null), [{ id: "x" }]);
});

test("review fixes: lookalike senders and domains are refused", () => {
  assert.equal(parseProtectedNote(note({ from: '"conor@paraform.com" <x@paraform.com.evil.io>' })), null);
  assert.equal(parseProtectedNote(note({ from: "x@paraform.com.evil.io" })), null);
  const lookalikeDmarc = "mx.google.com; dmarc=pass (p=NONE) header.from=paraform.com.evil.io";
  assert.equal(parseProtectedNote(note({ auth: lookalikeDmarc })).unparsed.reason, "auth");
  assert.equal(parseProtectedNote(note({ from: '"Staff" <staff.member@paraform.com>' })).record.sender, "staff.member@paraform.com");
});

test("review fixes: a note naming two requests stores both, and a body-only mention never pages", () => {
  const second = SUBMIT.replace(REQ, "cprotectedreq0000000000003");
  const both = parseProtectedNote(note({ html: `<a href="${WRAPPED}">one</a> <a href="${second}">two</a>` }));
  assert.deepEqual(both.records.map((row) => row.requestId), [REQ, "cprotectedreq0000000000003"]);
  assert.equal(both.records[0].candidateName, null, "a two-request note's subject names neither");
  assert.equal(parseProtectedNote(note({ subject: "Weekly update", html: "<div>about protected submission rules</div>" })), null);
});

test("review fixes: one unreadable message is skipped, a failed search keeps the stored subs, and a chaser on a known note thread never pages", async () => {
  const memory = memoryStore();
  memory.subs.set(REQ, { requestId: REQ, noteThreadId: "thread-msg-1", submitUrl: SUBMIT });
  memory.meta.set("seeded", "x");
  memory.meta.set("sender:staff.member@paraform.com", "x");
  const alerts = [];
  const messages = new Map([
    ["broken", null],
    ["chaser", { ...note({ id: "chaser", subject: "Re: Rating-protected sub: Jane Doe → Acme", html: "<div>any update?</div>" }), threadId: "thread-msg-1" }],
    ["fresh", note({ id: "fresh", html: `<a href="${SUBMIT.replace(REQ, "cprotectedreq0000000000004")}">submit here</a>` })],
  ]);
  const result = await scanProtectedNotes({
    mailbox: "david@raydar.xyz",
    searchImpl: async () => [...messages.keys()].map((id) => ({ id })),
    getMessageImpl: async (_mailbox, id) => {
      if (id === "broken") throw Object.assign(new Error("not found"), { status: 404 });
      return messages.get(id);
    },
    notifyImpl: async (text) => { alerts.push(text); return true; },
    store: memory.store,
  });
  assert.equal(result.failed, 1);
  assert.deepEqual(result.added, ["cprotectedreq0000000000004"], "the message after the broken one is still read");
  assert.equal(memory.seen.has("broken"), false, "the broken one is retried next scan");
  assert.deepEqual(alerts, [], "the chaser is not a new note");
  const failed = await scanProtectedNotes({
    mailbox: "david@raydar.xyz",
    searchImpl: async () => { throw Object.assign(new Error("429"), { code: "GMAIL_RATE_LIMITED" }); },
    store: memory.store,
  });
  assert.equal(failed.error, "GMAIL_RATE_LIMITED");
  assert.equal(failed.subs.size, 2);
});

test("review fixes: a send queued in the Mailroom is not reported unemailed", async () => {
  const subs = new Map([["q", { requestId: "q", receivedAt: "2026-11-04T16:00:00Z", submitUrl: "https://x/q" }]]);
  const flagged = await watchUnsentProtectedSubs({
    subs,
    history: [{ id: "q", status: "pending" }],
    states: [{ matches: {}, outbox: { "match:q": { status: "queued" } } }],
    now: Date.parse("2026-11-04T18:00:00Z"),
    claimImpl: async () => true,
  });
  assert.deepEqual(flagged, []);
});

test("a burst is read over several scans, oldest first", async () => {
  const memory = memoryStore();
  const ids = Array.from({ length: 5 }, (_, i) => `m${i}`);
  const reads = [];
  const options = {
    mailbox: "david@raydar.xyz",
    maxReads: 2,
    searchImpl: async () => ids.map((id) => ({ id })),
    getMessageImpl: async (_mailbox, id) => { reads.push(id); return note({ id, html: `<a href="${SUBMIT.replace(REQ, `cprotectedreq000000000010${id.slice(1)}`)}">x</a>` }); },
    store: memory.store,
  };
  await scanProtectedNotes(options);
  await scanProtectedNotes(options);
  await scanProtectedNotes(options);
  assert.deepEqual(reads, ["m4", "m3", "m2", "m1", "m0"]);
  assert.equal(memory.subs.size, 5);
});

test("the match record says which stored subs the request read holds, and their markers", () => {
  const created = Date.parse("2026-11-04T16:00:00.000Z");
  const subs = new Map([
    ["req-a", { requestId: "req-a", receivedAt: "2026-11-04T18:00:00.000Z" }],
    ["req-b", { requestId: "req-b", receivedAt: "2026-11-04T18:00:00.000Z" }],
    ["req-c", { requestId: "req-c", receivedAt: "2026-11-04T18:00:00.000Z" }],
    ["req-old", { requestId: "req-old", receivedAt: "2026-11-01T18:00:00.000Z" }],
  ]);
  const history = [
    { id: "req-a", status: "pending", reachedOut: false, createdAtMs: created, recipientTypes: ["CANDIDATE"] },
    { id: "req-b", status: "pending", reachedOut: true, createdAtMs: created, reachedOutAtMs: created + 2_000, recipientTypes: [] },
    { id: "req-old", status: "expired", reachedOut: true, createdAtMs: created, reachedOutAtMs: created + 3_600_000, recipientTypes: [] },
    { id: "req-other", status: "pending", reachedOut: false, createdAtMs: created, recipientTypes: [] },
  ];
  const match = protectedSubMatch({
    subs,
    history,
    config: { protectedNotBeforeMs: Date.parse("2026-11-04T17:46:07Z") },
    now: Date.parse("2026-11-04T19:00:00.000Z"),
  });
  assert.equal(match.known, 4);
  assert.equal(match.inRead, 3);
  assert.equal(match.missing, 1);
  assert.deepEqual(match.status, { pending: 2, expired: 1 });
  assert.equal(match.reachedOut, 2);
  assert.equal(match.premarked, 1);
  assert.deepEqual(match.recipientTypes, { CANDIDATE: 1, none: 2 });
  // req-a (not reached out) and req-b (premarked) are admitted; req-old's note
  // predates the switch-on.
  assert.equal(match.admissible, 2);
  assert.deepEqual(match.rows.find((row) => row.requestId === "req-c"), { requestId: "req-c", inRead: false, receivedAt: "2026-11-04T18:00:00.000Z" });
  assert.equal(match.rows.find((row) => row.requestId === "req-b").reachedOutAfterS, 2);
  assert.ok(!JSON.stringify(match).includes("candidate"), "no names or candidate fields in the record");
});

import {
  lookupProtectedSub,
  lookupReason,
  protectedLookupQueue,
  runProtectedLookups,
  sameName,
  syntheticProtectedRequests,
} from "../api/paraai/_lib/outreach-protected-lookup.mjs";

function fakeParaform({ role = { id: "role-1", status: "ACTIVE", title: "Founding Engineer", company: { name: "Acme" } }, crm = [], apps = {}, cursor = null, refuseAt = null } = {}) {
  const calls = [];
  const impl = async (proc, input) => {
    calls.push(proc);
    if (refuseAt != null && calls.length === refuseAt) {
      throw Object.assign(new Error("cap"), { code: "PARAFORM_REQUEST_LANES_RATE_LIMITED" });
    }
    if (proc === "role.getRoleByIdSimple") return role;
    if (proc === "candidateUser.getCRMExternalCandidates") return { items: crm, next_cursor: cursor };
    if (proc === "candidateUser.getCandidateUserApplications") return apps[input.candidate_user_id] || [];
    throw new Error(`unexpected ${proc}`);
  };
  return { impl, calls };
}

const NOTE = Object.freeze({
  requestId: "req-1",
  ctarId: "ctar-1",
  roleId: "role-1",
  candidateName: "Jane Q. Doe",
  companyName: "Acme",
  submitUrl: "https://www.paraform.com/company/acme/role-1/recruit/submit_candidate?from_submission_request=true&submission_request_id=req-1",
  receivedAt: "2026-11-04T18:00:00.000Z",
});

test("names match on first and last name, ignoring case, accents and middle names", () => {
  assert.ok(sameName("Jane Q. Doe", "jane doe"));
  assert.ok(sameName("José Núñez", "Jose Nunez"));
  assert.ok(!sameName("Jane Doe", "Jane Doering"));
  assert.ok(!sameName("Jane Doe", "John Doe"));
});

test("the lookup accepts exactly one person by that name who has the note's role on their record", async () => {
  const { impl, calls } = fakeParaform({
    crm: [
      { id: "cu-1", candidate: { name: "Jane Doe" }, linkedin_user: "janedoe" },
      { id: "cu-2", candidate: { name: "Jane Doe" } },
      { id: "cu-3", candidate: { name: "John Smith" } },
    ],
    apps: { "cu-1": [{ id: "app-9", role_id: "role-1", created_at: "2026-11-04T17:54:00Z" }], "cu-2": [{ id: "app-8", role_id: "role-2", created_at: "2026-11-04T17:54:00Z" }] },
  });
  const record = await lookupProtectedSub(NOTE, { trpcGetImpl: impl, now: Date.parse("2026-11-04T18:05:00Z") });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-1");
  assert.equal(record.roleName, "Founding Engineer");
  assert.equal(record.companyName, "Acme");
  assert.equal(record.nameMatches, 2);
  assert.equal(record.ctarMatch, false);
  // Only the two same-name people are opened, never the third.
  assert.equal(calls.filter((proc) => proc === "candidateUser.getCandidateUserApplications").length, 2);
});

test("two people by that name on the role, nobody on it, or an unreadable role never resolves", async () => {
  const both = fakeParaform({
    crm: [{ id: "cu-1", candidate: { name: "Jane Doe" } }, { id: "cu-2", candidate: { name: "Jane Doe" } }],
    apps: { "cu-1": [{ role_id: "role-1", created_at: "2026-11-04T17:00:00Z" }], "cu-2": [{ role: { id: "role-1" }, created_at: "2026-11-02T17:00:00Z" }] },
  });
  assert.equal((await lookupProtectedSub(NOTE, { trpcGetImpl: both.impl })).status, "ambiguous");
  const nobody = fakeParaform({ crm: [{ id: "cu-1", candidate: { name: "Jane Doe" } }], apps: { "cu-1": [{ role_id: "role-9" }] } });
  assert.equal((await lookupProtectedSub(NOTE, { trpcGetImpl: nobody.impl })).status, "not_found");
  const noRole = fakeParaform({ role: { title: "" } });
  assert.equal((await lookupProtectedSub(NOTE, { trpcGetImpl: noRole.impl })).status, "role_unreadable");
  assert.equal((await lookupProtectedSub({ ...NOTE, candidateName: null }, { trpcGetImpl: nobody.impl })).status, "no_name");
  assert.match(lookupReason({ status: "ambiguous" }), /more than one person/);
  assert.equal(lookupReason({ status: "resolved" }), null);
});

test("the queue takes new notes first, retries not-found three times, and backfills earlier notes once", () => {
  const now = Date.parse("2026-11-04T19:00:00Z");
  const notBeforeMs = Date.parse("2026-11-04T17:46:07Z");
  const sub = (id, receivedAt) => [id, { ...NOTE, requestId: id, receivedAt }];
  const subs = new Map([
    sub("new-a", "2026-11-04T18:30:00Z"),
    sub("new-b", "2026-11-04T18:00:00Z"),
    sub("old-a", "2026-11-04T16:00:00Z"),
    sub("old-b", "2026-11-03T16:00:00Z"),
    sub("in-read", "2026-11-04T18:10:00Z"),
    sub("ancient", "2026-10-20T16:00:00Z"),
  ]);
  const ids = (queue) => queue.map((row) => row.requestId);
  const historyIds = new Set(["in-read"]);
  assert.deepEqual(ids(protectedLookupQueue({ subs, historyIds, notBeforeMs, now, backfill: 1 })), ["new-b", "new-a", "old-a"]);
  const lookups = {
    "new-b": { status: "not_found", attempts: 1, lastTriedAt: "2026-11-04T18:55:00Z" },
    "new-a": { status: "not_found", attempts: 3, lastTriedAt: "2026-11-04T18:00:00Z" },
    "old-a": { status: "not_found", attempts: 1, lastTriedAt: "2026-11-04T18:00:00Z" },
  };
  // new-b is not due for 10 minutes, new-a is out of attempts, old-a used the backfill.
  assert.deepEqual(ids(protectedLookupQueue({ subs, historyIds, lookups, notBeforeMs, now, backfill: 1 })), []);
  assert.deepEqual(ids(protectedLookupQueue({ subs, historyIds, lookups, notBeforeMs, now, backfill: 2 })), ["old-b"]);
});

test("a throttle refusal stops the lookups without spending an attempt", async () => {
  const saved = [];
  const refused = Object.assign(new Error("cap"), { code: "PARAFORM_REQUEST_LANES_RATE_LIMITED" });
  const result = await runProtectedLookups({
    subs: new Map([["req-1", NOTE]]),
    historyIds: new Set(),
    notBeforeMs: Date.parse("2026-11-04T17:46:07Z"),
    now: Date.parse("2026-11-04T18:05:00Z"),
    trpcGetImpl: async () => { throw refused; },
    store: { list: async () => ({}), save: async (record) => { saved.push(record); }, prune: async () => {} },
  });
  assert.equal(result.stopped, "PARAFORM_REQUEST_LANES_RATE_LIMITED");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, "throttled");
  assert.ok(!saved[0].attempts, "a pacing refusal spends no attempt");
});

test("rows are made only for resolved notes from after the switch-on, with every field the send needs", () => {
  const lookups = { "req-1": { status: "resolved", candidateUserId: "cu-1", roleName: "Founding Engineer", companyName: "Acme" } };
  const args = { lookups, historyIds: new Set(), notBeforeMs: Date.parse("2026-11-04T17:46:07Z"), now: Date.parse("2026-11-04T19:00:00Z") };
  const [row] = syntheticProtectedRequests({ ...args, subs: new Map([["req-1", NOTE]]) });
  assert.equal(row.id, "req-1");
  assert.equal(row.status, "pending");
  assert.equal(row.synthetic, true);
  assert.equal(row.ownRequest, true);
  assert.equal(row.reachedOut, false);
  assert.equal(row.protectedSub.submitUrl, NOTE.submitUrl);
  assert.deepEqual(syntheticProtectedRequests({ ...args, subs: new Map([["req-1", { ...NOTE, receivedAt: "2026-11-04T16:00:00Z" }]]) }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, historyIds: new Set(["req-1"]), subs: new Map([["req-1", NOTE]]) }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, lookups: { "req-1": { ...lookups["req-1"], roleName: "" } }, subs: new Map([["req-1", NOTE]]) }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, notBeforeMs: null, subs: new Map([["req-1", NOTE]]) }), []);
});

test("review fixes: too many namesakes, an unfinished search, an old application or a closed role never resolves", async () => {
  const jane = (n) => ({ id: `cu-${n}`, candidate: { name: "Jane Doe" } });
  const recent = [{ role_id: "role-1", created_at: "2026-11-04T17:54:00Z" }];
  const five = fakeParaform({ crm: [1, 2, 3, 4, 5].map(jane), apps: { "cu-5": recent } });
  const crowded = await lookupProtectedSub(NOTE, { trpcGetImpl: five.impl });
  assert.equal(crowded.status, "too_many");
  assert.equal(five.calls.filter((proc) => proc === "candidateUser.getCandidateUserApplications").length, 0);
  const fullPage = Array.from({ length: 50 }, (_, n) => ({ id: `x-${n}`, candidate: { name: `Other Person${n}` } }));
  const endless = fakeParaform({ crm: [jane(1), ...fullPage.slice(1)], cursor: 50, apps: { "cu-1": recent } });
  const unfinished = await lookupProtectedSub(NOTE, { trpcGetImpl: endless.impl });
  assert.equal(unfinished.status, "incomplete");
  assert.equal(unfinished.crmPages, 3);
  // A namesake who applied to the role months ago is not the person the note means.
  const old = fakeParaform({ crm: [jane(1)], apps: { "cu-1": [{ role_id: "role-1", created_at: "2026-06-01T00:00:00Z" }] } });
  assert.equal((await lookupProtectedSub(NOTE, { trpcGetImpl: old.impl })).status, "not_found");
  // ...unless Paraform's own id for that application is the note's protected-sub id.
  const exact = fakeParaform({ crm: [jane(1)], apps: { "cu-1": [{ id: "ctar-1", role_id: "role-1", created_at: "2026-06-01T00:00:00Z" }] } });
  const exactRecord = await lookupProtectedSub(NOTE, { trpcGetImpl: exact.impl });
  assert.equal(exactRecord.status, "resolved");
  assert.equal(exactRecord.ctarMatch, true);
  const closed = fakeParaform({ role: { id: "role-1", status: "PAUSED", title: "Founding Engineer", company: { name: "Acme" } } });
  assert.equal((await lookupProtectedSub(NOTE, { trpcGetImpl: closed.impl })).status, "role_inactive");
  const otherRole = fakeParaform({ role: { id: "role-2", status: "ACTIVE", title: "Founding Engineer", company: { name: "Acme" } } });
  assert.equal((await lookupProtectedSub(NOTE, { trpcGetImpl: otherRole.impl })).status, "role_unreadable");
  assert.match(lookupReason({ status: "too_many" }), /too many people/);
  assert.match(lookupReason(undefined), /does not show this request/);
});

test("review fixes: a pacing refusal mid-lookup is recorded, keeps its attempts, and moves the note back", async () => {
  const saved = [];
  const { impl } = fakeParaform({ crm: [{ id: "cu-1", candidate: { name: "Jane Doe" } }], refuseAt: 3 });
  const now = Date.parse("2026-11-04T18:05:00Z");
  const result = await runProtectedLookups({
    subs: new Map([["req-1", NOTE]]),
    historyIds: new Set(),
    notBeforeMs: Date.parse("2026-11-04T17:46:07Z"),
    now,
    trpcGetImpl: impl,
    store: { list: async () => ({}), save: async (record) => { saved.push(record); }, prune: async () => {} },
  });
  assert.equal(result.stopped, "PARAFORM_REQUEST_LANES_RATE_LIMITED");
  assert.equal(saved[0].status, "throttled");
  assert.equal(saved[0].throttled, 1);
  assert.ok(!saved[0].attempts);
  // Not due again for ten minutes, so the next note goes first.
  assert.deepEqual(protectedLookupQueue({
    subs: new Map([["req-1", NOTE]]), historyIds: new Set(), lookups: { "req-1": saved[0] },
    notBeforeMs: Date.parse("2026-11-04T17:46:07Z"), now: now + 60_000,
  }), []);
});

test("review fixes: an unreadable lookup store runs no lookup", async () => {
  let called = 0;
  const result = await runProtectedLookups({
    subs: new Map([["req-1", NOTE]]),
    historyIds: new Set(),
    notBeforeMs: Date.parse("2026-11-04T17:46:07Z"),
    trpcGetImpl: async () => { called += 1; return null; },
    store: { list: async () => { throw new Error("kv down"); } },
  });
  assert.equal(called, 0);
  assert.equal(result.error, "lookup_store_unreadable");
});
