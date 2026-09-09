import { createHash } from "node:crypto";

/**
 * Pure, additive projection contract for Applicant Profile V2.
 *
 * This module deliberately has no repository, provider, readiness, or delivery
 * imports.  A caller supplies already-authorized, application-scoped evidence;
 * this module only selects what a read model may display and records why.
 */
export const APPLICANT_PROFILE_V2_CONTRACT_VERSION = "applicant-profile-v2";
export const APPLICANT_PROFILE_V2_FACT_SET_VERSION = "applicant-profile-v2-fact-set-v1";

const PROFILE_SOURCE = "paraform_linkedin";
const RESUME_SOURCE = "resume";
const EMPTY = Object.freeze([]);
const ENTITY_LOGO_PREFIX = "https://storage.googleapis.com/paraform-company-logo-urls/company-logos/";
const text = (value, limit = 4_000) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
const id = (value) => text(value, 180);
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const list = (value) => Array.isArray(value) ? value : EMPTY;
const iso = (value) => {
  const candidate = text(value);
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

function canonical(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    const child = value[key];
    return child === undefined ? EMPTY : [[key, canonical(child)]];
  }));
}

export function applicantProfileFactSetDigest(factSet) {
  return createHash("sha256").update(JSON.stringify(canonical(factSet))).digest("hex");
}

function scope(value) {
  const candidate = object(value);
  const tenantScopeId = id(candidate?.tenantScopeId);
  const personId = id(candidate?.personId);
  return tenantScopeId && personId ? { tenantScopeId, personId } : null;
}

/** Exact tenant/person scope comparison. Paraform data uses the separately
 * verified provider tenant; resume data stays in the application's tenant. */
export function hasExactApplicantProfileScope(candidate, application, { resume = false } = {}) {
  const left = scope(candidate?.scope);
  const right = scope({
    tenantScopeId: resume ? application?.tenantScopeId
      : application?.providerTenantScopeId ?? application?.tenantScopeId,
    personId: application?.personId,
  });
  return Boolean(left && right
    && left.tenantScopeId === right.tenantScopeId && left.personId === right.personId);
}

function factMetadata(candidate, source, state) {
  return {
    source,
    observedAt: iso(candidate?.observedAt),
    factVersion: text(candidate?.factVersion),
    freshness: ["current", "stale", "unknown"].includes(candidate?.freshness)
      ? candidate.freshness : "unknown",
    state,
  };
}

function candidateValidity(candidate, application, { resume = false } = {}) {
  const source = object(candidate);
  if (!source || Object.keys(source).length === 0) return "missing";
  if (!hasExactApplicantProfileScope(source, application, { resume })) return "scope_mismatch";
  if (text(source.sourceObservationId) !== application.sourceObservationId) return "source_mismatch";
  if (!text(source.factVersion)) return "version_missing";
  if (resume) {
    if (id(source.applicationId) !== application.applicationId) return "application_mismatch";
    if (!id(source.artifact?.id) || !text(source.artifact?.digest) || !text(source.parserVersion)) {
      return "resume_unusable";
    }
  } else if (source.state !== "verified") {
    return source.state === "conflict" ? "conflict" : "unavailable";
  }
  return "usable";
}

function sourceSummary(candidate, validity, source) {
  const meta = factMetadata(candidate, source, validity === "usable" ? "available" : "unavailable");
  return { ...meta, validity };
}

function nullFact() {
  return Object.freeze({
    value: null,
    source: null,
    observedAt: null,
    factVersion: null,
    freshness: "unknown",
    state: "unavailable",
  });
}

function selectedFact(value, candidate, source, state) {
  return Object.freeze({ value, ...factMetadata(candidate, source, state) });
}

// Logos are a provider record attribute, never a name lookup. Requiring the
// exact provider entity id prevents one record's image being borrowed for a
// similarly named company or school.
function safeEntityLogo(value, entityId) {
  const candidate = text(value, 2_000);
  if (!entityId || !candidate || !candidate.startsWith(ENTITY_LOGO_PREFIX)) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && parsed.hostname === "storage.googleapis.com"
      && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash
      && parsed.pathname.startsWith("/paraform-company-logo-urls/company-logos/") ? candidate : null;
  } catch {
    return null;
  }
}

function scalar(value) {
  if (typeof value === "string") return text(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

function selectScalar(key, provider, providerValidity, resume, resumeValidity) {
  if (providerValidity === "usable" && own(provider.facts, key)) {
    const value = scalar(provider.facts[key]);
    if (value !== null) return selectedFact(value, provider, PROFILE_SOURCE, "verified");
  }
  if (resumeValidity === "usable" && own(resume.facts, key)) {
    const value = scalar(resume.facts[key]);
    if (value !== null) return selectedFact(value, resume, RESUME_SOURCE, "fallback");
  }
  return nullFact();
}

function experience(entry, candidate, source, state) {
  const row = object(entry) ?? {};
  const companyId = id(row.companyId);
  // These fields always come from this one record.  Never fill a blank field
  // from a similarly-positioned record in another source.
  return Object.freeze({
    recordId: id(row.recordId),
    companyId,
    companyName: text(row.companyName, 500),
    roleTitle: text(row.roleTitle, 500),
    start: text(row.start, 64),
    end: text(row.end, 64),
    current: row.current === true,
    location: text(row.location, 500),
    description: text(row.description, 8_000),
    industry: text(row.industry, 500),
    logo: safeEntityLogo(row.logo, companyId),
    source,
    observedAt: iso(candidate?.observedAt),
    factVersion: text(candidate?.factVersion),
    freshness: ["current", "stale", "unknown"].includes(candidate?.freshness)
      ? candidate.freshness : "unknown",
    state,
  });
}

function education(entry, candidate, source, state) {
  const row = object(entry) ?? {};
  const schoolId = id(row.schoolId);
  return Object.freeze({
    recordId: id(row.recordId),
    schoolId,
    school: text(row.school, 500),
    degree: text(row.degree, 500),
    start: text(row.start, 64),
    end: text(row.end, 64),
    schoolLocation: text(row.schoolLocation, 500),
    schoolWebsite: text(row.schoolWebsite, 1_500),
    description: text(row.description, 8_000),
    logo: safeEntityLogo(row.logo, schoolId),
    source,
    observedAt: iso(candidate?.observedAt),
    factVersion: text(candidate?.factVersion),
    freshness: ["current", "stale", "unknown"].includes(candidate?.freshness)
      ? candidate.freshness : "unknown",
    state,
  });
}

function selectHistory(key, map, provider, providerValidity, resume, resumeValidity) {
  if (providerValidity === "usable" && Array.isArray(provider.facts?.[key])) {
    return Object.freeze({
      entries: provider.facts[key].map((entry) => map(entry, provider, PROFILE_SOURCE, "verified")),
      ...factMetadata(provider, PROFILE_SOURCE, "verified"),
    });
  }
  if (resumeValidity === "usable" && Array.isArray(resume.facts?.[key])) {
    return Object.freeze({
      entries: resume.facts[key].map((entry) => map(entry, resume, RESUME_SOURCE, "fallback")),
      ...factMetadata(resume, RESUME_SOURCE, "fallback"),
    });
  }
  return Object.freeze({
    entries: [], source: null, observedAt: null, factVersion: null,
    freshness: "unknown", state: "unavailable",
  });
}

function appliedTo(application) {
  const input = object(application?.appliedTo) ?? {};
  const roleVersionId = id(input.roleVersionId);
  const roleId = id(input.roleId);
  const roleVersion = object(input.hiringCompany?.roleVersion);
  const roleBinding = object(input.hiringCompany?.roleBinding);
  const sourceJobPeer = object(input.hiringCompany?.sourceJobPeer);
  const company = (candidate, source) => ({
    name: text(candidate?.name), source,
    observedAt: iso(candidate?.observedAt), version: text(candidate?.version),
  });
  const primary = company(roleVersion, "role_version");
  const fallback = company(roleBinding, "role_agent_binding");
  const peerContext = sourceJobPeer
    && id(sourceJobPeer.provider) && id(sourceJobPeer.accountScope)
    && id(sourceJobPeer.sourceJobId) && id(sourceJobPeer.roleId)
    && Number.isSafeInteger(Number(sourceJobPeer.peerApplicationCount))
    && Number(sourceJobPeer.peerApplicationCount) > 0
    ? Object.freeze({
        source: "source_job_peer",
        provider: id(sourceJobPeer.provider),
        accountScope: id(sourceJobPeer.accountScope),
        sourceJobId: id(sourceJobPeer.sourceJobId),
        representativePostingId: id(sourceJobPeer.representativePostingId),
        representativeRoleVersionId: id(sourceJobPeer.representativeRoleVersionId),
        roleId: id(sourceJobPeer.roleId),
        peerApplicationCount: Number(sourceJobPeer.peerApplicationCount),
        peerPostingCount: Number(sourceJobPeer.peerPostingCount) || 0,
        peerRoleVersionCount: Number(sourceJobPeer.peerRoleVersionCount) || 0,
      }) : null;
  const peer = company(peerContext ? sourceJobPeer : null,
    sourceJobPeer?.source === "role_agent_binding"
      ? "source_job_peer_role_agent_binding" : "source_job_peer_role_version");
  const names = new Set([primary.name, fallback.name, peer.name]
    .filter(Boolean).map((name) => name.toLowerCase()));
  let hiringCompany;
  let problem = null;
  // Without either exact applied-role identifier, no company input is safe to
  // display as the hiring company, even when a caller happened to provide one.
  if (!roleVersionId && !roleId && !peerContext) {
    hiringCompany = { name: null, source: null, observedAt: null, version: null, state: "unknown" };
    problem = "applied_hiring_company_unknown";
  } else if (names.size > 1) {
    hiringCompany = { name: null, source: null, observedAt: null, version: null, state: "conflict" };
    problem = "applied_hiring_company_conflict";
  } else if (primary.name) {
    hiringCompany = { ...primary, state: "verified" };
  } else if (fallback.name) {
    hiringCompany = { ...fallback, state: "verified" };
  } else if (peer.name) {
    hiringCompany = { ...peer, state: "verified" };
  } else {
    hiringCompany = { name: null, source: null, observedAt: null, version: null, state: "unknown" };
    problem = "applied_hiring_company_unknown";
  }
  return {
    value: Object.freeze({
      roleVersionId,
      roleId,
      title: text(input.title),
      hiringCompany: Object.freeze(hiringCompany),
      roleContext: peerContext,
    }),
    problem,
  };
}

function actionability(value) {
  const raw = object(value) ?? {};
  const eligibility = ["waiting", "ready", "hard_hold", "stopped"].includes(raw.eligibility)
    ? raw.eligibility : "unknown";
  return Object.freeze({
    eligibility,
    // Do not pass `text` directly to map: the array index would become its
    // length limit, dropping the first reason and truncating every later one.
    reasons: list(raw.reasons).map((reason) => text(reason)).filter(Boolean),
    readinessRevision: text(raw.readinessRevision),
    // This is an intent/approval summary only. It is never send authority.
    canCreateApproval: eligibility === "waiting",
    approvalState: eligibility === "waiting" ? "required"
      : eligibility === "ready" ? "not_required"
        : ["hard_hold", "stopped"].includes(eligibility) ? "forbidden" : "unavailable",
  });
}

function applicationIdentity(input) {
  const candidate = object(input) ?? {};
  return {
    applicationId: id(candidate.applicationId),
    tenantScopeId: id(candidate.tenantScopeId),
    providerTenantScopeId: id(candidate.providerTenantScopeId),
    personId: id(candidate.personId),
    sourceObservationId: id(candidate.sourceObservationId),
    rowRevision: text(candidate.rowRevision),
  };
}

/**
 * Builds a stable read-model payload. Missing application identity is a caller
 * error because it would make a display selection cross-tenant ambiguous.
 */
export function projectApplicantProfileV2({ application, paraformProfile = null, resume = null, actionability: rawActionability = null } = {}) {
  const app = applicationIdentity(application);
  if (!app.applicationId || !app.tenantScopeId || !app.personId || !app.sourceObservationId) {
    throw new Error("APPLICANT_PROFILE_V2_APPLICATION_SCOPE_REQUIRED");
  }
  const provider = object(paraformProfile) ?? {};
  const selectedResume = object(resume) ?? {};
  const providerValidity = candidateValidity(provider, app);
  const resumeValidity = candidateValidity(selectedResume, app, { resume: true });
  const exactAppliedTo = appliedTo(application);
  const problems = exactAppliedTo.problem ? [Object.freeze({
    code: exactAppliedTo.problem,
    state: "open",
    applicationId: app.applicationId,
    domain: "application",
  })] : EMPTY;
  const facts = Object.freeze({
    name: selectScalar("name", provider, providerValidity, selectedResume, resumeValidity),
    title: selectScalar("title", provider, providerValidity, selectedResume, resumeValidity),
    location: selectScalar("location", provider, providerValidity, selectedResume, resumeValidity),
    about: selectScalar("about", provider, providerValidity, selectedResume, resumeValidity),
    linkedin: selectScalar("linkedin", provider, providerValidity, selectedResume, resumeValidity),
    experiences: selectHistory("experiences", experience, provider, providerValidity, selectedResume, resumeValidity),
    education: selectHistory("education", education, provider, providerValidity, selectedResume, resumeValidity),
  });
  const profile = Object.freeze({
    facts,
    photo: providerValidity === "usable" ? text(provider.facts?.photo)
      : resumeValidity === "usable" ? text(selectedResume.facts?.photo) : null,
    paraform: Object.freeze(sourceSummary(provider, providerValidity, PROFILE_SOURCE)),
    resume: Object.freeze(sourceSummary(selectedResume, resumeValidity, RESUME_SOURCE)),
    selectedResume: resumeValidity === "usable" ? Object.freeze({
      artifactId: id(selectedResume.artifact.id),
      digest: text(selectedResume.artifact.digest),
      parserVersion: text(selectedResume.parserVersion),
      observedAt: iso(selectedResume.observedAt),
      factVersion: text(selectedResume.factVersion),
      state: "available",
    }) : null,
  });
  const action = actionability(rawActionability);
  const factSet = {
    version: APPLICANT_PROFILE_V2_FACT_SET_VERSION,
    application: app,
    appliedTo: exactAppliedTo.value,
    facts,
    sources: { paraform: profile.paraform, resume: profile.resume },
  };
  return Object.freeze({
    contractVersion: APPLICANT_PROFILE_V2_CONTRACT_VERSION,
    application: Object.freeze({ ...app, appliedTo: exactAppliedTo.value }),
    profile,
    actionability: action,
    problems: Object.freeze(problems),
    factSetDigest: applicantProfileFactSetDigest(factSet),
  });
}
