import { FACTS_VERSION, factsFromProfile } from "./facts.mjs";
import { richProfileBinding } from "./rich-profile.mjs";

export const RICH_RULE_FACTS_VERSION = 1;
export const RICH_PROFILE_RECEIPT_VERSION = 1;
export const RICH_RULE_MAX_JOBS = 60;
export const RICH_RULE_MAX_SCHOOLS = 30;

const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const present = (value) => typeof value === "string" ? value.trim() || null : value ?? null;

// Older retained caches converted unknown status to false. A dated end is
// required before those records may offer a past-role condition.
export function richProfileForRules(profile) {
  if (!profile) return null;
  return { ...profile, experiences: (Array.isArray(profile.experiences) ? profile.experiences : []).map((job) => ({
    ...job, current: job?.current === true ? true : job?.current === false && validDate(job?.end) ? false : null,
  })) };
}

export function richRuleFactsFromProfile(profile, {
  now = Date.now(),
  receiptVersion = RICH_PROFILE_RECEIPT_VERSION,
} = {}) {
  const binding = richProfileBinding(profile);
  if (!binding || profile?.profileSource !== "paraform"
    || !validDate(profile.profileEnrichedAt) || !validDate(profile.richProfileRetainedUntil)) return null;
  const derived = factsFromProfile(richProfileForRules(profile), {
    now,
    maxJobs: RICH_RULE_MAX_JOBS,
    maxSchools: RICH_RULE_MAX_SCHOOLS,
    preserveUnknownCurrent: true,
  });
  return {
    projectionVersion: RICH_RULE_FACTS_VERSION,
    receiptVersion: Number(receiptVersion) || 0,
    ...binding,
    profileEnrichedAt: profile.profileEnrichedAt,
    richProfileRetainedUntil: profile.richProfileRetainedUntil,
    projectedAt: new Date(now).toISOString(),
    updatedAt: derived.updatedAt,
    title: derived.title,
    location: derived.location,
    densityScore: derived.densityScore,
    schools: derived.schools,
    jobs: derived.jobs,
    schoolCount: derived.schoolCount,
    jobCount: derived.jobCount,
    months: derived.months,
    currentCompanyId: derived.currentCompanyId,
    currentCompanyName: derived.currentCompanyName,
    currentTitle: derived.currentTitle,
    hasHistory: derived.hasHistory,
  };
}

export function richReceiptMatches(binding, receipt, { now = Date.now() } = {}) {
  const normalized = richProfileBinding(receipt);
  return Boolean(binding && normalized && receipt?.source === "paraform"
    && Object.keys(binding).every((field) => binding[field] === normalized[field])
    && validDate(receipt.profileEnrichedAt)
    && validDate(receipt.richProfileRetainedUntil)
    && Date.parse(receipt.richProfileRetainedUntil) > now);
}

export function richRuleFactsMatch({ binding, facts, receipt, now = Date.now() } = {}) {
  if (!richReceiptMatches(binding, receipt, { now }) || !facts
    || facts.projectionVersion !== RICH_RULE_FACTS_VERSION
    || facts.receiptVersion !== (Number(receipt.v) || 0)
    || facts.profileEnrichedAt !== receipt.profileEnrichedAt
    || facts.richProfileRetainedUntil !== receipt.richProfileRetainedUntil) return false;
  const normalized = richProfileBinding(facts);
  return Boolean(normalized && Object.keys(binding).every((field) => binding[field] === normalized[field]));
}

function sourcedRows(rows, source) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, source }));
}

function sourceOnlyFacts(sourceFacts) {
  if (!sourceFacts) return null;
  return {
    ...sourceFacts,
    schools: sourcedRows(sourceFacts.schools, "source"),
    jobs: sourcedRows(sourceFacts.jobs, "source"),
    allCompanies: sourcedRows(sourceFacts.allCompanies, "source"),
    historyIncomplete: {
      jobs: Number(sourceFacts.jobCount) > (sourceFacts.jobs?.length || 0),
      schools: Number(sourceFacts.schoolCount) > (sourceFacts.schools?.length || 0),
    },
    provenance: {
      title: "source", location: "source", densityScore: "source",
      currentCompanyId: "source", currentCompanyName: "source", currentTitle: "source",
      months: "source", jobCount: "source", schoolCount: "source",
      hasResume: "source", hasLinkedin: "source",
    },
  };
}

export function selectRuleFacts({ row, sourceFacts, richFacts, richReceipt, now = Date.now(), bindings } = {}) {
  let source = sourceOnlyFacts(sourceFacts);
  const binding = richProfileBinding(row?.richProfileBinding);
  const snapshotBinding = bindings === undefined ? binding : bindings.get(row?.profileKey || row?.cuId);
  const currentBinding = binding && snapshotBinding && binding.sourceObservationId === row?.sourceObservationId
    && Object.keys(binding).every((field) => binding[field] === snapshotBinding[field]) ? binding : null;
  const receiptEligible = richReceiptMatches(currentBinding, richReceipt, { now });
  if (!receiptEligible) return { facts: source, richEligible: false, projectionPending: false, reason: null };
  if (!richRuleFactsMatch({ binding: currentBinding, facts: richFacts, receipt: richReceipt, now })) {
    return { facts: source, richEligible: true, projectionPending: true, reason: "rich_profile_facts_pending" };
  }
  if (source?.v !== FACTS_VERSION) source = null;

  const richJobs = sourcedRows(richFacts.jobs, "paraform");
  const richSchools = sourcedRows(richFacts.schools, "paraform");
  const hasRichHistory = Boolean(richJobs.length || richSchools.length);
  const currentRich = richJobs.find((job) => job?.current === true) ?? null;
  const chosen = (provider, fallback) => present(provider) ?? fallback ?? null;
  const sourceName = source?.currentCompanyName ?? null;
  const currentCompanyName = currentRich ? present(currentRich.name) : sourceName;
  const currentCompanyId = currentRich ? present(currentRich.id) : source?.currentCompanyId ?? null;
  const currentTitle = currentRich ? present(currentRich.title) : source?.currentTitle ?? null;
  const facts = {
    ...(source || {}),
    v: FACTS_VERSION,
    updatedAt: chosen(richFacts.updatedAt, source?.updatedAt),
    title: chosen(richFacts.title, source?.title),
    location: chosen(richFacts.location, source?.location),
    densityScore: richFacts.densityScore ?? source?.densityScore ?? null,
    schools: [...richSchools, ...sourcedRows(source?.schools, "source")],
    jobs: [...richJobs, ...sourcedRows(source?.jobs, "source")],
    // Funded-company membership deliberately remains bound to the durable
    // source receipt and its complete source-only history.
    allCompanies: sourcedRows(source?.allCompanies, "source"),
    schoolCount: hasRichHistory ? richFacts.schoolCount : source?.schoolCount ?? richFacts.schoolCount,
    jobCount: hasRichHistory ? richFacts.jobCount : source?.jobCount ?? richFacts.jobCount,
    months: richFacts.months ?? source?.months ?? null,
    currentCompanyId,
    currentCompanyName,
    currentTitle,
    hasHistory: Boolean(richJobs.length || richSchools.length || source?.hasHistory),
    hasResume: source?.hasResume ?? null,
    hasLinkedin: source?.hasLinkedin ?? null,
    historyIncomplete: {
      jobs: Boolean(source?.historyIncomplete?.jobs) || Number(richFacts.jobCount) > richJobs.length,
      schools: Boolean(source?.historyIncomplete?.schools) || Number(richFacts.schoolCount) > richSchools.length,
    },
    provenance: {
      title: present(richFacts.title) != null ? "paraform" : "source",
      location: present(richFacts.location) != null ? "paraform" : "source",
      densityScore: richFacts.densityScore != null ? "paraform" : "source",
      currentCompanyId: currentRich ? "paraform" : "source",
      currentCompanyName: currentRich ? "paraform" : "source",
      currentTitle: currentRich ? "paraform" : "source",
      months: richFacts.months != null ? "paraform" : "source",
      jobCount: hasRichHistory || source?.jobCount == null ? "paraform" : "source",
      schoolCount: hasRichHistory || source?.schoolCount == null ? "paraform" : "source",
      hasResume: "source", hasLinkedin: "source",
    },
  };
  return { facts, richEligible: true, projectionPending: false, reason: null };
}

export function ruleNeedsProfileFacts(rule) {
  return (Array.isArray(rule?.conditions) ? rule.conditions : [])
    .some((condition) => {
      const field = String(condition?.field || "");
      return !field.startsWith("application.") && !field.startsWith("employment.")
        && !["applicant.hasResume", "applicant.hasLinkedin"].includes(field);
    });
}
