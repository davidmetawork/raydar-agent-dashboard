// Validates a Rule draft seeded from one displayed Applicant Profile V2 fact.
//
// The browser supplies only an opaque identity for its selection. This module
// re-reads the active immutable generation and rebuilds that selection from
// Core's fact projection. It never reads a profile cache, so preview and the
// later manual Rule run use the same V2 source family.

import { applicantRowsV2ForArtifacts, ruleSubjectFromApplicantV2 } from "./rule-run-v2.mjs";

export const PROFILE_V2_RULE_SEED_VERSION = "applicant-profile-v2-rule-seed-v1";

const SHA256 = /^[a-f0-9]{64}$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const clean = (value, max = 180) => typeof value === "string" ? value.trim().slice(0, max) : "";
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function validName(value, placeholders = []) {
  const name = clean(value, 160);
  const normalized = name.normalize("NFC").replace(/\s+/gu, " ").toLowerCase();
  return name && String(value).length < 160 && /[\p{L}\p{N}]/u.test(name)
    && !placeholders.includes(normalized) && !/(?:\.{3}|…)/u.test(name) ? name : null;
}

function candidates(kind, record) {
  const value = clean(record?.value, 120);
  if (kind === "headline") return value ? [{ id: "applicant-headline", condition: { field: "applicant.headline", op: "contains", value } }] : [];
  if (kind === "location") return value ? [{ id: "applicant-location", condition: { field: "applicant.location", op: "contains", value } }] : [];
  if (kind === "application") {
    const roleId = clean(record?.roleId, 80);
    return roleId ? [{ id: "application-role", condition: { field: "application.roleId", op: "any_of", value: [roleId] } }] : [];
  }
  if (kind === "experience") {
    const companyId = clean(record?.companyId, 80);
    const company = validName(record?.companyName, ["n/a", "na", "none", "null", "undefined", "unknown", "unknown company", "not provided", "not available"]);
    const title = clean(record?.roleTitle, 120);
    return [
      ...(companyId ? [{ id: "experience-company", condition: { field: "job.companyId", op: "any_of", value: [companyId] } }]
        : company ? [{ id: "experience-company-name", condition: { field: "job.companyName", op: "equals", value: company } }] : []),
      ...(title ? [{ id: "experience-title", condition: { field: "job.title", op: "contains", value: title } }] : []),
      ...(typeof record?.current === "boolean" ? [{ id: "experience-current", condition: { field: "job.current", op: "is", value: record.current } }] : []),
    ];
  }
  if (kind === "education") {
    const schoolId = clean(record?.schoolId, 80);
    const school = validName(record?.school, []);
    const degree = clean(record?.degree, 120);
    return [
      ...(schoolId ? [{ id: "education-school", condition: { field: "school.id", op: "any_of", value: [schoolId] } }]
        : school ? [{ id: "education-school-name", condition: { field: "school.name", op: "equals", value: school } }] : []),
      ...(degree ? [{ id: "education-degree", condition: { field: "school.degreeText", op: "contains", value: degree } }] : []),
    ];
  }
  return [];
}

function sourceFor(projection, selection) {
  const kind = clean(selection?.kind, 32);
  const index = Number(selection?.index);
  const facts = projection?.profile?.facts || {};
  if (kind === "headline" && facts.title?.state !== "unavailable") return { kind, index: 0, record: { value: facts.title?.value } };
  if (kind === "location" && facts.location?.state !== "unavailable") return { kind, index: 0, record: { value: facts.location?.value } };
  if (kind === "application") return { kind, index: 0, record: { roleId: projection?.application?.appliedTo?.roleId } };
  if (!Number.isSafeInteger(index) || index < 0 || index >= 50 || !["experience", "education"].includes(kind)) return null;
  const entries = kind === "experience" ? facts.experiences?.entries : facts.education?.entries;
  const record = Array.isArray(entries) ? entries[index] : null;
  if (!record || typeof record !== "object" || record.state === "unavailable") return null;
  const recordId = clean(selection?.recordId, 180);
  // Index scopes this selection to a single immutable record. If Core gave a
  // record id, require it too so a reordered projection cannot change meaning.
  if (recordId && recordId !== clean(record.recordId, 180)) return null;
  return { kind, index, record };
}

export function validateProfileV2RuleSeed(seed, rule, artifacts, { now = Date.now() } = {}) {
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) return { ok: true, present: false };
  if (seed.version !== PROFILE_V2_RULE_SEED_VERSION || !SHA256.test(String(seed.factSetDigest || ""))
    || !UUID.test(String(seed.applicationId || "")) || !clean(seed.key, 240)
    || !clean(seed.inputRevision) || !Number.isSafeInteger(Number(seed.decisionRevision))) {
    return { ok: false, error: "profile_v2_fact_set_changed_refresh_required" };
  }
  const row = (artifacts?.queue?.rows || []).find((candidate) => candidate?.key === seed.key);
  const projection = applicantRowsV2ForArtifacts(artifacts)[seed.key];
  const subject = ruleSubjectFromApplicantV2(row, projection, { now });
  if (!subject
    || subject.applicationId !== String(seed.applicationId).toLowerCase()
    || projection.application.sourceObservationId !== clean(seed.sourceObservationId)
    || projection.application.rowRevision !== clean(seed.rowRevision)
    || projection.inputRevision !== clean(seed.inputRevision)
    || projection.decisionRevision !== Number(seed.decisionRevision)
    || projection.factSetDigest !== String(seed.factSetDigest).toLowerCase()) {
    return { ok: false, error: "profile_v2_fact_set_changed_refresh_required" };
  }
  const source = sourceFor(projection, seed.selection);
  const selectedIds = Array.isArray(seed.selection?.selectedFactIds) ? seed.selection.selectedFactIds : [];
  if (!source || !selectedIds.length || selectedIds.length > 3 || new Set(selectedIds).size !== selectedIds.length
    || selectedIds.some((id) => typeof id !== "string" || id.length > 80)) {
    return { ok: false, error: "profile_v2_fact_set_changed_refresh_required" };
  }
  const selected = candidates(source.kind, source.record).filter((candidate) => selectedIds.includes(candidate.id));
  if (selected.length !== selectedIds.length) return { ok: false, error: "profile_v2_fact_set_changed_refresh_required" };
  const ruleConditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  if (selected.some((candidate) => !ruleConditions.some((condition) => same(condition, candidate.condition)))) {
    return { ok: false, error: "profile_v2_fact_set_changed_refresh_required" };
  }
  return { ok: true, present: true, applicationId: subject.applicationId, factSetDigest: subject.factSetDigest };
}
