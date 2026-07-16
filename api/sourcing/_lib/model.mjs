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

export function stripHtml(value) {
  return text(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/li>|<\/h\d>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

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
  if (typeof row === "string") return stripHtml(row);
  return stripHtml(row?.requirement || row?.text || row?.description || row?.name || row?.label || row?.question);
}

function isRequired(row) {
  if (!row || typeof row === "string") return true;
  const importance = [row.importance, row.type, row.priority].map((value) => text(value).toLowerCase()).join(" ");
  return row.required === true || row.is_required === true || row.must_have === true ||
    text(row.type).toUpperCase() === "DEALBREAKER" || importance.includes("must") || importance.includes("required");
}

function isOptional(row) {
  if (!row || typeof row === "string") return false;
  return text(row.type || row.importance).toUpperCase() === "OPTIONAL";
}

function isExclusion(row) {
  if (!row || typeof row === "string") return false;
  if (text(row.group).toUpperCase() === "TRAITS_TO_AVOID") return true;
  const criterion = requirementText(row).toLowerCase();
  return /^(?:no\b|not\b|avoid\b|exclude\b|must not\b|cannot\b|can't\b|without\b)|trend[- ]chas|job[- ]hopp|frequent job/i.test(criterion);
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
    workplace: text(role?.workplace_type || role?.workplaceType || role?.workplace || role?.workPlaceText || role?.remote_policy),
    employment: text(role?.employment_type || role?.employmentType || role?.role_type),
    summary: text(role?.short_description || role?.summary || role?.description).slice(0, 2500),
  };
}

function shareSlug(value) {
  return text(value).toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fundingStage(role) {
  const haystack = [
    role?.company?.fundingStage,
    role?.company?.funding_stage,
    role?.companyTip,
    role?.highlight_description,
    role?.position_explanation,
    role?.company?.description,
    role?.description,
  ].map(stripHtml).join(" ");
  const match = haystack.match(/\b(pre[- ]seed|seed|series\s+[a-g]|growth(?:-stage)?|public|bootstrapped)\b/i);
  if (!match) return "";
  return match[1].replace(/\b\w/g, (char) => char.toUpperCase()).replace(/Pre Seed/i, "Pre-Seed");
}

function inmailTemplate(role) {
  const values = [
    role?.linkedin_inmail,
    role?.linkedinInmail,
    role?.inmail,
    role?.inmail_template,
    role?.inmailTemplate,
    role?.outreach_template,
    role?.outreachTemplate,
  ];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const subject = text(value.subject || value.title);
    const bodyHtml = text(value.body_html || value.bodyHtml || value.body || value.message);
    if (subject && bodyHtml) return { subject, bodyHtml };
  }
  return null;
}

function htmlListItems(value) {
  const raw = text(value);
  const items = [...raw.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => stripHtml(match[1]));
  return unique(items);
}

function responsibilityRows(role) {
  const direct = list(role?.responsibilities).map((item) => typeof item === "string" ? item : item?.description || item?.text || item?.name);
  return unique([...direct.map(stripHtml), ...htmlListItems(role?.description)]).slice(0, 8);
}

// Small, job-only context for sequence composition. It intentionally excludes
// recruiter notes unrelated to the role and gives structured fields precedence
// over prose when Paraform contains conflicting numbers.
export function buildSequenceContext(detail = {}) {
  const role = detail?.role || detail?.data || detail;
  const company = role?.company || {};
  const title = text(role?.title || role?.job_title || role?.name) || "Untitled role";
  const companyNameValue = companyName(role);
  const industries = names(company?.normalized_industries || company?.industries);
  const industry = industries.slice(0, 3).join(" ") || text(company?.industry).split(",").slice(0, 2).join(" ").trim();
  const workplace = text(role?.workPlaceText || role?.workplaceText || role?.workplaceType || role?.workplace_type);
  const techStack = names(role?.tech_stack || role?.techStack);
  const engineering = /engineer|developer|architect|machine learning|data scientist|technical lead|infrastructure|devops|security/i.test(title);
  const facts = unique([
    role?.position_explanation,
    role?.highlight_description,
    role?.description,
    role?.responsibilities,
    role?.selling_points,
    company?.description,
    role?.companyTip,
    ...list(role?.requirements).map((item) => item?.description || item?.text),
    ...list(role?.benefits),
  ].map(stripHtml)).join("\n\n").slice(0, 18_000);
  const id = text(role?.id || role?.role_id);
  return {
    roleId: id,
    title,
    company: companyNameValue,
    companyUrl: text(company?.websiteUrl || company?.website_url || company?.website),
    shareUrl: id && companyNameValue ? `https://www.paraform.com/share/${shareSlug(companyNameValue)}/${id}` : "",
    fundingAmount: text(company?.fundingAmount || company?.funding_amount),
    stage: fundingStage(role),
    industry,
    workplace,
    locations: names(role?.locations || role?.normalized_locations),
    salaryLowerBound: Number(role?.publicSalaryLowerBound ?? role?.salaryLowerBound ?? 0) || null,
    salaryUpperBound: Number(role?.publicSalaryUpperBound ?? role?.salaryUpperBound ?? 0) || null,
    engineering,
    techStack,
    responsibilities: responsibilityRows(role),
    roleSummary: stripHtml(role?.position_explanation || role?.highlight_description || role?.description).slice(0, 4000),
    companySummary: stripHtml(company?.description).slice(0, 3000),
    facts,
    inmail: inmailTemplate(role),
  };
}

export function buildRoleRubric({ detail = {}, requirements = {}, filters = {} } = {}) {
  const role = detail?.role || detail?.data || detail;
  const explicitRequirements = requirementRows(requirements);
  const nestedRequirements = role?.requirements || role?.roleRequirements || role?.role_requirements || {};
  const rows = (explicitRequirements.length ? explicitRequirements : requirementRows(nestedRequirements))
    .filter((row) => typeof row === "string" || (row?.active !== false && row?.hidden !== true))
    .sort((a, b) => Number(a?.priority ?? 999) - Number(b?.priority ?? 999));
  const mustHaves = unique(rows.filter((row) => isRequired(row) && !isExclusion(row)).map(requirementText));
  const preferences = unique(rows.filter((row) => isOptional(row) && !isExclusion(row)).map(requirementText));
  const dealbreakers = unique(rows.filter(isExclusion).map(requirementText));
  const explicitFilters = filters && Object.keys(filters).length ? filters : null;
  const normalizedFilters = normalizeFilters(explicitFilters || role?.candidateFilters || role?.candidate_filters || role?.filters || {});
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
      criteria: dealbreakers,
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
    query: text(idea?.query || idea?.search_text || idea?.searchText || idea?.prompt).slice(0, 5000) || null,
    filters: ideaFilters(idea),
  }));
}
