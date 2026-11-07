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
  "<p><b>Why I think it fits:</b> senior backend engineer on Hooli&#39;s messaging team since 2021, after building",
  " object storage for Initech&rsquo;s cloud (see https://example.com/profile?id=1) and Globex storage APIs.</p>",
  "<p><b>*Why the role is worth a call*</b></p><p>Acme pays well, via Paraform.</p>",
].join("");

test("fitText is the 'Why I think it fits' paragraph only, without links, tags or the role details", () => {
  const fit = protectedFitText(FIT_NOTE);
  assert.equal(fit, "senior backend engineer on Hooli's messaging team since 2021, after building object storage for Initech's cloud (see ) and Globex storage APIs.");
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
  assert.match(parsed.record.fitText, /^senior backend engineer on Hooli's messaging/);
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
  assert.match(memory.subs.get("req-a").fitText, /Hooli's messaging/);
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
  assert.match(memory.subs.get(REQ).fitText, /Hooli's messaging/, "a new note carries its fitText");
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

test("backgroundHits: whole capitalised phrases, possessives, legal suffixes, accents, aliases; strong only in an employment context", () => {
  const row = (...names) => ({ experiences: names.map((company_name) => ({ company_name })) });
  // Case rule: a company named like an ordinary word counts only capitalised.
  assert.deepEqual(backgroundHits(row("Block"), "worked on block storage at scale"), []);
  assert.deepEqual(backgroundHits(row("Block"), "led payments at Block for three years"), ["Block"]);
  assert.deepEqual(backgroundHits(row("Meta"), "wrote meta tooling"), []);
  assert.deepEqual(backgroundHits(row("Meta"), "two years at Meta"), ["Meta"]);
  // Possessive yes, a longer word no.
  assert.deepEqual(backgroundHits(row("Hooli"), "on Hooli's messaging team"), ["Hooli"]);
  assert.deepEqual(backgroundHits(row("Apple"), "Apples and oranges"), []);
  assert.deepEqual(backgroundHits(row("Globex"), "Globexian systems"), []);
  // Legal suffixes are not needed in the note.
  assert.deepEqual(backgroundHits(row("Soylent, Inc."), "ran checkout end to end at Soylent"), ["Soylent, Inc."]);
  assert.deepEqual(backgroundHits(row("Umbrella LLC"), "an AE at Umbrella"), ["Umbrella LLC"]);
  assert.deepEqual(backgroundHits(row("Initech S.A."), "Initech's platform"), ["Initech S.A."]);
  // Multi-word names as a phrase; accents folded; a parenthesised alias.
  assert.deepEqual(backgroundHits(row("Pied Piper"), "Enterprise AE at Pied Piper (2023 to 2024)"), ["Pied Piper"]);
  assert.deepEqual(backgroundHits(row("Zürich Analytics"), "five years at Zurich Analytics"), ["Zürich Analytics"]);
  assert.deepEqual(backgroundHits(row("Hooli (Nucleus)"), "built Nucleus compression"), ["Hooli (Nucleus)"]);
  assert.deepEqual(backgroundHits(row("Hooli (Nucleus)"), "built Nucleus compression", { strongOnly: true }), [], "a bare mention is weak");
  assert.deepEqual(backgroundHits(row("Hooli (Nucleus)"), "five years at Nucleus", { strongOnly: true }), ["Hooli (Nucleus)"]);
  // Generic employers never count, even capitalised.
  assert.deepEqual(backgroundHits(row("Stealth", "Freelance", "Confidential"), "Stealth work, Freelance, Confidential"), []);
  // The role's own company and Paraform never count.
  assert.deepEqual(backgroundHits(row("Acme Corp", "Paraform", "Globex"), "Acme hired via Paraform; ex Globex", { exclude: ["Acme"] }), ["Globex"]);
  assert.deepEqual(backgroundHits(row("Globex"), ""), []);
});

test("backgroundHits: the first word alone counts (weakly only) for a long, uncommon first word of a longer name", () => {
  const row = (...names) => ({ experiences: names.map((company_name) => ({ company_name })) });
  assert.deepEqual(backgroundHits(row("Initrode Cloud Services"), "and Initrode Cloud storage APIs"), ["Initrode Cloud Services"]);
  assert.deepEqual(backgroundHits(row("Soylent Merchant Services"), "end to end at Soylent"), ["Soylent Merchant Services"]);
  // 2026-11-07 review: a first-word hit never decides anything on its own.
  assert.deepEqual(backgroundHits(row("Soylent Merchant Services"), "end to end at Soylent", { strongOnly: true }), []);
  assert.deepEqual(backgroundHits(row("Initrode Cloud Services"), "an initrode of storage"), [], "not capitalised");
  assert.deepEqual(backgroundHits(row("Meta Platforms"), "at Meta since 2022"), [], "first word under 5 letters");
  assert.deepEqual(backgroundHits(row("Strategic Education"), "Strategic Account Executive at Pied Piper"), [], "a common title word");
  assert.deepEqual(backgroundHits(row("Senior Living Co"), "Senior engineer"), []);
  assert.deepEqual(backgroundHits(row("Acmeworks Robotics"), "Acmeworks team", { exclude: ["Acmeworks"] }), [], "the role's company");
});

// ── C. The v4 decision ──────────────────────────────────────────────────────

test("rule 1: one role holder shown as 'First L.' resolves, with the background when it agrees", async () => {
  const fit = "Staff engineer at Hooli since 2020. Earlier led search at Vandelay.";
  const people = [
    person("cu-q", "Avery Q.", { role: "recent", employers: ["Hooli", "Vandelay"] }),
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
  assert.deepEqual(record.options[0].backgroundHits, ["Hooli", "Vandelay"]);
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
    person("cu-2", "Avery Quill", { employers: ["Soylent"] }),
  ] });
  const record = await lookupProtectedSub(note("Avery Quill", { fitText: "ran checkout end to end at Soylent" }), { trpcGetImpl: fake.impl, now: NOW });
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
  const people = Array.from({ length: 10 }, (_, n) => person(`cu-${n}`, "Rowan Lark", { employers: n === 7 ? ["Soylent Inc", "Initech"] : ["Globex"] }));
  const fake = fakeParaform({ people });
  const fit = "Senior engineer who ran checkout end to end at Soylent.";
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
  const fit = "an AE at Umbrella, then at Pied Piper";
  const twoBg = fakeParaform({ people: [
    person("cu-1", "Avery Quill", { employers: ["Umbrella"] }),
    person("cu-2", "Avery Quill", { employers: ["Pied Piper"] }),
  ] });
  const both = await lookupProtectedSub(note("Avery Quill", { fitText: fit }), { trpcGetImpl: twoBg.impl, now: NOW });
  assert.equal(both.status, "ambiguous");
  assert.equal(both.bgMatches, 2);
  // The reason says the tie is on the background, not on the role.
  assert.match(lookupReason(both), /worked at the employers the note names, and none has this role/);
  // Two holders on the role (the role-scoped search honoured): the one whose
  // employer the note names is the person.
  const people = [
    person("cu-1", "Avery Quill", { role: "recent", employers: ["Initech"] }),
    person("cu-2", "Avery Quill", { role: "recent", employers: ["Umbrella"] }),
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

// ── Review fixes (2026-11-07) ───────────────────────────────────────────────

const rowOf = (...names) => ({ experiences: names.map((company_name) => ({ company_name })) });

test("review fix: the note's own name words never make an employer match (Edward Jones, Michael Page)", async () => {
  const edwardFit = "Edward has been a senior engineer at Meta since 2022.";
  assert.deepEqual(backgroundHits(rowOf("Edward Jones"), edwardFit, { nameWords: ["Edward", "Vantor"] }), []);
  assert.deepEqual(backgroundHits(rowOf("Quill"), "Quill shipped search at Globex", { nameWords: ["Avery", "Quill"] }), [], "an employer named like the surname");
  // An employer that merely starts with the name still counts when written out.
  assert.deepEqual(backgroundHits(rowOf("Edward Jones"), "an advisor at Edward Jones since 2019", { nameWords: ["Edward", "Vantor"] }), ["Edward Jones"]);
  // End to end: no role holder; the real person's row says Facebook, a
  // namesake's says Edward Jones. Nobody is matched, nothing is sent.
  const edward = await lookupProtectedSub(note("Edward Vantor", { fitText: edwardFit }), { trpcGetImpl: fakeParaform({ people: [
    person("cu-real", "Edward Vantor", { employers: ["Facebook"] }),
    person("cu-other", "Edward Vantor", { employers: ["Edward Jones"] }),
  ] }).impl, now: NOW });
  assert.notEqual(edward.status, "resolved");
  assert.equal(edward.bgMatches, 0);
  // Ten namesakes, one at Soylent and one at Michael Page: the Soylent one.
  const people = Array.from({ length: 10 }, (_, n) => person(`cu-${n}`, "Michael Orlan", { employers: n === 4 ? ["Soylent"] : n === 6 ? ["Michael Page"] : ["Globex"] }));
  const michael = await lookupProtectedSub(note("Michael Orlan", { fitText: "Michael ran checkout end to end at Soylent." }), { trpcGetImpl: fakeParaform({ people }).impl, now: NOW });
  assert.equal(michael.status, "resolved");
  assert.equal(michael.candidateUserId, "cu-4");
  assert.equal(michael.bgMatches, 1);
});

test("review fix: tools, platforms, schools, places and skills are not employers unless the note says the person worked there", async () => {
  const strong = (names, text) => backgroundHits(rowOf(...names), text, { strongOnly: true });
  assert.deepEqual(backgroundHits(rowOf("Amazon Web Services (AWS)"), "Built Kafka pipelines on AWS"), [], "a bracketed alias under 4 letters is dropped");
  assert.deepEqual(strong(["Google"], "on Google Cloud and BigQuery"), []);
  assert.deepEqual(strong(["Google"], "Google's BigQuery"), [], "a platform's possessive is its product");
  assert.deepEqual(strong(["Snowflake"], "Built Snowflake and dbt pipelines"), []);
  assert.deepEqual(strong(["Salesforce"], "lived in Salesforce all day"), []);
  assert.deepEqual(strong(["Salesforce"], "an AE at Salesforce for four years"), ["Salesforce"], "at Salesforce is a job");
  assert.deepEqual(backgroundHits(rowOf("Stanford University"), "Stanford CS grad"), [], "schools are never employers");
  assert.deepEqual(backgroundHits(rowOf("Columbia University"), "MS from Columbia, then backend at Initech."), []);
  assert.deepEqual(backgroundHits(rowOf("Boston Consulting Group"), "Based in Boston, backend at Initech."), []);
  assert.deepEqual(backgroundHits(rowOf("Python Software Foundation"), "Strong Python and Go engineer"), []);
  assert.deepEqual(backgroundHits(rowOf("Stanford Health Care"), "Stanford CS grad"), []);
  // Employment contexts that do count.
  for (const text of ["at Hooli", "@Hooli", "joined Hooli in 2021", "ex-Hooli", "formerly Hooli", "storage for Hooli", "on Hooli's search team", "Hooli (2019 to 2022)", "Hooli since 2020", "a Hooli engineer"]) {
    assert.deepEqual(strong(["Hooli"], text), ["Hooli"], text);
  }
  assert.deepEqual(strong(["Hooli"], "Hooli and others"), [], "a bare mention is weak");
  // End to end: no holder, the real person's row says Facebook, a namesake's
  // says Amazon Web Services (AWS): not sent to the namesake.
  const aws = await lookupProtectedSub(note("Avery Quill", { fitText: "Senior engineer at Meta since 2021, running Kafka on AWS." }), { trpcGetImpl: fakeParaform({ people: [
    person("cu-real", "Avery Quill", { employers: ["Facebook"] }),
    person("cu-other", "Avery Quill", { employers: ["Amazon Web Services (AWS)"] }),
  ] }).impl, now: NOW });
  assert.equal(aws.status, "not_found");
  assert.equal(aws.bgMatches, 0);
  // A school on a namesake's row never resolves the note to them.
  const school = await lookupProtectedSub(note("Avery Quill", { fitText: "MS from Columbia, now a backend engineer at Initech." }), { trpcGetImpl: fakeParaform({ people: [
    person("cu-real", "Avery Quill"),
    person("cu-other", "Avery Quill", { employers: ["Columbia University"] }),
  ] }).impl, now: NOW });
  assert.equal(school.status, "not_found");
  // With one holder, a tool mention of a namesake's employer is no conflict.
  const holder = await lookupProtectedSub(note("Avery Quill", { fitText: "building on Google Cloud for years" }), { trpcGetImpl: fakeParaform({ people: [
    person("cu-real", "Avery Quill", { role: "recent", employers: ["Facebook"] }),
    person("cu-other", "Avery Quill", { employers: ["Google"] }),
  ] }).impl, now: NOW });
  assert.equal(holder.status, "resolved");
  assert.equal(holder.candidateUserId, "cu-real");
  // A first-word-only (weak) mention on the holder keeps a strong mention of
  // another namesake's employer from holding the note.
  const weak = await lookupProtectedSub(note("Avery Quill", { fitText: "Initrode storage APIs, then at Globex." }), { trpcGetImpl: fakeParaform({ people: [
    person("cu-real", "Avery Quill", { role: "recent", employers: ["Initrode Cloud Services"] }),
    person("cu-other", "Avery Quill", { employers: ["Globex"] }),
  ] }).impl, now: NOW });
  assert.equal(weak.status, "resolved");
  assert.equal(weak.candidateUserId, "cu-real");
  assert.equal(weak.confirmedBy, "role");
});

test("review fix: the note's own id on a person's application beats the background", async () => {
  const fit = "Senior engineer at Globex since 2020.";
  // Holder A on the CRM row with the note's employer; holder B's application
  // carries the note's ctar id: B is the person.
  const two = fakeParaform({
    people: [person("cu-a", "Avery Quill", { role: "recent", employers: ["Globex"] }), person("cu-b", "Avery Quill", { employers: ["Facebook"] })],
    apps: { "cu-b": [{ role_id: ROLE, id: "ctar-v4", created_at: RECENT }] },
  });
  const record = await lookupProtectedSub(note("Avery Quill", { fitText: fit }), { trpcGetImpl: two.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-b");
  assert.equal(record.confirmedBy, "ctar");
  assert.equal(record.ctarMatch, true);
  // A lone ctar holder is never held as a background conflict.
  const lone = fakeParaform({
    people: [person("cu-a", "Avery Quill", { employers: ["Globex"] }), person("cu-b", "Avery Quill", { employers: ["Initech"] })],
    apps: { "cu-b": [{ role_id: ROLE, candidate_to_approved_role_id: "ctar-v4", created_at: "2026-10-01T00:00:00Z" }] },
  });
  const held = await lookupProtectedSub(note("Avery Quill", { fitText: fit }), { trpcGetImpl: lone.impl, now: NOW });
  assert.equal(held.status, "resolved");
  assert.equal(held.candidateUserId, "cu-b");
  assert.equal(held.confirmedBy, "ctar");
  // Two people carrying the note's id: never a guess.
  const twin = fakeParaform({
    people: [person("cu-a", "Avery Quill"), person("cu-b", "Avery Quill")],
    apps: { "cu-a": [{ role_id: ROLE, id: "ctar-v4" }], "cu-b": [{ role_id: ROLE, id: "ctar-v4" }] },
  });
  assert.equal((await lookupProtectedSub(note("Avery Quill", { fitText: fit }), { trpcGetImpl: twin.impl, now: NOW })).status, "ambiguous");
});

// A crowd of "<first> <initial>..." rows that pushes the short-form search
// past its page cap.
const crowdOf = (first, initial, size) => Array.from({ length: size }, (_, n) => person(`f-${n}`, `${first} ${initial}${String.fromCharCode(97 + (n % 26))}x${n}`));

test("review fix: an unfinished short-form search never resolves on the background alone, nor on a cut-short holder", async () => {
  // Rule 3: the one "Mira S." at Globex was seen, the "Mira S." with the
  // role sits past the page cap. Held, not sent to the Globex one.
  const people = [
    person("cu-a", "Mira S.", { employers: ["Globex"] }),
    ...crowdOf("Mira", "S", 140),
    person("cu-b", "Mira S.", { role: "recent" }),
  ];
  const record = await lookupProtectedSub(note("Mira Smith", { fitText: "Led payments at Globex." }), { trpcGetImpl: fakeParaform({ people }).impl, now: NOW });
  assert.equal(record.shortFormSearch, "unfinished");
  assert.notEqual(record.status, "resolved");
  assert.equal(record.status, "incomplete");
  // Same with a full-name namesake and two cut-short Initech people, the
  // second on a page the cap never reached.
  const rowan = [
    person("cu-full", "Rowan Lark"),
    person("cu-p1", "Rowan L.", { employers: ["Initech"] }),
    ...crowdOf("Rowan", "L", 140),
    person("cu-p3", "Rowan L.", { employers: ["Initech"] }),
  ];
  const lark = await lookupProtectedSub(note("Rowan Lark", { fitText: "Senior engineer at Initech." }), { trpcGetImpl: fakeParaform({ people: rowan }).impl, now: NOW });
  assert.equal(lark.shortFormSearch, "unfinished");
  assert.equal(lark.status, "incomplete");
  // Rule 1: a cut-short holder past an unfinished short-form search is held.
  const holderPeople = [person("cu-a", "Mira S.", { role: "recent" }), ...crowdOf("Mira", "S", 140), person("cu-b", "Mira S.", { role: "recent" })];
  const holder = await lookupProtectedSub(note("Mira Smith"), { trpcGetImpl: fakeParaform({ people: holderPeople }).impl, now: NOW });
  assert.equal(holder.status, "incomplete");
});

test("review fix: a background-only match first reads the unread cut-short namesakes", async () => {
  const fit = "built storage at Globex";
  // The cut-short namesake's application carries the note's own id: them.
  const withCtar = fakeParaform({
    people: [person("cu-full", "Avery Quill", { employers: ["Globex"] }), person("cu-short", "Avery Q.", { employers: ["Initech"] })],
    apps: { "cu-short": [{ role_id: ROLE, id: "ctar-v4", created_at: RECENT }] },
  });
  const record = await lookupProtectedSub(note("Avery Quill", { fitText: fit }), { trpcGetImpl: withCtar.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-short");
  assert.equal(record.confirmedBy, "ctar");
  assert.equal(record.cutShortRead, 1);
  // Read and not on the role: the background match stands.
  const clean = fakeParaform({ people: [person("cu-full", "Avery Quill", { employers: ["Globex"] }), person("cu-short", "Avery Q.", { employers: ["Initech"] })] });
  const resolved = await lookupProtectedSub(note("Avery Quill", { fitText: fit }), { trpcGetImpl: clean.impl, now: NOW });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.candidateUserId, "cu-full");
  assert.equal(resolved.confirmedBy, "background_only");
  assert.equal(clean.count(APPS), 2);
  // More cut-short namesakes than the reads left: held, not guessed.
  const many = fakeParaform({ people: [
    person("cu-full", "Avery Quill", { employers: ["Globex"] }),
    ...[1, 2, 3, 4, 5, 6].map((n) => person(`cu-s${n}`, "Avery Q.")),
  ] });
  const held = await lookupProtectedSub(note("Avery Quill", { fitText: fit }), { trpcGetImpl: many.impl, now: NOW });
  assert.equal(held.status, "incomplete");
  assert.ok(held.cutShortUnread > 0);
  assert.ok(held.reads <= 7);
});

test("review fix: the fitText backfill reads notes as far back as the lookup window", async () => {
  const tenDaysAgo = new Date(NOW - 10 * 24 * 3_600_000).toISOString();
  const memory = scanStore([stored("req-ten", { receivedAt: tenDaysAgo })]);
  const reads = [];
  const scan = (windowMs) => scanProtectedNotes({
    mailbox: "m", now: NOW, windowMs, searchImpl: async () => [],
    getMessageImpl: async (_mailbox, id) => { reads.push(id); return gmailMessage(id, FIT_NOTE); },
    store: memory.store,
  });
  await scan(undefined);
  assert.deepEqual(reads, [], "the default week leaves it");
  await scan(14 * 24 * 3_600_000);
  assert.deepEqual(reads, ["msg-req-ten"]);
  assert.match(memory.subs.get("req-ten").fitText, /Hooli's messaging/);
  // ...so the lookup queue over the same window no longer waits on it.
  const queued = protectedLookupQueue({ subs: memory.subs, historyIds: new Set(), notBeforeMs: Date.parse("2026-10-01T00:00:00Z"), now: NOW, windowMs: 14 * 24 * 3_600_000 });
  assert.deepEqual(queued.map((sub) => sub.requestId), ["req-ten"]);
});

test("review fix: reasons say what held the note, and a closed role's older record promises no send", () => {
  assert.match(lookupReason({ status: "ambiguous", confirmed: 0, bgMatches: 2 }), /worked at the employers the note names, and none has this role/);
  assert.match(lookupReason({ status: "ambiguous", confirmed: 2, bgMatches: 2 }), /has this role on their record/);
  assert.match(lookupReason({ status: "ambiguous" }), /has this role on their record/);
  const closed = lookupReason({ status: "role_inactive", roleStatus: "PAUSED" });
  assert.match(closed, /PAUSED; it is looked up again$/);
  assert.doesNotMatch(closed, /sends/);
});
