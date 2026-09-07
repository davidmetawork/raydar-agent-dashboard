// Additive Applicant Profile V2 read adapter.
//
// Core owns fact selection and the fact-set digest. The dashboard only accepts
// a bounded display subset from an already verified immutable generation. This
// module has no provider, Rules, decision, or delivery dependency.

const text = (value, max = 4_000) => {
  const result = typeof value === "string" ? value.trim().slice(0, max) : "";
  return result || null;
};
const id = (value) => text(value, 180);
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const list = (value) => Array.isArray(value) ? value : [];
const validState = (value) => ["verified", "fallback", "unavailable", "available"].includes(value)
  ? value : "unavailable";
const validFreshness = (value) => ["current", "stale", "unknown"].includes(value) ? value : "unknown";
const ENTITY_LOGO_PREFIX = "https://storage.googleapis.com/paraform-company-logo-urls/company-logos/";
function safeEntityLogo(value, entityId) {
  const candidate = text(value, 2_000);
  if (!entityId || !candidate || !candidate.startsWith(ENTITY_LOGO_PREFIX)) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && parsed.hostname === "storage.googleapis.com"
      && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash
      && parsed.pathname.startsWith("/paraform-company-logo-urls/company-logos/") ? candidate : null;
  } catch { return null; }
}

function fact(value) {
  const raw = object(value) ?? {};
  const state = validState(raw.state);
  // An unavailable fact is a display denial as well as a Rules denial. Never
  // carry a stale payload value across this adapter merely because a producer
  // sent an inconsistent envelope.
  const scalar = state !== "unavailable"
    && (typeof raw.value === "string" || typeof raw.value === "number" || typeof raw.value === "boolean")
    ? raw.value : null;
  return Object.freeze({
    value: scalar,
    source: ["paraform_linkedin", "resume"].includes(raw.source) ? raw.source : null,
    observedAt: text(raw.observedAt, 64),
    factVersion: text(raw.factVersion, 180),
    freshness: validFreshness(raw.freshness),
    state,
  });
}

function historyRow(value, kind) {
  const raw = object(value) ?? {};
  const shared = {
    recordId: id(raw.recordId),
    source: ["paraform_linkedin", "resume"].includes(raw.source) ? raw.source : null,
    observedAt: text(raw.observedAt, 64),
    factVersion: text(raw.factVersion, 180),
    freshness: validFreshness(raw.freshness),
    state: validState(raw.state),
  };
  const entityId = id(kind === "experience" ? raw.companyId : raw.schoolId);
  return Object.freeze(kind === "experience" ? {
    ...shared, companyId: entityId, companyName: text(raw.companyName, 500),
    roleTitle: text(raw.roleTitle, 500), start: text(raw.start, 64), end: text(raw.end, 64),
    current: raw.current === true, location: text(raw.location, 500), industry: text(raw.industry, 500),
    description: text(raw.description, 8_000), logo: safeEntityLogo(raw.logo, entityId),
  } : {
    ...shared, schoolId: entityId, school: text(raw.school, 500), degree: text(raw.degree, 500),
    start: text(raw.start, 64), end: text(raw.end, 64), schoolLocation: text(raw.schoolLocation, 500),
    schoolWebsite: text(raw.schoolWebsite, 1_500), description: text(raw.description, 8_000),
    logo: safeEntityLogo(raw.logo, entityId),
  });
}

function history(value, kind) {
  const raw = object(value) ?? {};
  const state = validState(raw.state);
  // Treat a history entry denied by the producer as absent. Its surrounding
  // history envelope may still report why it is unavailable, but no title,
  // company, school, description, or logo reaches the card/detail renderer.
  const entries = state === "unavailable" ? [] : list(raw.entries).slice(0, 50)
    .map((entry) => historyRow(entry, kind)).filter((entry) => entry.state !== "unavailable");
  return Object.freeze({
    entries: Object.freeze(entries),
    source: ["paraform_linkedin", "resume"].includes(raw.source) ? raw.source : null,
    observedAt: text(raw.observedAt, 64), factVersion: text(raw.factVersion, 180),
    freshness: validFreshness(raw.freshness), state,
  });
}

function appliedTo(value) {
  const raw = object(value) ?? {};
  const company = object(raw.hiringCompany) ?? {};
  return Object.freeze({
    roleVersionId: id(raw.roleVersionId), roleId: id(raw.roleId), title: text(raw.title, 500),
    hiringCompany: Object.freeze({
      name: text(company.name, 500),
      source: ["role_version", "role_agent_binding"].includes(company.source) ? company.source : null,
      observedAt: text(company.observedAt, 64), version: text(company.version, 180),
      state: ["verified", "unknown", "conflict"].includes(company.state) ? company.state : "unknown",
    }),
  });
}

function profile(value) {
  const raw = object(value) ?? {};
  const source = (candidate) => {
    const input = object(candidate) ?? {};
    return Object.freeze({
      source: ["paraform_linkedin", "resume"].includes(input.source) ? input.source : null,
      observedAt: text(input.observedAt, 64), factVersion: text(input.factVersion, 180),
      freshness: validFreshness(input.freshness), state: validState(input.state),
      validity: text(input.validity, 120) || "missing",
    });
  };
  const selected = object(raw.selectedResume);
  return Object.freeze({
    facts: Object.freeze({
      name: fact(raw.facts?.name), title: fact(raw.facts?.title), location: fact(raw.facts?.location),
      about: fact(raw.facts?.about), linkedin: fact(raw.facts?.linkedin),
      experiences: history(raw.facts?.experiences, "experience"), education: history(raw.facts?.education, "education"),
    }),
    paraform: source(raw.paraform), resume: source(raw.resume),
    selectedResume: selected ? Object.freeze({ artifactId: id(selected.artifactId), digest: text(selected.digest, 180),
      parserVersion: text(selected.parserVersion, 180), observedAt: text(selected.observedAt, 64),
      factVersion: text(selected.factVersion, 180), state: validState(selected.state) }) : null,
  });
}

function invitation(value) {
  const raw = object(value);
  if (!raw) return null;
  const state = ["waiting", "queued", "held", "reconcile_required", "externally_committed", "cancelled"].includes(raw.state)
    ? raw.state : null;
  if (!state) return null;
  return Object.freeze({
    state, reasonCode: text(raw.reasonCode, 180), reason: text(raw.reason, 500),
    requestedAt: text(raw.requestedAt, 64),
    ageSeconds: Number.isSafeInteger(Number(raw.ageSeconds)) && Number(raw.ageSeconds) >= 0
      ? Math.min(Number(raw.ageSeconds), 31_536_000) : null,
    nextAttemptAt: text(raw.nextAttemptAt, 64), providerAcceptedAt: text(raw.providerAcceptedAt, 64),
  });
}

function actionability(value) {
  const raw = object(value) ?? {};
  const eligibility = ["waiting", "ready", "hard_hold", "stopped", "unknown"].includes(raw.eligibility)
    ? raw.eligibility : "unknown";
  return Object.freeze({
    eligibility, reasons: Object.freeze(list(raw.reasons).map((item) => text(item, 160)).filter(Boolean).slice(0, 8)),
    readinessRevision: text(raw.readinessRevision, 180), canCreateApproval: raw.canCreateApproval === true,
    approvalState: ["required", "not_required", "forbidden", "unavailable"].includes(raw.approvalState)
      ? raw.approvalState : "unavailable",
  });
}

export function normalizeApplicantRowV2(value, { key = null } = {}) {
  const raw = object(value);
  const application = object(raw?.application);
  if (!raw || !application || !id(application.applicationId) || !id(application.tenantScopeId)
    || !id(application.personId) || !id(application.sourceObservationId)) return null;
  const resolvedKey = id(key ?? raw.key);
  if (!resolvedKey) return null;
  return Object.freeze({
    key: resolvedKey,
    application: Object.freeze({
      applicationId: id(application.applicationId), tenantScopeId: id(application.tenantScopeId),
      personId: id(application.personId), sourceObservationId: id(application.sourceObservationId),
      rowRevision: text(application.rowRevision, 180), appliedTo: appliedTo(application.appliedTo),
    }),
    profile: profile(raw.profile), actionability: actionability(raw.actionability), invitation: invitation(raw.invitation),
    problems: Object.freeze(list(raw.problems).map((problem) => normalizeApplicantProblem(problem, { applicationId: application.applicationId })).filter(Boolean)),
    factSetDigest: /^[a-f0-9]{64}$/i.test(String(raw.factSetDigest || "")) ? String(raw.factSetDigest).toLowerCase() : null,
    // Core sets these only when this fact digest belongs to the exact current
    // evaluation revision. Rules consumes them as a fence; display ignores
    // them.
    inputRevision: text(raw.inputRevision, 180),
    decisionRevision: Number.isSafeInteger(Number(raw.decisionRevision)) ? Number(raw.decisionRevision) : null,
    factsCurrent: raw.factsCurrent === true,
  });
}

export function normalizeApplicantRowsV2(value) {
  const rows = object(value);
  if (rows) return Object.freeze(Object.fromEntries(Object.entries(rows)
    .map(([key, row]) => [key, normalizeApplicantRowV2(row, { key })]).filter(([, row]) => row)));
  if (Array.isArray(value)) return Object.freeze(Object.fromEntries(value
    .map((row) => [row?.key, normalizeApplicantRowV2(row)]).filter(([key, row]) => key && row)));
  return Object.freeze({});
}

export function normalizeApplicantProblem(value, { applicationId = null, key = null } = {}) {
  const raw = object(value);
  const code = text(raw?.code, 180);
  if (!code) return null;
  return Object.freeze({
    code, state: ["open", "resolved"].includes(raw.state) ? raw.state : "open",
    applicationId: id(raw.applicationId ?? applicationId), key: id(raw.key ?? key),
    domain: text(raw.domain, 120) || "application", reason: text(raw.reason, 500),
    nextAction: text(raw.nextAction, 500), sharedIncidentId: id(raw.sharedIncidentId),
    affectedCount: Number.isSafeInteger(Number(raw.affectedCount)) && Number(raw.affectedCount) > 0
      ? Math.min(Number(raw.affectedCount), 1_000_000) : null,
    observedAt: text(raw.observedAt ?? raw.createdAt, 64), nextAt: text(raw.nextAt ?? raw.retryAt, 64),
    ageSeconds: Number.isSafeInteger(Number(raw.ageSeconds)) && Number(raw.ageSeconds) >= 0
      ? Math.min(Number(raw.ageSeconds), 31_536_000) : null, owner: text(raw.owner, 120),
  });
}

export function applicantProblemsV2(rows, explicit = null) {
  const combined = [
    ...list(explicit).map((problem) => normalizeApplicantProblem(problem)),
    ...Object.values(rows || {}).flatMap((row) => row?.problems || []).map((problem) => normalizeApplicantProblem(problem)),
  ].filter(Boolean);
  const seen = new Set();
  return Object.freeze(combined.filter((problem) => {
    const identity = [problem.applicationId || "", problem.key || "", problem.code, problem.state].join("|");
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }));
}

export function applicantRowsV2FromSnapshot(snapshot) {
  const raw = object(snapshot) ?? {};
  return normalizeApplicantRowsV2(raw.applicantRowsV2 ?? raw.applicantRowV2 ?? raw.rowsV2);
}
