// Pure normalization and learning helpers for the Sourcing workspace.
//
// Paraform's internal response shapes have drifted before, so the API layer
// reduces them to this deliberately small contract before anything reaches the
// browser. Keep this module free of network calls so synthetic fixtures can
// exercise the important behavior without candidate data or a live session.

import {
  FEEDBACK_REASONS,
  proposeNextRun,
  summarizeFeedback,
} from "../../../sourcing-domain.mjs";

export { FEEDBACK_REASONS, proposeNextRun, summarizeFeedback };

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
