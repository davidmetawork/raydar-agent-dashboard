// The evaluation facts for one applicant — the ONLY thing a rule ever reads.
//
// WHY THIS EXISTS AND apphub:cards DOES NOT SUFFICE. Cards are a render
// projection: they truncate to the first three jobs and schools and carry no
// stable ids. Measured on the live queue (2026-08-20) experience rows run to a
// median of 2 but a p90 of 9 and a max of 23, so a card-based rule would
// silently miss a quarter of people's history — and with no school id it could
// only match institutions by typed text, which cannot tell Harvard College
// from Harvard Business School. Rules need every row and every id.
//
// SOURCE. Derived from the prewarmed profile as it lands in sync, exactly the
// way cardFromProfile derives a card from the same object. Never a source of
// truth: it is always regenerable from the profile, and a bad build is fixed
// by the next prewarm rather than by a migration.
//
// THE HALF THAT ISN'T HERE. Some published applicants have no education AND no
// experience in the provider profile. For them `hasHistory` is false and every
// history condition simply cannot be satisfied. That is a fact about the data,
// not a profile-readiness gate: see FACTS_VERSION's note on fail-closed
// matching in rules.mjs.

import { degreeLevel, degreeLevels } from "./degree.mjs";
import { schoolInUS } from "./school-us.mjs";
import { topSchoolGroup } from "./school-top.mjs";
import { resolveSchoolCountryEvidence, locationExplicitlyNamesForeignCountry } from "./school-country-registry.mjs";

/**
 * Bump when the shape changes in a way a stored rule could misread. The tick
 * skips any facts row built by a different version rather than guessing at an
 * older shape, and the next prewarm rebuilds it.
 */
export const FACTS_VERSION = 1;
// NOT bumped for the additive countryEvidence/levels fields. The country
// reader requires consistent, recognized evidence and skips old rows until
// they are rebuilt; the degree reader still accepts a legacy scalar level.
// NOT bumped when `location`/`inUS` were added on 2026-08-25. A bump makes the
// tick skip EVERY stored record until the whole queue is re-warmed, which at
// the measured 8-12 profiles per cycle would have taken the existing live rule
// off the air for days. The new keys are additive and fail closed on their
// own: a record built before them has `inUS: undefined`, which compares false,
// so a rule asking for a US school simply does not match that person until
// their next prewarm. Bump only for a change a stored rule could MISREAD.

// Caps exist so one 23-role profile cannot bloat the hash the tick reads in
// batches. Both sit comfortably above the observed p99 (jobs p90 = 9, max 23;
// education p90 = 3, max 4), and the true totals ride alongside as counts so a
// "more than N roles" condition stays exact even when the list is trimmed.
export const MAX_JOBS = 14;
export const MAX_SCHOOLS = 8;
const FIELD_MAX = 160;

const str = (value) => {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, FIELD_MAX) : null;
};

const list = (value) => (Array.isArray(value) ? value : []);

function schoolCountry(row) {
  const location = row?.schoolLocation;
  const foreign = locationExplicitlyNamesForeignCountry(location);
  if (foreign) return { inUS: false, countryEvidence: { status: "foreign", source: "profile_location" } };
  if (schoolInUS({ website: row?.schoolWebsite, location })) {
    return { inUS: true, countryEvidence: { status: "us", source: "profile_location_or_website" } };
  }
  const evidence = resolveSchoolCountryEvidence({ name: row?.school, location, website: row?.schoolWebsite });
  return evidence ? {
    inUS: true,
    countryEvidence: { status: "us", source: evidence.sourceURL, version: evidence.sourceVersion,
      match: evidence.match, unitid: evidence.unitid },
  } : { inUS: false, countryEvidence: { status: "unknown", source: null } };
}

/** Paraform dates are ISO strings or null. Returns epoch ms, or null. */
const ms = (value) => {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
};

/** Year only — every date-shaped rule condition is expressed in years. */
export const yearOf = (value) => {
  const t = ms(value);
  return t == null ? null : new Date(t).getUTCFullYear();
};

/**
 * Total months worked, with overlapping roles counted once.
 *
 * Naively summing each role's length double-counts every concurrent job, and
 * concurrent roles are common (a contractor with four clients, anyone with a
 * side company). Merging the intervals first is what makes "8 years of
 * experience" mean what a reader thinks it means.
 *
 * Still an ESTIMATE and labelled as one in the UI: LinkedIn dates are
 * month-precision at best, and a role with no start date cannot be counted at
 * all. Returns null when nothing datable exists rather than a misleading 0.
 */
export function experienceMonths(jobs, now = Date.now()) {
  const spans = [];
  for (const job of list(jobs)) {
    const start = ms(job?.start);
    if (start == null) continue;
    const end = ms(job?.end) ?? (job?.current ? now : null);
    // An undated end on a non-current role is unknowable; skip rather than
    // assume it ran until today, which would inflate every stale profile.
    if (end == null || end < start) continue;
    spans.push([start, end]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [spans[0]];
  for (const [start, end] of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const total = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
  return Math.round(total / (30.44 * 86_400_000));
}

/**
 * One profile -> one facts record. Total and defensive: every key is always
 * present, so the evaluator never branches on absence, and a profile that is
 * missing everything yields a record whose conditions simply cannot match.
 */
export function factsFromProfile(profile, {
  now = Date.now(),
  sourceObservationId = null,
  sourcePayloadDigest = null,
} = {}) {
  const source = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};

  const schools = list(source.education).slice(0, MAX_SCHOOLS).map((row) => ({
    id: str(row?.schoolId),
    name: str(row?.school),
    // Classified once, here, rather than once per rule per tick.
    level: degreeLevel(row?.degree),
    levels: degreeLevels(row?.degree),
    degree: str(row?.degree),
    endYear: yearOf(row?.end),
    rank: str(row?.talentRank),
    location: str(row?.schoolLocation),
    // Classified here for the same reason `level` is: once per profile rather
    // than once per rule per tick, and by ONE function so the preview, the
    // tick and the audit can never disagree about what "American" means.
    // A missing location/website can be resolved from the public institution
    // registry; otherwise countryEvidence stays unknown and neither country
    // condition can match it.
    ...schoolCountry(row),
    // Which curated top-university list this school is on, or null. Derived
    // from the NAME (the one deliberate exception to id matching — see
    // school-top.mjs for why ids cannot express a world ranking).
    top: topSchoolGroup(row?.school),
  }));

  const jobs = list(source.experiences).slice(0, MAX_JOBS).map((row) => ({
    id: str(row?.companyId),
    name: str(row?.companyName),
    title: str(row?.roleTitle),
    startYear: yearOf(row?.start),
    endYear: yearOf(row?.end),
    current: Boolean(row?.current),
    industry: str(row?.industry),
    rank: str(row?.talentRank),
  }));

  // Membership predicates need the complete employer history. `jobs` stays
  // capped because existing row-scoped rules depend on that long-standing
  // storage bound; this additive projection carries only the two identity
  // fields needed for exact set membership and therefore remains compact.
  // Do not deduplicate by name. A raw name is not identity; when an id is
  // absent, the rule evaluator may resolve only an exact name that appears in
  // a separate immutable, provider-wide reviewed bridge.
  const seenCompanies = new Set();
  const allCompanies = [];
  for (const row of list(source.experiences)) {
    const id = str(row?.companyId);
    const name = str(row?.companyName);
    const key = `${id ?? ""}\u0000${name ?? ""}`;
    if ((!id && !name) || seenCompanies.has(key)) continue;
    seenCompanies.add(key);
    allCompanies.push({ id, name });
  }

  // `current` is end_date == null on the Paraform feed (is_current is always
  // null there — a documented vendor gotcha). The first current row wins;
  // Paraform orders experiences newest-first.
  const currentJob = jobs.find((job) => job.current) ?? null;

  const months = experienceMonths(
    list(source.experiences).map((row) => ({ start: row?.start, end: row?.end, current: Boolean(row?.current) })),
    now,
  );

  return {
    v: FACTS_VERSION,
    at: new Date(now).toISOString(),
    // Present for durable Applicant Hub facts. Funded-employer membership
    // requires both values to equal the active row and current durable receipt
    // so an older best-effort facts write can never act on a newer profile.
    sourceObservationId: str(sourceObservationId),
    sourcePayloadDigest: str(sourcePayloadDigest)?.toLowerCase() ?? null,
    // The age of the LinkedIn snapshot behind these facts. Surfaced in the
    // audit so a decision made on stale data is visibly made on stale data.
    updatedAt: str(source.updatedAt),

    title: str(source.title),
    location: str(source.location),
    hasAbout: Boolean(source.about),
    hasResume: Boolean(source.resumeUrl),
    hasLinkedin: Boolean(source.linkedin),
    densityScore: typeof source.densityScore === "number" ? source.densityScore : null,
    possibleFake: Boolean(source.possibleFake),

    schools,
    // True totals, not the truncated list lengths, so "more than N" is exact.
    schoolCount: list(source.education).length,
    jobs,
    allCompanies,
    jobCount: list(source.experiences).length,

    months,
    currentCompanyId: currentJob?.id ?? null,
    currentCompanyName: currentJob?.name ?? null,
    currentTitle: currentJob?.title ?? null,

    // The single flag the UI reads to explain why a rule could not reach
    // someone. False for the 44% with an empty Paraform record.
    hasHistory: Boolean(list(source.education).length || list(source.experiences).length),
  };
}

/**
 * Directory entries for the rule editor's pickers, harvested from one facts
 * record. Paraform exposes no company or school search we can call, so the
 * pickers are built from our own applicant pool — which is exactly the useful
 * set, because a rule about an institution nobody in the queue attended can
 * never fire anyway.
 *
 * Returns `{schools, companies}` as `{id: name}` maps. Rows without a stable
 * id are skipped: an entry the rule editor cannot store as an id has no
 * business being offered as a choice.
 */
export function directoryFromFacts(facts) {
  const schools = {};
  const companies = {};
  for (const school of list(facts?.schools)) {
    if (school?.id && school?.name) schools[school.id] = school.name;
  }
  for (const job of list(facts?.jobs)) {
    if (job?.id && job?.name) companies[job.id] = job.name;
  }
  return { schools, companies };
}
