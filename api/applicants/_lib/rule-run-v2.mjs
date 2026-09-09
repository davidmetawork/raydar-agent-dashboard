import { createHash } from "node:crypto";

import { factsFromProfile } from "./facts.mjs";
import { normalizeApplicantRowsV2 } from "./profile-v2.mjs";

export const GRAPH_RULE_RUN_VERSION = "applicant-core-graph-rule-run-v2";
export const GRAPH_RULE_FACT_SET_VERSION = "applicant-profile-v2-fact-set-v1";
export const GRAPH_RULE_EVALUATOR_VERSION = "raydar-monitor-applicant-rules-v1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function ruleRunDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function applicantRowsV2ForArtifacts(artifacts) {
  const source = artifacts?.snapshot?.applicantRowsV2
    ?? artifacts?.snapshot?.applicantRowV2
    ?? artifacts?.snapshot?.rowsV2
    ?? {};
  return normalizeApplicantRowsV2(source);
}

function value(fact) {
  return fact && fact.state !== "unavailable" ? fact.value ?? null : null;
}

/** Convert only the values selected by Core's immutable Profile V2 projection
 * into the long-standing Rules evaluator shape. Preview and Run call this same
 * function, so neither can silently fall back to a different profile cache. */
export function ruleSubjectFromApplicantV2(row, projection, { now = Date.now() } = {}) {
  if (!projection || projection.key !== row?.key
    || !UUID.test(String(projection.application?.applicationId || ""))
    || !SHA256.test(String(projection.factSetDigest || ""))
    || !String(row?.inputRevision || "")
    || !Number.isSafeInteger(Number(row?.decisionRevision))
    || projection.factsCurrent !== true
    || projection.inputRevision !== String(row.inputRevision)
    || projection.decisionRevision !== Number(row.decisionRevision)) return null;

  const selected = projection.profile?.facts || {};
  const profile = {
    title: value(selected.title),
    location: value(selected.location),
    about: value(selected.about),
    linkedin: value(selected.linkedin),
    resumeUrl: projection.profile?.selectedResume?.state === "available" ? "selected-resume" : null,
    experiences: (selected.experiences?.entries || []).map((entry) => ({
      companyId: entry.companyId,
      companyName: entry.companyName,
      roleTitle: entry.roleTitle,
      start: entry.start,
      end: entry.end,
      current: entry.current,
      location: entry.location,
      industry: entry.industry,
    })),
    education: (selected.education?.entries || []).map((entry) => ({
      schoolId: entry.schoolId,
      school: entry.school,
      degree: entry.degree,
      start: entry.start,
      end: entry.end,
      schoolLocation: entry.schoolLocation,
      schoolWebsite: entry.schoolWebsite,
    })),
    updatedAt: projection.profile?.paraform?.observedAt
      || projection.profile?.resume?.observedAt || null,
  };
  const facts = factsFromProfile(profile, { now, preserveUnknownCurrent: true });
  const sourceFor = (entry) => entry?.source === "paraform_linkedin" ? "paraform"
    : ["resume", "selected_resume"].includes(entry?.source) ? "resume"
    : entry?.source === "application_source" ? "application_source" : "profile_v2";
  facts.schools = facts.schools.map((school, index) => ({
    ...school, source: sourceFor(selected.education?.entries?.[index]),
  }));
  facts.jobs = facts.jobs.map((job, index) => ({
    ...job, source: sourceFor(selected.experiences?.entries?.[index]),
  }));
  facts.allCompanies = facts.allCompanies.map((company) => ({
    ...company, source: sourceFor(selected.experiences),
  }));
  facts.provenance = {
    title: sourceFor(selected.title), location: sourceFor(selected.location),
    currentCompanyId: sourceFor(selected.experiences), currentCompanyName: sourceFor(selected.experiences),
    currentTitle: sourceFor(selected.experiences), months: sourceFor(selected.experiences),
    jobCount: sourceFor(selected.experiences), schoolCount: sourceFor(selected.education),
    hasResume: projection.profile?.selectedResume ? "resume" : "profile_v2",
    hasLinkedin: sourceFor(selected.linkedin),
  };

  const appliedTo = projection.application?.appliedTo || {};
  return Object.freeze({
    row: Object.freeze({
      ...row,
      roleId: appliedTo.roleId || null,
      roleTitle: appliedTo.title || null,
      company: appliedTo.hiringCompany?.state === "verified"
        ? appliedTo.hiringCompany.name : null,
    }),
    facts: Object.freeze(facts),
    profileFactsPending: false,
    profileReceipt: null,
    applicationId: projection.application.applicationId.toLowerCase(),
    factSetDigest: projection.factSetDigest,
  });
}

export function graphRuleRunBasis({ generationId, generationDigest, ruleVersions, items }) {
  if (!UUID.test(String(generationId || "")) || !SHA256.test(String(generationDigest || "").toLowerCase())
    || !Array.isArray(ruleVersions) || !ruleVersions.length || ruleVersions.length > 512
    || !Array.isArray(items) || !items.length || items.length > 10_000) {
    throw new Error("graph_rule_run_invalid");
  }
  const normalizedRules = ruleVersions.map((rule) => ({ id: String(rule?.id || "").trim(), version: Number(rule?.version) }));
  if (normalizedRules.some((rule) => !rule.id || !Number.isSafeInteger(rule.version) || rule.version < 1)
    || new Set(normalizedRules.map((rule) => rule.id)).size !== normalizedRules.length) {
    throw new Error("graph_rule_run_invalid");
  }
  const normalizedItems = items.map((item) => ({ ...item,
    applicationId: String(item?.applicationId || "").toLowerCase(),
    monitorKey: String(item?.monitorKey || "").trim(),
    inputRevision: String(item?.inputRevision || "").trim(),
    factSetDigest: String(item?.factSetDigest || "").toLowerCase(),
    decisionRevision: Number(item?.decisionRevision),
    outcome: String(item?.outcome || "").toLowerCase(),
    ruleId: item?.ruleId == null ? null : String(item.ruleId).trim(),
    ruleVersion: item?.ruleVersion == null ? null : Number(item.ruleVersion),
  }));
  if (normalizedItems.some((item) => !UUID.test(item.applicationId) || !item.monitorKey
    || !item.inputRevision || !SHA256.test(item.factSetDigest)
    || !Number.isSafeInteger(item.decisionRevision) || item.decisionRevision < 0
    || !["no_match", "interview", "pass"].includes(item.outcome)
    || (item.outcome === "no_match" ? item.ruleId !== null || item.ruleVersion !== null
      : !normalizedRules.some((rule) => rule.id === item.ruleId && rule.version === item.ruleVersion)))
    || new Set(normalizedItems.map((item) => item.applicationId)).size !== normalizedItems.length
    || new Set(normalizedItems.map((item) => item.monitorKey)).size !== normalizedItems.length) {
    throw new Error("graph_rule_run_invalid");
  }
  return Object.freeze({
    version: GRAPH_RULE_RUN_VERSION,
    trigger: "run_rules_now",
    generationId: String(generationId).toLowerCase(),
    generationDigest: String(generationDigest).toLowerCase(),
    evaluatorVersion: GRAPH_RULE_EVALUATOR_VERSION,
    factSetVersion: GRAPH_RULE_FACT_SET_VERSION,
    ruleVersions: Object.freeze(normalizedRules
      .map((rule) => Object.freeze(rule))
      .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version)),
    items: Object.freeze(normalizedItems.map((item) => Object.freeze(item))
      .sort((left, right) => left.applicationId.localeCompare(right.applicationId)
        || left.monitorKey.localeCompare(right.monitorKey))),
  });
}

export function graphRuleRunManifest({ runId, authorizerId, authenticatedAt, ...input }) {
  if (!UUID.test(String(runId || "")) || !String(authorizerId || "").trim()
    || !Number.isFinite(Date.parse(authenticatedAt || ""))) throw new Error("graph_rule_run_invalid");
  const basis = graphRuleRunBasis(input);
  const manifest = Object.freeze({
    runId: String(runId).toLowerCase(),
    authorizerId: String(authorizerId).trim().toLowerCase(),
    authenticatedAt: new Date(authenticatedAt).toISOString(),
    previewDigest: ruleRunDigest(basis),
    ...basis,
  });
  return Object.freeze({ manifest, manifestDigest: ruleRunDigest(manifest) });
}
