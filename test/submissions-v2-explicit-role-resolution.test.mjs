import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedRolePhrase,
  resolveExplicitCandidateRoles,
} from "../api/submissions-v2/_lib/explicit-role-resolution.mjs";
import { paraformRoleLink } from "../api/submissions-v2/_lib/email-source-policy.mjs";

const NOW = Date.parse("2026-09-05T15:00:00.000Z");
const FRESH = "2026-09-05T14:00:00.000Z";
const DIGEST = "a".repeat(64);
const role = (role_id, company_name, role_title, extra = {}) => ({
  role_id, company_name, role_title, active: true, last_confirmed_at: FRESH,
  destination_url: `https://www.paraform.com/browse?role=${role_id}`,
  ...extra,
});
const catalog = (roles) => ({ status: "ready", complete: true, digest: DIGEST, roles });

test("explicit role resolution binds normalized full company-title pairs and one exact list-role URL", () => {
  const roles = [
    role("protege-role", "Protégé", "Forward Deployed Machine Learning Engineer"),
    role("serval-role", "Serval", "Forward Deployed Engineer"),
    role("x5-role", "X5 Labs", "AI Engineer"),
    role("basis-role", "Basis", "Member of Technical Staff - Applied ML"),
    role("brook-role", "Brook Street Labs", "Founding Engineer"),
  ];
  const reply = [
    "Protege — Forward Deployed Machine Learning Engineer",
    "Forward Deployed Engineer at Serval",
    "X5 Labs: AI Engineer",
    "Basis, Member of Technical Staff, Applied ML",
    "Also this: https://www.paraform.com/lists/list-123/role/brook-role.",
    "I'd appreciate introductions to these teams, starting with Protege and Serval.",
  ].join("\n");
  const result = resolveExplicitCandidateRoles(reply, catalog(roles), { now: NOW });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.roles.map((item) => item.role_id), [
    "basis-role", "brook-role", "protege-role", "serval-role", "x5-role",
  ]);
  assert.deepEqual(result.source_evidence.match_kinds, ["company_full_title", "paraform_role_url"]);
  assert.equal(result.source_evidence.resolved_role_count, 5);
  assert.match(result.source_evidence.role_evidence_digest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(result.source_evidence).includes("Protege"), false);
});

test("normalization tolerates separators but preserves technical title tokens", () => {
  assert.equal(
    normalizedRolePhrase("Member of Technical Staff, Applied ML"),
    normalizedRolePhrase("Member of Technical Staff - Applied ML"),
  );
  assert.notEqual(normalizedRolePhrase("C++ Engineer"), normalizedRolePhrase("C Engineer"));
  assert.notEqual(normalizedRolePhrase("C# Engineer"), normalizedRolePhrase("C Engineer"));
  assert.notEqual(normalizedRolePhrase("CI/CD Engineer"), normalizedRolePhrase("CI CD Engineer"));
  assert.notEqual(normalizedRolePhrase("Node.js Engineer"), normalizedRolePhrase("Node JS Engineer"));
});

test("generic replies, title-only mentions, and distant company/title mentions do not bind a role", () => {
  const roles = catalog([role("role-1", "Acme", "Backend Engineer")]);
  for (const reply of [
    "Yes, please.",
    "The Backend Engineer role sounds interesting.",
    "Acme is one company I know. After considering several other teams and options, the Backend Engineer role sounds interesting.",
  ]) {
    assert.equal(resolveExplicitCandidateRoles(reply, roles, { now: NOW }).status, "unresolved");
  }
});

test("a longer full title does not also bind its shorter catalog title", () => {
  const result = resolveExplicitCandidateRoles(
    "Acme — Senior AI Engineer\nI would appreciate an introduction.",
    catalog([
      role("ai", "Acme", "AI Engineer"),
      role("senior-ai", "Acme", "Senior AI Engineer"),
    ]),
    { now: NOW },
  );
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.roles.map((item) => item.role_id), ["senior-ai"]);
});

test("a catalog title cannot bind as a prefix of a longer unrecognized title", () => {
  const roles = catalog([role("short", "Acme", "Engineer")]);
  for (const reply of [
    "Acme - Engineer Manager",
    "Acme Engineer Manager",
    "I am interested in Acme Engineer Manager",
  ]) {
    assert.equal(resolveExplicitCandidateRoles(reply, roles, { now: NOW }).status, "unresolved", reply);
  }
});

test("an exact full title followed by role or position at the exact company can bind", () => {
  const roles = catalog([role("catalyst", "Catalyst", "Founding Designer")]);
  for (const reply of [
    "The Founding Designer role at Catalyst caught my attention, and I would love an introduction.",
    "Founding Designer position at Catalyst. That sounds like a strong fit.",
    "The Founding Designer role at Catalyst caught my attention because of its fast-paced work.",
  ]) {
    const result = resolveExplicitCandidateRoles(reply, roles, { now: NOW });
    assert.equal(result.status, "resolved", reply);
    assert.deepEqual(result.roles.map((item) => item.role_id), ["catalyst"]);
  }
  assert.equal(
    resolveExplicitCandidateRoles("Founding Designer Manager role at Catalyst caught my attention.", roles, { now: NOW }).status,
    "unresolved",
  );
});

test("duplicate labels, stale or inactive roles, unknown URLs, and incomplete catalogs fail closed without partial roles", () => {
  const duplicate = catalog([
    role("one", "Acme", "AI Engineer"),
    role("two", "Acme", "AI Engineer", { active: false }),
  ]);
  assert.deepEqual(
    resolveExplicitCandidateRoles("Acme — AI Engineer", duplicate, { now: NOW }),
    { status: "unresolved", reason: "role_label_ambiguous", roles: [] },
  );

  const stale = catalog([role("stale", "Acme", "Backend Engineer", { last_confirmed_at: "2026-09-04T14:59:59.999Z" })]);
  assert.equal(resolveExplicitCandidateRoles("Acme — Backend Engineer", stale, { now: NOW }).reason, "role_label_unavailable");

  const mixed = catalog([role("known", "Acme", "Backend Engineer")]);
  const mixedReply = "Acme — Backend Engineer\nhttps://www.paraform.com/lists/list-1/role/unknown";
  assert.deepEqual(
    resolveExplicitCandidateRoles(mixedReply, mixed, { now: NOW }),
    { status: "unresolved", reason: "role_url_unavailable", roles: [] },
  );
  assert.equal(resolveExplicitCandidateRoles("Acme — Backend Engineer", { ...mixed, complete: false }, { now: NOW }).reason, "catalog_unavailable");
});

test("overlong replies are refused before a later explicit role can be truncated", () => {
  const reply = `Acme — Backend Engineer\n${"x".repeat(6_000)}\nUnknownCo — Astronaut`;
  assert.deepEqual(
    resolveExplicitCandidateRoles(reply, catalog([role("known", "Acme", "Backend Engineer")]), { now: NOW }),
    { status: "unresolved", reason: "candidate_text_too_large", roles: [] },
  );
});

test("quoted or forwarded role text can never supply candidate-authored role evidence", () => {
  const roles = catalog([role("known", "Acme", "Backend Engineer")]);
  for (const reply of [
    "Yes, please.\nOn Wed, David wrote:\n> Acme — Backend Engineer",
    "On Wed, David wrote:\nAcme — Backend Engineer",
    "Yes, please.\n--- Forwarded Message\nAcme — Backend Engineer",
    "Yes, please.\n> Acme — Backend Engineer",
  ]) {
    assert.equal(
      resolveExplicitCandidateRoles(reply, roles, { now: NOW }).reason,
      "candidate_text_contains_quoted_history",
      reply,
    );
  }
});

test("a known named role plus any unknown explicit list entry fails as one indivisible set", () => {
  const roles = catalog([role("known", "Acme", "Backend Engineer")]);
  for (const reply of [
    "Acme — Backend Engineer\nUnknownCo — Astronaut",
    "Acme — Backend Engineer; UnknownCo: Astronaut",
    "Acme — Backend Engineer\nUnknownCo- Astronaut",
    "Acme — Backend Engineer\nUnknownCo-Astronaut",
    "Acme — Backend Engineer\nUnknownCo at Astronaut",
    "Acme — Backend Engineer\nAstronaut at UnknownCo",
    "Acme — Backend Engineer\nUnknownCo with Astronaut",
  ]) {
    assert.deepEqual(
      resolveExplicitCandidateRoles(reply, roles, { now: NOW }),
      { status: "unresolved", reason: "partial_explicit_role_list", roles: [] },
      reply,
    );
  }
});

test("invalid Paraform-looking references invalidate the whole candidate-authored role set", () => {
  const roles = catalog([role("known", "Acme", "Backend Engineer")]);
  for (const invalidUrl of [
    "http://www.paraform.com/lists/list-1/role/known",
    "https://www.paraform.com/lists/list-1/role/known?source=reply",
    "https://www.paraform.com/lists/list-1/role/known%2Fother",
    "https://www.paraform.com/jobs/known",
    "www.paraform.com/lists/list-1/role/known",
  ]) {
    assert.equal(
      resolveExplicitCandidateRoles(`Acme — Backend Engineer\n${invalidUrl}`, roles, { now: NOW }).reason,
      "role_url_invalid",
      invalidUrl,
    );
  }
});

test("existing exact browse and share URLs remain valid and duplicate evidence resolves once", () => {
  const roles = catalog([role("known-role", "Acme", "Backend Engineer")]);
  const reply = [
    "Acme — Backend Engineer",
    "https://www.paraform.com/browse?role=known-role",
    "https://www.paraform.com/share/acme/known-role",
  ].join("\n");
  const result = resolveExplicitCandidateRoles(reply, roles, { now: NOW });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.roles.map((item) => item.role_id), ["known-role"]);
  assert.equal(result.source_evidence.resolved_role_count, 1);
});

test("a conversational preface before an exact role URL is not mistaken for another list entry", () => {
  const result = resolveExplicitCandidateRoles(
    "Also this :- https://www.paraform.com/lists/list-1/role/known-role\nI'd appreciate an introduction to this team.",
    catalog([role("known-role", "Acme", "Backend Engineer")]),
    { now: NOW },
  );
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.roles.map((item) => item.role_id), ["known-role"]);
});

test("Paraform list-role URLs are exact and reject unsafe path variants", () => {
  assert.equal(
    paraformRoleLink("https://www.paraform.com/lists/list-123/role/role-456")?.role_id,
    "role-456",
  );
  for (const value of [
    "http://www.paraform.com/lists/list-123/role/role-456",
    "https://evil.example/lists/list-123/role/role-456",
    "https://www.paraform.com/lists/list-123/role/role-456?next=1",
    "https://www.paraform.com/lists/list-123/role/role-456#fragment",
    "https://www.paraform.com/lists/list-123/role/role%2F456",
    "https://user@www.paraform.com/lists/list-123/role/role-456",
  ]) assert.equal(paraformRoleLink(value), null, value);
});
