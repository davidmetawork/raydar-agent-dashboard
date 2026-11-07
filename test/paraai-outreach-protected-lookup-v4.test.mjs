// Lookup v4 for rating-protected subs (2026-11-07, David's rules): the note's
// "Why I think it fits" background, employer matching, one role holder
// resolves whatever the surname looks like, closed roles still send. All
// names and companies here are made up.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTECTED_FIT_TEXT_MAX_TRIES,
  PROTECTED_LOOKUP_VERSION,
  awaitingFitText,
  backgroundHits,
  employersOf,
  lookupProtectedSub,
  lookupReason,
  nameTokens,
  pickLookupProblem,
  protectedLookupQueue,
  roleLinkInRow,
  runProtectedLookups,
  syntheticProtectedRequests,
} from "../api/paraai/_lib/outreach-protected-lookup.mjs";
import { parseProtectedNote, protectedFitText, scanProtectedNotes } from "../api/paraai/_lib/outreach-protected.mjs";

const ROLE = "role-v4";
const RECEIVED = "2026-11-07T18:00:00.000Z";
const NOW = Date.parse("2026-11-07T18:05:00Z");
const RECENT = "2026-11-07T17:54:00Z";
const CRM = "candidateUser.getCRMExternalCandidates";
const APPS = "candidateUser.getCandidateUserApplications";

const note = (candidateName, extra = {}) => ({
  requestId: "req-v4",
  ctarId: "ctar-v4",
  roleId: ROLE,
  candidateName,
  companyName: "Acme",
  submitUrl: `https://www.paraform.com/company/acme/${ROLE}/recruit/submit_candidate?from_submission_request=true&submission_request_id=req-v4`,
  receivedAt: RECEIVED,
  ...extra,
});

// A CRM row; `role` "recent" puts the note's role on the row near the note.
const person = (id, name, { role = null, employers = [] } = {}) => ({
  id,
  name,
  linkedin_user: `li-${id}`,
  roles: role ? [{ role_id: ROLE, created_at: RECENT }] : [{ role_id: "role-other", created_at: RECENT }],
  experiences: employers.map((company_name) => ({ company_name, role_title: "Engineer", start_date: "2020-01-01", end_date: null })),
});

const flatTokens = (value) => nameTokens(value).flatMap((token) => token.split("-")).filter(Boolean);
const searchMatches = (query, name) => {
  const q = flatTokens(query);
  const r = flatTokens(name);
  return q.length > 0 && q.every((token) => r.some((part) => part.startsWith(token)));
};

function fakeParaform({
  role = { id: ROLE, status: "ACTIVE", title: "Founding Engineer", company: { name: "Acme" } },
  people = [],
  honourRoles = false,
  apps = {},
} = {}) {
  const calls = [];
  const impl = async (proc, input) => {
    calls.push({ proc, input });
    if (proc === "role.getRoleByIdSimple") return role;
    if (proc === CRM) {
      const filters = input.filters || {};
      let rows = people.filter((row) => searchMatches(filters.general_search, row.name));
      if (Array.isArray(filters.roles) && honourRoles) rows = rows.filter((row) => roleLinkInRow(row, filters.roles[0]));
      const offset = Number(input.cursor || 0);
      return { items: rows.slice(offset, offset + input.limit), next_cursor: offset + input.limit < rows.length ? offset + input.limit : null };
    }
    if (proc === APPS) return apps[input.candidate_user_id] || [];
    throw new Error(`unexpected ${proc}`);
  };
  return { impl, calls, count: (proc) => calls.filter((call) => call.proc === proc).length };
}

const memoryLookups = (initial = {}) => {
  const saved = [];
  return { saved, store: { list: async () => ({ ...initial }), save: async (record) => { saved.push(record); }, prune: async () => {}, getPick: async () => null } };
};

// ── A. The note's background ────────────────────────────────────────────────

const FIT_NOTE = [
  "<p>Hi David,</p>",
  "<p>Avery is a great match for the Founding Engineer role at Acme.</p>",
  "<p><b>Why I think it fits:</b> senior backend engineer on Apple&#39;s iMessage team since 2021, after building",
  " object storage for Initech&rsquo;s cloud (see https://example.com/profile?id=1) and Oracle Cloud storage APIs.</p>",
  "<p><b>*Why the role is worth a call*</b></p><p>Acme pays well, via Paraform.</p>",
].join("");

test("fitText is the 'Why I think it fits' paragraph only, without links, tags or the role details", () => {
  const fit = protectedFitText(FIT_NOTE);
  assert.equal(fit, "senior backend engineer on Apple's iMessage team since 2021, after building object storage for Initech's cloud (see ) and Oracle Cloud storage APIs.");
  assert.doesNotMatch(fit, /Acme|Paraform|https?:/);
  // Other wordings of the marker, and asterisks around it.
  assert.equal(protectedFitText("*Why I think they fit*: led payments at Globex. *Why the role is worth* more"), "led payments at Globex.");
  assert.equal(protectedFitText("Why I think she fits: Hooli since 2022.\nWHY THE ROLE IS WORTH A CALL: x"), "Hooli since 2022.");
  // No marker: nothing (never the whole body, which names the hiring company).
  assert.equal(protectedFitText("<p>Avery would be great at Acme. Why the role is worth a call: pay.</p>"), "");
  // No end marker: capped at 1200 characters.
  const long = protectedFitText(`Why I think it fits: ${"Worked at Globex on storage. ".repeat(80)}`);
  assert.ok(long.length <= 1200 && long.length > 1000);
  assert.equal(protectedFitText(`Why I think it fits: see www.example.com/x and <https://example.com/y> then Globex.`), "see and then Globex.");
});

const REQ = "cprotectedreq0000000000001";
const CTAR = "cprotectedctar000000000001";
const LINK_ROLE = "cprotectedrole000000000001";
const SUBMIT = `https://www.paraform.com/company/acme/${LINK_ROLE}/recruit/submit_candidate?single_submission=true&from_submission_request=true&candidate_to_approved_role_id=${CTAR}&submission_request_id=${REQ}`;
const DMARC_PASS = "mx.google.com; dkim=pass; spf=pass; dmarc=pass (p=QUARANTINE) header.from=paraform.com";
const gmailMessage = (id, html, internalDate = Date.parse(RECEIVED)) => ({
  id,
  threadId: `thread-${id}`,
  internalDate: String(internalDate),
  payload: {
    mimeType: "text/html",
    headers: [
      { name: "From", value: "Paraform Staff <staff.member@paraform.com>" },
      { name: "Subject", value: "Rating-protected sub: Avery Quill → Acme" },
      { name: "Authentication-Results", value: DMARC_PASS },
    ],
    body: { data: Buffer.from(html, "utf8").toString("base64url") },
  },
});

test("a parsed note stores its fitText on every record, \"\" when it has none", () => {
  const parsed = parseProtectedNote(gmailMessage("msg-fit", `${FIT_NOTE}<a href="${SUBMIT}">Submit here</a>`));
  assert.match(parsed.record.fitText, /^senior backend engineer on Apple's iMessage/);
  const bare = parseProtectedNote(gmailMessage("msg-bare", `<p>Avery for Acme.</p><a href="${SUBMIT}">Submit here</a>`));
  assert.equal(bare.record.fitText, "");
});

function scanStore(initialSubs = []) {
  const subs = new Map(initialSubs.map((row) => [row.requestId, row]));
  const meta = new Map([["seeded", "x"]]);
  const saves = [];
  return {
    subs, saves,
    store: {
      acquireSlot: async () => true,
      claimMeta: async (field) => (meta.has(field) ? false : (meta.set(field, "x"), true)),
      getMeta: async () => Object.fromEntries(meta),
      list: async () => [...subs.values()],
      markSeen: async () => {},
      seenIds: async () => new Set(),
      save: async (row) => { saves.push(row); subs.set(row.requestId, row); },
    },
  };
}

const stored = (requestId, extra = {}) => ({
  requestId, roleId: ROLE, candidateName: "Avery Quill", submitUrl: `https://www.paraform.com/x/${requestId}`,
  noteMessageId: `msg-${requestId}`, receivedAt: RECEIVED, sender: "staff.member@paraform.com", ...extra,
});

test("the scan backfills fitText for stored notes from their note, counts failed reads, and keeps to its read budget", async () => {
  const memory = scanStore([
    stored("req-a"),
    stored("req-b"),
    stored("req-done", { fitText: "" }),
    stored("req-spent", { fitTextTries: PROTECTED_FIT_TEXT_MAX_TRIES }),
    stored("req-old", { receivedAt: "2026-10-20T00:00:00.000Z" }),
    stored("req-nomsg", { noteMessageId: null }),
  ]);
  const reads = [];
  const result = await scanProtectedNotes({
    mailbox: "david@raydar.xyz",
    now: NOW,
    searchImpl: async () => [],
    getMessageImpl: async (_mailbox, id) => {
      reads.push(id);
      if (id === "msg-req-b") throw Object.assign(new Error("gone"), { status: 404 });
      return gmailMessage(id, FIT_NOTE);
    },
    store: memory.store,
  });
  assert.deepEqual(reads.sort(), ["msg-req-a", "msg-req-b"], "only notes in the window, unread, with tries left and a message id");
  assert.match(memory.subs.get("req-a").fitText, /Apple's iMessage/);
  assert.equal(result.subs.get("req-a").fitText, memory.subs.get("req-a").fitText, "the tick sees it at once");
  assert.equal(memory.subs.get("req-b").fitText, undefined);
  assert.equal(memory.subs.get("req-b").fitTextTries, 1);
  assert.equal(result.fitTextRead, 1);
  assert.equal(result.fitTextFailed, 1);
  // The failed one is tried again next scan; a third failure ends its tries.
  await scanProtectedNotes({ mailbox: "m", now: NOW, searchImpl: async () => [], getMessageImpl: async () => { throw new Error("gone"); }, store: memory.store });
  await scanProtectedNotes({ mailbox: "m", now: NOW, searchImpl: async () => [], getMessageImpl: async () => { throw new Error("gone"); }, store: memory.store });
  assert.equal(memory.subs.get("req-b").fitTextTries, 3);
  let more = 0;
  await scanProtectedNotes({ mailbox: "m", now: NOW, searchImpl: async () => [], getMessageImpl: async () => { more += 1; return null; }, store: memory.store });
  assert.equal(more, 0, "no read after the last try");
});

test("the backfill uses only the reads the scan has left after new notes", async () => {
  const memory = scanStore([stored("req-a"), stored("req-b")]);
  const reads = [];
  const fresh = gmailMessage("msg-new", `${FIT_NOTE}<a href="${SUBMIT}">Submit here</a>`);
  const result = await scanProtectedNotes({
    mailbox: "david@raydar.xyz",
    now: NOW,
    maxReads: 2,
    searchImpl: async () => [{ id: "msg-new" }],
    getMessageImpl: async (_mailbox, id) => { reads.push(id); return id === "msg-new" ? fresh : gmailMessage(id, FIT_NOTE); },
    store: memory.store,
  });
  assert.deepEqual(reads, ["msg-new", "msg-req-a"]);
  assert.equal(result.fitTextCapped, true);
  assert.match(memory.subs.get(REQ).fitText, /iMessage/, "a new note carries its fitText");
  assert.equal(memory.subs.get("req-b").fitText, undefined, "left for the next scan");
});

test("the lookup queue waits for a note's background, a few tries at most", () => {
  const notBeforeMs = Date.parse("2026-11-07T00:00:00Z");
  const queue = (sub) => protectedLookupQueue({ subs: new Map([[sub.requestId, sub]]), historyIds: new Set(), notBeforeMs, now: NOW }).length;
  const waiting = note("Avery Quill", { noteMessageId: "msg-1" });
  assert.equal(awaitingFitText(waiting), true);
  assert.equal(queue(waiting), 0, "fitText not read yet: deferred");
  assert.equal(queue({ ...waiting, fitTextTries: 2 }), 0);
  assert.equal(queue({ ...waiting, fitTextTries: PROTECTED_FIT_TEXT_MAX_TRIES }), 1, "tries spent: goes on without it");
  assert.equal(queue({ ...waiting, fitText: "" }), 1, "read, and the note has none");
  assert.equal(queue({ ...waiting, fitText: "Globex since 2020." }), 1);
  assert.equal(queue(note("Avery Quill")), 1, "no note message to read it from");
});

// ── B. Employer matching ────────────────────────────────────────────────────

test("employersOf reads every experience shape, drops generic and short names, and dedupes", () => {
  const row = {
    experiences: [
      { name: "Globex" },
      { company_name: "Initech, Inc." },
      { company: "Hooli" },
      { company: { name: "Umbrella Labs" } },
      { company_name: "Initech" },
      { company_name: "Stealth Startup" },
      { company_name: "Self-Employed" },
      { name: "Freelance" },
      { company_name: "HP" },
      { company_name: "" },
      null,
    ],
    candidate: { experiences: [{ company_name: "Vandelay Industries" }] },
  };
  assert.deepEqual(employersOf(row), ["Globex", "Initech, Inc.", "Hooli", "Umbrella Labs", "Vandelay Industries"]);
  assert.deepEqual(employersOf({}), []);
});

test("backgroundHits: whole capitalised phrases, possessives, legal suffixes, accents, aliases", () => {
  const row = (...names) => ({ experiences: names.map((company_name) => ({ company_name })) });
  // Case rule: a company named like an ordinary word counts only capitalised.
  assert.deepEqual(backgroundHits(row("Block"), "worked on block storage at scale"), []);
  assert.deepEqual(backgroundHits(row("Block"), "led payments at Block for three years"), ["Block"]);
  assert.deepEqual(backgroundHits(row("Meta"), "wrote meta tooling"), []);
  assert.deepEqual(backgroundHits(row("Meta"), "Software Engineer at Meta since 2022"), ["Meta"]);
  // Possessive yes, a longer word no.
  assert.deepEqual(backgroundHits(row("Apple"), "on Apple's iMessage team"), ["Apple"]);
  assert.deepEqual(backgroundHits(row("Apple"), "Apples and oranges"), []);
  assert.deepEqual(backgroundHits(row("Globex"), "Globexian systems"), []);
  // Legal suffixes are not needed in the note.
  assert.deepEqual(backgroundHits(row("Groupon, Inc."), "owned marketplace features end to end at Groupon"), ["Groupon, Inc."]);
  assert.deepEqual(backgroundHits(row("Collibra LLC"), "an AE at Collibra"), ["Collibra LLC"]);
  assert.deepEqual(backgroundHits(row("Initech S.A."), "Initech's platform"), ["Initech S.A."]);
  // Multi-word names as a phrase; accents folded; a parenthesised alias.
  assert.deepEqual(backgroundHits(row("Blue Mountain"), "Strategic Account Executive at Blue Mountain (2024 to 2025)"), ["Blue Mountain"]);
  assert.deepEqual(backgroundHits(row("Zürich Analytics"), "five years at Zurich Analytics"), ["Zürich Analytics"]);
  assert.deepEqual(backgroundHits(row("Hooli (Nucleus)"), "built Nucleus compression"), ["Hooli (Nucleus)"]);
  // Generic employers never count, even capitalised.
  assert.deepEqual(backgroundHits(row("Stealth", "Freelance", "Confidential"), "Stealth work, Freelance, Confidential"), []);
  // The role's own company and Paraform never count.
  assert.deepEqual(backgroundHits(row("Acme Corp", "Paraform", "Globex"), "Acme hired via Paraform; ex Globex", { exclude: ["Acme"] }), ["Globex"]);
  assert.deepEqual(backgroundHits(row("Globex"), ""), []);
});

test("backgroundHits: the first word alone counts only for a long, uncommon first word of a longer name", () => {
  const row = (...names) => ({ experiences: names.map((company_name) => ({ company_name })) });
  assert.deepEqual(backgroundHits(row("Oracle Cloud Infrastructure"), "and Oracle Cloud storage APIs"), ["Oracle Cloud Infrastructure"]);
  assert.deepEqual(backgroundHits(row("Groupon Merchant Services"), "end to end at Groupon"), ["Groupon Merchant Services"]);
  assert.deepEqual(backgroundHits(row("Oracle Cloud Infrastructure"), "an oracle of storage"), [], "not capitalised");
  assert.deepEqual(backgroundHits(row("Meta Platforms"), "at Meta since 2022"), [], "first word under 5 letters");
  assert.deepEqual(backgroundHits(row("Strategic Education"), "Strategic Account Executive at Blue Mountain"), [], "a common title word");
  assert.deepEqual(backgroundHits(row("Senior Living Co"), "Senior engineer"), []);
  assert.deepEqual(backgroundHits(row("Acmeworks Robotics"), "Acmeworks team", { exclude: ["Acmeworks"] }), [], "the role's company");
});

// ── C. The v4 decision ──────────────────────────────────────────────────────

test("rule 1: one role holder shown as 'First L.' resolves, with the background when it agrees", async () => {
  const fit = "Software Engineer at Meta since 2022. Earlier led ranking at Bloomberg.";
  const people = [
    person("cu-q", "Avery Q.", { role: "recent", employers: ["Meta", "Bloomberg"] }),
    person("cu-x", "Avery Q."),
  ];
  const fake = fakeParaform({ people });
  const record = await lookupProtectedSub(note("Avery Quillon", { fitText: fit }), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-q");
  assert.equal(record.confirmedBy, "role+background");
  assert.equal(record.via, "crm_row");
  assert.equal(record.background, "read");
  assert.equal(record.bgMatches, 1);
  assert.deepEqual(record.options[0].backgroundHits, ["Meta", "Bloomberg"]);
  assert.equal(record.options[1].backgroundHits, undefined);
  assert.equal(record.version, PROTECTED_LOOKUP_VERSION);
  // No background on the note: still resolved, on the role alone.
  const plain = await lookupProtectedSub(note("Avery Quillon", { fitText: "" }), { trpcGetImpl: fakeParaform({ people }).impl, now: NOW });
  assert.equal(plain.status, "resolved");
  assert.equal(plain.confirmedBy, "role");
  assert.equal(plain.background, "none");
  // A note naming only an initial resolves on its one holder too.
  const initial = await lookupProtectedSub(note("Avery Q."), { trpcGetImpl: fakeParaform({ people: [person("cu-1", "Avery Quist", { role: "recent" }), person("cu-2", "Avery Quade")] }).impl, now: NOW });
  assert.equal(initial.status, "resolved");
  assert.equal(initial.candidateUserId, "cu-1");
});

test("rule 1: the one holder is held when the background names another namesake's employer and not theirs", async () => {
  const fake = fakeParaform({ people: [
    person("cu-1", "Avery Quill", { role: "recent", employers: ["Initech"] }),
    person("cu-2", "Avery Quill", { employers: ["Groupon"] }),
  ] });
  const record = await lookupProtectedSub(note("Avery Quill", { fitText: "owned marketplace features end to end at Groupon" }), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "background_conflict");
  assert.equal(record.candidateUserId, undefined);
  assert.equal(record.bgMatches, 1);
  assert.match(lookupReason(record), /did not work at the employers the note names/);
  assert.deepEqual(record.options.map((option) => option.candidateUserId), ["cu-1", "cu-2"]);
});

test("too many namesakes to read with one row holder resolves on that holder, without applications reads", async () => {
  const people = [1, 2, 3, 4, 5, 6].map((n) => person(`cu-${n}`, "Rowan Lark", { role: n === 3 ? "recent" : null }));
  const fake = fakeParaform({ people });
  const record = await lookupProtectedSub(note("Rowan Lark"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-3");
  assert.equal(record.confirmedBy, "role");
  assert.equal(record.namesakesUnchecked, 5);
  assert.equal(fake.count(APPS), 0);
});

test("ten namesakes, nobody with the role on their row, one who worked where the note says: resolved on the background", async () => {
  const people = Array.from({ length: 10 }, (_, n) => person(`cu-${n}`, "Rowan Lark", { employers: n === 7 ? ["Groupon Inc", "Initech"] : ["Globex"] }));
  const fake = fakeParaform({ people });
  const fit = "Senior engineer who owned marketplace features end to end at Groupon.";
  const record = await lookupProtectedSub(note("Rowan Lark", { fitText: fit }), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-7");
  assert.equal(record.confirmedBy, "background_only");
  assert.equal(record.via, "background");
  assert.equal(record.namesakesUnchecked, 10);
  assert.equal(fake.count(APPS), 0);
  assert.equal(record.options[0].candidateUserId, "cu-7", "the background match is listed first");
  // Without the background it stays too_many.
  const plain = await lookupProtectedSub(note("Rowan Lark", { fitText: "" }), { trpcGetImpl: fakeParaform({ people }).impl, now: NOW });
  assert.equal(plain.status, "too_many");
});

test("two namesakes who both worked where the note says are ambiguous; several holders resolve on the one the note names", async () => {
  const fit = "an AE at Collibra before Blue Mountain";
  const twoBg = fakeParaform({ people: [
    person("cu-1", "Avery Quill", { employers: ["Collibra"] }),
    person("cu-2", "Avery Quill", { employers: ["Blue Mountain"] }),
  ] });
  const both = await lookupProtectedSub(note("Avery Quill", { fitText: fit }), { trpcGetImpl: twoBg.impl, now: NOW });
  assert.equal(both.status, "ambiguous");
  assert.equal(both.bgMatches, 2);
  // Two holders on the role (the role-scoped search honoured): the one whose
  // employer the note names is the person.
  const people = [
    person("cu-1", "Avery Quill", { role: "recent", employers: ["Initech"] }),
    person("cu-2", "Avery Quill", { role: "recent", employers: ["Collibra"] }),
  ];
  const holders = await lookupProtectedSub(note("Avery Quill", { fitText: fit }), { trpcGetImpl: fakeParaform({ people, honourRoles: true }).impl, now: NOW });
  assert.equal(holders.status, "resolved");
  assert.equal(holders.candidateUserId, "cu-2");
  assert.equal(holders.confirmedBy, "background");
  // ...and without a background they stay ambiguous.
  const plain = await lookupProtectedSub(note("Avery Quill"), { trpcGetImpl: fakeParaform({ people, honourRoles: true }).impl, now: NOW });
  assert.equal(plain.status, "ambiguous");
});

test("no holder after the applications reads: the one namesake the background names resolves", async () => {
  const fake = fakeParaform({ people: [
    person("cu-1", "Avery Quill", { employers: ["Globex"] }),
    person("cu-2", "Avery Quill", { employers: ["Hooli"] }),
  ] });
  const record = await lookupProtectedSub(note("Avery Quill", { fitText: "built search at Hooli" }), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(fake.count(APPS), 2);
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-2");
  assert.equal(record.confirmedBy, "background_only");
});

// ── D. Closed roles still send ──────────────────────────────────────────────

test("a paused or closed role is recorded and the note resolves and makes a row; picks on it are allowed", async () => {
  const fake = fakeParaform({
    role: { id: ROLE, status: "CLOSED_CHURNED", title: "Founding Engineer", company: { name: "Acme" } },
    people: [person("cu-1", "Avery Quill", { role: "recent" })],
  });
  const sub = note("Avery Quill");
  const record = await lookupProtectedSub(sub, { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.roleStatus, "CLOSED_CHURNED");
  const [row] = syntheticProtectedRequests({
    subs: new Map([[sub.requestId, sub]]),
    lookups: { [sub.requestId]: record },
    historyIds: new Set(),
    notBeforeMs: Date.parse("2026-11-07T00:00:00Z"),
    now: NOW,
  });
  assert.equal(row.candidateUserId, "cu-1");
  assert.equal(row.synthetic, true);
  assert.equal(row.roleName, "Founding Engineer");
  const pick = { action: "send", candidateUserId: "cu-9" };
  assert.equal(pickLookupProblem({ status: "role_inactive", roleStatus: "PAUSED", roleName: "Founding Engineer", companyName: "Acme" }, pick), null);
  assert.equal(pickLookupProblem({ status: "role_unreadable" }, pick), "the role could not be read on Paraform");
});

// ── Re-runs ─────────────────────────────────────────────────────────────────

test("a v3 unconfirmed_name record is looked up again once under v4 and resolves", async () => {
  const notBeforeMs = Date.parse("2026-11-07T00:00:00Z");
  const sub = note("Avery Quillon");
  const subs = new Map([[sub.requestId, sub]]);
  const v3 = { requestId: sub.requestId, version: 3, status: "unconfirmed_name", attempts: 1, checkedAt: "2026-11-07T18:00:00Z", lastTriedAt: "2026-11-07T18:00:00Z" };
  assert.equal(protectedLookupQueue({ subs, historyIds: new Set(), lookups: { [sub.requestId]: v3 }, notBeforeMs, now: NOW }).length, 1);
  const memory = memoryLookups({ [sub.requestId]: v3 });
  const fake = fakeParaform({ people: [{ ...person("cu-q", "Avery Q.", { role: "recent" }), linkedin_user: "aq-1988" }] });
  await runProtectedLookups({ subs, historyIds: new Set(), notBeforeMs, now: NOW, trpcGetImpl: fake.impl, store: memory.store });
  assert.equal(memory.saved[0].status, "resolved");
  assert.equal(memory.saved[0].candidateUserId, "cu-q");
  assert.equal(memory.saved[0].version, PROTECTED_LOOKUP_VERSION);
  assert.equal(memory.saved[0].attempts, 1, "attempts start over");
  // Once resolved under v4, never again; a v4 hold waits its day.
  assert.equal(protectedLookupQueue({ subs, historyIds: new Set(), lookups: { [sub.requestId]: memory.saved[0] }, notBeforeMs, now: NOW + 60_000 }).length, 0);
  const held = { ...v3, version: PROTECTED_LOOKUP_VERSION, status: "background_conflict" };
  assert.equal(protectedLookupQueue({ subs, historyIds: new Set(), lookups: { [sub.requestId]: held }, notBeforeMs, now: NOW }).length, 0);
});
