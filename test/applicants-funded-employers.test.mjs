import assert from "node:assert/strict";
import test from "node:test";

import {
  compileFundedEmployerSnapshot,
  importFundedEmployerSnapshot,
  loadFundedEmployerSnapshots,
} from "../api/applicants/_lib/funded-employers.mjs";
import { FACTS_VERSION, MAX_JOBS, factsFromProfile } from "../api/applicants/_lib/facts.mjs";
import { evaluateRule, validateCondition } from "../api/applicants/_lib/rules.mjs";
import { K } from "../api/applicants/_lib/kv.mjs";
import { createFundedEmployersHandler } from "../api/applicants/funded-employers.mjs";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const SNAPSHOT_ID = "funded-us-gb-ca-2026-09-05";

function manifest(entries = []) {
  return {
    snapshotId: SNAPSHOT_ID,
    generatedAt: "2026-09-05T10:00:00.000Z",
    criteria: {
      headquartersCountryCodes: ["US", "GB", "CA"],
      minimumTotalFundingUsd: 1_000_000,
      qualifyingFundingRoundTypes: ["seed", "series_a", "series_b", "series_c", "series_d"],
      qualifyingRoundAnnouncedOnOrAfter: "2011-09-05",
      qualifyingRoundAnnouncedOnOrBefore: "2026-09-05",
    },
    provenance: {
      provider: "crunchbase",
      exportedAt: "2026-09-05T09:00:00.000Z",
      sourceFileSha256: "a".repeat(64),
      qualifyingSearch: {
        entity: "organizations",
        filters: { fundingRoundTypes: ["seed", "series_a", "series_b", "series_c", "series_d"] },
      },
      queryEvidenceSha256: "b".repeat(64),
    },
    entries: entries.length ? entries : [{
      orgId: "org_acme",
      name: "Acme",
      legalName: "Acme, Inc.",
      aliases: ["Acme Labs"],
      countryCode: "US",
      domain: "https://www.acme.example",
      linkedin: "https://www.linkedin.com/company/acme",
      paraformCompanyIds: ["pf_acme"],
      fundingProof: { totalFundingUsd: 2_500_000, sourceRowId: "org_acme" },
    }],
  };
}

const membershipRule = {
  id: "rule-funded",
  name: "Funded employer history",
  action: "interview",
  state: "live",
  scope: { roleIds: [] },
  conditions: [{ field: "employment.fundedEmployerSnapshot", op: "member_of", value: SNAPSHOT_ID }],
};

function subject(experiences, snapshots) {
  return {
    row: { roleId: "role-1", tier: "C" },
    facts: factsFromProfile({ experiences, education: [] }, { now: NOW }),
    fundedEmployerSnapshots: snapshots,
  };
}

test("snapshot compiler keeps private provenance and builds only reviewed Paraform id membership", () => {
  const { snapshot, metadata } = compileFundedEmployerSnapshot(manifest());
  assert.equal(metadata.companyCount, 1);
  assert.equal(metadata.reviewedParaformIdCount, 1);
  assert.deepEqual(snapshot.byParaformId.pf_acme, { orgId: "org_acme", name: "Acme" });
  assert.equal(snapshot.entries[0].domain, "acme.example");
  assert.equal(metadata.digest, snapshot.digest);
});

test("names and domains never substitute for a reviewed Paraform company id", () => {
  const { snapshot } = compileFundedEmployerSnapshot(manifest());
  const snapshots = { [SNAPSHOT_ID]: snapshot };
  assert.equal(evaluateRule(membershipRule, subject([
    { companyId: "pf_acme", companyName: "Acme" },
  ], snapshots)).matched, true);

  const sameName = evaluateRule(membershipRule, subject([
    { companyId: "pf_unrelated", companyName: "Acme" },
  ], snapshots));
  assert.equal(sameName.matched, false, "a namesake outside the whitelist must not match");

  const nameOnly = evaluateRule(membershipRule, subject([
    { companyId: null, companyName: "Acme" },
  ], snapshots));
  assert.equal(nameOnly.matched, false);
  assert.equal(nameOnly.skipped, true);
  assert.equal(nameOnly.reason, "employment_company_id_missing");
});

test("membership scans employment beyond the existing fourteen-job rule cap", () => {
  const { snapshot } = compileFundedEmployerSnapshot(manifest());
  const experiences = Array.from({ length: MAX_JOBS + 2 }, (_, index) => ({
    companyId: index === MAX_JOBS + 1 ? "pf_acme" : `pf_other_${index}`,
    companyName: index === MAX_JOBS + 1 ? "Acme" : `Other ${index}`,
  }));
  const facts = factsFromProfile({ experiences, education: [] }, { now: NOW });
  assert.equal(facts.jobs.length, MAX_JOBS, "existing row-scoped rule storage stays capped");
  assert.equal(facts.allCompanies.length, MAX_JOBS + 2);
  assert.equal(evaluateRule(membershipRule, {
    row: {}, facts, fundedEmployerSnapshots: { [SNAPSHOT_ID]: snapshot },
  }).matched, true);
});

test("old additive facts and a missing immutable snapshot both fail closed", () => {
  const oldFacts = { v: FACTS_VERSION, hasHistory: true, jobs: [], schools: [] };
  const old = evaluateRule(membershipRule, { row: {}, facts: oldFacts, fundedEmployerSnapshots: {} });
  assert.deepEqual({ matched: old.matched, skipped: old.skipped, reason: old.reason }, {
    matched: false, skipped: true, reason: "employment_history_not_refreshed",
  });

  const missing = evaluateRule(membershipRule, subject([
    { companyId: "pf_acme", companyName: "Acme" },
  ], {}));
  assert.deepEqual({ matched: missing.matched, skipped: missing.skipped, reason: missing.reason }, {
    matched: false, skipped: true, reason: "membership_snapshot_missing",
  });
});

test("the compiler rejects ambiguous reviewed ids and a source row outside the locked cohort", () => {
  const duplicateMapping = manifest([
    manifest().entries[0],
    { ...manifest().entries[0], orgId: "org_namesake", name: "Namesake", paraformCompanyIds: ["pf_acme"] },
  ]);
  assert.throws(() => compileFundedEmployerSnapshot(duplicateMapping), /funded_employer_paraform_id_ambiguous/);
  assert.throws(() => compileFundedEmployerSnapshot(manifest([
    { ...manifest().entries[0], countryCode: "FR" },
  ])), /funded_employer_country_invalid/);
});

test("import is immutable and the shared loader detects missing or corrupt snapshots", async () => {
  const state = {};
  const readJson = async (key) => state[key] ?? null;
  const writeJson = async (key, value) => { state[key] = value; };
  const writeIfAbsent = async (key, value) => {
    if (state[key]) return null;
    state[key] = value;
    return "OK";
  };
  const first = await importFundedEmployerSnapshot(manifest(), { readJson, writeJson, writeIfAbsent });
  assert.equal(first.created, true);
  assert.equal(first.catalog.activeSnapshotId, SNAPSHOT_ID);
  const loaded = await loadFundedEmployerSnapshots([membershipRule], { readJson });
  assert.ok(loaded[SNAPSHOT_ID]);

  state[K.fundedEmployerSnapshot(SNAPSHOT_ID)] = {
    ...state[K.fundedEmployerSnapshot(SNAPSHOT_ID)],
    byParaformId: { injected: { orgId: "org_bad", name: "Injected" } },
  };
  assert.deepEqual(await loadFundedEmployerSnapshots([membershipRule], { readJson }), {});
});

test("only a bounded immutable snapshot id is valid for the compact condition", () => {
  assert.equal(validateCondition(membershipRule.conditions[0]), null);
  assert.match(validateCondition({
    field: "employment.fundedEmployerSnapshot", op: "member_of", value: "../private",
  }), /invalid value/);
  assert.match(validateCondition({
    field: "employment.fundedEmployerSnapshot", op: "any_of", value: [SNAPSHOT_ID],
  }), /does not support/);
});

test("the private import route requires publisher auth and never returns licensed rows", async () => {
  const state = {};
  const response = () => ({
    statusCode: null, body: null, headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const deps = {
    corsHandler: () => false,
    authHandler: (req) => req.headers.authorization === "Bearer test",
    kvReady: () => true,
    readJson: async (key) => state[key] ?? null,
    writeJson: async (key, value) => { state[key] = value; },
    writeIfAbsent: async (key, value) => {
      if (state[key]) return null;
      state[key] = value;
      return "OK";
    },
  };
  const denied = response();
  await createFundedEmployersHandler(deps)({ method: "POST", headers: {}, body: manifest() }, denied);
  assert.equal(denied.statusCode, 401);
  assert.deepEqual(state, {});

  const imported = response();
  await createFundedEmployersHandler(deps)({
    method: "POST", headers: { authorization: "Bearer test" }, body: manifest(),
  }, imported);
  assert.equal(imported.statusCode, 201);
  assert.equal(imported.body.snapshot.companyCount, 1);
  assert.equal("entries" in imported.body.snapshot, false);
  assert.equal(JSON.stringify(imported.body).includes("Acme Labs"), false);
});
