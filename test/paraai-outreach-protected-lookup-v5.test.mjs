// Lookup v5 for rating-protected subs (2026-11-19): a full-named note that
// no search found anyone for is also searched by surname alone, because
// Paraform's search matches the stored name as typed (a double space between
// first name and surname hid a person who had the note's role). All names
// and companies here are made up.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTECTED_LOOKUP_VERSION,
  lookupProtectedSub,
  protectedLookupQueue,
  roleLinkInRow,
} from "../api/paraai/_lib/outreach-protected-lookup.mjs";

const ROLE = "role-v5";
const RECEIVED = "2026-11-12T21:00:00.000Z";
const NOW = Date.parse("2026-11-19T15:00:00Z");
const RECENT = "2026-11-12T20:54:00Z";
const CRM = "candidateUser.getCRMExternalCandidates";
const APPS = "candidateUser.getCandidateUserApplications";

const note = (candidateName, extra = {}) => ({
  requestId: "req-v5",
  ctarId: "ctar-v5",
  roleId: ROLE,
  candidateName,
  companyName: "Acme",
  submitUrl: `https://www.paraform.com/company/acme/${ROLE}/recruit/submit_candidate?from_submission_request=true&submission_request_id=req-v5`,
  receivedAt: RECEIVED,
  fitText: "",
  ...extra,
});

const person = (id, name, { role = false } = {}) => ({
  id,
  name,
  linkedin_user: `li-${id}`,
  roles: role ? [{ role_id: ROLE, created_at: RECENT }] : [{ role_id: "role-other", created_at: RECENT }],
  experiences: [],
});

// Paraform's search as measured on 2026-11-19: a case-insensitive match on
// the stored name as typed, so "Avery Quillon" never finds "Avery  Quillon".
function fakeParaform({ people = [], honourRoles = false } = {}) {
  const calls = [];
  const impl = async (proc, input) => {
    calls.push({ proc, input });
    if (proc === "role.getRoleByIdSimple") return { id: ROLE, status: "ACTIVE", title: "Founding Engineer", company: { name: "Acme" } };
    if (proc === CRM) {
      const filters = input.filters || {};
      const q = String(filters.general_search || "").toLowerCase();
      let rows = people.filter((row) => row.name.toLowerCase().includes(q));
      if (Array.isArray(filters.roles) && honourRoles) rows = rows.filter((row) => roleLinkInRow(row, filters.roles[0]));
      const offset = Number(input.cursor || 0);
      return { items: rows.slice(offset, offset + input.limit), next_cursor: offset + input.limit < rows.length ? offset + input.limit : null };
    }
    if (proc === APPS) return [];
    throw new Error(`unexpected ${proc}`);
  };
  const terms = () => calls.filter((call) => call.proc === CRM && !call.input.filters.roles).map((call) => call.input.filters.general_search);
  return { impl, calls, terms };
}

test("v5: the version is bumped so held notes are looked up again", () => {
  assert.equal(PROTECTED_LOOKUP_VERSION, 5);
  const sub = note("Avery Quillon");
  const queue = protectedLookupQueue({
    subs: new Map([[sub.requestId, sub]]),
    historyIds: new Set(),
    lookups: { [sub.requestId]: { requestId: sub.requestId, status: "not_found", version: 4, attempts: 3, lastTriedAt: "2026-11-19T14:00:00Z", checkedAt: "2026-11-19T14:00:00Z" } },
    notBeforeMs: Date.parse("2026-11-01T00:00:00Z"),
    now: NOW,
  });
  assert.deepEqual(queue.map((entry) => entry.requestId ?? entry.sub?.requestId ?? entry), [sub.requestId]);
});

test("v5: a role holder stored with two spaces in the name is found by surname and resolves", async () => {
  const fake = fakeParaform({ people: [
    person("cu-1", "Avery  Quillon", { role: true }),
    person("cu-2", "Avery Moss"),
  ] });
  const record = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "resolved");
  assert.equal(record.candidateUserId, "cu-1");
  assert.equal(record.confirmedBy, "role");
  assert.equal(record.surnameSearch, "done");
  assert.deepEqual(fake.terms(), ["Avery Quillon", "Avery Q", "Quillon"]);
  assert.ok(record.reads <= 7);
});

test("v5: a surname match without the role is only an option, never a send", async () => {
  const fake = fakeParaform({ people: [person("cu-1", "Avery  Quillon"), person("cu-2", "Avery Moss")] });
  const record = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "not_found");
  assert.equal(record.surnameSearch, "done");
  assert.deepEqual(record.options.map((option) => option.candidateUserId), ["cu-1"]);
});

test("v5: another first name with the surname is never taken", async () => {
  const fake = fakeParaform({ people: [person("cu-1", "Blake  Quillon", { role: true })] });
  const record = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.status, "not_found");
  assert.equal(record.surnameSearch, "done");
  assert.deepEqual(record.options, []);
});

test("v5: no surname search when the full-name search found someone", async () => {
  const fake = fakeParaform({ people: [person("cu-1", "Avery Quillon"), person("cu-2", "Avery  Quillon", { role: true })] });
  const record = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.surnameSearch, undefined);
  assert.ok(!fake.terms().includes("Quillon"));
  assert.notEqual(record.candidateUserId, "cu-2");
});

test("v5: no surname search for an initial surname or a surname under three letters", async () => {
  const initial = fakeParaform({ people: [person("cu-1", "Avery  Quillon", { role: true }), person("cu-2", "Avery Moss")] });
  await lookupProtectedSub(note("Avery Q."), { trpcGetImpl: initial.impl, now: NOW });
  assert.ok(!initial.terms().includes("Quillon") && !initial.terms().includes("Q."));
  const short = fakeParaform({ people: [person("cu-1", "Avery  Li", { role: true }), person("cu-2", "Avery Moss")] });
  const record = await lookupProtectedSub(note("Avery Li"), { trpcGetImpl: short.impl, now: NOW });
  assert.equal(record.surnameSearch, undefined);
  assert.equal(record.status, "not_found");
});

test("v5: a surname search cut off at its page cap holds the note with what it found", async () => {
  const crowd = Array.from({ length: 60 }, (_, index) => person(`cu-x${index}`, `Other${String.fromCharCode(97 + (index % 26))} Quillon`));
  const fake = fakeParaform({ people: [person("cu-1", "Avery  Quillon", { role: true }), person("cu-2", "Avery Moss"), ...crowd] });
  const record = await lookupProtectedSub(note("Avery Quillon"), { trpcGetImpl: fake.impl, now: NOW });
  assert.equal(record.surnameSearch, "unfinished");
  assert.equal(record.status, "incomplete");
  assert.deepEqual(record.options.map((option) => option.candidateUserId), ["cu-1"]);
});
