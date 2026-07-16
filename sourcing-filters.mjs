// Browser/server-safe contract for Paraform's native sourcing filters.
// Keep the names aligned with sourcing.applyFilters so the UI does not invent
// a second search language that can drift from Paraform.

const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];
const unique = (value, limit = 100) => [...new Set(list(value).map(text).filter(Boolean))].slice(0, limit);
const finite = (value, { integer = false, min = 0, max = 60 } = {}) => {
  if (value === "" || value == null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) return undefined;
  return number;
};

export const DEGREE_TYPES = Object.freeze([
  ["HIGH_SCHOOL", "High school"],
  ["CERTIFICATE", "Certificate"],
  ["ASSOCIATE", "Associate"],
  ["BACHELOR", "Bachelor's"],
  ["MASTER", "Master's"],
  ["MBA", "MBA"],
  ["JD", "JD"],
  ["MD", "MD"],
  ["PHD", "PhD"],
]);

export const FUNDING_STAGES = Object.freeze([
  ["pre_seed", "Pre-seed"], ["seed", "Seed"], ["series_a", "Series A"],
  ["series_b", "Series B"], ["series_c", "Series C"], ["series_d", "Series D"],
  ["series_e", "Series E"], ["series_f", "Series F"], ["series_g", "Series G"],
  ["series_h", "Series H"], ["series_i", "Series I"], ["series_j", "Series J"],
  ["private_equity", "Private equity"], ["ipo", "IPO"], ["angel", "Angel"],
  ["debt_financing", "Debt financing"], ["convertible_note", "Convertible note"],
  ["corporate_round", "Corporate round"], ["secondary_market", "Secondary market"],
  ["grant", "Grant"], ["non_equity_assistance", "Non-equity assistance"],
  ["equity_crowdfunding", "Equity crowdfunding"], ["product_crowdfunding", "Product crowdfunding"],
  ["initial_coin_offering", "Initial coin offering"], ["series_unknown", "Series unknown"],
  ["undisclosed", "Undisclosed"],
]);

export const TALENT_DENSITY_TIERS = Object.freeze([
  ["S", "S tier"], ["A", "A tier"], ["B", "B tier"], ["other", "Other"],
]);

export function emptyWorkClause() {
  return {
    titles: [], companies: [], companyLinkedinIds: [], scope: "any",
    companyKeywords: [], companyFundingStages: [], companyFundingStageSemantic: "current",
    companyInvestors: [], companyTalentDensityTiers: [],
  };
}

export function emptyEducationClause() {
  return { schools: [], fieldsOfStudy: [], degreeTypes: [] };
}

export function emptyNativeFilters() {
  return {
    candidateName: "", linkedinSlug: "", keyword: "", excludeKeyword: "",
    workExperienceGroups: [], excludeWorkExperienceGroups: [],
    skills: [], skillsMode: "boost", excludeSkills: [],
    locations: [], excludeLocations: [],
    educationGroups: [], excludeSchools: [], excludeFieldsOfStudy: [],
  };
}

function normalizeWorkClause(raw = {}) {
  const scope = ["current", "past", "any"].includes(raw.scope) ? raw.scope : "any";
  const semantic = ["current", "tenure"].includes(raw.companyFundingStageSemantic)
    ? raw.companyFundingStageSemantic : "current";
  const knownFunding = new Set(FUNDING_STAGES.map(([id]) => id));
  const knownTiers = new Set(TALENT_DENSITY_TIERS.map(([id]) => id));
  const companyLinkedinIds = list(raw.companyLinkedinIds).map((item) => ({
    linkedinId: text(item?.linkedinId), name: text(item?.name), ...(text(item?.domain) ? { domain: text(item.domain) } : {}),
  })).filter((item) => item.linkedinId && item.name).slice(0, 50);
  return {
    titles: unique(raw.titles, 50),
    companies: unique(raw.companies, 50),
    companyLinkedinIds,
    scope,
    companyKeywords: unique(raw.companyKeywords, 50),
    ...(finite(raw.companyHeadcountMin, { integer: true, max: 10_000_000 }) !== undefined
      ? { companyHeadcountMin: finite(raw.companyHeadcountMin, { integer: true, max: 10_000_000 }) } : {}),
    ...(finite(raw.companyHeadcountMax, { integer: true, max: 10_000_000 }) !== undefined
      ? { companyHeadcountMax: finite(raw.companyHeadcountMax, { integer: true, max: 10_000_000 }) } : {}),
    companyFundingStages: unique(raw.companyFundingStages, 30).filter((value) => knownFunding.has(value)),
    companyFundingStageSemantic: semantic,
    companyInvestors: unique(raw.companyInvestors, 50),
    ...(finite(raw.companyTotalFundingMin, { max: 1_000_000_000_000 }) !== undefined
      ? { companyTotalFundingMin: finite(raw.companyTotalFundingMin, { max: 1_000_000_000_000 }) } : {}),
    ...(finite(raw.companyTotalFundingMax, { max: 1_000_000_000_000 }) !== undefined
      ? { companyTotalFundingMax: finite(raw.companyTotalFundingMax, { max: 1_000_000_000_000 }) } : {}),
    companyTalentDensityTiers: unique(raw.companyTalentDensityTiers, 4).filter((value) => knownTiers.has(value)),
  };
}

function workClauseHasValue(clause) {
  return ["titles", "companies", "companyLinkedinIds", "companyKeywords", "companyFundingStages", "companyInvestors", "companyTalentDensityTiers"]
    .some((key) => clause[key]?.length) || ["companyHeadcountMin", "companyHeadcountMax", "companyTotalFundingMin", "companyTotalFundingMax"]
    .some((key) => clause[key] !== undefined);
}

function normalizeEducationClause(raw = {}) {
  const known = new Set(DEGREE_TYPES.map(([id]) => id));
  return {
    schools: unique(raw.schools, 50),
    fieldsOfStudy: unique(raw.fieldsOfStudy, 50),
    degreeTypes: unique(raw.degreeTypes, 12).filter((value) => known.has(value)),
  };
}

const educationClauseHasValue = (clause) => clause.schools.length || clause.fieldsOfStudy.length || clause.degreeTypes.length;

export function normalizeNativeFilters(raw = {}) {
  const out = emptyNativeFilters();
  out.candidateName = text(raw.candidateName).slice(0, 200);
  out.linkedinSlug = text(raw.linkedinSlug).slice(0, 300);
  out.keyword = text(raw.keyword).slice(0, 1000);
  out.excludeKeyword = text(raw.excludeKeyword).slice(0, 1000);
  out.workExperienceGroups = list(raw.workExperienceGroups).map(normalizeWorkClause).filter(workClauseHasValue).slice(0, 12);
  out.excludeWorkExperienceGroups = list(raw.excludeWorkExperienceGroups).map(normalizeWorkClause).filter(workClauseHasValue).slice(0, 12);
  out.skills = unique(raw.skills, 100);
  out.skillsMode = raw.skillsMode === "strict" ? "strict" : "boost";
  out.excludeSkills = unique(raw.excludeSkills, 100);
  out.locations = unique(raw.locations, 100);
  out.excludeLocations = unique(raw.excludeLocations, 100);
  out.yoeMin = finite(raw.yoeMin, { integer: true });
  out.yoeMax = finite(raw.yoeMax, { integer: true });
  out.timeAtCurrentRoleMinYears = finite(raw.timeAtCurrentRoleMinYears);
  out.timeAtCurrentRoleMaxYears = finite(raw.timeAtCurrentRoleMaxYears);
  out.educationGroups = list(raw.educationGroups).map(normalizeEducationClause).filter(educationClauseHasValue).slice(0, 12);
  out.excludeSchools = unique(raw.excludeSchools, 100);
  out.excludeFieldsOfStudy = unique(raw.excludeFieldsOfStudy, 100);
  const knownDegree = new Set(DEGREE_TYPES.map(([id]) => id));
  if (knownDegree.has(raw.minDegreeType)) out.minDegreeType = raw.minDegreeType;
  for (const [minKey, maxKey] of [["yoeMin", "yoeMax"], ["timeAtCurrentRoleMinYears", "timeAtCurrentRoleMaxYears"]]) {
    if (out[minKey] !== undefined && out[maxKey] !== undefined && out[minKey] > out[maxKey]) {
      throw new Error(`${minKey} cannot be greater than ${maxKey}`);
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined && value !== ""));
}

export function deriveNativeFilters(rubric = {}) {
  const positive = rubric.searchSignals || {};
  const negative = rubric.exclusions || {};
  const role = rubric.role || {};
  const work = unique(positive.titles).length || unique(positive.companies).length
    ? [{ ...emptyWorkClause(), titles: unique(positive.titles).length ? unique(positive.titles) : [text(role.title)].filter(Boolean), companies: unique(positive.companies) }]
    : text(role.title) ? [{ ...emptyWorkClause(), titles: [text(role.title)] }] : [];
  const excludeWork = unique(negative.titles).length || unique(negative.companies).length
    ? [{ ...emptyWorkClause(), titles: unique(negative.titles), companies: unique(negative.companies) }] : [];
  const experience = text(positive.experience);
  const range = experience.match(/(?:(\d+(?:\.\d+)?)\s*)?(?:-|to)?\s*(\d+(?:\.\d+)?)?\s*years?/i);
  return normalizeNativeFilters({
    workExperienceGroups: work,
    excludeWorkExperienceGroups: excludeWork,
    skills: positive.skills,
    skillsMode: "boost",
    excludeSkills: negative.skills,
    locations: unique(positive.locations).length ? positive.locations : [role.location].filter(Boolean),
    yoeMin: range?.[1], yoeMax: range?.[2],
  });
}

export function deriveAgentCriteria(rubric = {}, adjustments = []) {
  const lines = [
    ...list(rubric.mustHaves).map((item) => `MUST: ${text(item)}`),
    ...list(rubric.preferences).map((item) => `PREFER: ${text(item)}`),
    ...list(rubric.exclusions?.criteria).map((item) => `REJECT: ${text(item)}`),
    ...list(adjustments).map((item) => `CALIBRATION: ${text(item?.action || item)}`),
  ].filter(Boolean);
  return lines.join("\n").slice(0, 12_000);
}

export function normalizeRankingConfig(raw = {}, candidateCap = 100) {
  const ceiling = Math.min(100, Math.max(1, Math.trunc(Number(candidateCap) || 100)));
  const poolSize = Math.min(ceiling, Math.max(1, Math.trunc(Number(raw.poolSize ?? ceiling) || ceiling)));
  const saveLimit = Math.min(poolSize, Math.max(1, Math.trunc(Number(raw.saveLimit) || 30)));
  const minimumScore = Math.min(100, Math.max(0, Math.trunc(Number(raw.minimumScore) || 75)));
  return { poolSize, saveLimit, minimumScore };
}
