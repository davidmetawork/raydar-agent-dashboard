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
import { attachProtectedSubs } from "../api/paraai/_lib/outreach.mjs";

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
  assert.deepEqual(reads, ["msg-1", "msg-2", "msg-3"], "a message already seen is never read again");
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /new Paraform sender .*new\.person@paraform\.com/);
  assert.match(alerts[1], /NOT handled/);
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
