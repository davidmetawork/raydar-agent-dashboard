// Lookup v3 for rating-protected subs (2026-11-06): cleaned note names,
// initial surnames, a role-scoped search first, role before the namesake cap,
// options for a staff pick, daily re-checks, and staff picks. All names here
// are made up.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTECTED_LOOKUP_MAX_READS,
  PROTECTED_LOOKUP_VERSION,
  compatibleName,
  nameFullyConfirmed,
  lookupProtectedSub,
  lookupReason,
  nameTokens,
  parseNoteName,
  pickLookupProblem,
  protectedLookupQueue,
  protectedPickBlocked,
  protectedPickStillSends,
  roleLinkInRow,
  runProtectedLookups,
  sameName,
  syntheticProtectedRequests,
} from "../api/paraai/_lib/outreach-protected-lookup.mjs";

const ROLE = "role-v3";
const RECEIVED = "2026-11-06T18:00:00.000Z";
const NOW = Date.parse("2026-11-06T18:05:00Z");
const RECENT = "2026-11-06T17:54:00Z";
const OLD = "2026-05-01T00:00:00Z";
const CRM = "candidateUser.getCRMExternalCandidates";
const APPS = "candidateUser.getCandidateUserApplications";

const note = (candidateName, extra = {}) => ({
  requestId: "req-v3",
  ctarId: "ctar-v3",
  roleId: ROLE,
  candidateName,
  companyName: "Acme",
  submitUrl: `https://www.paraform.com/company/acme/${ROLE}/recruit/submit_candidate?from_submission_request=true&submission_request_id=req-v3`,
  receivedAt: RECEIVED,
  ...extra,
});

// A CRM row: `role` "recent" | "old" | null puts the role on the row.
const person = (id, name, role = null) => ({
  id,
  name,
  linkedin_user: `li-${id}`,
  roles: role ? [{ role_id: ROLE, created_at: role === "recent" ? RECENT : OLD }] : [{ role_id: "role-other", created_at: RECENT }],
});

const flatTokens = (value) => nameTokens(value).flatMap((token) => token.split("-")).filter(Boolean);
// Paraform's search, roughly: every word typed starts a word of the name.
const searchMatches = (query, name) => {
  const q = flatTokens(query);
  const r = flatTokens(name);
  return q.length > 0 && q.every((token) => r.some((part) => part.startsWith(token)));
};

// A fake Paraform that records every call. `honourRoles` false returns the
// role-scoped search unfiltered (Paraform ignoring filters.roles).
function fakeParaform({
  role = { id: ROLE, status: "ACTIVE", title: "Founding Engineer", company: { name: "Acme" } },
  people = [],
  honourRoles = true,
  roleSearchError = null,
  nameSearchRows = null,
  initialSearchEmpty = false,
  endless = false,
  apps = {},
} = {}) {
  const calls = [];
  const impl = async (proc, input) => {
    calls.push({ proc, input });
    if (proc === "role.getRoleByIdSimple") return role;
    if (proc === CRM) {
      const filters = input.filters || {};
      const scoped = Array.isArray(filters.roles);
      if (scoped && roleSearchError) throw roleSearchError;
      let rows;
      if (scoped) {
        rows = people.filter((row) => searchMatches(filters.general_search, row.name));
        if (honourRoles) rows = rows.filter((row) => roleLinkInRow(row, filters.roles[0]));
      } else if (nameSearchRows) {
        rows = nameSearchRows;
      } else if (initialSearchEmpty && /\s[A-Za-z]$/.test(filters.general_search)) {
        rows = [];
      } else {
        rows = people.filter((row) => searchMatches(filters.general_search, row.name));
      }
      const offset = Number(input.cursor || 0);
      if (endless && !scoped) {
        const filler = Array.from({ length: 50 }, (_, n) => ({ id: `fill-${offset}-${n}`, name: `Other Person${n}` }));
        return { items: offset === 0 ? [...rows.slice(0, 1), ...filler.slice(1)] : filler, next_cursor: offset + 50 };
      }
      const items = rows.slice(offset, offset + input.limit);
      return { items, next_cursor: offset + input.limit < rows.length ? offset + input.limit : null };
    }
    if (proc === APPS) return apps[input.candidate_user_id] || [];
    throw new Error(`unexpected ${proc}`);
  };
  const count = (proc) => calls.filter((call) => call.proc === proc).length;
  return { impl, calls, count };
}

const memoryStore = (initial = {}) => {
  const saved = [];
  return {
    saved,
    store: { list: async () => ({ ...initial }), save: async (record) => { saved.push(record); }, prune: async () => {}, getPick: async () => null },
  };
};

test("note names lose credentials, nicknames and suffixes, and an initial surname is recognised", () => {
  const cred = parseNoteName("Avery Quill, M.A.Sc., P.Eng.");
  assert.deepEqual(cred.tokens, ["avery", "quill"]);
  assert.equal(cred.search, "Avery Quill");
  assert.equal(cred.nameForm, "full");
  assert.deepEqual(parseNoteName("Avery Quill PhD").tokens, ["avery", "quill"]);
  assert.deepEqual(parseNoteName("Avery Quill MBA Jr.").tokens, ["avery", "quill"]);
  assert.deepEqual(parseNoteName("Avery (Ave) Quill").tokens, ["avery", "quill"]);
  assert.deepEqual(parseNoteName("Avery Quill III").tokens, ["avery", "quill"]);
  // Ma and Ba are surnames too: kept unless written as letters.
  assert.deepEqual(parseNoteName("Wen Ma").tokens, ["wen", "ma"]);
  assert.deepEqual(parseNoteName("Lin Wen Ma").tokens, ["lin", "wen", "ma"]);
  assert.deepEqual(parseNoteName("Lin Wen M.A.").tokens, ["lin", "wen"]);
  const initial = parseNoteName("Trish J.");
  assert.equal(initial.nameForm, "initial");
  assert.equal(initial.first, "trish");
  assert.equal(initial.lastInitial, "j");
  assert.equal(initial.search, "Trish J");
  assert.equal(parseNoteName("Dara O").nameForm, "initial");
  assert.equal(parseNoteName("Jane Q. Doe").nameForm, "full", "a middle initial is not a surname initial");
  assert.equal(parseNoteName("").tokens.length, 0);
});

test("compatible names: hyphen and spacing of a surname, initials, and the old sameName", () => {
  const hyphen = parseNoteName("Yael Ben-Atar");
  assert.ok(compatibleName(hyphen, "Yael Ben Atar"));
  assert.ok(compatibleName(hyphen, "Yael Benatar"));
  assert.ok(compatibleName(parseNoteName("Yael Ben Atar"), "Yael Ben-Atar"));
  assert.ok(compatibleName(parseNoteName("Yael Benatar"), "yael ben atar"));
  assert.ok(compatibleName(parseNoteName("Yael M. Ben Atar"), "Yael Ben-Atar"));
  assert.ok(!compatibleName(hyphen, "Yael Atari"));
  assert.ok(!compatibleName(hyphen, "Noa Ben-Atar"));
  const initial = parseNoteName("Trish J.");
  assert.ok(compatibleName(initial, "Trish Jo"));
  assert.ok(compatibleName(initial, "Trish Anne Jameson"));
  assert.ok(!compatibleName(initial, "Trish Smith"));
  assert.ok(!compatibleName(initial, "Patricia Jo"));
  assert.ok(!compatibleName(initial, "Trish"));
  assert.ok(compatibleName("Avery Quill, PhD", "avery quill"));
  // The old export keeps its meaning.
  assert.ok(sameName("Jane Q. Doe", "jane doe"));
  assert.ok(!sameName("Jane Doe", "Jane Doering"));
});

test("a note with degree letters resolves on the cleaned name", async () => {
  const fake = fakeParaform({
    honourRoles: false,
    people: [person("cu-1", "Avery Quill", "recent"), person("cu-2", "Avery Stone")],
  });
  const record = await lookupProtectedSub(note("Avery Quill, M.A.Sc., P.Eng."), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-1");
  assert.equal(record.via, "crm_row");
  assert.equal(record.roleSearch, "ignored");
  assert.equal(record.version, PROTECTED_LOOKUP_VERSION);
  assert.equal(record.nameForm, "full");
  const nameSearch = fake.calls.find((call) => call.proc === CRM && !call.input.filters.roles);
  assert.equal(nameSearch.input.filters.general_search, "Avery Quill");
});

test("an initial surname resolves on its one compatible role holder (v4), and is ambiguous with two", async () => {
  const people = [person("cu-1", "Trish Jo", "recent"), person("cu-2", "Trish Jameson"), person("cu-3", "Trish Smith", "recent")];
  // Role-scoped search honoured: its one holder is still confirmed by the
  // name search and the namesakes' applications (2026-11-06 review).
  const scoped = fakeParaform({ people });
  const one = await lookupProtectedSub(note("Trish J."), { trpcGetImpl: scoped.impl, now: NOW });
  // v4 (2026-11-07, David's rule 2): the one person with the role is the
  // person, though the surname is only an initial (v3 held it as
  // unconfirmed_name for a staff pick).
  assert.equal(one.status, "resolved");
  assert.equal(one.candidateUserId, "cu-1");
  assert.equal(one.confirmedBy, "role");
  assert.equal(one.options[0].candidateUserId, "cu-1");
  assert.equal(one.nameForm, "initial");
  assert.equal(one.roleSearch, "scoped");
  assert.equal(scoped.calls[1].input.filters.general_search, "Trish");
  assert.deepEqual(scoped.calls[1].input.filters.roles, [ROLE]);
  assert.equal(scoped.count(APPS), 1, "Trish Jameson's applications were read");
  // Ignored: the name search "Trish J" and the CRM rows decide.
  const ignored = fakeParaform({ people, honourRoles: false });
  const viaName = await lookupProtectedSub(note("Trish J."), { trpcGetImpl: ignored.impl, now: NOW });
  assert.equal(viaName.status, "resolved", "v4: was unconfirmed_name");
  assert.equal(viaName.candidateUserId, "cu-1");
  assert.equal(ignored.count(APPS), 1, "only Trish Jameson needed an applications read");
  assert.equal(viaName.nameMatches, 2, "Trish Smith is not compatible with J.");
  // Two compatible people on the role: never a guess, both offered.
  const two = fakeParaform({ people: [...people, person("cu-4", "Trish Jun", "recent")] });
  const both = await lookupProtectedSub(note("Trish J."), { trpcGetImpl: two.impl, now: NOW });
  assert.equal(both.status, "ambiguous");
  assert.equal(both.candidateUserId, undefined);
  assert.deepEqual(both.options.map((option) => option.candidateUserId).sort(), ["cu-1", "cu-4"]);
  assert.ok(both.options.every((option) => option.roleOnRecord && option.roleRecent));
});

test("an initial surname falls back to the first name alone only when the initial search finds nobody", async () => {
  const fake = fakeParaform({ people: [person("cu-1", "Trish Jo", "recent"), person("cu-2", "Trish Lane")], honourRoles: false, initialSearchEmpty: true });
  const record = await lookupProtectedSub(note("Trish J."), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved", "v4: was unconfirmed_name");
  assert.equal(record.candidateUserId, "cu-1");
  const terms = fake.calls.filter((call) => call.proc === CRM && !call.input.filters.roles).map((call) => call.input.filters.general_search);
  assert.deepEqual(terms, ["Trish J", "Trish"]);
  // Found on the initial search: no first-name search.
  const direct = fakeParaform({ people: [person("cu-1", "Trish Jo", "recent"), person("cu-2", "Trish Lane")], honourRoles: false });
  await lookupProtectedSub(note("Trish J."), { trpcGetImpl: direct.impl, now: NOW });
  assert.deepEqual(direct.calls.filter((call) => call.proc === CRM && !call.input.filters.roles).map((call) => call.input.filters.general_search), ["Trish J"]);
});

test("a hyphenated or joined surname on Paraform still matches the note", async () => {
  const fake = fakeParaform({ people: [person("cu-1", "Yael Benatar", "recent"), person("cu-2", "Yael Cohen", "recent")] });
  const record = await lookupProtectedSub(note("Yael Ben-Atar"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-1");
  assert.equal(record.via, "crm_row");
});

test("the role-scoped search counts only when every row carries the role", async () => {
  // Honoured: the only role holder by that name, once the name search and
  // the other Jane Doe's applications show nobody else has the role.
  const honoured = fakeParaform({ people: [person("cu-1", "Jane Doe", "recent"), person("cu-2", "Jane Doe")] });
  const scoped = await lookupProtectedSub(note("Jane Doe"), { trpcGetImpl: honoured.impl, now: NOW });
  assert.equal(scoped.status, "resolved");
  assert.equal(scoped.candidateUserId, "cu-1");
  assert.equal(scoped.roleSearch, "scoped");
  assert.equal(honoured.count(CRM), 3, "the scoped page, the name search and its \"Jane D\" short form");
  assert.equal(honoured.count(APPS), 1);
  // One row without the role: the whole search is ignored. Here the name
  // search finds nobody, so the role holder it returned is not used.
  const ignored = fakeParaform({
    honourRoles: false,
    people: [person("cu-1", "Jane Doe", "recent"), person("cu-2", "Jane Roe")],
    nameSearchRows: [],
  });
  const record = await lookupProtectedSub(note("Jane Doe"), { trpcGetImpl: ignored.impl, now: NOW });
  assert.equal(record.roleSearch, "ignored");
  assert.equal(record.status, "not_found");
  assert.deepEqual(record.options, []);
  // A failed role-scoped search (not pacing) is skipped, and the name search decides.
  const broken = fakeParaform({ people: [person("cu-1", "Jane Doe", "recent")], roleSearchError: Object.assign(new Error("bad input"), { code: "BAD_REQUEST" }) });
  const fallback = await lookupProtectedSub(note("Jane Doe"), { trpcGetImpl: broken.impl, now: NOW });
  assert.equal(fallback.roleSearch, "error");
  assert.equal(fallback.status, "resolved");
  assert.equal(fallback.via, "crm_row");
  // A role holder whose link is old is not the answer of the scoped search.
  const stale = fakeParaform({ people: [person("cu-1", "Jane Doe", "old")] });
  const old = await lookupProtectedSub(note("Jane Doe"), { trpcGetImpl: stale.impl, now: NOW });
  assert.equal(old.status, "not_found");
  assert.equal(old.options[0].roleOnRecord, true);
  assert.equal(old.options[0].roleRecent, false);
});

test("a pacing refusal on the role-scoped search still throws and is recorded as throttled", async () => {
  const refused = Object.assign(new Error("cap"), { code: "PARAFORM_REQUEST_LANES_RATE_LIMITED" });
  const fake = fakeParaform({ people: [person("cu-1", "Jane Doe", "recent")], roleSearchError: refused });
  await assert.rejects(lookupProtectedSub(note("Jane Doe"), { trpcGetImpl: fake.impl, now: NOW }), /cap/);
  const memory = memoryStore();
  const result = await runProtectedLookups({
    subs: new Map([["req-v3", note("Jane Doe")]]),
    historyIds: new Set(),
    notBeforeMs: Date.parse("2026-11-06T00:00:00Z"),
    now: NOW,
    trpcGetImpl: fake.impl,
    store: memory.store,
  });
  assert.equal(result.stopped, "PARAFORM_REQUEST_LANES_RATE_LIMITED");
  assert.equal(memory.saved[0].status, "throttled");
  assert.equal(memory.saved[0].throttled, 1);
  assert.ok(!memory.saved[0].attempts);
});

test("six namesakes with one row-linked role holder resolve on that holder (v4)", async () => {
  // v3 (2026-11-06 review) held this: the five unread namesakes could have
  // the role in their applications. v4 (2026-11-07, David's rules 2 and 4):
  // the one person with the role attached is the person, not held.
  const people = [1, 2, 3, 4, 5, 6].map((n) => person(`cu-${n}`, "Rowan Lark", n === 4 ? "recent" : null));
  const fake = fakeParaform({ people, honourRoles: false });
  const record = await lookupProtectedSub(note("Rowan Lark"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-4");
  assert.equal(record.via, "crm_row");
  assert.equal(record.confirmedBy, "role");
  assert.equal(record.confirmed, 1);
  assert.match(lookupReason({ status: "too_many", confirmed: 1 }), /one has this role on their CRM row \(listed first\)/);
  assert.equal(record.namesakesUnchecked, 5);
  assert.equal(record.nameMatches, 6);
  assert.equal(fake.count(APPS), 0);
  assert.ok(record.reads <= PROTECTED_LOOKUP_MAX_READS);
  assert.equal(record.options[0].candidateUserId, "cu-4", "the role holder is offered first");
  assert.equal(record.options.length, 6);
});

test("six namesakes with nobody row-linked are too many, and no applications are read", async () => {
  const people = [1, 2, 3, 4, 5, 6].map((n) => person(`cu-${n}`, "Rowan Lark"));
  const fake = fakeParaform({ people, honourRoles: false, apps: { "cu-6": [{ role_id: ROLE, created_at: RECENT }] } });
  const record = await lookupProtectedSub(note("Rowan Lark"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "too_many");
  assert.equal(record.namesakesUnchecked, 6);
  assert.equal(fake.count(APPS), 0);
  assert.equal(record.options.length, 6);
  assert.match(lookupReason(record), /too many people/);
});

test("an exact namesake without the role is not found, and is listed as an option without it", async () => {
  const fake = fakeParaform({ people: [person("cu-1", "Avery Quill")], apps: { "cu-1": [{ role_id: "role-other", created_at: RECENT }] } });
  const record = await lookupProtectedSub(note("Avery Quill"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "not_found");
  assert.equal(record.candidateUserId, undefined);
  assert.deepEqual(record.options, [{
    candidateUserId: "cu-1", name: "Avery Quill", linkedinUser: "li-cu-1", roleOnRecord: false, roleRecent: false, roleAt: null, checked: true,
  }]);
  assert.match(lookupReason(record), /no one on Paraform/);
});

test("an unfinished name search never resolves, even with a row-linked holder", async () => {
  const fake = fakeParaform({ people: [person("cu-1", "Jane Doe", "recent"), person("cu-2", "Jane Roe")], honourRoles: false, endless: true });
  const record = await lookupProtectedSub(note("Jane Doe"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "incomplete");
  assert.equal(record.crmPages, 3);
  assert.equal(record.candidateUserId, undefined);
  assert.equal(record.options[0].candidateUserId, "cu-1");
  assert.ok(record.reads <= PROTECTED_LOOKUP_MAX_READS);
});

test("the worst case stays within seven reads, leaving the tick room in the pace cap", async () => {
  // 2026-11-06 review: ten reads was the whole 10-a-minute cap, shared with
  // the reads the tick made first, so the hardest notes were refused every time.
  assert.equal(PROTECTED_LOOKUP_MAX_READS, 7);
  // 60 people named Trish with a K surname on the role (one scoped page,
  // unfinished), the initial search empty, then 2 pages for "Trish".
  const crowd = Array.from({ length: 60 }, (_, n) => person(`k-${n}`, `Trish Kay${n}`, "old"));
  const compatible = (count) => Array.from({ length: count }, (_, n) => person(`j-${n}`, `Trish Jo${n}`));
  const three = fakeParaform({ people: [...crowd, ...compatible(3)], initialSearchEmpty: true, apps: { "j-2": [{ role_id: ROLE, created_at: RECENT }] } });
  const record = await lookupProtectedSub(note("Trish J."), { trpcGetImpl: three.impl, now: NOW });
  assert.equal(record.roleSearch, "unfinished");
  assert.equal(record.status, "too_many", "3 namesakes, 2 reads left: held");
  assert.equal(three.calls.length, 5);
  // Two compatible people fit the budget: read and resolved.
  const two = fakeParaform({ people: [...crowd, ...compatible(2)], initialSearchEmpty: true, apps: { "j-1": [{ role_id: ROLE, created_at: RECENT }] } });
  const resolved = await lookupProtectedSub(note("Trish J."), { trpcGetImpl: two.impl, now: NOW });
  assert.equal(resolved.status, "resolved", "one holder with only an initial: resolved in v4 (was unconfirmed_name)");
  assert.equal(resolved.candidateUserId, "j-1");
  assert.equal(resolved.reads, 7);
  assert.equal(two.calls.length, 7);
  // A first-name search past its page limit is never a match.
  const crowded = fakeParaform({ people: [...Array.from({ length: 101 }, (_, n) => person(`k-${n}`, `Trish Kay${n}`, "old")), ...compatible(1)], initialSearchEmpty: true });
  const partial = await lookupProtectedSub(note("Trish J."), { trpcGetImpl: crowded.impl, now: NOW });
  assert.equal(partial.status, "incomplete");
  assert.ok(crowded.calls.length <= PROTECTED_LOOKUP_MAX_READS);
});

test("options are capped at ten, role holders first", async () => {
  const people = Array.from({ length: 12 }, (_, n) => person(`cu-${n}`, "Rowan Lark", n === 10 ? "recent" : n === 11 ? "old" : null));
  const fake = fakeParaform({ people, honourRoles: false });
  const record = await lookupProtectedSub(note("Rowan Lark"), { trpcGetImpl: fake.impl, now: NOW });
  // v4: the one recent row holder resolves (was too_many); the options are kept all the same.
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-10");
  assert.equal(record.options.length, 10);
  assert.equal(record.options[0].candidateUserId, "cu-10");
  assert.equal(record.options[0].roleAt, new Date(RECENT).toISOString());
  assert.equal(record.options[1].candidateUserId, "cu-11");
  assert.equal(record.options[1].roleOnRecord, true);
  assert.equal(record.options[1].roleRecent, false);
  assert.deepEqual(record.options.slice(2).map((option) => option.candidateUserId), ["cu-0", "cu-1", "cu-2", "cu-3", "cu-4", "cu-5", "cu-6", "cu-7"]);
  assert.ok(record.options.slice(2).every((option) => !option.roleOnRecord && !option.checked));
});

test("unresolved notes are checked again once a day; resolved stays final", () => {
  const notBeforeMs = Date.parse("2026-11-05T00:00:00Z");
  const now = Date.parse("2026-11-07T18:00:00Z");
  const subs = new Map([["req-v3", note("Jane Doe")]]);
  const at = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const due = (record) => protectedLookupQueue({ subs, historyIds: new Set(), lookups: { "req-v3": { version: PROTECTED_LOOKUP_VERSION, ...record } }, notBeforeMs, now }).length === 1;
  // v4: a closed role no longer stops the lookup (role_inactive is not made);
  // a background conflict is the new daily re-check.
  assert.equal(due({ status: "background_conflict", attempts: 5, lastTriedAt: at(23) }), false);
  assert.equal(due({ status: "background_conflict", attempts: 5, lastTriedAt: at(25) }), true, "no attempts cap");
  assert.equal(due({ status: "not_found", attempts: 3, lastTriedAt: at(23) }), false);
  assert.equal(due({ status: "not_found", attempts: 3, lastTriedAt: at(25) }), true);
  assert.equal(due({ status: "not_found", attempts: 1, lastTriedAt: at(0.5) }), true, "first retries stay ten minutes apart");
  for (const status of ["ambiguous", "too_many", "incomplete"]) {
    assert.equal(due({ status, attempts: 1, lastTriedAt: at(1) }), false, status);
    assert.equal(due({ status, attempts: 1, lastTriedAt: at(25) }), true, status);
  }
  assert.equal(due({ status: "resolved", attempts: 1, lastTriedAt: at(48) }), false);
  // An error after daily checks used up the attempts is tried again a day
  // after the failed try, not dropped for good; early errors keep quick retries.
  assert.equal(due({ status: "error", attempts: 4, checkedAt: at(30), lastTriedAt: at(23) }), false);
  assert.equal(due({ status: "error", attempts: 4, checkedAt: at(50), lastTriedAt: at(25) }), true);
  assert.equal(due({ status: "error", attempts: 1, lastTriedAt: at(0.5) }), true);
  // A pacing refusal after a finished check keeps the daily clock and the
  // ten-minute spacing.
  assert.equal(due({ status: "not_found", attempts: 3, checkedAt: at(25), lastTriedAt: at(0.05) }), false);
  assert.equal(due({ status: "not_found", attempts: 3, checkedAt: at(25), lastTriedAt: at(0.5) }), true);
  assert.equal(due({ status: "not_found", attempts: 3, checkedAt: at(5), lastTriedAt: at(0.5) }), false);
  // Out of the window: never.
  const late = protectedLookupQueue({ subs, historyIds: new Set(), lookups: { "req-v3": { version: 3, status: "role_inactive", lastTriedAt: at(30) } }, notBeforeMs, now: Date.parse(RECEIVED) + 8 * 24 * 3_600_000 });
  assert.deepEqual(late, []);
  assert.match(lookupReason({ status: "role_inactive", roleStatus: "PAUSED" }), /PAUSED/);
});

test("version-2 failures are looked up once more with attempts from 0, earlier notes included", async () => {
  const notBeforeMs = Date.parse("2026-11-06T00:00:00Z");
  const fresh = note("Jane Doe");
  const earlier = note("Avery Quill", { requestId: "req-early", receivedAt: "2026-11-05T12:00:00Z" });
  const subs = new Map([[fresh.requestId, fresh], [earlier.requestId, earlier]]);
  const v2 = {
    "req-v3": { requestId: "req-v3", status: "not_found", attempts: 3, version: 2, lastTriedAt: "2026-11-06T18:04:00Z" },
    "req-early": { requestId: "req-early", status: "too_many", attempts: 1, version: 2, lastTriedAt: "2026-11-06T10:00:00Z" },
  };
  const ids = (queue) => queue.map((sub) => sub.requestId);
  assert.deepEqual(ids(protectedLookupQueue({ subs, historyIds: new Set(), lookups: v2, notBeforeMs, now: NOW, backfill: 1 })), ["req-v3", "req-early"]);
  const fake = fakeParaform({ people: [person("cu-1", "Jane Doe")] });
  const memory = memoryStore(v2);
  await runProtectedLookups({ subs, historyIds: new Set(), notBeforeMs, now: NOW, trpcGetImpl: fake.impl, backfill: 1, maxLookups: 2, store: memory.store });
  const byId = Object.fromEntries(memory.saved.map((record) => [record.requestId, record]));
  assert.equal(byId["req-v3"].version, PROTECTED_LOOKUP_VERSION);
  assert.equal(byId["req-v3"].attempts, 1, "attempts counted from 0");
  assert.equal(byId["req-v3"].status, "not_found");
  assert.equal(byId["req-early"].version, PROTECTED_LOOKUP_VERSION);
  // Measured once: the earlier note no longer takes a backfill slot, and the
  // new one waits its ten minutes.
  assert.deepEqual(ids(protectedLookupQueue({ subs, historyIds: new Set(), lookups: byId, notBeforeMs, now: NOW + 60_000, backfill: 1 })), []);
  // A pacing refusal on a version-2 failure starts it over too, without an attempt.
  const refused = Object.assign(new Error("cap"), { code: "PARAFORM_REQUEST_LANES_COOLING_DOWN" });
  const throttledStore = memoryStore(v2);
  await runProtectedLookups({ subs, historyIds: new Set(), notBeforeMs, now: NOW, trpcGetImpl: async () => { throw refused; }, store: throttledStore.store });
  assert.equal(throttledStore.saved[0].version, PROTECTED_LOOKUP_VERSION);
  assert.equal(throttledStore.saved[0].status, "throttled");
  assert.ok(!throttledStore.saved[0].attempts);
  // An earlier note whose v3 lookup was only refused is still owed its look.
  assert.equal(protectedLookupQueue({
    subs, historyIds: new Set(), notBeforeMs, now: NOW, backfill: 1,
    lookups: { "req-v3": byId["req-v3"], "req-early": { requestId: "req-early", status: "throttled", throttled: 1, version: PROTECTED_LOOKUP_VERSION } },
  }).length, 1);
});

test("staff picks: send overrides the lookup, skip removes the row, and a picked note is never looked up", async () => {
  const notBeforeMs = Date.parse("2026-11-06T00:00:00Z");
  const sub = note("Trish J.");
  const subs = new Map([[sub.requestId, sub]]);
  const ambiguous = { requestId: sub.requestId, status: "ambiguous", roleName: "Founding Engineer", companyName: "Acme", options: [] };
  const sendPick = { requestId: sub.requestId, action: "send", candidateUserId: "cu-4", name: "Trish Jun", linkedinUser: "li-cu-4", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-06T18:30:00Z" };
  const args = { subs, historyIds: new Set(), notBeforeMs, now: NOW };
  // Without a pick, an ambiguous note makes no row.
  assert.deepEqual(syntheticProtectedRequests({ ...args, lookups: { [sub.requestId]: ambiguous } }), []);
  const [row] = syntheticProtectedRequests({ ...args, lookups: { [sub.requestId]: ambiguous }, picks: { [sub.requestId]: sendPick } });
  assert.equal(row.candidateUserId, "cu-4");
  assert.equal(row.linkedinUser, "li-cu-4");
  assert.equal(row.roleName, "Founding Engineer");
  assert.equal(row.companyName, "Acme");
  assert.equal(row.protectedSub.via, "staff_pick");
  assert.equal(row.protectedSub.pickedBy, "staff@raydar.xyz");
  assert.equal(row.synthetic, true);
  // A send pick over a lookup that now names someone else makes no row
  // (2026-11-06 review: the send path is no looser than the pick check).
  const resolved = { ...ambiguous, status: "resolved", candidateUserId: "cu-1", linkedinUser: "li-cu-1", via: "crm_row" };
  assert.deepEqual(syntheticProtectedRequests({ ...args, lookups: { [sub.requestId]: resolved }, picks: { [sub.requestId]: sendPick } }), []);
  // The lookup's own answer says how it was found.
  assert.equal(syntheticProtectedRequests({ ...args, lookups: { [sub.requestId]: resolved } })[0].protectedSub.via, "crm_row");
  assert.equal(syntheticProtectedRequests({ ...args, lookups: { [sub.requestId]: resolved } })[0].protectedSub.pickedBy, undefined);
  // Skip, or a send pick with no person: no row, even over a resolved lookup.
  const skipPick = { requestId: sub.requestId, action: "skip", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-06T18:30:00Z" };
  assert.deepEqual(syntheticProtectedRequests({ ...args, lookups: { [sub.requestId]: resolved }, picks: { [sub.requestId]: skipPick } }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, lookups: { [sub.requestId]: resolved }, picks: { [sub.requestId]: { ...sendPick, candidateUserId: "" } } }), []);
  // No lookup record, or one without the role: no row.
  assert.deepEqual(syntheticProtectedRequests({ ...args, lookups: {}, picks: { [sub.requestId]: sendPick } }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, lookups: { [sub.requestId]: { status: "role_unreadable" } }, picks: { [sub.requestId]: sendPick } }), []);
  // Picked notes (either action) are never queued or looked up.
  for (const pick of [sendPick, skipPick]) {
    assert.deepEqual(protectedLookupQueue({ subs, historyIds: new Set(), notBeforeMs, now: NOW, picks: { [sub.requestId]: pick } }), []);
  }
  let calls = 0;
  const memory = memoryStore({ [sub.requestId]: ambiguous });
  const result = await runProtectedLookups({
    subs, historyIds: new Set(), notBeforeMs, now: NOW,
    trpcGetImpl: async () => { calls += 1; return null; },
    picks: { [sub.requestId]: skipPick },
    store: memory.store,
  });
  assert.equal(calls, 0);
  assert.equal(result.looked, 0);
  assert.equal(memory.saved.length, 0);
});

test("staff picks still pass every guard: window, skip list, send cutoff, read, and same person and role already emailed", () => {
  const notBeforeMs = Date.parse("2026-11-06T00:00:00Z");
  const sub = note("Trish J.");
  const subs = new Map([[sub.requestId, sub]]);
  const lookups = { [sub.requestId]: { status: "ambiguous", roleName: "Founding Engineer", companyName: "Acme" } };
  const picks = { [sub.requestId]: { action: "send", candidateUserId: "cu-4", pickedBy: "staff@raydar.xyz" } };
  const args = { subs, lookups, picks, historyIds: new Set(), notBeforeMs, now: NOW };
  assert.equal(syntheticProtectedRequests(args).length, 1);
  assert.deepEqual(syntheticProtectedRequests({ ...args, skip: new Set([sub.requestId]) }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, historyIds: new Set([sub.requestId]) }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, notBeforeMs: Date.parse("2026-11-06T19:00:00Z") }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, notBeforeMs: null }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, now: Date.parse(RECEIVED) + 8 * 24 * 3_600_000 }), []);
  assert.deepEqual(syntheticProtectedRequests({ ...args, subs: new Map([[sub.requestId, { ...sub, submitUrl: "" }]]) }), []);
  // The picked person was already emailed about this role under another request.
  const states = [{ candidateUserId: "cu-4", matches: { other: { requestId: "other", roleId: ROLE, sentAt: "2026-11-05T00:00:00Z" } } }];
  assert.deepEqual(syntheticProtectedRequests({ ...args, states }), []);
  // ...but this request's own earlier send keeps its row.
  const own = [{ candidateUserId: "cu-4", matches: { [sub.requestId]: { requestId: sub.requestId, roleId: ROLE, sentAt: "2026-11-06T18:40:00Z" } } }];
  assert.equal(syntheticProtectedRequests({ ...args, states: own }).length, 1);
});

test("every lookup status has a reason (resolved has none)", () => {
  const statuses = ["resolved", "ambiguous", "background_conflict", "too_many", "incomplete", "not_found", "unconfirmed_name", "role_inactive", "role_unreadable", "no_name", "error", "throttled"];
  for (const status of statuses) {
    const reason = lookupReason({ status });
    if (status === "resolved") assert.equal(reason, null);
    else assert.ok(typeof reason === "string" && reason.length > 10, status);
  }
  assert.match(lookupReason({ status: "not_found", nameForm: "initial" }), /initial/);
  assert.match(lookupReason({ status: "ambiguous" }), /staff pick/);
});

// ── Review fixes (2026-11-06) ────────────────────────────────────────────────

test("review fix: a Paraform name is cleaned like the note's, so a suffixed namesake is never lost", async () => {
  assert.ok(compatibleName("Avery Quill Jr", "Avery Quill Jr"));
  assert.ok(compatibleName("Avery Quill PhD", "Avery Quill PhD"));
  assert.ok(compatibleName("Avery Quill, M.A.Sc., P.Eng.", "Avery Quill, M.A.Sc., P.Eng."));
  assert.ok(compatibleName("Avery Quill", "Avery Quill, PhD"));
  // Father and son both on the role: held for a pick, both offered.
  const fake = fakeParaform({ honourRoles: false, people: [person("cu-dad", "Avery Quill", "recent"), person("cu-son", "Avery Quill Jr", "recent")] });
  const record = await lookupProtectedSub(note("Avery Quill Jr"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "ambiguous");
  assert.equal(record.candidateUserId, undefined);
  assert.deepEqual(record.options.map((option) => option.candidateUserId).sort(), ["cu-dad", "cu-son"]);
  // The letters stored in Paraform's name: still found.
  const lettered = fakeParaform({ honourRoles: false, people: [person("cu-1", "Avery Quill, PhD", "recent")] });
  const found = await lookupProtectedSub(note("Avery Quill, PhD"), { trpcGetImpl: lettered.impl, now: NOW });
  assert.equal(found.status, "resolved");
  assert.equal(found.candidateUserId, "cu-1");
});

test("over the namesake cap a single row holder resolves (v4; held in v3), and read namesakes with the role still make it ambiguous", async () => {
  const people = [1, 2, 3, 4, 5, 6].map((n) => person(`p${n}`, "Avery Quill", n === 1 ? "recent" : null));
  const apps = { p2: [{ role_id: ROLE, created_at: "2026-11-04T18:00:00Z" }] };
  const many = await lookupProtectedSub(note("Avery Quill"), { trpcGetImpl: fakeParaform({ people, apps, honourRoles: false }).impl, now: NOW });
  // v4 (David's rules 2 and 4): the unread namesakes do not hold it.
  assert.equal(many.status, "resolved");
  assert.equal(many.candidateUserId, "p1");
  assert.equal(many.options[0].candidateUserId, "p1", "the row holder is listed first");
  // Three namesakes with the same facts: read and held too.
  const few = await lookupProtectedSub(note("Avery Quill"), { trpcGetImpl: fakeParaform({ people: people.slice(0, 3), apps, honourRoles: false }).impl, now: NOW });
  assert.equal(few.status, "ambiguous");
});

test("review fix: the role-scoped search's one holder is not the answer while another person on the role applied near the note", async () => {
  const people = [person("cu-1", "Avery Quill", "recent"), person("cu-2", "Avery Quill", "old")];
  // v4 review fix (2026-11-07): this used to carry the note's own ctar id;
  // that now names cu-2 outright (below), so a near-note application without
  // it is what keeps two people on the role.
  const apps = { "cu-2": [{ id: "ctar-other", role_id: ROLE, created_at: "2026-11-06T17:54:00Z" }] };
  for (const honourRoles of [true, false]) {
    const fake = fakeParaform({ people, apps, honourRoles });
    const record = await lookupProtectedSub(note("Avery Quill"), { trpcGetImpl: fake.impl, now: NOW });
    assert.equal(record.status, "ambiguous", `honourRoles ${honourRoles}`);
    assert.equal(fake.count(APPS), 1);
  }
  // The note's own id on cu-2's application: cu-2 is the person.
  const ctarApps = { "cu-2": [{ id: "ctar-v3", role_id: ROLE, created_at: "2026-11-06T17:54:00Z" }] };
  for (const honourRoles of [true, false]) {
    const record = await lookupProtectedSub(note("Avery Quill"), { trpcGetImpl: fakeParaform({ people, apps: ctarApps, honourRoles }).impl, now: NOW });
    assert.equal(record.status, "resolved", `honourRoles ${honourRoles}`);
    assert.equal(record.candidateUserId, "cu-2");
    assert.equal(record.confirmedBy, "ctar");
    assert.equal(record.ctarMatch, true);
  }
  // The name search runs even when the scoped search found a holder, so a
  // compatible person the role filter left out is still seen.
  const fake = fakeParaform({ people: [person("cu-1", "Avery Quill", "recent")], nameSearchRows: [person("cu-1", "Avery Quill", "recent"), person("cu-3", "Avery Quill")], apps: { "cu-3": [{ role_id: ROLE, created_at: "2026-11-06T17:00:00Z" }] } });
  const record = await lookupProtectedSub(note("Avery Quill"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "ambiguous");
});

test("review fix: a non-Latin surname is compared, never dropped down to the first name", async () => {
  assert.deepEqual(nameTokens("Avery Квилл"), ["avery", "квилл"]);
  assert.ok(!compatibleName("Avery Квилл", "Avery Петров"));
  assert.ok(compatibleName("Avery Квилл", "avery квилл"));
  assert.ok(compatibleName("Łukasz Nowak", "Lukasz Nowak"), "Ł folds to L");
  const fake = fakeParaform({ people: [person("real", "Avery Kvill", "recent"), person("wrong", "Avery Петров", "recent")] });
  const record = await lookupProtectedSub(note("Avery Квилл"), { trpcGetImpl: fake.impl, now: NOW });
  assert.notEqual(record.status, "resolved");
  assert.equal(record.candidateUserId, undefined);
});

test("review fix: a finished check resets the pacing count, refusals never end the daily re-checks, and a v2 record keeps its role", async () => {
  const notBeforeMs = Date.parse("2026-11-05T00:00:00Z");
  const now = Date.parse("2026-11-07T18:00:00Z");
  const subs = new Map([["req-v3", note("Jane Doe")]]);
  const at = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const due = (record) => protectedLookupQueue({ subs, historyIds: new Set(), lookups: { "req-v3": { version: PROTECTED_LOOKUP_VERSION, ...record } }, notBeforeMs, now }).length === 1;
  assert.equal(due({ status: "too_many", throttled: 12, checkedAt: at(50), lastTriedAt: at(1) }), false, "refusals spent: waits a day");
  assert.equal(due({ status: "too_many", throttled: 12, checkedAt: at(50), lastTriedAt: at(25) }), true, "then tried again");
  assert.equal(due({ status: "throttled", throttled: 12, lastTriedAt: at(25) }), true);
  // A finished check starts the count over.
  const fake = fakeParaform({ people: [person("cu-1", "Jane Doe")] });
  const finished = await lookupProtectedSub(note("Jane Doe"), { trpcGetImpl: fake.impl, now: NOW, previous: { version: PROTECTED_LOOKUP_VERSION, status: "too_many", throttled: 11, attempts: 1 } });
  assert.equal(finished.throttled, 0);
  // A v2 record refused under v3 keeps its role, company and options.
  const memory = memoryStore({ "req-v3": { requestId: "req-v3", version: 2, status: "ambiguous", roleName: "Founding Engineer", companyName: "Acme", options: [{ candidateUserId: "cu-1" }] } });
  const refused = Object.assign(new Error("cap"), { code: "PARAFORM_REQUEST_LANES_RATE_LIMITED" });
  await runProtectedLookups({ subs: new Map([["req-v3", note("Jane Doe")]]), historyIds: new Set(), notBeforeMs: Date.parse("2026-11-06T00:00:00Z"), now: NOW, trpcGetImpl: async () => { throw refused; }, store: memory.store });
  assert.equal(memory.saved[0].status, "throttled");
  assert.equal(memory.saved[0].version, PROTECTED_LOOKUP_VERSION);
  assert.equal(memory.saved[0].roleName, "Founding Engineer");
  assert.equal(memory.saved[0].companyName, "Acme");
  assert.deepEqual(memory.saved[0].options, [{ candidateUserId: "cu-1" }]);
});

test("review fix: a note never looked up goes before re-checks and re-queues of older notes", () => {
  const notBeforeMs = Date.parse("2026-11-01T00:00:00Z");
  const now = Date.parse("2026-11-06T18:00:00Z");
  const older = (n) => note("Jane Doe", { requestId: `req-old-${n}`, receivedAt: `2026-11-0${n}T10:00:00Z` });
  const subs = new Map([
    ...[2, 3, 4].map((n) => [`req-old-${n}`, older(n)]),
    ["req-new", note("Avery Quill", { requestId: "req-new", receivedAt: "2026-11-06T17:00:00Z" })],
    ["req-refused", note("Avery Quill", { requestId: "req-refused", receivedAt: "2026-11-06T16:00:00Z" })],
  ]);
  const lookups = {
    "req-old-2": { version: 2, status: "not_found", attempts: 3, lastTriedAt: "2026-11-05T00:00:00Z" },
    "req-old-3": { version: 3, status: "ambiguous", checkedAt: "2026-11-05T10:00:00Z", lastTriedAt: "2026-11-05T10:00:00Z" },
    "req-old-4": { version: 3, status: "not_found", attempts: 1, checkedAt: "2026-11-06T16:00:00Z", lastTriedAt: "2026-11-06T16:00:00Z" },
    "req-refused": { version: 3, status: "throttled", throttled: 1, lastTriedAt: "2026-11-06T16:30:00Z" },
  };
  const ids = protectedLookupQueue({ subs, historyIds: new Set(), lookups, notBeforeMs, now }).map((sub) => sub.requestId);
  assert.deepEqual(ids, ["req-refused", "req-new", "req-old-2", "req-old-3", "req-old-4"]);
});

test("review fix: a send pick makes no row over an unreadable role or a lookup naming someone else, and says why; a closed role sends (v4)", () => {
  const notBeforeMs = Date.parse("2026-11-06T00:00:00Z");
  const sub = note("Trish J.");
  const subs = new Map([[sub.requestId, sub]]);
  const pick = { action: "send", candidateUserId: "cu-b", name: "Trish Jo", pickedBy: "staff@raydar.xyz" };
  const rows = (lookup) => syntheticProtectedRequests({ subs, lookups: { [sub.requestId]: lookup }, picks: { [sub.requestId]: pick }, historyIds: new Set(), notBeforeMs, now: NOW });
  const base = { status: "ambiguous", roleName: "Founding Engineer", companyName: "Acme" };
  assert.equal(rows(base).length, 1);
  // v4 (David's rule 3): a closed role still sends (v3 made no row).
  assert.equal(rows({ ...base, status: "role_inactive", roleStatus: "CLOSED" }).length, 1);
  assert.deepEqual(rows({ ...base, status: "role_unreadable" }), []);
  assert.deepEqual(rows({ ...base, status: "resolved", candidateUserId: "cu-a" }), []);
  assert.equal(rows({ ...base, status: "resolved", candidateUserId: "cu-b" }).length, 1);
  assert.equal(pickLookupProblem({ ...base, status: "role_inactive", roleStatus: "CLOSED" }, pick), null);
  assert.equal(pickLookupProblem(base, pick), null);
  const states = [{ candidateUserId: "cu-b", matches: { other: { requestId: "other", roleId: ROLE, sentAt: "2026-11-05T00:00:00Z" } } }];
  assert.match(protectedPickBlocked({ sub, lookup: base, pick, states }), /already emailed about this role/);
  assert.equal(protectedPickBlocked({ sub, lookup: base, pick, states: [] }), null);
});

test("review fix: a protected row sends only while the re-read pick still says so", () => {
  const picked = { protectedSub: { via: "staff_pick" }, candidateUserId: "cu-b" };
  const auto = { protectedSub: { via: "crm_row" }, candidateUserId: "cu-a" };
  assert.equal(protectedPickStillSends(picked, { action: "send", candidateUserId: "cu-b" }), true);
  assert.equal(protectedPickStillSends(picked, { action: "skip" }), false);
  assert.equal(protectedPickStillSends(picked, { action: "send", candidateUserId: "cu-c" }), false);
  assert.equal(protectedPickStillSends(picked, null), false);
  assert.equal(protectedPickStillSends(auto, null), true);
  assert.equal(protectedPickStillSends(auto, { action: "skip" }), false);
  assert.equal(protectedPickStillSends(auto, undefined), false, "unreadable sends nothing");
});

// ── Second review (2026-11-06) ───────────────────────────────────────────────

test("second review: a row from Paraform's own read that a note names stops for a skip or a pick of someone else", () => {
  const inRead = { id: "req-in-read", candidateUserId: "cu-a", protectedSub: { submitUrl: "https://www.paraform.com/x" } };
  assert.equal(protectedPickStillSends(inRead, null), true, "no pick: Paraform's row sends");
  assert.equal(protectedPickStillSends(inRead, { action: "skip" }), false, "a staff skip stops it");
  assert.equal(protectedPickStillSends(inRead, { action: "send", candidateUserId: "cu-b" }), false, "a pick of someone else stops it");
  assert.equal(protectedPickStillSends(inRead, { action: "send", candidateUserId: "cu-a" }), true);
  assert.equal(protectedPickStillSends(inRead, undefined), false, "unreadable sends nothing");
  // A looked-up automatic row still needs no pick at all.
  const auto = { synthetic: true, candidateUserId: "cu-a", protectedSub: { via: "crm_row" } };
  assert.equal(protectedPickStillSends(auto, { action: "send", candidateUserId: "cu-a" }), false);
});

test("second review: a lookup never saves over a staff pick made after the tick read the picks", async () => {
  const fake = fakeParaform({ people: [person("cu-1", "Jane Doe", "recent")] });
  const memory = memoryStore();
  const reads = [];
  const sub = note("Jane Doe");
  const result = await runProtectedLookups({
    subs: new Map([[sub.requestId, sub]]),
    historyIds: new Set(),
    notBeforeMs: Date.parse("2026-11-06T00:00:00Z"),
    now: NOW,
    trpcGetImpl: fake.impl,
    // The tick's picks were read before the pick: none.
    picks: {},
    store: {
      ...memory.store,
      getPick: async (requestId) => {
        reads.push(requestId);
        return { requestId, action: "send", candidateUserId: "cu-2", pickedBy: "staff@raydar.xyz" };
      },
    },
  });
  assert.deepEqual(reads, [sub.requestId], "the pick is read again just before the save");
  assert.equal(memory.saved.length, 0, "no lookup saved over the pick");
  assert.equal(result.lookups[sub.requestId], undefined);
  assert.equal(result.pickedMeanwhile, 1);
  // An unreadable pick saves nothing either; no pick saves as before.
  const unreadable = memoryStore();
  await runProtectedLookups({
    subs: new Map([[sub.requestId, sub]]), historyIds: new Set(), notBeforeMs: Date.parse("2026-11-06T00:00:00Z"), now: NOW,
    trpcGetImpl: fakeParaform({ people: [person("cu-1", "Jane Doe", "recent")] }).impl,
    store: { ...unreadable.store, getPick: async () => { throw new Error("kv down"); } },
  });
  assert.equal(unreadable.saved.length, 0);
  const none = memoryStore();
  await runProtectedLookups({
    subs: new Map([[sub.requestId, sub]]), historyIds: new Set(), notBeforeMs: Date.parse("2026-11-06T00:00:00Z"), now: NOW,
    trpcGetImpl: fakeParaform({ people: [person("cu-1", "Jane Doe", "recent")] }).impl,
    store: none.store,
  });
  assert.equal(none.saved.length, 1);
  assert.equal(none.saved[0].status, "resolved");
});

// 2026-11-06: Conor's notes carry the full name, but Paraform shows about 13%
// of its own people as "First L.". Such a row fits the note, is found by the
// "<first> <initial>" search, and resolves on its own only when the person's
// LinkedIn handle spells the note's surname. v4 (2026-11-07): the handle no
// longer gates a lone role holder; nameFullyConfirmed is kept as a measure.
test("a Paraform name cut to an initial fits the full note name, and needs the LinkedIn handle to resolve", () => {
  assert.equal(compatibleName("Avery Quillon", "Avery Q."), true);
  assert.equal(compatibleName("Avery Quillon", "Avery R."), false);
  assert.equal(compatibleName("Avery Quillon", "Blake Q."), false);
  assert.equal(nameFullyConfirmed("Avery Quillon", "Avery Q.", "avery-quillon-7b2"), true);
  assert.equal(nameFullyConfirmed("Avery Quillon", "Avery Q.", "aq1988"), false);
  assert.equal(nameFullyConfirmed("Avery Quillon", "Avery Quillon", null), true);
  assert.equal(nameFullyConfirmed("Avery Q.", "Avery Quillon", "avery-quillon"), false, "a note initial is never confirmed by name");
});

test("a person Paraform shows as First L. is found by the short-form search", async () => {
  const short = (linkedin) => ({ ...person("cu-q", "Avery Q.", "recent"), linkedin_user: linkedin });
  // The full-name search finds nobody; "Avery Q" finds the cut-short row.
  const spelled = fakeParaform({ people: [short("avery-quillon-1"), person("cu-x", "Avery Quist")], honourRoles: false });
  const resolved = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: spelled.impl, now: NOW });
  assert.deepEqual(spelled.calls.filter((call) => call.proc === CRM && !call.input.filters.roles).map((call) => call.input.filters.general_search), ["Avery Quillon", "Avery Q"]);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.candidateUserId, "cu-q");
  assert.equal(resolved.shortFormSearch, "done");
  // Handle does not spell it: v3 held it (unconfirmed_name); v4 resolves
  // the one person with the role (David's rule 2).
  const unspelled = fakeParaform({ people: [short("aq-1988"), person("cu-x", "Avery Quist")], honourRoles: false });
  const held = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: unspelled.impl, now: NOW });
  assert.equal(held.status, "resolved");
  assert.equal(held.candidateUserId, "cu-q");
  assert.equal(held.options[0].candidateUserId, "cu-q");
  assert.match(lookupReason({ status: "unconfirmed_name" }), /only as an initial/, "older records keep their reason");
  // Two cut-short people on the role: ambiguous.
  const twin = fakeParaform({ people: [short("avery-quillon-1"), { ...person("cu-q2", "Avery Q.", "recent"), linkedin_user: "avery-q-2" }], honourRoles: false });
  assert.equal((await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: twin.impl, now: NOW })).status, "ambiguous");
});

test("a full-name holder still resolves when the short-form search is cut off", async () => {
  // The full name finds the holder; the "Avery Q" search runs out of pages.
  const crowd = Array.from({ length: 160 }, (_, n) => person(`q-${n}`, `Avery Qa${n}`));
  const fake = fakeParaform({ people: [person("cu-1", "Avery Quillon", "recent"), ...crowd], honourRoles: false });
  const record = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-1");
  assert.equal(record.shortFormSearch, "unfinished");
  assert.ok(fake.calls.length <= PROTECTED_LOOKUP_MAX_READS);
});

test("cut-short namesakes without the role never hold a full-name match", async () => {
  // Five "Avery Q." people not on the role come back from the short-form
  // search; the full-named holder still resolves, with no applications reads.
  const cut = Array.from({ length: 5 }, (_, n) => ({ ...person(`c-${n}`, "Avery Q."), linkedin_user: `aq-${n}` }));
  const fake = fakeParaform({ people: [person("cu-1", "Avery Quillon", "recent"), ...cut], honourRoles: false });
  const record = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-1");
  assert.equal(record.cutShortUnchecked, 5);
  assert.equal(fake.count(APPS), 0);
  assert.equal(record.options[0].candidateUserId, "cu-1");
});

// Review of the cut-short edit (2026-11-06), five cases that each failed.
test("the short-form search never takes reads the full-name namesakes need", async () => {
  const people = [1, 2, 3, 4].map((n) => person(`cu-${n}`, "Avery Quillon"));
  const fake = fakeParaform({ people, honourRoles: false, apps: { "cu-3": [{ role_id: ROLE, id: "ctar-v3", created_at: RECENT }] } });
  const record = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-3");
  assert.equal(record.shortFormSearch, "skipped");
});

test("a cut-short holder found by an unfinished short-form search is held, unless the background names them", async () => {
  const crowd = Array.from({ length: 140 }, (_, n) => person(`f-${n}`, `Mira S${String.fromCharCode(97 + (n % 26))}x${n}`));
  const people = [
    { ...person("cu-a", "Mira S.", "recent"), linkedin_user: "mirasmithson" },
    ...crowd,
    { ...person("cu-b", "Mira S.", "recent"), linkedin_user: "mira-77" },
  ];
  const record = await lookupProtectedSub(note("Mira Smith"), { trpcGetImpl: fakeParaform({ people, honourRoles: false }).impl, now: NOW });
  // v4 review fix (2026-11-07): a second cut-short person with the role sits
  // past the short-form search's page cap, so the one seen is not the answer
  // ("incomplete", as v3 held it). With the role-scoped search honoured,
  // both are seen and it is ambiguous.
  assert.notEqual(record.status, "resolved");
  assert.equal(record.status, "incomplete");
  assert.equal(record.shortFormSearch, "unfinished");
  // The note's background naming cu-a's employer settles it.
  const named = people.map((row) => (row.id === "cu-a" ? { ...row, experiences: [{ company_name: "Globex" }] } : row));
  const confirmed = await lookupProtectedSub(note("Mira Smith", { fitText: "Led payments at Globex for five years." }), { trpcGetImpl: fakeParaform({ people: named, honourRoles: false }).impl, now: NOW });
  assert.equal(confirmed.status, "resolved");
  assert.equal(confirmed.candidateUserId, "cu-a");
  assert.equal(confirmed.confirmedBy, "role+background");
  const scoped = await lookupProtectedSub(note("Mira Smith"), { trpcGetImpl: fakeParaform({ people }).impl, now: NOW });
  assert.equal(scoped.status, "ambiguous");
});

test("a cut-short holder's unread cut-short namesakes are read with the budget left (v4), and a handle must spell the surname as a word", async () => {
  const people = [
    { ...person("cu-a", "Ray L.", "recent"), linkedin_user: "raylinden" },
    { ...person("cu-b", "Ray L."), linkedin_user: "ray-l-1" },
  ];
  const fake = fakeParaform({ people, apps: { "cu-b": [{ role_id: ROLE, id: "ctar-v3", created_at: RECENT }] } });
  const record = await lookupProtectedSub(note("Ray Lin"), { trpcGetImpl: fake.impl, now: NOW });
  // v4: cu-b's applications are read (the budget had room) and show the
  // note's own id, which names cu-b outright (v4 review fix, 2026-11-07;
  // v3: unconfirmed_name).
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-b");
  assert.equal(record.confirmedBy, "ctar");
  assert.equal(record.cutShortRead, 1);
  // Near the note but without the note's id: two people have the role.
  const near = fakeParaform({ people, apps: { "cu-b": [{ role_id: ROLE, id: "ctar-other", created_at: RECENT }] } });
  assert.equal((await lookupProtectedSub(note("Ray Lin"), { trpcGetImpl: near.impl, now: NOW })).status, "ambiguous");
  assert.equal(nameFullyConfirmed("Ray Lin", "Ray L.", "raylinden"), false);
  assert.equal(nameFullyConfirmed("Ray Lin", "Ray L.", "ray-lin-4"), true);
  assert.equal(nameFullyConfirmed("Avery Quillon", "Avery Q.", "averyquillon88"), true);
});

test("a middle name in the note does not block the LinkedIn confirmation", () => {
  assert.equal(nameFullyConfirmed("Avery Jane Quillon", "Avery Q.", "avery-quillon"), true);
});

test("a one-character non-Latin surname is searched once and resolves on a full match", async () => {
  const fake = fakeParaform({ people: [person("cu-w", "Wei 王", "recent")] });
  const record = await lookupProtectedSub(note("Wei 王"), { trpcGetImpl: fake.impl, now: NOW });
  assert.deepEqual(fake.calls.filter((call) => call.proc === CRM && !call.input.filters.roles).map((call) => call.input.filters.general_search), ["Wei 王"]);
  assert.equal(record.status, "resolved");
});
