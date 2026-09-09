import { historicalV4SourceAttribution } from './historical-source-attribution.mjs';

export const APPLICATION_SOURCE_FACTS_VERSION = "applicant-core-application-source-facts-v1";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const boundedText = (value, limit = 4_000) => typeof value === "string" && value.trim()
  ? value.trim().slice(0, limit) : null;

function canonicalLinkedinUrl(value) {
  const raw = boundedText(value, 1_500);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)
      || !["linkedin.com", "www.linkedin.com"].includes(parsed.hostname.toLowerCase())
      || !/^\/in\/[^/]+\/?$/iu.test(parsed.pathname)) return null;
    return `https://www.linkedin.com${parsed.pathname.replace(/\/$/u, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

function firstText(...values) {
  for (const value of values) {
    const selected = boundedText(value, 500);
    if (selected) return selected;
  }
  return null;
}

function arrayField(value, keys) {
  for (const key of keys) if (own(value, key) && Array.isArray(value[key])) {
    return { present: true, value: value[key] };
  }
  return { present: false, value: [] };
}

function sourceExperience(entry, index) {
  const row = object(entry) ?? {};
  const end = firstText(row.end_date, row.endDate, row.ended_at, row.end, row.to);
  const explicitlyPresent = /^(?:present|current|now)$/iu.test(end || "");
  const explicitlyEnded = end != null && Number.isFinite(Date.parse(end));
  const current = typeof row.current === "boolean" ? row.current
    : typeof row.is_current === "boolean" ? row.is_current
      : explicitlyPresent ? true : explicitlyEnded ? false : null;
  const value = {
    companyName: firstText(row.company, row.company_name, row.organization),
    roleTitle: firstText(row.title, row.role_title, row.position),
    start: firstText(row.start_date, row.startDate, row.started_at, row.start, row.from),
    end,
    current,
    location: firstText(row.location),
    description: boundedText(row.description || row.summary, 8_000),
  };
  return Object.values(value).some((field) => field != null && field !== false)
    ? Object.freeze({ recordId: firstText(row.id, row.record_id) || `source-experience:${index}`, ...value })
    : null;
}

function sourceEducation(entry, index) {
  const row = object(entry) ?? {};
  const degree = [firstText(row.degree, row.degree_name, row.qualification),
    firstText(row.field_of_study, row.fieldOfStudy)].filter(Boolean).join(" — ") || null;
  const value = {
    school: firstText(row.school, row.school_name, row.institution),
    degree,
    start: firstText(row.start_date, row.startDate, row.started_at, row.start, row.from),
    end: firstText(row.end_date, row.endDate, row.ended_at, row.end, row.to),
    schoolLocation: firstText(row.location),
    description: boundedText(row.description || row.summary, 8_000),
  };
  return Object.values(value).some((field) => field != null)
    ? Object.freeze({ recordId: firstText(row.id, row.record_id) || `source-education:${index}`, ...value })
    : null;
}

/** Bounded application facts from one already-normalized immutable source
 * observation. Missing values stay missing. This function never reads a
 * resume, calls a provider, or guesses structured facts from document text. */
export function applicationSourceFactsFromNormalized(normalized, { provider, observedAt } = {}) {
  if (historicalV4SourceAttribution(normalized, { provider })) return Object.freeze({});
  const source = object(normalized) ?? {};
  const sourceContext = object(source.sourceContext) ?? object(source.source_context) ?? {};
  const detail = object(source.context_snapshot?.candidate_detail) ?? {};
  const raw = object(source.raw_xlsx_row) ?? object(sourceContext.raw_xlsx_row) ?? detail;
  const historyCanAssertEmpty = provider === "workable";
  const experience = arrayField(detail, ["experience_entries", "experiences", "experience"]);
  const education = arrayField(detail, ["education_entries", "education"]);
  const currentTitle = firstText(source.current_title, sourceContext.current_title, raw["Current Title"]);
  const currentCompany = firstText(source.current_company, sourceContext.current_company, raw["Current Company"]);
  const sourceExperiences = experience.value.length ? experience.value
    : currentTitle || currentCompany ? [{
      title: currentTitle,
      company: currentCompany,
      start_date: firstText(source.current_position_start_date,
        sourceContext.current_position_start_date, raw["Current Position Start Date"]),
      end_date: null,
      current: true,
    }] : [];
  const educationContext = object(source.education) ?? object(sourceContext.education) ?? {};
  const school = firstText(educationContext.institution, raw["Education Institution"]);
  const degree = firstText(educationContext.degree, raw["Education Degree"]);
  const sourceSchools = education.value.length ? education.value
    : school || degree ? [{ school, degree }] : [];
  const experiences = sourceExperiences.slice(0, 60).map(sourceExperience).filter(Boolean);
  const schools = sourceSchools.slice(0, 30).map(sourceEducation).filter(Boolean);
  const facts = {};
  const provenance = {};
  const add = (key, value) => {
    if (value == null) return;
    facts[key] = value;
    provenance[key] = Object.freeze({ source: "application_source", observedAt });
  };
  const rawName = [firstText(raw["First Name"]), firstText(raw["Last Name"])].filter(Boolean).join(" ");
  add("name", firstText(source.applicant?.name, source.candidate?.name,
    source.contact?.name, detail.name, raw["Applicant Name"], rawName));
  add("title", firstText(detail.headline, source.headline, sourceContext.headline,
    raw.Headline, currentTitle));
  const location = typeof detail.location === "string" ? detail.location
    : firstText(detail.location?.name, detail.address, source.location?.general_location,
      sourceContext.location?.general_location, raw["General Location"], raw.Location);
  add("location", location);
  const linkedin = source.linkedin?.status === "valid"
    ? canonicalLinkedinUrl(source.linkedin.canonical_url)
    : canonicalLinkedinUrl(source.applicant?.linkedin_url || raw["LinkedIn Profile URL"]
      || raw["LinkedIn URL"]);
  add("linkedin", linkedin || null);
  if ((experience.present || currentTitle || currentCompany) && (experiences.length
    || (historyCanAssertEmpty && experience.value.length === 0))) add("experiences", Object.freeze(experiences));
  if ((education.present || school || degree) && (schools.length
    || (historyCanAssertEmpty && education.value.length === 0))) add("education", Object.freeze(schools));
  return Object.freeze({ ...facts,
    ...(Object.keys(provenance).length ? { provenance: Object.freeze(provenance) } : {}) });
}
