#!/usr/bin/env node

/**
 * Local-only Applicants Rules design fixture.
 *
 * This server deliberately has no proxy and never imports a production API
 * handler. It serves the repository's real static UI, answers only the small
 * synthetic API surface below, and keeps every mutation in this process's
 * memory. Restarting it restores the fixtures.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { DEGREE_LEVELS, DEGREE_LEVEL_LABELS } from "../api/applicants/_lib/degree.mjs";
import {
  compileFundedEmployerSnapshot,
  loadFundedEmployerSnapshots,
  readFundedEmployerCatalog,
} from "../api/applicants/_lib/funded-employers.mjs";
import { factsFromProfile } from "../api/applicants/_lib/facts.mjs";
import { K } from "../api/applicants/_lib/kv.mjs";
import { ruleInterviewSkipReason } from "../api/applicants/_lib/rule-interview-eligibility.mjs";
import {
  FIELD_GROUPS,
  evaluateRule,
  fieldCatalog,
  inScope,
  normalizeRule,
} from "../api/applicants/_lib/rules.mjs";

const ROOT = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const FIXTURE_EMAIL = "local-rules-fixture@raydar.invalid";
const FUNDED_SNAPSHOT_ID = "local-funded-companies-2026-09-05";
const SOURCE_PAYLOAD_DIGEST = "f".repeat(64);
const generation = Object.freeze({
  generationId: "local-rules-design-fixture-v1",
  digest: "local-fixture-no-production-data",
  sourceCutoff: "2026-09-05T16:00:00.000Z",
  sourceWatermark: "synthetic-only",
  publishedAt: "2026-09-05T16:00:00.000Z",
});

const roles = Object.freeze([
  ["role-platform", "Senior Platform Engineer", "Northstar Labs"],
  ["role-product", "Product Designer", "Cinder Studio"],
  ["role-ops", "Recruiting Operations Lead", "Juniper Health"],
]);

function fundedHistoryBeyondRuleCap() {
  return [
    { companyId: "company-anthropic", companyName: "Anthropic", roleTitle: "Machine Learning Engineer", start: "2022-04-01", end: null, current: true, industry: "Artificial intelligence", talentRank: "S" },
    ...Array.from({ length: 14 }, (_, index) => ({
      companyId: `company-synthetic-${index + 1}`,
      companyName: `Synthetic Past Company ${index + 1}`,
      roleTitle: "Software Engineer",
      start: `${2007 + index}-01-01`, end: `${2007 + index}-10-01`, current: false,
      industry: "Synthetic fixture", talentRank: null,
    })),
    { companyId: null, companyName: "Orbit Birch", roleTitle: "Early Engineer", start: "2006-01-01", end: "2006-12-01", current: false, industry: "Synthetic fixture", talentRank: null },
  ];
}

const profiles = {
  "core:local0000000000000000000000000001": {
    name: "Maya Chen", title: "Senior backend engineer", location: "San Francisco, CA",
    about: "Builds reliable developer infrastructure.", linkedin: null, updatedAt: "2026-09-03T18:00:00.000Z",
    densityScore: 88, possibleFake: false, resumeUrl: "local-fixture-resume",
    experiences: [{ companyId: "company-stripe", companyName: "Stripe", roleTitle: "Senior Software Engineer", start: "2021-02-01", end: null, current: true, industry: "Financial technology", talentRank: "S" }],
    education: [{ schoolId: "school-berkeley", school: "University of California, Berkeley", degree: "B.S. Computer Science", start: "2013-08-01", end: "2017-05-01", schoolLocation: "Berkeley, California, United States", schoolWebsite: "berkeley.edu", talentRank: "S" }],
  },
  "core:local0000000000000000000000000002": {
    name: "Jon Bell", title: "Founding product designer", location: "Brooklyn, NY",
    about: "Product designer for early-stage teams.", linkedin: null, updatedAt: "2026-09-01T12:00:00.000Z",
    densityScore: 73, possibleFake: false, resumeUrl: null,
    experiences: [{ companyId: "company-figma", companyName: "Figma", roleTitle: "Product Designer", start: "2020-01-01", end: "2024-03-01", current: false, industry: "Design software", talentRank: "A" }],
    education: [{ schoolId: "school-risd", school: "Rhode Island School of Design", degree: "BFA Graphic Design", start: "2012-08-01", end: "2016-05-01", schoolLocation: "Providence, Rhode Island, United States", schoolWebsite: "risd.edu", talentRank: "A" }],
  },
  "core:local0000000000000000000000000003": {
    name: "Priya Raman", title: "People operations leader", location: "Austin, TX",
    about: "Scales recruiting operations.", linkedin: null, updatedAt: "2026-09-04T09:30:00.000Z",
    densityScore: 66, possibleFake: false, resumeUrl: "local-fixture-resume",
    experiences: [{ companyId: "company-rippling", companyName: "Rippling", roleTitle: "Recruiting Operations Manager", start: "2019-06-01", end: null, current: true, industry: "HR technology", talentRank: "A" }],
    education: [{ schoolId: "school-michigan", school: "University of Michigan", degree: "Bachelor of Arts", start: "2011-09-01", end: "2015-05-01", schoolLocation: "Ann Arbor, Michigan, United States", schoolWebsite: "umich.edu", talentRank: "A" }],
  },
  "core:local0000000000000000000000000004": {
    name: "Alex Morgan", title: "Software engineer", location: "Toronto, Canada",
    about: null, linkedin: null, updatedAt: "2026-08-29T15:00:00.000Z",
    densityScore: 59, possibleFake: false, resumeUrl: null,
    experiences: [{ companyId: "company-shopify", companyName: "Shopify", roleTitle: "Software Engineer", start: "2022-01-01", end: null, current: true, industry: "Commerce", talentRank: "B" }],
    education: [{ schoolId: "school-waterloo", school: "University of Waterloo", degree: "Bachelor of Computer Science", start: "2017-09-01", end: "2021-05-01", schoolLocation: "Waterloo, Ontario, Canada", schoolWebsite: "uwaterloo.ca", talentRank: "A" }],
  },
  "core:local0000000000000000000000000005": {
    name: "Sam Rivera", title: null, location: "Phoenix, AZ", about: null, linkedin: null,
    updatedAt: "2026-09-02T10:00:00.000Z", densityScore: null, possibleFake: false, resumeUrl: null,
    experiences: [], education: [],
  },
  "core:local0000000000000000000000000006": {
    name: "Noor Haddad", title: "ML infrastructure engineer", location: "Seattle, WA",
    about: "Production ML systems.", linkedin: null, updatedAt: "2026-09-04T19:00:00.000Z",
    densityScore: 91, possibleFake: false, resumeUrl: "local-fixture-resume",
    experiences: fundedHistoryBeyondRuleCap(),
    education: [{ schoolId: "school-cmu", school: "Carnegie Mellon University", degree: "M.S. Machine Learning", start: "2018-08-01", end: "2020-05-01", schoolLocation: "Pittsburgh, Pennsylvania, United States", schoolWebsite: "cmu.edu", talentRank: "S" }],
  },
};

// Synthetic only: the application record stays at the top level while the
// cache-derived LinkedIn record is explicitly nested. This lets the preview
// exercise provenance, unknown values, and the C-tier case without reading a
// provider or resembling a production applicant.
const paraformOverlays = {
  "core:local0000000000000000000000000001": {
    title: "Infrastructure engineer building developer platforms",
    location: "San Francisco, CA", densityScore: 88, paraformTier: "S", paraformTierSource: "paraform",
    paraformUpdatedAt: "2026-09-04T18:00:00.000Z", profileEnrichedAt: "2026-09-05T15:00:00.000Z",
    experiences: [{ companyName: "Stripe", roleTitle: "Staff Infrastructure Engineer", start: "2021-02-01", end: null, current: true, industry: "Financial technology", talentRank: "S", logo: null }],
    education: [{ school: "University of California, Berkeley", degree: "B.S. Computer Science", start: "2013-08-01", end: "2017-05-01", talentRank: "S", logo: null }],
  },
  "core:local0000000000000000000000000002": {
    title: "Product designer for early-stage teams", location: "Brooklyn, NY", densityScore: 73, paraformTier: "A", paraformTierSource: "paraform",
    paraformUpdatedAt: "2026-09-03T12:00:00.000Z", profileEnrichedAt: "2026-09-05T15:00:00.000Z",
    experiences: [{ companyName: "Figma", roleTitle: "Product Designer", start: "2020-01-01", end: "2024-03-01", current: false, industry: "Design software", talentRank: "A", logo: null }],
    education: [{ school: "Rhode Island School of Design", degree: "BFA Graphic Design", start: "2012-08-01", end: "2016-05-01", talentRank: "A", logo: null }],
  },
  "core:local0000000000000000000000000003": {
    title: "Recruiting operations leader", location: "Austin, TX", densityScore: 66, paraformTier: null, paraformTierSource: null,
    paraformUpdatedAt: "2026-09-04T09:30:00.000Z", profileEnrichedAt: "2026-09-05T15:00:00.000Z",
    experiences: [{ companyName: "Rippling", roleTitle: "Recruiting Operations Manager", start: "2019-06-01", end: null, current: true, industry: "HR technology", talentRank: "B", logo: null }],
    education: [{ school: "University of Michigan", degree: "Bachelor of Arts", start: "2011-09-01", end: "2015-05-01", talentRank: "A", logo: null }],
  },
  "core:local0000000000000000000000000004": {
    title: "Software engineer focused on commerce systems", location: "Toronto, Canada", densityScore: 59, paraformTier: "C", paraformTierSource: "paraform",
    paraformUpdatedAt: "2026-09-02T15:00:00.000Z", profileEnrichedAt: "2026-09-05T15:00:00.000Z",
    experiences: [{ companyName: "Shopify", roleTitle: "Software Engineer", start: "2022-01-01", end: null, current: true, industry: "Commerce", talentRank: "C", logo: null }],
    education: [{ school: "University of Waterloo", degree: "Bachelor of Computer Science", start: "2017-09-01", end: "2021-05-01", talentRank: "A", logo: null }],
  },
};
for (const [profileKey, overlay] of Object.entries(paraformOverlays)) profiles[profileKey].paraformProfile = overlay;

const profileIds = Object.keys(profiles);
const rows = [
  row(0, 0, "S", "2026-09-05T14:20:00.000Z"),
  row(1, 1, "A", "2026-09-05T13:05:00.000Z"),
  row(2, 2, "B", "2026-09-05T11:40:00.000Z"),
  row(3, 0, "B", "2026-09-04T20:15:00.000Z"),
  row(4, 1, "unrated", "2026-09-04T17:30:00.000Z"),
  row(5, 0, "S", "2026-09-04T16:10:00.000Z"),
];

function row(profileIndex, roleIndex, tier, appliedAt) {
  const profileKey = profileIds[profileIndex];
  const [roleId, roleTitle, company] = roles[roleIndex];
  return {
    key: `${profileKey}:${roleId}`, profileKey, cuId: null,
    name: profiles[profileKey].name, roleId, roleTitle, company, tier, appliedAt,
    linkedin: null, inputRevision: `local-input-${profileIndex + 1}`,
    readinessRevision: `local-ready-${profileIndex + 1}`, decisionRevision: 0,
    sourceObservationId: `local-source-${profileIndex + 1}`,
  };
}

function compactParaformProfile(profile) {
  const overlay = profile.paraformProfile;
  if (!overlay) return null;
  return {
    title: overlay.title, location: overlay.location, updatedAt: overlay.paraformUpdatedAt,
    paraformTier: overlay.paraformTier, paraformTierSource: overlay.paraformTierSource,
    densityScore: overlay.densityScore, profileEnrichedAt: overlay.profileEnrichedAt,
    exp: overlay.experiences.slice(0, 3).map((item) => ({ role: item.roleTitle, company: item.companyName, start: item.start, end: item.end, current: item.current, logo: item.logo, talentRank: item.talentRank })),
    edu: overlay.education.slice(0, 3).map((item) => ({ school: item.school, degree: item.degree, start: item.start, end: item.end, logo: item.logo, talentRank: item.talentRank })),
    expCount: overlay.experiences.length, eduCount: overlay.education.length,
  };
}
const cards = Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, {
  title: profile.title, location: profile.location, photo: null,
  exp: profile.experiences.slice(0, 3).map((item) => ({ role: item.roleTitle, company: item.companyName, start: item.start, end: item.end })),
  edu: profile.education.slice(0, 3).map((item) => ({ school: item.school, degree: item.degree, start: item.start, end: item.end })),
  expCount: profile.experiences.length, eduCount: profile.education.length,
}]));
// Match production: feed cards stay small. The cached provider history is a
// generation-fenced viewport request from the rendered list rows.
const richCards = Object.fromEntries(Object.entries(profiles).flatMap(([id, profile]) => {
  const paraformProfile = compactParaformProfile(profile);
  return paraformProfile ? [[id, { paraformProfile }]] : [];
}));
const facts = Object.fromEntries(Object.entries(profiles).map(([id, profile], index) => [id, factsFromProfile(profile, {
  now: Date.parse("2026-09-05T16:00:00.000Z"),
  sourceObservationId: `local-source-${index + 1}`,
  sourcePayloadDigest: SOURCE_PAYLOAD_DIGEST,
})]));
const profileReceipts = Object.fromEntries(profileIds.map((id, index) => [id, {
  source: "applicant_hub",
  durable: true,
  historyState: "data",
  sourceObservationId: `local-source-${index + 1}`,
  payloadDigest: SOURCE_PAYLOAD_DIGEST,
}]));

const { snapshot: fundedSnapshot, metadata: fundedMetadata } = compileFundedEmployerSnapshot({
  snapshotId: FUNDED_SNAPSHOT_ID,
  generatedAt: "2026-09-05T15:30:00.000Z",
  criteria: {
    headquartersCountryCodes: ["US", "GB", "CA"],
    minimumTotalFundingUsd: 1_000_000,
    qualifyingFundingRoundTypes: ["seed", "series_a", "series_b", "series_c", "series_d"],
    qualifyingRoundAnnouncedOnOrAfter: "2011-09-05",
    qualifyingRoundAnnouncedOnOrBefore: "2026-09-05",
  },
  provenance: { sources: [{
    id: "local-public-proof-ledger",
    kind: "public_primary_sources",
    observedAt: "2026-09-05T15:00:00.000Z",
    label: "Synthetic fixture evidence",
  }] },
  entries: [{
    orgId: "org-orbit-birch",
    name: "Orbit Birch",
    countryCode: "US",
    domain: "orbit-birch.invalid",
    sourceRef: "local-public-proof-ledger",
    paraformCompanyIds: ["company-orbit-birch"],
    reviewedSourceNames: [{
      name: "Orbit Birch",
      paraformCompanyId: "company-orbit-birch",
      observedAt: "2026-09-05T15:15:00.000Z",
      searchEndpoint: "candidateUser.searchCRMFilterOptions",
      searchUniverse: "paraform_recruiter_crm",
      exactCandidateCount: 1,
      verifiedDomain: "orbit-birch.invalid",
      reviewedBy: "codex",
    }],
    fundingProof: {
      totalFundingUsd: 2_000_000,
      totalFundingSourceUrl: "https://orbit-birch.invalid/funding",
      qualification: {
        kind: "explicit_round",
        stage: "seed",
        announcedDate: "2024-06-15",
        amountUsd: 2_000_000,
        primarySourceUrl: "https://orbit-birch.invalid/funding",
      },
    },
  }],
});

const syntheticMembershipDocuments = new Map([
  [K.fundedEmployerCatalog, {
    activeSnapshotId: FUNDED_SNAPSHOT_ID,
    snapshots: [fundedMetadata],
    updatedAt: "2026-09-05T15:30:00.000Z",
  }],
  [K.fundedEmployerSnapshot(FUNDED_SNAPSHOT_ID), fundedSnapshot],
]);

export async function readSyntheticMembership(key) {
  const value = syntheticMembershipDocuments.get(key);
  return value == null ? null : structuredClone(value);
}

const directory = {
  schools: Object.fromEntries(Object.values(profiles).flatMap((p) => p.education).map((s) => [s.schoolId, s.school])),
  companies: Object.fromEntries(Object.values(profiles).flatMap((p) => p.experiences)
    .filter((job) => job.companyId).map((job) => [job.companyId, job.companyName])),
};

const initialRules = [
  demoRule("demo-top-us", "Top US undergraduate", "interview", "live", [
    { field: "school.inUS", op: "is", value: true },
    { field: "school.level", op: "any_of", value: ["bachelors"] },
  ]),
  demoRule("demo-platform", "Platform engineering background", "interview", "watching", [
    { field: "job.title", op: "contains", value: "engineer" },
    { field: "application.roleId", op: "any_of", value: ["role-platform"] },
  ], { "role-platform": "Senior Platform Engineer" }),
  demoRule("demo-funded", "Worked at a funded company", "interview", "watching", [
    { field: "employment.fundedEmployerSnapshot", op: "member_of", value: FUNDED_SNAPSHOT_ID },
  ]),
  demoRule("demo-no-resume", "No resume attached", "pass", "off", [
    { field: "applicant.hasResume", op: "is", value: false },
  ]),
  demoRule("demo-c-tier", "C tier applications", "pass", "off", [
    { field: "application.tier", op: "any_of", value: ["C"] },
  ]),
];

function demoRule(id, name, action, state, conditions, labels = {}) {
  const normalized = normalizeRule({ id, name, action, state, conditions, labels, scope: { roleIds: [] }, note: "Synthetic local design fixture" }, {
    now: () => "2026-09-05T16:00:00.000Z", by: FIXTURE_EMAIL,
  });
  if (!normalized.ok) throw new Error(`Invalid local fixture rule: ${normalized.error}`);
  return { ...normalized.rule, id, version: 1, versions: [], createdAt: normalized.rule.updatedAt, createdBy: FIXTURE_EMAIL };
}

export function createFixtureState() {
  return {
    rev: 1, pausedAll: false, rules: structuredClone(initialRules),
    decisions: {}, acks: {}, stats: {}, hits: {}, runNumber: 0,
  };
}

function previewRule(rule, state, fundedEmployerSnapshots) {
  const matched = [];
  const skipped = {};
  const pending = pendingRows(state);
  const scoped = pending.filter((candidate) => inScope(rule, candidate));
  for (const candidate of scoped) {
    const result = evaluateRule(rule, {
      row: candidate,
      facts: facts[candidate.profileKey],
      profileReceipt: profileReceipts[candidate.profileKey],
      fundedEmployerSnapshots,
    });
    const hold = rule.action === "interview"
      ? ruleInterviewSkipReason(candidate, { decision: state.decisions[candidate.key], ack: state.acks[candidate.key] }) : null;
    if (result.matched && hold) skipped[hold] = (skipped[hold] || 0) + 1;
    else if (result.matched) matched.push({ candidate, evidence: result.evidence });
    else if (result.skipped) skipped[result.reason] = (skipped[result.reason] || 0) + 1;
  }
  return { pending: pending.length, considered: scoped.length, matched, skipped };
}

function pendingRows(state) {
  return rows.filter((candidate) => !state.decisions[candidate.key]);
}

function rulesPayload(state, withDirectories = false, fundedEmployers = { activeSnapshotId: null, snapshots: [] }) {
  return {
    ok: true, rev: state.rev, pausedAll: state.pausedAll,
    rules: state.rules, stats: state.stats, catalog: fieldCatalog(), groups: FIELD_GROUPS,
    degreeLevels: DEGREE_LEVELS.map((id) => ({ id, label: DEGREE_LEVEL_LABELS[id] })),
    fundedEmployers,
    generation: { generationId: generation.generationId, digest: generation.digest },
    ...(withDirectories ? { directories: directory } : {}),
  };
}

function feedPayload(state) {
  const pending = pendingRows(state);
  return {
    ok: true,
    snapshot: {
      generatedAt: generation.publishedAt, planAt: generation.publishedAt,
      counts: { newToday: 3, queue: pending.length, stream: 2, emailedToday: 0 },
      queue: rows, stream: rows.slice(0, 2), profilePreparing: 0,
    },
    decisions: state.decisions, acks: state.acks, photos: {}, cards,
    counts: { alert: null }, pipeline: null,
    profileCache: { required: true, totalCandidates: rows.length, readyCandidates: rows.length, withheldCandidates: 0 },
    profilePreparing: 0, profileReceiptWithheld: 0, generation,
  };
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-raydar-fixture": "synthetic-local-only",
  });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function generationMatches(body) {
  return String(body.generationId || "") === generation.generationId
    && String(body.generationDigest || "") === generation.digest;
}

async function rulesApi(req, res, url, state, readMembership) {
  if (req.method === "GET") {
    const fundedEmployers = await readFundedEmployerCatalog({ readJson: readMembership });
    return json(res, 200, rulesPayload(state, url.searchParams.get("with") === "directories", fundedEmployers));
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "GET or POST only" });
  let body;
  try { body = await bodyJson(req); } catch (error) { return json(res, 400, { ok: false, error: String(error.message) === "request_too_large" ? "request_too_large" : "invalid_json" }); }
  const op = String(body.op || "").trim();

  if (op === "preview") {
    if (!generationMatches(body)) return json(res, 409, { ok: false, error: "generation_changed_refresh_required", generationId: generation.generationId, generationDigest: generation.digest });
    const normalized = normalizeRule(body.rule, { by: FIXTURE_EMAIL });
    if (!normalized.ok) return json(res, 400, { ok: false, error: "rule_invalid", detail: normalized.error });
    const fundedEmployerSnapshots = await loadFundedEmployerSnapshots([normalized.rule], { readJson: readMembership });
    const result = previewRule(normalized.rule, state, fundedEmployerSnapshots);
    return json(res, 200, {
      ok: true, pending: result.pending, considered: result.considered,
      matched: result.matched.length, skipped: result.skipped,
      generationId: generation.generationId, generationDigest: generation.digest,
      manifest: { count: result.considered, digest: "local-preview-manifest" },
      samples: result.matched.slice(0, 8).map(({ candidate, evidence }) => ({ key: candidate.key, name: candidate.name, roleTitle: candidate.roleTitle, evidence })),
    });
  }

  if (op !== "pauseAll" && Number.isInteger(body.rev) && body.rev !== state.rev) {
    return json(res, 409, { ok: false, error: "rules_changed", rev: state.rev });
  }
  if (op === "pauseAll") {
    state.pausedAll = Boolean(body.paused); state.rev += 1;
    return json(res, 200, { ok: true, rev: state.rev, pausedAll: state.pausedAll });
  }
  if (op === "delete") {
    const before = state.rules.length;
    state.rules = state.rules.filter((rule) => rule.id !== String(body.id || ""));
    if (state.rules.length === before) return json(res, 404, { ok: false, error: "rule_not_found" });
    state.rev += 1;
    return json(res, 200, { ok: true, rev: state.rev, rules: state.rules });
  }
  if (op === "setState") {
    const index = state.rules.findIndex((rule) => rule.id === String(body.id || ""));
    if (index < 0) return json(res, 404, { ok: false, error: "rule_not_found" });
    const normalized = normalizeRule({ ...state.rules[index], state: body.state }, { by: FIXTURE_EMAIL });
    if (!normalized.ok) return json(res, 400, { ok: false, error: "rule_invalid", detail: normalized.error });
    state.rules[index] = { ...state.rules[index], state: normalized.rule.state, updatedAt: normalized.rule.updatedAt, updatedBy: FIXTURE_EMAIL };
    state.rev += 1;
    return json(res, 200, { ok: true, rev: state.rev, rules: state.rules });
  }
  if (op === "save") {
    const normalized = normalizeRule(body.rule, { by: FIXTURE_EMAIL });
    if (!normalized.ok) return json(res, 400, { ok: false, error: "rule_invalid", detail: normalized.error });
    const at = normalized.rule.updatedAt;
    const index = normalized.rule.id ? state.rules.findIndex((rule) => rule.id === normalized.rule.id) : -1;
    const previous = index >= 0 ? state.rules[index] : null;
    const saved = {
      ...normalized.rule, id: normalized.rule.id || `local-rule-${randomUUID()}`,
      version: (previous?.version || 0) + 1,
      versions: previous ? [...(previous.versions || []), { at: previous.updatedAt, by: previous.updatedBy, name: previous.name, action: previous.action, conditions: previous.conditions, scope: previous.scope, note: previous.note }].slice(-10) : [],
      createdAt: previous?.createdAt || at, createdBy: previous?.createdBy || FIXTURE_EMAIL,
    };
    if (index >= 0) state.rules[index] = saved; else state.rules.push(saved);
    state.rev += 1;
    return json(res, 200, { ok: true, rev: state.rev, rule: saved, rules: state.rules });
  }
  if (op === "hits") return json(res, 200, { ok: true, hits: (state.hits[String(body.id || "")] || []).slice(0, 10) });
  return json(res, 400, { ok: false, error: "unsupported_op" });
}

async function runTick(req, res, state, readMembership) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
  let body;
  try { body = await bodyJson(req); } catch { return json(res, 400, { ok: false, error: "invalid_json" }); }
  if (!generationMatches(body)) return json(res, 409, { ok: false, error: "generation_changed_refresh_required", generationId: generation.generationId, generationDigest: generation.digest });
  const stamp = new Date().toISOString();
  const ruleRunId = `local-run-${++state.runNumber}`;
  if (state.pausedAll) return json(res, 200, { ok: true, at: stamp, parked: "all_rules_paused", decided: 0, ruleRunId, generationId: generation.generationId, generationDigest: generation.digest });
  const live = state.rules.filter((rule) => rule.state === "live");
  const watching = state.rules.filter((rule) => rule.state === "watching");
  if (!live.length && !watching.length) return json(res, 200, { ok: true, at: stamp, parked: "no_active_rules", decided: 0, ruleRunId, generationId: generation.generationId, generationDigest: generation.digest });
  const fired = {};
  const wouldFire = {};
  const skipped = {};
  let decided = 0;
  const pending = pendingRows(state);
  const fundedEmployerSnapshots = await loadFundedEmployerSnapshots([...live, ...watching], { readJson: readMembership });
  for (const candidate of pending) {
    const subject = {
      row: candidate,
      facts: facts[candidate.profileKey],
      profileReceipt: profileReceipts[candidate.profileKey],
      fundedEmployerSnapshots,
    };
    for (const rule of watching) {
      if (!inScope(rule, candidate) || !evaluateRule(rule, subject).matched) continue;
      const hold = rule.action === "interview"
        ? ruleInterviewSkipReason(candidate, { decision: state.decisions[candidate.key], ack: state.acks[candidate.key] }) : null;
      if (hold) skipped[hold] = (skipped[hold] || 0) + 1;
      else wouldFire[rule.id] = (wouldFire[rule.id] || 0) + 1;
    }
    const matches = [];
    for (const rule of live) {
      if (!inScope(rule, candidate)) continue;
      const result = evaluateRule(rule, subject);
      if (result.matched) matches.push({ rule, evidence: result.evidence });
      else if (result.skipped) skipped[result.reason] = (skipped[result.reason] || 0) + 1;
    }
    if (!matches.length) continue;
    const winner = matches.find(({ rule }) => rule.action === "pass") || matches[0];
    const hold = winner.rule.action === "interview"
      ? ruleInterviewSkipReason(candidate, { decision: state.decisions[candidate.key], ack: state.acks[candidate.key] }) : null;
    if (hold) { skipped[hold] = (skipped[hold] || 0) + 1; continue; }
    const decision = {
      action: winner.rule.action, at: stamp, by: `rule:${winner.rule.id}`,
      actorType: "rule", actorId: winner.rule.id, authorizedBy: FIXTURE_EMAIL,
      name: candidate.name, roleTitle: candidate.roleTitle, requestId: randomUUID(),
      inputRevision: candidate.inputRevision, readinessRevision: candidate.readinessRevision,
      decisionRevision: candidate.decisionRevision, status: "pending",
      ...(winner.rule.action === "interview" ? { deliveryState: "requested" } : {}),
      generationId: generation.generationId, generationDigest: generation.digest, ruleRunId,
    };
    state.decisions[candidate.key] = decision;
    const hit = { key: candidate.key, at: stamp, ruleRunId, ruleId: winner.rule.id, ruleName: winner.rule.name, action: winner.rule.action, name: candidate.name, roleTitle: candidate.roleTitle, evidence: winner.evidence };
    state.hits[winner.rule.id] = [hit, ...(state.hits[winner.rule.id] || [])].slice(0, 10);
    fired[winner.rule.id] = (fired[winner.rule.id] || 0) + 1;
    decided += 1;
  }
  for (const rule of state.rules) {
    const prior = state.stats[rule.id] || {};
    state.stats[rule.id] = { ...prior, fired: (prior.fired || 0) + (fired[rule.id] || 0), wouldFire: wouldFire[rule.id] || 0, firedAt: fired[rule.id] ? stamp : prior.firedAt };
  }
  return json(res, 200, { ok: true, at: stamp, decided, pending: pending.length, considered: pending.length, skipped, fired, wouldFire, ruleRunId, generationId: generation.generationId, generationDigest: generation.digest });
}

async function decisionApi(req, res, state) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
  let body;
  try { body = await bodyJson(req); } catch { return json(res, 400, { ok: false, error: "invalid_json" }); }
  if (!generationMatches(body)) return json(res, 409, { ok: false, error: "generation_changed_refresh_required" });
  const candidate = rows.find((item) => item.key === body.key);
  if (!candidate) return json(res, 404, { ok: false, error: "applicant_not_found" });
  if (body.action === "undo") delete state.decisions[candidate.key];
  else if (["pass", "interview"].includes(body.action)) state.decisions[candidate.key] = { action: body.action, reason: body.reason || null, at: new Date().toISOString(), by: FIXTURE_EMAIL, requestId: body.requestId || randomUUID(), status: "pending", ...(body.action === "interview" ? { deliveryState: "requested" } : {}) };
  else return json(res, 400, { ok: false, error: "invalid_action" });
  return json(res, 200, { ok: true, key: candidate.key, decision: state.decisions[candidate.key] || null });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

async function staticFile(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { ok: false, error: "GET only" });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { ok: false, error: "invalid_path" }); }
  if (pathname === "/" || pathname === "/applicants" || pathname === "/applicants/") pathname = "/applicants.html";
  const target = normalize(join(ROOT, pathname.replace(/^\/+/, "")));
  const rel = relative(ROOT, target);
  if (isAbsolute(rel) || rel.startsWith("..") || rel.includes("..")) return json(res, 403, { ok: false, error: "outside_fixture_root" });
  try {
    if (!(await stat(target)).isFile()) throw new Error("not_file");
    let content = await readFile(target);
    // The marker is injected by this server and never touches applicants.html,
    // so a screenshot cannot be mistaken for production while the actual UI
    // source remains the file under review.
    if (target === join(ROOT, "applicants.html")) {
      const html = content.toString("utf8")
        .replaceAll("https://webview-lake.vercel.app/assets/raydar-black.png", "/resume-renderer-v2/assets/raydar-lockup.svg")
        .replace("<body>", '<body><div aria-label="Local design preview" style="position:fixed;z-index:1000;top:8px;left:50%;transform:translateX(-50%);padding:6px 12px;border:1px solid #c7791a;border-radius:999px;background:#fff4dc;color:#8b4d00;font:700 11px system-ui;letter-spacing:.03em;box-shadow:0 3px 14px rgba(40,30,10,.12);pointer-events:none">Local design preview · Sample data</div>');
      content = Buffer.from(html);
    }
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'",
      "x-raydar-fixture": "synthetic-local-only",
    });
    if (req.method === "HEAD") res.end(); else res.end(content);
  } catch {
    json(res, 404, { ok: false, error: "fixture_file_not_found", path: pathname });
  }
}

export function createFixtureServer({
  state = createFixtureState(),
  readMembership = readSyntheticMembership,
} = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/embedded-demo") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; object-src 'none'",
          "x-raydar-fixture": "synthetic-local-only",
        });
        return res.end('<!doctype html><meta charset="utf-8"><title>Rules embedded fixture</title><style>html,body{height:100%;margin:0;background:#ded8ca}body{display:grid;grid-template-rows:auto 1fr;font:13px system-ui;color:#16140f}.note{padding:8px 14px;background:#fff9e8;border-bottom:1px solid #cfc7b7}.note b{color:#b34700}iframe{width:100%;height:100%;border:0;background:#f6f3e9}</style><div class="note"><b>Local synthetic fixture</b> · Embedded layout check · Memory-only actions</div><iframe title="Embedded Applicants Rules" src="/applicants?embed=1#rules"></iframe>');
      }
      if (url.pathname === "/api/seq/config") return json(res, 200, { ok: true, authRequired: true, googleClientId: "local-fixture-client" });
      if (url.pathname === "/api/auth/session") return json(res, 200, { ok: true, authenticated: true, email: FIXTURE_EMAIL });
      if (url.pathname === "/api/auth/google") return json(res, 200, { ok: true, authenticated: true, email: FIXTURE_EMAIL });
      if (url.pathname === "/api/auth/logout") return json(res, 200, { ok: true });
      if (url.pathname === "/api/applicants/feed") return req.method === "GET" ? json(res, 200, feedPayload(state)) : json(res, 405, { ok: false, error: "GET only" });
      if (url.pathname === "/api/applicants/cards") {
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
        const ids = [...new Set((url.searchParams.get("cus") || "").split(",").map((id) => id.trim()).filter(Boolean))].slice(0, 60);
        if (url.searchParams.get("rich") !== "1") return json(res, 200, { ok: true, cards: Object.fromEntries(ids.filter((id) => cards[id]).map((id) => [id, cards[id]])) });
        if (url.searchParams.get("generationId") !== generation.generationId || url.searchParams.get("generationDigest") !== generation.digest) {
          return json(res, 409, { ok: false, error: "generation_changed" });
        }
        return json(res, 200, { ok: true, cards: Object.fromEntries(ids.filter((id) => cards[id]).map((id) => [id, { ...cards[id], ...(richCards[id] || {}) }])), generation: { generationId: generation.generationId, digest: generation.digest } });
      }
      if (url.pathname === "/api/applicants/profile") {
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
        const profile = profiles[url.searchParams.get("cu") || ""];
        return profile ? json(res, 200, { ok: true, ...profile }) : json(res, 404, { ok: false, error: "profile_cache_miss" });
      }
      if (url.pathname === "/api/applicants/rules") return rulesApi(req, res, url, state, readMembership);
      if (url.pathname === "/api/applicants/rules-tick") return runTick(req, res, state, readMembership);
      if (url.pathname === "/api/applicants/decision") return decisionApi(req, res, state);
      if (url.pathname === "/api/applicants/refresh") return json(res, 200, { ok: true, queued: false, localFixture: true });
      if (url.pathname.startsWith("/api/")) return json(res, 404, { ok: false, error: "local_fixture_only", detail: "No remote proxy or provider calls are available." });
      return staticFile(req, res, url);
    } catch (error) {
      return json(res, 500, { ok: false, error: "local_fixture_error", detail: String(error?.message || error).slice(0, 200) });
    }
  });
}

function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index >= 0) {
    const port = Number(argv[index + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
    return port;
  }
  return Number(process.env.RULES_PREVIEW_PORT || 4178);
}

if (process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))) {
  const port = parsePort(process.argv.slice(2));
  const server = createFixtureServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    console.log(`Applicants Rules local fixture: http://127.0.0.1:${actual}/applicants#rules`);
    console.log(`Embedded layout: http://127.0.0.1:${actual}/embedded-demo`);
    console.log("Synthetic data only. All saves, state changes, decisions, and rule runs are memory-only; restart to reset.");
    console.log("Remote proxying and provider calls are disabled.");
  });
}
