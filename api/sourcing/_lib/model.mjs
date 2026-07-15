// Pure normalization and learning helpers for the Sourcing workspace.
//
// Paraform's internal response shapes have drifted before, so the API layer
// reduces them to this deliberately small contract before anything reaches the
// browser. Keep this module free of network calls so synthetic fixtures can
// exercise the important behavior without candidate data or a live session.

const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];
const unique = (values) => [...new Set(values.map(text).filter(Boolean))];

function firstArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function names(value) {
  return unique(list(value).map((item) => {
    if (typeof item === "string") return item;
    return item?.name || item?.label || item?.title || item?.company_name || item?.location || "";
  }));
}

function companyName(role) {
  return text(role?.company?.name || role?.client?.name || role?.company_name || role?.client_name);
}

export function normalizeActiveRoles(raw) {
  const rows = firstArray(raw, ["roles", "items", "active_roles", "activeRoles", "data"]);
  return rows.map((row) => {
    const role = row?.role || row?.active_role || row;
    const id = text(role?.id || role?.role_id || row?.role_id);
    // Only recruiter approval gates the list. A role's own `status` may be
    // ACTIVE/PAUSED and must not be mistaken for recruiter approval.
    const status = text(row?.user_status || row?.recruiter_status || role?.user_status).toUpperCase();
    return {
      id,
      title: text(role?.title || role?.job_title || role?.name) || "Untitled role",
      company: companyName(role),
      location: names(role?.locations || role?.normalized_locations || row?.locations).join(", "),
      status: status || null,
      updatedAt: role?.updated_at || row?.updated_at || null,
    };
  })
    .filter((role) => role.id && (!role.status || role.status === "APPROVED"))
    .sort((a, b) => `${a.company} ${a.title}`.localeCompare(`${b.company} ${b.title}`));
}

function requirementRows(raw) {
  return firstArray(raw, ["requirements", "items", "role_requirements", "data"]);
}

function requirementText(row) {
  if (typeof row === "string") return text(row);
  return text(row?.requirement || row?.text || row?.description || row?.name || row?.label || row?.question);
}

function isRequired(row) {
  if (!row || typeof row === "string") return true;
  const importance = text(row.importance || row.priority || row.type).toLowerCase();
  return row.required === true || row.is_required === true || row.must_have === true ||
    importance.includes("must") || importance.includes("required");
}

function rangeLabel(value, unit = "years") {
  if (!value || typeof value !== "object") return "";
  const min = value.min ?? value.minimum ?? value.from;
  const max = value.max ?? value.maximum ?? value.to;
  if (min == null && max == null) return "";
  if (min != null && max != null) return `${min}-${max} ${unit}`;
  return min != null ? `${min}+ ${unit}` : `up to ${max} ${unit}`;
}

export function normalizeFilters(raw = {}) {
  const value = raw?.filters || raw?.candidate_filters || raw || {};
  const experience = value.experience_range || value.years_of_experience || {
    min: value.yoeMin ?? value.yoe_min,
    max: value.yoeMax ?? value.yoe_max,
  };
  return {
    locations: names(value.normalized_locations || value.locations),
    targetTitles: names(value.job_titles || value.titles || value.workExperienceGroups),
    excludedTitles: names(value.exclude_job_titles || value.excluded_titles || value.excludeWorkExperienceGroups),
    skills: names(value.skills),
    excludedSkills: names(value.exclude_skills || value.excludeSkills),
    idealCompanies: names(value.ideal_companies || value.companies),
    avoidCompanies: names(value.avoid_companies || value.exclude_companies),
    experience: rangeLabel(experience),
    topSchoolImportant: Boolean(value.top_school_is_important || value.topSchoolIsImportant),
  };
}

function roleSummary(detail = {}) {
  const role = detail?.role || detail?.data || detail;
  return {
    id: text(role?.id || role?.role_id),
    title: text(role?.title || role?.job_title || role?.name) || "Untitled role",
    company: companyName(role),
    location: names(role?.locations || role?.normalized_locations).join(", "),
    workplace: text(role?.workplace_type || role?.workplace || role?.remote_policy),
    employment: text(role?.employment_type || role?.role_type),
    summary: text(role?.short_description || role?.summary || role?.description).slice(0, 2500),
  };
}

export function buildRoleRubric({ detail = {}, requirements = {}, filters = {} } = {}) {
  const rows = requirementRows(requirements);
  const mustHaves = unique(rows.filter(isRequired).map(requirementText));
  const preferences = unique(rows.filter((row) => !isRequired(row)).map(requirementText));
  const normalizedFilters = normalizeFilters(filters);
  return {
    role: roleSummary(detail),
    mustHaves,
    preferences,
    searchSignals: {
      titles: normalizedFilters.targetTitles,
      skills: normalizedFilters.skills,
      companies: normalizedFilters.idealCompanies,
      locations: normalizedFilters.locations,
      experience: normalizedFilters.experience,
      topSchoolImportant: normalizedFilters.topSchoolImportant,
    },
    exclusions: {
      titles: normalizedFilters.excludedTitles,
      skills: normalizedFilters.excludedSkills,
      companies: normalizedFilters.avoidCompanies,
    },
  };
}

function ideaFilters(value = {}) {
  const filters = value?.filters || value?.search_filters || value;
  return normalizeFilters(filters);
}

export function normalizeSearchIdeas(raw) {
  const rows = firstArray(raw, ["ideas", "searchIdeas", "search_ideas", "data"]);
  return rows.slice(0, 8).map((idea, index) => ({
    id: text(idea?.id) || `idea-${index + 1}`,
    name: text(idea?.name || idea?.title || idea?.label) || `Search lane ${index + 1}`,
    rationale: text(idea?.rationale || idea?.reason || idea?.description).slice(0, 1200),
    filters: ideaFilters(idea),
  }));
}

export const FEEDBACK_REASONS = Object.freeze([
  { id: "wrong_title", label: "Wrong function or title" },
  { id: "too_junior", label: "Too junior" },
  { id: "too_senior", label: "Too senior" },
  { id: "wrong_industry", label: "Wrong industry" },
  { id: "weak_company", label: "Company background misses" },
  { id: "missing_skill", label: "Missing must-have skill" },
  { id: "location", label: "Location mismatch" },
  { id: "job_hopper", label: "Tenure pattern misses" },
  { id: "duplicate_or_known", label: "Duplicate or already known" },
  { id: "other", label: "Other" },
]);

const REASON_LABELS = new Map(FEEDBACK_REASONS.map((reason) => [reason.id, reason.label]));

export function summarizeFeedback(items = []) {
  const summary = { total: 0, good: 0, maybe: 0, bad: 0, unreviewed: 0, reasons: [] };
  const counts = new Map();
  for (const item of list(items)) {
    const verdict = ["good", "maybe", "bad"].includes(item?.verdict) ? item.verdict : "unreviewed";
    summary.total++;
    summary[verdict]++;
    if (verdict === "bad" && REASON_LABELS.has(item?.reason)) {
      counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
    }
  }
  summary.reasons = [...counts.entries()]
    .map(([id, count]) => ({ id, label: REASON_LABELS.get(id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return summary;
}

export function proposeNextRun(items = []) {
  const summary = summarizeFeedback(items);
  const proposals = [];
  for (const reason of summary.reasons) {
    if (reason.count < 2) continue;
    const action = {
      wrong_title: "Tighten target titles and add the rejected title family to exclusions.",
      too_junior: "Raise minimum years of experience or require a stronger seniority title.",
      too_senior: "Lower maximum years of experience or exclude leadership titles.",
      wrong_industry: "Add industry or ideal-company constraints; exclude the repeated off-target sector.",
      weak_company: "Strengthen the ideal-company lane or talent-density requirement.",
      missing_skill: "Promote the repeated missing capability to a required skill filter.",
      location: "Tighten included locations and explicitly exclude the repeated mismatch.",
      job_hopper: "Increase minimum time in current role or add a tenure requirement.",
      duplicate_or_known: "Expand the pre-search dedup set; do not change fit filters for duplicates.",
      other: "Review the notes and turn any repeated pattern into a named reason before rerunning.",
    }[reason.id];
    proposals.push({ reason: reason.id, evidence: reason.count, action });
  }
  return { summary, proposals, autoApply: false };
}
