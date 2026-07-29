// Human-confirm Para AI state machine. Every external write is claimed in KV
// before it runs and performed once. Paraform accepts direct submissions
// asynchronously, so approval is reconciled read-only before match processing.

import {
  INTERNAL_NAMES,
  RECRUITER_ID,
  SEQUENCE_NAMES,
  candidateAlreadySubmitted,
  candidateDetails,
  candidateProfileInfo,
  candidatePreferences,
  directSubmitQuota,
  fetchCall,
  findCrmCandidate,
  findIdentity,
  findLead,
  findResumeUri,
  firstEmail,
  getResume,
  hasFutureScheduledStep,
  hasEmail,
  isSuccessfulCall,
  isArchiveImportCandidate,
  listSequences,
  normLinkedin,
  normName,
  normalizeEmail,
  paraAIConfig,
  registerLifecycleEnrollment,
  resumeContact,
  scanCrm,
  scoreIdentity,
  targetMembership,
  trpcGet,
  trpcPost,
  uploadResume,
} from "./core.mjs";
import { FUNDING_ROUNDS, PARAAI_LOCATIONS, WORKPLACE_TYPES, extraNote, extractPreferences, normalizeExtraction } from "./extract.mjs";
import {
  HUMAN_CALL_SOFT_REVIEW_CODE,
  HUMAN_CALL_SOFT_REVIEW_MESSAGE,
  fetchHumanCall,
  humanCallReadiness,
  isHumanCallJob,
  callIdFromHumanJob,
  persistedHumanCallMetadata,
} from "./human-call.mjs";
import {
  HUMAN_INTRO_PAYLOAD_CONFLICT_CODE,
  HUMAN_INTRO_PAYLOAD_CONFLICT_MESSAGE,
  HUMAN_INTRO_RESUME_AMBIGUOUS_CODE,
  HUMAN_INTRO_RESUME_AMBIGUOUS_MESSAGE,
  HUMAN_INTRO_RESUME_REVIEW_CODE,
  HUMAN_INTRO_RESUME_REVIEW_MESSAGE,
  humanIntroCallFromJob,
  isHumanIntroJob,
  persistedHumanIntroMetadata,
} from "./human-intro.mjs";
import {
  resumeWaitPlanFromEnv,
} from "./resume-wait.mjs";
import {
  claimSubmissionIntent,
  createJob,
  finishSubmissionAttempt,
  getJob,
  getSubmissionIntent,
  hashSubmissionPayload,
  saveJob,
  savePhase3ShadowDecision,
  startSubmissionAttempt,
  transition,
} from "./store.mjs";
import { jobReviewReasons, reviewActionFor } from "./review.mjs";
import {
  ALL_OUTCOME_SEQUENCE_IDS,
  PHASE3_SHADOW_POLICY_VERSION,
  buildAggregateShadowAudit,
  curatedPostAddMatchCount,
  lateMatchDecision,
  matchSettlementDecision,
  mostRecentSuccessfulCallDecision,
  nextMatchPollDecision,
  outcomeMembershipDecision,
  planCuratedAdds,
} from "./phase3-shadow-policy.mjs";

export const STATES = new Set([
  "detected", "resolving_identity", "needs_identity_review", "extracting",
  "ready_to_submit", "waiting_for_resume", "submit_intent", "submitting", "submission_unknown",
  "awaiting_approval", "awaiting_matches", "ready_to_enroll",
  "needs_review", "ensuring_email", "enrolling", "verifying", "enrolled",
  "no_email", "error",
]);

const BOT_ID = /^[A-Za-z0-9_-]{8,100}$/;
export const PARAAI_SALARY_CAP = 200_000;
export const PARAAI_SALARY_ROUTING_BUFFER = 10_000;
const configuredSalaryDefault = Number(process.env.PARAAI_SALARY_DEFAULT_MIN || 120_000);
export const PARAAI_SALARY_DEFAULT_MIN = Number.isFinite(configuredSalaryDefault) && configuredSalaryDefault >= 0
  ? configuredSalaryDefault
  : 120_000;
export const PARAAI_STAGE_ORDER = Object.freeze([
  "PRE_SEED", "SEED", "SERIES_A", "SERIES_B", "SERIES_C", "SERIES_D_PLUS", "UNKNOWN",
]);
export const PARAAI_NA_LOCATIONS = Object.freeze([
  "new_york", "san_francisco", "south_bay_area", "los_angeles", "boston", "seattle",
  "texas", "chicago", "washington_dc", "denver", "florida", "minnesota", "sacramento",
  "canada",
]);
export const VISA_SPONSORSHIP = new Set(["Available", "Not available"]);

function stateError(message, code, job = null) {
  const error = new Error(message);
  error.code = code;
  if (job) error.job = job;
  return error;
}

async function fail(job, code, detail, extra = {}) {
  const saved = await saveJob(transition(job, "error", {
    error: { code, detail: String(detail || code).slice(0, 300), at: new Date().toISOString() },
    ...extra,
    journalDetail: code,
  }), job.revision);
  throw stateError(detail || code, code, saved);
}

export function targetSequenceName(matchCount) {
  return Number(matchCount) === 1 ? SEQUENCE_NAMES.one : SEQUENCE_NAMES.multiple;
}

const array = (value) => Array.isArray(value) ? value : [];
const values = (value) => Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
const uniqueAllowed = (value, allowed, transform = (item) => item) => [...new Set(array(value).map(transform).filter((item) => allowed.has(item)))];
const unique = (value) => [...new Set(value)];
const US_LOCATION_IDS = new Set(PARAAI_NA_LOCATIONS.filter((location) => location !== "canada"));

function normalizedPlace(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const locationAliases = new Map([
  ["new york", ["new_york"]], ["new york city", ["new_york"]], ["nyc", ["new_york"]],
  ["new jersey", ["new_york"]], ["nj", ["new_york"]],
  ["san francisco", ["san_francisco"]], ["sf", ["san_francisco"]],
  ["south bay", ["south_bay_area"]], ["south bay area", ["south_bay_area"]],
  ["san jose", ["south_bay_area"]], ["bay area", ["south_bay_area", "san_francisco"]],
  ["silicon valley", ["south_bay_area", "san_francisco"]],
  ["los angeles", ["los_angeles"]], ["la", ["los_angeles"]],
  ["boston", ["boston"]], ["seattle", ["seattle"]], ["texas", ["texas"]],
  ["chicago", ["chicago"]], ["washington dc", ["washington_dc"]],
  ["washington d c", ["washington_dc"]], ["dc", ["washington_dc"]],
  ["d c", ["washington_dc"]], ["district of columbia", ["washington_dc"]],
  ["denver", ["denver"]], ["florida", ["florida"]], ["minnesota", ["minnesota"]],
  ["sacramento", ["sacramento"]],
  ["canada", ["canada"]], ["toronto", ["canada"]], ["vancouver", ["canada"]],
  ["montreal", ["canada"]],
  ["united kingdom", ["uk"]], ["uk", ["uk"]], ["london", ["uk"]],
  ["manchester", ["uk"]], ["edinburgh", ["uk"]],
  ["south korea", ["korea"]], ["korea", ["korea"]], ["seoul", ["korea"]],
  ["india", ["india"]], ["bengaluru", ["india"]], ["bangalore", ["india"]],
  ["mumbai", ["india"]], ["delhi", ["india"]], ["hyderabad", ["india"]],
  ["australia", ["australia"]], ["sydney", ["australia"]], ["melbourne", ["australia"]],
  ["europe", ["europe"]], ["european union", ["europe"]], ["eu", ["europe"]],
  ["germany", ["europe"]], ["france", ["europe"]], ["netherlands", ["europe"]],
  ["ireland", ["europe"]], ["spain", ["europe"]], ["portugal", ["europe"]],
  ["italy", ["europe"]], ["sweden", ["europe"]], ["switzerland", ["europe"]],
  ["berlin", ["europe"]], ["paris", ["europe"]], ["amsterdam", ["europe"]],
  ["dublin", ["europe"]], ["madrid", ["europe"]], ["barcelona", ["europe"]],
  ["lisbon", ["europe"]], ["stockholm", ["europe"]], ["munich", ["europe"]],
  ["latin america", ["latam"]], ["latam", ["latam"]], ["south america", ["latam"]],
  ["brazil", ["latam"]], ["mexico", ["latam"]], ["argentina", ["latam"]],
  ["colombia", ["latam"]], ["chile", ["latam"]], ["peru", ["latam"]],
  ["sao paulo", ["latam"]], ["mexico city", ["latam"]], ["buenos aires", ["latam"]],
  ["bogota", ["latam"]], ["lima", ["latam"]],
  ["asia", ["asia"]], ["pakistan", ["asia"]], ["japan", ["asia"]], ["china", ["asia"]],
  ["taiwan", ["asia"]], ["philippines", ["asia"]], ["thailand", ["asia"]],
  ["vietnam", ["asia"]], ["indonesia", ["asia"]], ["malaysia", ["asia"]],
  ["united arab emirates", ["asia"]], ["uae", ["asia"]],
  ["lahore", ["asia"]], ["karachi", ["asia"]], ["dubai", ["asia"]],
  ["singapore", ["asia"]], ["tokyo", ["asia"]], ["hong kong", ["asia"]],
  ["taipei", ["asia"]], ["manila", ["asia"]], ["bangkok", ["asia"]],
  ...[...PARAAI_LOCATIONS].map((value) => [value.replaceAll("_", " "), [value]]),
]);

const US_STATE_NAMES = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/;
const US_UNMAPPED_CITIES = /\b(?:atlanta|nashville|portland|austin|miami|philadelphia|phoenix|san diego|charlotte|raleigh|durham|pittsburgh|detroit|cleveland|columbus|cincinnati|indianapolis|kansas city|st louis|new orleans|salt lake city|las vegas|honolulu|boise|baltimore|milwaukee|omaha)\b/;
const US_COUNTRY = /\b(?:united states(?: of america)?|usa|u s a|us|u s|america)\b/;
const US_STATE_CODE = /(?:,\s*|^|\s)(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?:\s*$|,)/i;
const COUNTRY_REGION_CODES = new Map([
  ["ca", "canada"], ["can", "canada"],
  ["gb", "uk"], ["gbr", "uk"],
  ["au", "australia"], ["aus", "australia"],
  ["in", "india"], ["ind", "india"],
  ["kr", "korea"], ["kor", "korea"],
  ...["at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr", "hu", "is", "ie", "it", "lv", "lt", "lu", "mt", "nl", "no", "pl", "pt", "ro", "sk", "si", "es", "se", "ch", "ua"].map((code) => [code, "europe"]),
  ...["mx", "br", "ar", "bo", "cl", "co", "cr", "cu", "do", "ec", "sv", "gt", "ht", "hn", "jm", "ni", "pa", "py", "pe", "pr", "uy", "ve"].map((code) => [code, "latam"]),
  ...["cn", "jp", "pk", "bd", "bt", "bn", "kh", "hk", "id", "kz", "kg", "la", "my", "mn", "mm", "np", "ph", "sg", "lk", "tw", "tj", "th", "tm", "uz", "vn", "ae", "il", "sa", "qa"].map((code) => [code, "asia"]),
]);
const EUROPE_COUNTRIES = /\b(?:albania|andorra|austria|belarus|belgium|bosnia(?: and herzegovina)?|bulgaria|croatia|cyprus|czech(?:ia| republic)|denmark|estonia|finland|france|germany|greece|hungary|iceland|ireland|italy|kosovo|latvia|liechtenstein|lithuania|luxembourg|malta|moldova|monaco|montenegro|netherlands|north macedonia|norway|poland|portugal|romania|san marino|serbia|slovakia|slovenia|spain|sweden|switzerland|ukraine|vatican)\b/;
const LATAM_COUNTRIES = /\b(?:mexico|argentina|bolivia|brazil|chile|colombia|costa rica|cuba|dominican republic|ecuador|el salvador|guatemala|haiti|honduras|jamaica|nicaragua|panama|paraguay|peru|puerto rico|uruguay|venezuela)\b/;
const ASIA_COUNTRIES = /\b(?:afghanistan|armenia|azerbaijan|bahrain|bangladesh|bhutan|brunei|cambodia|china|georgia|hong kong|indonesia|iran|iraq|israel|japan|jordan|kazakhstan|kuwait|kyrgyzstan|laos|lebanon|malaysia|maldives|mongolia|myanmar|nepal|oman|pakistan|philippines|qatar|saudi arabia|singapore|sri lanka|taiwan|tajikistan|thailand|timor leste|turkey|turkmenistan|united arab emirates|uzbekistan|vietnam)\b/;

function countryRegion(value) {
  const place = normalizedPlace(value);
  if (!place) return [];
  const code = COUNTRY_REGION_CODES.get(place);
  if (code) return [code];
  if (/\b(?:canada)\b/.test(place)) return ["canada"];
  if (/\b(?:united kingdom|great britain|england|scotland|wales|northern ireland)\b/.test(place)) return ["uk"];
  if (/\b(?:australia|new zealand)\b/.test(place)) return ["australia"];
  if (/\b(?:india)\b/.test(place)) return ["india"];
  if (/\b(?:south korea|republic of korea)\b/.test(place)) return ["korea"];
  if (EUROPE_COUNTRIES.test(place)) return ["europe"];
  if (LATAM_COUNTRIES.test(place)) return ["latam"];
  if (ASIA_COUNTRIES.test(place)) return ["asia"];
  return [];
}

function isUSGeography(location, country = "") {
  const place = normalizedPlace(location);
  const countryValue = normalizedPlace(country);
  if (US_COUNTRY.test(countryValue)) return true;
  if (/\b(?:canada|mexico|united kingdom|uk|india|australia|korea)\b/.test(countryValue)) return false;
  if (US_STATE_CODE.test(String(location || ""))) return true;
  if (US_STATE_NAMES.test(place) || US_UNMAPPED_CITIES.test(place)) return true;
  for (const [alias, mapped] of locationAliases) {
    if (place === alias && mapped.some((item) => US_LOCATION_IDS.has(item))) return true;
  }
  return US_COUNTRY.test(place);
}

function mappedLocations(value, country = "") {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const direct = raw.toLowerCase();
  if (PARAAI_LOCATIONS.has(direct)) return [direct];
  const place = normalizedPlace(raw);
  const exact = locationAliases.get(place);
  if (exact) return [...exact];

  const embeddedAliases = [
    [/\b(?:bay area|silicon valley)\b/, ["south_bay_area", "san_francisco"]],
    [/\bsan francisco\b/, ["san_francisco"]],
    [/\b(?:south bay|san jose)\b/, ["south_bay_area"]],
    [/^(?:new york(?: city)?|nyc)\b|\b(?:new york city|nyc|new jersey)\b/, ["new_york"]],
    [/\blos angeles\b/, ["los_angeles"]],
    [/\bboston\b/, ["boston"]],
    [/\bseattle\b/, ["seattle"]],
    [/\bchicago\b/, ["chicago"]],
    [/\b(?:washington d c|washington dc|district of columbia)\b/, ["washington_dc"]],
    [/\bdenver\b/, ["denver"]],
    [/\bsacramento\b/, ["sacramento"]],
  ];
  for (const [pattern, result] of embeddedAliases) {
    if (pattern.test(place)) return result;
  }
  for (const [alias, result] of locationAliases) {
    if (result.some((location) => US_LOCATION_IDS.has(location))) continue;
    if (alias.length > 3 && new RegExp(`\\b${alias.replaceAll(" ", "\\s+")}\\b`).test(place)) return [...result];
  }
  if (isUSGeography(raw, country)) return [...PARAAI_NA_LOCATIONS];

  const countryMapped = locationAliases.get(normalizedPlace(country));
  if (countryMapped?.length) return [...countryMapped];
  return countryRegion(country || raw);
}

function mapLocationValues(value, country = "") {
  return unique(values(value).flatMap((item) => mappedLocations(item, country)));
}

const GEOGRAPHY_LOCATION_KEYS = new Set([
  "location", "currentlocation", "currentcity", "locationname", "city", "residence", "basedin",
]);
const GEOGRAPHY_COUNTRY_KEYS = new Set([
  "country", "currentcountry", "countryname", "countrycode", "countryiso",
]);

function geographyText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return String(value.label || value.name || value.city || value.value || "").trim();
}

function findGeographyField(value, keys, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return "";
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
    if (!keys.has(normalizedKey)) continue;
    const found = geographyText(item);
    if (found) return found;
  }
  const preferred = ["candidate", "candidate_user", "candidateUser", "profile", "item", "data", "byId"];
  for (const key of preferred) {
    const found = findGeographyField(value[key], keys, depth + 1, seen);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const found = findGeographyField(item, keys, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

function resolveRoutingGeography(context = {}) {
  const currentLocation = String(context.currentLocation || context.current_location || "").trim()
    || findGeographyField(context, GEOGRAPHY_LOCATION_KEYS);
  const country = String(context.country || context.currentCountry || context.country_code || "").trim()
    || findGeographyField(context, GEOGRAPHY_COUNTRY_KEYS);
  return { currentLocation, country };
}

export function buildPreferenceRoutingInput(native = null, context = {}) {
  const geography = resolveRoutingGeography(context);
  const strings = (value) => values(value)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const salary = native?.salary_min == null
    || native.salary_min === ""
    || !Number.isFinite(Number(native.salary_min))
    ? null
    : Number(native.salary_min);
  return {
    native: {
      workplace: strings(native?.workplace),
      last_funding_round: strings(native?.last_funding_round),
      locations: strings(native?.locations),
      salary_min: salary,
      visa: strings(native?.visa),
    },
    context: {
      currentLocation: geography.currentLocation,
      country: geography.country,
    },
  };
}

function visaFromExtraction(sponsorship = {}) {
  const statuses = array(sponsorship.statuses).map((item) => String(item).toUpperCase());
  if (sponsorship.required === true || statuses.includes("VISA")) return ["Available"];
  if (sponsorship.required === false || statuses.some((item) => ["CITIZEN", "GREEN_CARD"].includes(item))) return ["Not available"];
  return [];
}

function isHardSalaryFloor(compensation = {}) {
  return compensation.baseMinIsHardFloor === true;
}

function hasLegacyStartupOpenness(extracted = {}) {
  const interested = array(extracted.industries?.interested);
  const rejected = array(extracted.industries?.notInterested).join(" ");
  const activity = String(extracted.searchActivity || "");
  const negative = /\b(not|dont|do not|wont|wouldnt|never|avoid|exclude|rule out|no)\b[^.]{0,60}\b(startup|start-up|startups)\b/i;
  const negativeReverse = /\b(startup|start-up|startups)\b[^.]{0,45}\b(not|no|never|avoid|exclude|rule out|not for me|are not)\b/i;
  if (/\b(startup|start-up|startups)\b/i.test(rejected) || negative.test(activity) || negativeReverse.test(activity)) {
    return false;
  }
  if (interested.some((value) => /^\s*(?:open to |interested in )?start-?ups?\s*$/i.test(String(value)))) {
    return true;
  }
  return /\b(open to|would consider|will consider|interested in|okay with|fine with)\b[^.]{0,60}\b(startup|start-up|startups)\b/i
    .test(activity);
}

export function normalizeParaAIPreferences(value = {}) {
  const salary = Number(value.salaryMin);
  const ote = Number(value.ote);
  const preferences = {
    locations: uniqueAllowed(value.locations, PARAAI_LOCATIONS, (item) => String(item || "").toLowerCase()),
    workplaceTypes: uniqueAllowed(value.workplaceTypes, WORKPLACE_TYPES, (item) => String(item || "").toUpperCase()),
    idealFundingRounds: uniqueAllowed(value.idealFundingRounds, FUNDING_ROUNDS, (item) => String(item || "").toUpperCase()),
    requiresSponsorship: uniqueAllowed(value.requiresSponsorship, VISA_SPONSORSHIP, (item) => String(item || "")),
  };
  if (Number.isFinite(salary) && salary >= 0) preferences.salaryMin = Math.min(salary, PARAAI_SALARY_CAP);
  if (value.ote != null && value.ote !== "" && Number.isFinite(ote) && ote >= 0) preferences.ote = ote;
  return preferences;
}

export function buildPreferenceRouting(extracted, native = null, context = {}) {
  const normalized = normalizeExtraction(extracted);
  const geography = resolveRoutingGeography(context);
  const currentLocations = mapLocationValues(geography.currentLocation, geography.country);

  const explicitWorkplaces = uniqueAllowed(
    normalized.workplaceTypes,
    WORKPLACE_TYPES,
    (item) => String(item || "").toUpperCase(),
  );
  const excludedWorkplaces = new Set(uniqueAllowed(
    normalized.excludedWorkplaceTypes,
    WORKPLACE_TYPES,
    (item) => String(item || "").toUpperCase(),
  ));
  const nativeWorkplaces = uniqueAllowed(
    values(native?.workplace),
    WORKPLACE_TYPES,
    (item) => String(item || "").toUpperCase(),
  );
  const workplaceText = [
    normalized.searchActivity,
    ...normalized.roleTypes,
  ].filter(Boolean).join(" ");
  const remoteOnly = (
    explicitWorkplaces.includes("REMOTE") &&
    excludedWorkplaces.has("HYBRID") &&
    excludedWorkplaces.has("ON_SITE")
  ) || /\b(?:remote[\s-]*only|only remote|fully remote only|w(?:ill|ould) not go into (?:an? )?office|won['’]?t go into (?:an? )?office|no office)\b/i.test(workplaceText);
  const workplaceFlexible = /\b(?:flexible|open|agnostic)\b[^.]{0,45}\b(?:workplace|work model|remote|hybrid|on[\s-]*site|office)\b|\b(?:workplace|work model)\b[^.]{0,45}\b(?:flexible|open|agnostic)\b/i.test(workplaceText);
  let workplaceSource;
  let workplaceRule;
  let workplaceBase;
  if (remoteOnly) {
    workplaceBase = ["REMOTE"];
    workplaceSource = "screening_call";
    workplaceRule = "workplace_remote_only";
  } else if (explicitWorkplaces.includes("ON_SITE")) {
    workplaceBase = [...WORKPLACE_TYPES];
    workplaceSource = "ladder_expansion";
    workplaceRule = "workplace_all_three_onsite";
  } else if (explicitWorkplaces.includes("HYBRID")) {
    workplaceBase = [...WORKPLACE_TYPES];
    workplaceSource = "ladder_expansion";
    workplaceRule = "workplace_all_three_hybrid";
  } else if (workplaceFlexible) {
    workplaceBase = [...WORKPLACE_TYPES];
    workplaceSource = "ladder_expansion";
    workplaceRule = "workplace_all_three_flexible";
  } else if (explicitWorkplaces.length || excludedWorkplaces.size) {
    workplaceBase = [...WORKPLACE_TYPES];
    workplaceSource = "ladder_expansion";
    workplaceRule = "workplace_all_three_mentioned";
  } else if (nativeWorkplaces.length) {
    workplaceBase = nativeWorkplaces;
    workplaceSource = "paraform_profile";
    workplaceRule = "workplace_profile";
  } else {
    workplaceBase = [...WORKPLACE_TYPES];
    workplaceSource = "select_all_default";
    workplaceRule = "select_all_unknown";
  }
  const workplaces = workplaceBase.filter((value) => !excludedWorkplaces.has(value));

  const explicitStages = uniqueAllowed(
    normalized.companyStages,
    FUNDING_ROUNDS,
    (item) => String(item || "").toUpperCase(),
  );
  const nativeStages = uniqueAllowed(
    values(native?.last_funding_round),
    FUNDING_ROUNDS,
    (item) => String(item || "").toUpperCase(),
  );
  const excludedStages = new Set(normalized.excludedCompanyStages || []);
  const stageText = [
    normalized.startupOpennessEvidence,
    normalized.searchActivity,
    ...normalized.companyHeadcounts,
  ].filter(Boolean).join(" ");
  const broadStageOpenness = normalized.openToStartups === true ||
    hasLegacyStartupOpenness(normalized) ||
    /\b(?:any|all|every)\b[^.]{0,30}\b(?:company |startup )?(?:size|stage|funding stage)s?\b|\b(?:stage|size)[\s-]*agnostic\b|\bflexible\b[^.]{0,35}\b(?:company stage|funding stage|stage|size)s?\b|\b(?:flexible|worked)\b[^.]{0,45}\b(?:all |any |across )?(?:company |startup )?sizes?\b/i.test(stageText);
  const fuzzyStages = [];
  if (/\bgrowth[\s-]*stage\b|\bgrowth\b[^.]{0,20}\bcompan(?:y|ies)\b/i.test(stageText)) fuzzyStages.push("SERIES_B");
  if (/\bpublic(?:ly traded)? compan(?:y|ies)\b|\bpublicly traded\b|\bipo\b/i.test(stageText)) fuzzyStages.push("SERIES_D_PLUS");
  const callStageSignals = unique([...explicitStages, ...fuzzyStages]);
  const routedStageSignals = callStageSignals.length ? callStageSignals : nativeStages;
  let stageBase;
  let companyStageSource;
  let companyStageRule;
  if (broadStageOpenness) {
    stageBase = [...PARAAI_STAGE_ORDER];
    companyStageSource = "ladder_expansion";
    companyStageRule = "stage_select_all_broad";
  } else if (routedStageSignals.length) {
    const lowestIndex = Math.min(...routedStageSignals.map((stage) => PARAAI_STAGE_ORDER.indexOf(stage)));
    stageBase = PARAAI_STAGE_ORDER.slice(Math.max(0, lowestIndex - 2));
    companyStageSource = callStageSignals.length ? "ladder_expansion" : "paraform_profile";
    companyStageRule = "stage_ladder_minus2";
  } else {
    stageBase = [...PARAAI_STAGE_ORDER];
    companyStageSource = "select_all_default";
    companyStageRule = "select_all_unknown";
  }
  const companyStages = stageBase.filter((stage) => !excludedStages.has(stage));

  const structuredLocations = uniqueAllowed(
    normalized.paraformLocations,
    PARAAI_LOCATIONS,
    (item) => String(item || "").toLowerCase(),
  );
  const freeTextLocations = mapLocationValues(normalized.locations);
  const statedLocations = unique([...structuredLocations, ...freeTextLocations]);
  const nativeLocations = mapLocationValues(native?.locations);
  const excludedLocations = new Set(normalized.excludedParaformLocations || []);
  const relocationText = `${normalized.relocation.scope || ""} ${normalized.relocation.evidence || ""}`.trim();
  const explicitlyRefusesRelocation = normalized.relocation.open === false &&
    /\b(?:will not|would not|won['’]?t|wouldn['’]?t|cannot|can['’]?t|not willing to|not open to|refuse to|no)\b[^.]{0,55}\b(?:relocat\w*|moving|move)\b|\b(?:relocat\w*|moving|move)\b[^.]{0,45}\b(?:not|no|never|off the table)\b/i.test(relocationText);
  const internationalCurrentLocation = currentLocations.length > 0 &&
    !isUSGeography(geography.currentLocation, geography.country);
  const internationalTarget = structuredLocations.some((location) => !US_LOCATION_IDS.has(location)) ||
    normalized.locations.some((location) => (
      !isUSGeography(location) &&
      mappedLocations(location).some((mapped) => !US_LOCATION_IDS.has(mapped))
    ));
  const internationalOpenness = /\b(?:anywhere(?: in the world)?|worldwide|global(?:ly)?|international(?:ly)?|overseas)\b/i.test(relocationText) ||
    internationalTarget;
  const openToUSRemote = internationalCurrentLocation &&
    /\b(?:us|u\.?s\.?|united states|american)\b[^.]{0,40}\bremote\b|\bremote\b[^.]{0,40}\b(?:us|u\.?s\.?|united states|american)\b/i
      .test(`${relocationText} ${normalized.locations.join(" ")}`);
  const hasLocationDiscussion = statedLocations.length > 0 ||
    normalized.locations.length > 0 ||
    normalized.relocation.open === true ||
    explicitlyRefusesRelocation ||
    Boolean(relocationText) ||
    excludedLocations.size > 0;
  let locationBase;
  let locationSource;
  let locationRule;
  let locationReviewNote = null;
  if (explicitlyRefusesRelocation) {
    if (statedLocations.length || currentLocations.length) {
      locationBase = unique([...statedLocations, ...currentLocations]);
      locationSource = "screening_call";
      locationRule = "location_relocation_refusal";
    } else {
      locationBase = [...PARAAI_LOCATIONS];
      locationSource = "select_all_default";
      locationRule = "select_all_default";
      locationReviewNote = "Relocation refused, but current geography is unknown; all locations selected for review.";
    }
  } else if (openToUSRemote) {
    locationBase = unique([...PARAAI_NA_LOCATIONS, ...currentLocations, ...statedLocations]);
    locationSource = "relocation_expansion";
    locationRule = "location_us_remote_plus_home";
  } else if (internationalOpenness) {
    locationBase = [...PARAAI_LOCATIONS];
    locationSource = "relocation_expansion";
    locationRule = "location_all_21";
  } else if (normalized.relocation.open === true) {
    locationBase = unique([...PARAAI_NA_LOCATIONS, ...statedLocations]);
    locationSource = "relocation_expansion";
    locationRule = "location_na_set";
  } else if (statedLocations.length) {
    locationBase = statedLocations;
    locationSource = "screening_call";
    locationRule = "location_stated";
  } else if (!hasLocationDiscussion && nativeLocations.length) {
    locationBase = nativeLocations;
    locationSource = "paraform_profile";
    locationRule = "location_profile";
  } else {
    locationBase = [...PARAAI_LOCATIONS];
    locationSource = "select_all_default";
    locationRule = "select_all_unknown";
  }
  const locations = unique([...locationBase, ...currentLocations])
    .filter((location) => !excludedLocations.has(location));

  const statedBaseMin = normalized.compensation.baseMin;
  const nativeBaseMin = native?.salary_min != null &&
    native?.salary_min !== "" &&
    Number.isFinite(Number(native.salary_min)) &&
    Number(native.salary_min) >= 0
    ? Number(native.salary_min)
    : null;
  let salarySource;
  let salaryRule;
  let salaryBase;
  if (statedBaseMin != null) {
    salaryBase = statedBaseMin;
    salarySource = "screening_call";
    salaryRule = "salary_stated";
  } else if (nativeBaseMin != null) {
    salaryBase = nativeBaseMin;
    salarySource = "paraform_profile";
    salaryRule = "salary_profile";
  } else {
    salaryBase = PARAAI_SALARY_DEFAULT_MIN;
    salarySource = "default_120k";
    salaryRule = "salary_default_120k";
  }
  const salaryWasWidened = statedBaseMin != null && isHardSalaryFloor(normalized.compensation);
  if (salaryWasWidened) {
    salaryBase = Math.max(0, salaryBase - PARAAI_SALARY_ROUTING_BUFFER);
    salaryRule = "salary_hard_floor_minus_10k";
  }
  const salaryMin = Math.min(salaryBase, PARAAI_SALARY_CAP);
  const salaryWasCapped = salaryBase > PARAAI_SALARY_CAP;

  const candidateOte = normalized.compensation.ote;
  const ote = candidateOte == null ? null : Math.max(candidateOte, salaryMin);

  const explicitVisa = visaFromExtraction(normalized.sponsorship);
  const nativeVisa = uniqueAllowed(
    values(native?.visa),
    VISA_SPONSORSHIP,
    (item) => String(item || ""),
  );
  const workAuthorizationText = `${normalized.sponsorship.kind || ""} ${normalized.sponsorship.statuses.join(" ")}`;
  const hasUSWorkAuthorizationContext = /\b(?:authorized to work|work authori[sz]ation|citizen|green card|permanent resident)\b[^.]{0,45}\b(?:us|u\.?s\.?|united states|america)\b|\b(?:us|u\.?s\.?|united states|american)\b[^.]{0,45}\b(?:work authori[sz]ation|citizen|green card|permanent resident)\b/i
    .test(workAuthorizationText);
  const usBased = isUSGeography(geography.currentLocation, geography.country) || hasUSWorkAuthorizationContext;
  let sponsorship;
  let visaSource;
  let visaRule;
  let sponsorshipReviewReason = null;
  if (explicitVisa.length) {
    sponsorship = explicitVisa;
    visaSource = "screening_call";
    visaRule = "visa_explicit";
  } else if (nativeVisa.length) {
    sponsorship = nativeVisa;
    visaSource = "paraform_profile";
    visaRule = "visa_profile";
  } else if (usBased) {
    sponsorship = ["Not available"];
    visaSource = "visa_default_us";
    visaRule = "visa_default_us";
  } else {
    sponsorship = [];
    visaSource = "unknown_international";
    visaRule = "visa_unknown_international";
    sponsorshipReviewReason = "sponsorship unknown for international candidate";
  }

  const preferences = normalizeParaAIPreferences({
    locations,
    workplaceTypes: workplaces,
    idealFundingRounds: companyStages,
    requiresSponsorship: sponsorship,
    salaryMin,
    ...(ote != null ? { ote } : {}),
  });
  const provenance = {
    workplaceTypes: {
      stated: [...explicitWorkplaces],
      routed: [...preferences.workplaceTypes],
      rule: workplaceRule,
      excluded: [...excludedWorkplaces],
    },
    idealFundingRounds: {
      stated: [...explicitStages],
      routed: [...preferences.idealFundingRounds],
      rule: companyStageRule,
      excluded: [...excludedStages],
    },
    locations: {
      stated: [...statedLocations],
      routed: [...preferences.locations],
      rule: locationRule,
      excluded: [...excludedLocations],
      current: [...currentLocations],
    },
    salaryMin: {
      stated: statedBaseMin,
      routed: preferences.salaryMin,
      rule: salaryRule,
      currency: normalized.compensation.currency,
    },
    requiresSponsorship: {
      stated: [...explicitVisa],
      routed: [...preferences.requiresSponsorship],
      rule: visaRule,
    },
  };
  return {
    preferences,
    policy: {
      preferenceRouting: provenance,
      provenance,
      workplaceSource,
      locationSource,
      locationsExpanded: preferences.locations.length > statedLocations.length,
      locationReviewNote,
      companyStageSource,
      companyStagesExpanded: preferences.idealFundingRounds.length > explicitStages.length,
      candidateStatedBaseMin: statedBaseMin,
      candidateStatedBaseCurrency: normalized.compensation.currency,
      routedSalaryMin: preferences.salaryMin,
      salarySource,
      salaryRoutingBuffer: salaryWasWidened ? PARAAI_SALARY_ROUTING_BUFFER : 0,
      salaryWasWidened,
      salaryWasCapped,
      visaSource,
      sponsorshipReviewReason,
      reviewNotes: [locationReviewNote, sponsorshipReviewReason].filter(Boolean),
    },
  };
}

export function buildPreferences(extracted, native = null, context = {}) {
  return buildPreferenceRouting(extracted, native, context).preferences;
}

export function missingRequiredPreferences(preferences = {}) {
  const normalized = normalizeParaAIPreferences(preferences);
  const missing = [];
  if (!normalized.locations.length) missing.push("locations");
  if (!normalized.workplaceTypes.length) missing.push("workplace types");
  if (!normalized.idealFundingRounds.length) missing.push("company stages");
  if (!Number.isFinite(Number(normalized.salaryMin))) missing.push("minimum base salary");
  if (!normalized.requiresSponsorship.length) missing.push("visa sponsorship");
  if (normalized.ote != null && normalized.ote < normalized.salaryMin) missing.push("OTE (must be at least minimum base salary)");
  return missing;
}

export function matchCountFromResponse(value) {
  if (Array.isArray(value)) return { count: value.length, settled: true };
  if (!value || typeof value !== "object") return { count: null, settled: false };
  const status = String(value.status || value.state || value.generation_status || value.matching_status || "").toUpperCase();
  if (["PENDING", "PROCESSING", "GENERATING", "QUEUED", "RUNNING"].includes(status)) return { count: null, settled: false };
  for (const key of ["matchCount", "match_count", "match_potential_role_count", "totalCount", "total_count"]) {
    if (Number.isFinite(Number(value[key]))) return { count: Math.max(0, Number(value[key])), settled: true };
  }
  for (const key of ["paraai_matches", "matches", "roles", "rankedRoles", "ranked_roles", "items", "results"]) {
    if (Array.isArray(value[key])) return { count: value[key].length, settled: true };
  }
  for (const key of ["data", "candidate", "matching", "result"]) {
    if (value[key] && typeof value[key] === "object") {
      const nested = matchCountFromResponse(value[key]);
      if (nested.count != null || nested.settled) return nested;
    }
  }
  return { count: null, settled: ["COMPLETE", "COMPLETED", "READY", "SETTLED", "SUCCESS"].includes(status) };
}

export const PHASE3_MATCH_READ_PROC =
  "candidateMatching.getRankedRolesForCandidate";

const PHASE3_PENDING_MATCH_STATUSES = new Set([
  "pending",
  "processing",
  "generating",
  "queued",
  "running",
]);
const PHASE3_STATUS_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const PHASE3_STATUS_DIAGNOSTIC =
  /^whitespace:[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

function phase3ObservedStatus(value) {
  if (value == null || value === "") return "missing";
  if (typeof value !== "string") return "unrecognized";
  // The capture is exact. In particular, variants such as "RANKED" or
  // " ranked " must not be normalized into the only settling status.
  if (PHASE3_STATUS_TOKEN.test(value)) return value;
  const trimmed = value.trim();
  if (trimmed !== value && PHASE3_STATUS_TOKEN.test(trimmed)) {
    return `whitespace:${trimmed}`;
  }
  return "unrecognized";
}

function phase3UnsettledMatchResult({
  status,
  statusKind,
  errorCode = null,
} = {}) {
  return Object.freeze({
    status,
    statusKind,
    settled: false,
    count: null,
    roles: Object.freeze([]),
    endorsedRoleIds: Object.freeze([]),
    suggestedRoleIds: Object.freeze([]),
    endorsedCount: 0,
    suggestedCount: 0,
    errorCode,
  });
}

/**
 * Normalize only the captured candidateMatching.getRankedRolesForCandidate
 * response. Unknown status values remain unsettled even when they carry an
 * empty roles array, and score/rank/display fields are ignored by construction.
 */
export function normalizePhase3RankedMatchResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return phase3UnsettledMatchResult({
      status: "missing",
      statusKind: "malformed",
      errorCode: "response_not_object",
    });
  }

  const status = phase3ObservedStatus(value.status);
  if (status !== "ranked") {
    return phase3UnsettledMatchResult({
      status,
      statusKind: PHASE3_PENDING_MATCH_STATUSES.has(status)
        ? "pending"
        : "unknown",
      errorCode: PHASE3_PENDING_MATCH_STATUSES.has(status)
        ? null
        : "status_unrecognized",
    });
  }
  if (!Array.isArray(value.roles)) {
    return phase3UnsettledMatchResult({
      status,
      statusKind: "malformed",
      errorCode: "roles_missing",
    });
  }

  const seenRoleIds = new Set();
  const roles = [];
  const endorsedRoleIds = [];
  const suggestedRoleIds = [];
  for (const role of value.roles) {
    if (!role || typeof role !== "object" || Array.isArray(role)) {
      return phase3UnsettledMatchResult({
        status,
        statusKind: "malformed",
        errorCode: "role_malformed",
      });
    }
    const roleId = typeof role.roleId === "string"
      ? role.roleId.trim()
      : "";
    if (!roleId || roleId.length > 256) {
      return phase3UnsettledMatchResult({
        status,
        statusKind: "malformed",
        errorCode: "role_id_invalid",
      });
    }
    if (seenRoleIds.has(roleId)) {
      return phase3UnsettledMatchResult({
        status,
        statusKind: "malformed",
        errorCode: "role_id_duplicate",
      });
    }
    if (
      typeof role.endorsed !== "boolean"
      || typeof role.suggested !== "boolean"
      || role.endorsed === role.suggested
    ) {
      return phase3UnsettledMatchResult({
        status,
        statusKind: "malformed",
        errorCode: "tier_invalid",
      });
    }

    seenRoleIds.add(roleId);
    const tier = role.endorsed ? "endorsed" : "suggested";
    roles.push(Object.freeze({ roleId, tier }));
    if (tier === "endorsed") endorsedRoleIds.push(roleId);
    else suggestedRoleIds.push(roleId);
  }

  const parsed = matchCountFromResponse(value);
  if (parsed.settled !== true || parsed.count !== roles.length) {
    return phase3UnsettledMatchResult({
      status,
      statusKind: "malformed",
      errorCode: "count_mismatch",
    });
  }
  return Object.freeze({
    status,
    statusKind: "settled",
    settled: true,
    count: parsed.count,
    roles: Object.freeze(roles),
    endorsedRoleIds: Object.freeze(endorsedRoleIds),
    suggestedRoleIds: Object.freeze(suggestedRoleIds),
    endorsedCount: endorsedRoleIds.length,
    suggestedCount: suggestedRoleIds.length,
    errorCode: null,
  });
}

function candidateFromCall(call) {
  const source = call?.candidate || {};
  return {
    fullName: String(source.fullName || source.name || "").trim(),
    firstName: String(source.firstName || "").trim(),
    email: normalizeEmail(source.email),
    linkedin: normLinkedin(source.linkedin),
    phone: String(source.phone || "").trim(),
    scheduledStart: source.scheduledStart || null,
    paraformEventId: source.paraformEventId || null,
  };
}

function persistedCallEndedAt(call, existingValue = null) {
  const existing = Date.parse(String(existingValue || ""));
  if (Number.isFinite(existing)) return new Date(existing).toISOString();
  const explicit = Date.parse(String(call?.endedAt || ""));
  if (Number.isFinite(explicit)) return new Date(explicit).toISOString();
  const joined = Date.parse(String(call?.joinAt || ""));
  const durationSeconds = Number(call?.durationSecs);
  if (Number.isFinite(joined) && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    return new Date(joined + durationSeconds * 1000).toISOString();
  }
  return null;
}

function persistedBookingCreatedAt(
  call,
  {
    existingAt = null,
    existingSource = null,
  } = {},
) {
  const existing = Date.parse(String(existingAt || ""));
  if (Number.isFinite(existing) && String(existingSource || "").trim()) {
    return {
      bookingCreatedAt: new Date(existing).toISOString(),
      bookingCreatedAtSource: String(existingSource).slice(0, 80),
    };
  }
  const candidates = [
    [
      String(call?.bookingCreatedAtSource || "booking_created_at"),
      call?.bookingCreatedAt ?? call?.booking_created_at,
    ],
    ["event_created_at", call?.eventCreatedAt ?? call?.event_created_at],
    ["source_created_at", call?.createdAt ?? call?.created_at],
    [
      "source_created_at",
      call?.source?.createdAt ?? call?.source?.created_at,
    ],
    ["source_created_at", call?.bot?.createdAt ?? call?.bot?.created_at],
  ]
    .map(([source, value]) => [
      String(source || "").replace(/[^a-z0-9_:-]/giu, "_").slice(0, 80),
      Date.parse(String(value || "")),
    ])
    .filter(([source, parsed]) => source && Number.isFinite(parsed))
    .sort((left, right) => left[1] - right[1]);
  if (!candidates.length) {
    return { bookingCreatedAt: null, bookingCreatedAtSource: null };
  }
  return {
    bookingCreatedAt: new Date(candidates[0][1]).toISOString(),
    bookingCreatedAtSource: candidates[0][0],
  };
}

export function scoreSelectedIdentity(candidate, crmItem) {
  const score = scoreIdentity(candidate, crmItem);
  return {
    signals: score.signals,
    ok: score.ok,
  };
}

function callLink(botId) {
  return `${String(process.env.MONITOR_URL || "https://monitor.raydar.xyz").replace(/\/+$/, "")}/c/${botId}`;
}

function newJournal(state, detail = null) {
  const at = new Date().toISOString();
  return [{ state, at, ...(detail ? { detail } : {}) }];
}

function hardProfileReviewReasons({
  submission = {},
  preferences = {},
  payloadConflict = null,
  resumeLinkDisposition = "none",
} = {}) {
  const reasons = [];
  const add = (code, message) => reasons.push({
    code,
    message,
    soft: false,
  });
  if (!String(submission.name || "").trim()) {
    add("candidate_name_missing", "Candidate name is required");
  }
  if (!normalizeEmail(submission.email)) {
    add("candidate_email_missing", "A deliverable candidate email is required");
  }
  if (!normLinkedin(submission.linkedinUrl)) {
    add("candidate_linkedin_missing", "A canonical candidate LinkedIn profile is required");
  }
  if (payloadConflict) {
    add(
      HUMAN_INTRO_PAYLOAD_CONFLICT_CODE,
      HUMAN_INTRO_PAYLOAD_CONFLICT_MESSAGE,
    );
  }
  if (resumeLinkDisposition === "received_review") {
    add(
      HUMAN_INTRO_RESUME_REVIEW_CODE,
      HUMAN_INTRO_RESUME_REVIEW_MESSAGE,
    );
  } else if (resumeLinkDisposition === "ambiguous") {
    add(
      HUMAN_INTRO_RESUME_AMBIGUOUS_CODE,
      HUMAN_INTRO_RESUME_AMBIGUOUS_MESSAGE,
    );
  }
  for (const missing of missingRequiredPreferences(preferences)) {
    add(
      missing === "visa sponsorship"
        ? "sponsorship_unknown"
        : `routing_${missing.replace(/[^a-z0-9]+/giu, "_")}_missing`,
      missing === "visa sponsorship"
        ? "Sponsorship eligibility requires human review"
        : `Required routing is incomplete: ${missing}`,
    );
  }
  return reasons;
}

export function humanProfileReviewDecision(
  readiness = null,
  context = null,
) {
  if (readiness?.profileOnly !== true) {
    return {
      state: "ready_to_submit",
      reviewReason: null,
      reviewReasons: [],
    };
  }
  const softReview = {
    state: "needs_review",
    reviewReason: HUMAN_CALL_SOFT_REVIEW_CODE,
    reviewReasons: [{
      code: HUMAN_CALL_SOFT_REVIEW_CODE,
      message: HUMAN_CALL_SOFT_REVIEW_MESSAGE,
      soft: true,
    }],
  };
  if (!context) return softReview;
  const hardReasons = hardProfileReviewReasons(context);
  const artifactReview = hardReasons.find((reason) => [
    HUMAN_INTRO_RESUME_REVIEW_CODE,
    HUMAN_INTRO_RESUME_AMBIGUOUS_CODE,
  ].includes(reason.code));
  return {
    ...softReview,
    state: artifactReview
      ? "needs_review"
      : String(context?.submission?.resumeUri || "").trim()
      ? "needs_review"
      : "waiting_for_resume",
    reviewReason: artifactReview?.code || softReview.reviewReason,
    reviewReasons: [
      ...softReview.reviewReasons,
      ...hardReasons,
    ],
  };
}

export async function prepareJob({
  botId,
  candidateUserId = "",
  force = false,
  strictReads = false,
  callRecord = null,
} = {}) {
  const id = String(botId || "").trim();
  if (!BOT_ID.test(id)) throw stateError("valid call job id required", "INVALID_BOT_ID");
  const paraformHumanCall = isHumanCallJob(id);
  const humanIntro = isHumanIntroJob(id);
  const humanCall = paraformHumanCall || humanIntro;
  const existing = await getJob(id);
  if (existing && !force && !["error", "needs_identity_review"].includes(existing.state)) return existing;

  const call = callRecord || (
    humanIntro
      ? humanIntroCallFromJob(existing)
      : paraformHumanCall
      ? await fetchHumanCall(callIdFromHumanJob(id))
      : await fetchCall(id)
  );
  const candidate = candidateFromCall(call);
  const callEndedAt = persistedCallEndedAt(call, existing?.callEndedAt);
  const booking = persistedBookingCreatedAt(call, {
    existingAt: existing?.bookingCreatedAt,
    existingSource: existing?.bookingCreatedAtSource,
  });
  const humanReadiness = humanCall ? humanCallReadiness(call) : null;
  const successful = humanCall
    ? humanReadiness.ready
    : isSuccessfulCall(call);
  const humanCallMeta = humanIntro
    ? {
        ...persistedHumanIntroMetadata(call),
        ...(existing?.humanCallMeta?.payloadConflict ? {
          payloadConflict: existing.humanCallMeta.payloadConflict,
        } : {}),
      }
    : paraformHumanCall
      ? persistedHumanCallMetadata(call)
      : null;
  const callTypeFields = {
    humanCall,
    humanIntro,
    callType: humanCall ? "human" : "agent",
    callTypeAt: callEndedAt || call.joinAt || null,
    ...booking,
    ...(humanIntro ? {
      bookingSourceId: humanCallMeta?.sourceId || null,
      resumeLinkDisposition:
        humanCallMeta?.resumeLinkDisposition || "none",
      resumeReceipt: humanCallMeta?.resumeReceipt || null,
    } : {}),
    ...(humanCall ? { humanCallMeta } : {}),
  };
  const callSourceVerified = humanCall
    ? humanCallMeta?.provenanceVerified === true
    : call?.source?.isScreener === true;
  const screeningCallLink = humanCall
    ? String(call?.screeningCallLink || "").trim()
    : callLink(id);
  if (!candidate.fullName || !successful) {
    const base = existing || {
      id, state: "detected", createdAt: new Date().toISOString(), revision: 0,
      journal: newJournal("detected"), candidate, callLink: screeningCallLink,
      callStartedAt: call.joinAt || null,
      callEndedAt,
      callSourceVerified,
      ...callTypeFields,
    };
    if (!existing) await createJob(base);
    const current = existing || await getJob(id);
    return fail(
      current,
      humanCall ? "HUMAN_CALL_NOT_READY" : "NOT_SUCCESSFUL_SCREEN",
      humanCall
        ? humanReadiness?.reason || "Paraform human call is not ready"
        : "Only successful screening calls can enter Para AI",
      {
        successfulCallVerified: false,
      },
    );
  }

  let job;
  if (existing) {
    job = await saveJob(transition(existing, "resolving_identity", {
      candidate, callLink: screeningCallLink, error: null, journalDetail: "manual re-prepare",
      callStartedAt: call.joinAt || existing.callStartedAt || null,
      callEndedAt,
      callSourceVerified,
      successfulCallVerified: true,
      ...callTypeFields,
    }), existing.revision);
  } else {
    job = await createJob({
      id,
      state: "resolving_identity",
      candidate,
      callLink: screeningCallLink,
      callStartedAt: call.joinAt || null,
      callEndedAt,
      callSourceVerified,
      successfulCallVerified: true,
      ...callTypeFields,
      createdAt: new Date().toISOString(),
      journal: [...newJournal("detected"), ...newJournal("resolving_identity")],
    });
  }

  try {
    const linkedCandidateUserId = String(
      candidateUserId || (humanCall ? call?.candidateUserId : "") || "",
    ).trim();
    const manuallySelectedIdentity = Boolean(String(candidateUserId || "").trim());
    let crmItem = linkedCandidateUserId
      ? await findCrmCandidate(linkedCandidateUserId)
      : null;
    let identityScore = linkedCandidateUserId && crmItem
      ? manuallySelectedIdentity
        ? scoreSelectedIdentity(candidate, crmItem)
        : scoreIdentity(candidate, crmItem)
      : null;
    let ambiguous = false;
    if (linkedCandidateUserId && !crmItem) {
      return saveJob(transition(job, "needs_identity_review", {
        identity: {
          candidateUserId: null,
          signals: [],
          ambiguous: false,
          reason: manuallySelectedIdentity
            ? "selected candidate user ID was not found"
            : "linked booking candidate user ID was not found",
        },
        journalDetail: manuallySelectedIdentity
          ? "selected identity not found"
          : "linked booking identity not found",
      }), job.revision);
    }
    if (linkedCandidateUserId && crmItem && !identityScore.ok) {
      return saveJob(transition(job, "needs_identity_review", {
        identity: {
          candidateUserId: null,
          signals: identityScore.signals,
          ambiguous: false,
          reason: manuallySelectedIdentity
            ? "selected Paraform candidate does not match this call"
            : "linked booking candidate does not meet the multi-signal identity bar",
        },
        journalDetail: manuallySelectedIdentity
          ? "selected identity mismatched call"
          : "linked booking identity failed multi-signal verification",
      }), job.revision);
    }
    if (!crmItem) {
      const rows = await scanCrm();
      const resolved = findIdentity(candidate, rows);
      crmItem = resolved.match;
      identityScore = resolved.score;
      ambiguous = resolved.ambiguous;
    }
    if (!crmItem) {
      return saveJob(transition(job, "needs_identity_review", {
        identity: { candidateUserId: null, signals: [], ambiguous, reason: ambiguous ? "multiple strong CRM identities" : "no multi-signal CRM identity" },
        journalDetail: ambiguous ? "ambiguous identity" : "identity not found",
      }), job.revision);
    }

    job = await saveJob(transition(job, "extracting", {
      identity: {
        candidateUserId: crmItem.id,
        candidateId: crmItem.candidate_id || null,
        signals: identityScore?.signals || [],
        ambiguous: false,
        ...(manuallySelectedIdentity ? { humanSelected: true } : {}),
      },
    }), job.revision);

    const extraction = humanReadiness?.profileOnly
      ? {
          extracted: normalizeExtraction({}),
          provider: "paraform_profile_defaults",
          model: null,
          usage: null,
        }
      : await extractPreferences(call.transcript || []);
    const reads = [
      getResume(crmItem.id),
      candidateDetails(crmItem.id, { strict: strictReads }),
      candidatePreferences(crmItem.id, { strict: strictReads }),
      candidateProfileInfo(crmItem.id),
    ];
    const [resume, details, nativePreferences, profileInfo] = await Promise.all(strictReads
      ? reads
      : [
          reads[0].catch(() => null),
          reads[1].catch(() => ({ byId: null, profile: null })),
          reads[2].catch(() => null),
          reads[3].catch(() => null),
        ]);
    if (isArchiveImportCandidate(crmItem, details, profileInfo)) {
      return fail(
        job,
        "ARCHIVE_IMPORT_EXCLUDED",
        "Historical archive imports are excluded from Para AI automation",
      );
    }
    const resumeUri = findResumeUri(resume);
    const contact = resumeUri ? await resumeContact(resumeUri).catch(() => null) : null;
    const email = candidate.email
      || firstEmail(crmItem)
      || firstEmail(details)
      || firstEmail(contact);
    const linkedin = candidate.linkedin || normLinkedin(contact?.linkedinUrl || crmItem?.linkedin_user);
    const extracted = extraction.extracted;
    const routing = buildPreferenceRouting(extracted, nativePreferences, {
      crmItem,
      details,
      profileInfo,
    });
    const routingInput = buildPreferenceRoutingInput(nativePreferences, {
      crmItem,
      details,
      profileInfo,
    });
    const reviewPreferences = routing.preferences;
    const statedBaseMin = extracted.compensation?.baseMin ?? null;
    const submission = {
      name: candidate.fullName || contact?.name || crmItem.name || "",
      email,
      linkedinUrl: linkedin,
      resumeUri,
      resumeStatus: resumeUri ? "on_file" : "missing",
      screeningCallLink,
    };
    const profileReview = humanProfileReviewDecision(humanReadiness, {
      submission,
      preferences: reviewPreferences,
      payloadConflict: humanCallMeta?.payloadConflict || null,
      resumeLinkDisposition:
        humanCallMeta?.resumeLinkDisposition || "none",
    });
    const nextState = profileReview.state;
    const reviewReasons = profileReview.reviewReasons;
    const waitingForResume = nextState === "waiting_for_resume";
    const resumeWait = waitingForResume
      ? resumeWaitPlanFromEnv({
          source: humanIntro ? "calendar_human_intro" : "human_call",
          anchorAt: callEndedAt,
        })
      : null;
    return saveJob(transition(job, nextState, {
      candidate: { ...candidate, fullName: candidate.fullName || contact?.name || crmItem.name },
      identity: { ...job.identity, candidateUserId: crmItem.id, candidateId: crmItem.candidate_id || job.identity?.candidateId || null },
      submission,
      extracted,
      reviewPreferences,
      reviewPolicy: {
        salaryCap: PARAAI_SALARY_CAP,
        candidateStatedBaseMin: statedBaseMin,
        candidateStatedBaseMax: extracted.compensation?.baseMax ?? null,
        preferenceRoutingInput: routingInput,
        ...(humanReadiness?.profileOnly ? {
          humanIntroWithoutTranscript: true,
        } : {}),
        ...routing.policy,
      },
      extraNote: extraNote(extracted, routing.policy.preferenceRouting),
      extraction: { provider: extraction.provider, model: extraction.model, usage: extraction.usage, at: new Date().toISOString() },
      ...(humanReadiness?.profileOnly ? {
        reviewReason: profileReview.reviewReason,
        reviewReasons,
        automation: {
          ...(job.automation || {}),
          status: waitingForResume
            ? "waiting_for_resume"
            : "needs_review",
          reasons: reviewReasons.map((reason) => reason.message),
          evaluatedAt: new Date().toISOString(),
          ...(waitingForResume ? {
            resumeWait,
            resumeWaitSweepEligible: false,
          } : {}),
        },
      } : {}),
      error: null,
      ...(humanReadiness?.profileOnly ? {
        journalDetail: waitingForResume
          ? "profile/default routing prepared; waiting for resume"
          : "profile/default routing prepared for human review",
      } : {}),
    }), job.revision);
  } catch (error) {
    if (error?.job) throw error;
    return fail(job, "PREPARE_FAILED", String(error?.message || error));
  }
}

export async function reroutePreparedJob(job) {
  if (job?.state !== "ready_to_submit") {
    throw stateError("job is not ready for preference rerouting", "INVALID_STATE", job);
  }
  if (!job?.extracted || !job?.identity?.candidateUserId) {
    throw stateError("stored extraction and resolved identity are required for rerouting", "REROUTE_INPUT_REQUIRED", job);
  }
  const candidateUserId = job.identity.candidateUserId;
  const [crmItem, details, nativePreferences, profileInfo] = await Promise.all([
    findCrmCandidate(candidateUserId),
    candidateDetails(candidateUserId, { strict: true }),
    candidatePreferences(candidateUserId, { strict: true }),
    candidateProfileInfo(candidateUserId),
  ]);
  if (!crmItem) {
    throw stateError("candidate identity no longer resolves in CRM", "IDENTITY_STALE", job);
  }
  if (isArchiveImportCandidate(crmItem, details, profileInfo)) {
    return fail(
      job,
      "ARCHIVE_IMPORT_EXCLUDED",
      "Historical archive imports are excluded from Para AI automation",
    );
  }
  const routing = buildPreferenceRouting(job.extracted, nativePreferences, {
    crmItem,
    details,
    profileInfo,
  });
  const routingInput = buildPreferenceRoutingInput(nativePreferences, {
    crmItem,
    details,
    profileInfo,
  });
  return saveJob(transition(job, "ready_to_submit", {
    reviewPreferences: routing.preferences,
    reviewPolicy: {
      ...(job.reviewPolicy || {}),
      salaryCap: PARAAI_SALARY_CAP,
      candidateStatedBaseMin: job.extracted?.compensation?.baseMin ?? null,
      candidateStatedBaseMax: job.extracted?.compensation?.baseMax ?? null,
      preferenceRoutingInput: routingInput,
      ...routing.policy,
    },
    extraNote: extraNote(job.extracted, routing.policy.preferenceRouting),
    automation: {
      ...(job.automation || {}),
      preferenceRerouteRequired: false,
      preferenceRoutedAt: new Date().toISOString(),
    },
    error: null,
    journalDetail: "stored extraction rerouted under the Phase 1 policy",
  }), job.revision);
}

function mergeEdits(job, body = {}) {
  const extracted = normalizeExtraction(body.extracted || job.extracted || {});
  const reviewPreferences = normalizeParaAIPreferences(
    body.preferences || job.reviewPreferences || buildPreferences(extracted),
  );
  return {
    ...job,
    extracted,
    reviewPreferences,
    extraNote: extraNote(extracted, job.reviewPolicy?.preferenceRouting),
    submission: {
      ...(job.submission || {}),
      ...(body.name != null ? { name: String(body.name).trim() } : {}),
      ...(body.email != null ? { email: normalizeEmail(body.email) } : {}),
      ...(body.linkedinUrl != null ? { linkedinUrl: normLinkedin(body.linkedinUrl) } : {}),
      ...(body.resumeUri != null ? { resumeUri: String(body.resumeUri).trim() } : {}),
      ...(body.screeningCallLink != null ? { screeningCallLink: String(body.screeningCallLink).trim() } : {}),
    },
  };
}

async function applyResumeUpload(job, body) {
  if (!body?.resumeBase64) return job;
  const encoded = String(body.resumeBase64).replace(/^data:application\/pdf;base64,/, "");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw stateError("Resume PDF must be between 1 byte and 4 MB", "INVALID_RESUME");
  const fileName = String(body.resumeFileName || `${job.id}.pdf`).replace(/[^A-Za-z0-9._-]/g, "_");
  const uploaded = await uploadResume({ bytes, fileName });
  return {
    ...job,
    submission: {
      ...job.submission,
      resumeUri: uploaded.resumeUri,
      resumeStatus: "uploaded",
      email: job.submission?.email || firstEmail(uploaded.contact),
      linkedinUrl: job.submission?.linkedinUrl || normLinkedin(uploaded.contact?.linkedinUrl),
      name: job.submission?.name || String(uploaded.contact?.name || "").trim(),
    },
  };
}

export async function applyLadderAndSubmit(job, {
  approvalSource = "human_ladder_review",
} = {}, dependencies = {}) {
  const reasons = jobReviewReasons(job);
  const action = reviewActionFor(job, reasons);
  if (!action.allowed) {
    throw stateError(
      "Apply ladder and submit is available only when every review reason is soft and ladder-resolvable",
      "LADDER_ACTION_NOT_ALLOWED",
      job,
    );
  }
  const routedPreferences = normalizeParaAIPreferences(job.reviewPreferences || {});
  const missing = missingRequiredPreferences(routedPreferences);
  if (missing.length) {
    throw stateError(
      `Stored ladder output is incomplete: ${missing.join(", ")}`,
      "LADDER_OUTPUT_INCOMPLETE",
      job,
    );
  }
  const ready = transition(job, "ready_to_submit", {
    reviewPreferences: routedPreferences,
    reviewReason: null,
    reviewReasons: [],
    reviewAction: {
      allowed: false,
      appliedAt: new Date().toISOString(),
      reasons: action.reasons,
    },
    automation: {
      ...(job.automation || {}),
      status: "ladder_approved",
      reasons: [],
      evaluatedAt: new Date().toISOString(),
    },
    journalDetail: "soft review reasons accepted; stored ladder applied",
  });
  return submitJob(ready, {
    confirmation: `SUBMIT ${ready.id}`,
    marketConfirmed: true,
    approvalSource,
  }, dependencies);
}

export function existingTalentNetworkTransition(job, {
  approvalSource = "talent_network_readback",
  checkedAt = new Date().toISOString(),
} = {}) {
  return transition(job, "awaiting_matches", {
    submissionApprovalCheckedAt: checkedAt,
    submitReadbackVerified: true,
    externalWriteMayHaveLanded: false,
    submitApprovalSource: String(approvalSource || "talent_network_readback").slice(0, 80),
    matchLegStartedAt: job.matchLegStartedAt || checkedAt,
    matchCount: null,
    error: null,
    journalDetail: "Talent Network membership already visible; submission write skipped",
  });
}

export async function advanceExistingTalentNetworkJob(job, {
  approvalSource = "talent_network_readback",
  saveAwaitingMatchesImpl = saveJob,
} = {}) {
  if (!["ready_to_submit", "waiting_for_resume"].includes(job?.state)) {
    throw stateError("job is not ready for a pre-claim Talent Network read", "INVALID_STATE", job);
  }
  const candidateUserId = job.identity?.candidateUserId;
  if (!candidateUserId) {
    throw stateError("candidate identity is missing", "IDENTITY_REQUIRED", job);
  }
  const [intent, freshCrm, details, profileInfo] = await Promise.all([
    getSubmissionIntent(candidateUserId),
    findCrmCandidate(candidateUserId),
    candidateDetails(candidateUserId, { strict: true }),
    candidateProfileInfo(candidateUserId),
  ]);
  if (!freshCrm) {
    throw stateError("candidate identity no longer resolves in CRM", "IDENTITY_STALE", job);
  }
  if (isArchiveImportCandidate(freshCrm, details, profileInfo)) {
    return fail(
      job,
      "ARCHIVE_IMPORT_EXCLUDED",
      "Historical archive imports are excluded from Para AI automation",
    );
  }
  if (candidateAlreadySubmitted(freshCrm) || candidateAlreadySubmitted(details)) {
    const checkedAt = new Date().toISOString();
    return saveAwaitingMatchesImpl(existingTalentNetworkTransition(job, {
      approvalSource,
      checkedAt,
    }), job.revision);
  }
  if (intent) {
    throw stateError(
      "A submission is already claimed for this candidate. Wait for read-only Talent Network reconciliation.",
      intent.attemptStartedAt ? "SUBMISSION_ATTEMPT_ALREADY_STARTED" : "SUBMISSION_ALREADY_CLAIMED",
      job,
    );
  }
  return job;
}

async function submissionIsVisible(candidateUserId) {
  const [details, crm] = await Promise.all([
    candidateDetails(candidateUserId, { strict: true }),
    findCrmCandidate(candidateUserId),
  ]);
  return candidateAlreadySubmitted(details) || candidateAlreadySubmitted(crm);
}

export function buildSubmissionPayload(job, config = paraAIConfig()) {
  return {
    name: String(job?.submission?.name || "").trim(),
    email: normalizeEmail(job?.submission?.email),
    linkedinUrl: normLinkedin(job?.submission?.linkedinUrl),
    screeningCallLink: String(job?.submission?.screeningCallLink || "").trim(),
    resumeUri: String(job?.submission?.resumeUri || "").trim(),
    preferences: normalizeParaAIPreferences(job?.reviewPreferences || {}),
    recruiterId: RECRUITER_ID,
    submissionOrigin: config.submissionOrigin,
  };
}

export async function submitJob(
  job,
  body = {},
  {
    saveAwaitingMatchesImpl = saveJob,
  } = {},
) {
  if (!["ready_to_submit", "submit_intent", "submitting"].includes(job?.state)) throw stateError("job is not ready to submit", "INVALID_STATE", job);
  if (String(body.confirmation || "") !== `SUBMIT ${job.id}`) throw stateError("submit confirmation mismatch", "CONFIRMATION_MISMATCH", job);
  if (body.marketConfirmed !== true) throw stateError("Confirm that you screened this candidate and they are actively on the market", "MARKET_CONFIRMATION_REQUIRED", job);
  const config = paraAIConfig();
  if (!config.submitApproved) throw stateError("PARAAI_SUBMIT_APPROVED is false", "SUBMIT_APPROVAL_REQUIRED", job);
  if (config.dryRun) throw stateError("PARAAI_DRY_RUN must be explicitly false", "DRY_RUN", job);
  if (!config.submissionOriginPinned) throw stateError("Phase 0 must pin PARAAI_SUBMISSION_ORIGIN", "PHASE0_ORIGIN_REQUIRED", job);
  if (INTERNAL_NAMES.has(normName(job.candidate?.fullName))) throw stateError("internal-name skip list", "INTERNAL_CANDIDATE", job);

  if (job.state === "ready_to_submit") {
    job = await advanceExistingTalentNetworkJob(job, {
      approvalSource: body.approvalSource || "preclaim_readback",
      saveAwaitingMatchesImpl,
    });
    if (job.state === "awaiting_matches" || job.state === "error") return job;
  }

  let edited = mergeEdits(job, body);
  const preferences = edited.reviewPreferences;
  const missingPreferences = missingRequiredPreferences(preferences);
  if (missingPreferences.length) {
    throw stateError(
      `The screening call did not provide every preference Para AI requires. Add: ${missingPreferences.join(", ")}.`,
      "PREFERENCES_REQUIRED",
      edited,
    );
  }
  edited = await applyResumeUpload(edited, body);
  const submission = edited.submission || {};
  if (!submission.name || !normalizeEmail(submission.email) || !normLinkedin(submission.linkedinUrl) || !submission.resumeUri) {
    throw stateError("name, non-Paraform email, LinkedIn, and resume are required", "SUBMISSION_FIELDS_REQUIRED", edited);
  }
  if (submission.screeningCallLink) {
    try {
      const url = new URL(submission.screeningCallLink);
      if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("invalid protocol");
    } catch {
      throw stateError("screening call link must be a valid http(s) URL", "INVALID_CALL_LINK", edited);
    }
  }
  const candidateUserId = edited.identity?.candidateUserId;
  const freshCrm = await findCrmCandidate(candidateUserId);
  const [details, profileInfo] = await Promise.all([
    candidateDetails(candidateUserId, { strict: true }),
    candidateProfileInfo(candidateUserId),
  ]);
  if (!freshCrm) throw stateError("candidate identity no longer resolves in CRM", "IDENTITY_STALE", job);
  if (isArchiveImportCandidate(freshCrm, details, profileInfo)) {
    return fail(
      job,
      "ARCHIVE_IMPORT_EXCLUDED",
      "Historical archive imports are excluded from Para AI automation",
    );
  }
  if (hasFutureScheduledStep(details)) return fail(job, "FUTURE_NEXT_STEP", "Candidate has a future scheduled next step");
  const membership = await targetMembership(candidateUserId);
  if (membership.memberships.some(({ lead }) => lead?.has_replied)) return fail(job, "HAS_REPLIED", "Candidate has replied in a target sequence");
  if (membership.memberships.length) return fail(job, "ALREADY_ENROLLED", `Candidate already belongs to ${membership.memberships[0].sequence.name}`);
  const quota = await directSubmitQuota(RECRUITER_ID);
  if (quota?.isAtLimit === true) {
    throw stateError(`Paraform direct-submit quota reached (${quota.used}/${quota.limit}). ${quota.resetLabel || ""}`.trim(), "DIRECT_SUBMIT_QUOTA_REACHED", edited);
  }

  const payload = buildSubmissionPayload({
    ...edited,
    submission: { ...submission, email: normalizeEmail(submission.email), linkedinUrl: normLinkedin(submission.linkedinUrl) },
  }, config);
  const payloadHash = hashSubmissionPayload(payload);
  const intentResult = await claimSubmissionIntent({
    candidateUserId,
    jobId: job.id,
    payloadHash,
  });
  let intent = intentResult.intent;
  if (intent.attemptStartedAt) {
    throw stateError(
      "A submission attempt already started for this candidate. Reconcile read-only; never retry the write.",
      "SUBMISSION_ATTEMPT_ALREADY_STARTED",
      job,
    );
  }
  if (job.state === "ready_to_submit") {
    edited = await saveJob(transition(edited, "submit_intent", {
      submission: { ...submission, email: payload.email, linkedinUrl: payload.linkedinUrl },
      submitClaimedAt: intent.claimedAt,
      submitAttemptId: intent.attemptId,
      submitPayloadHash: payloadHash,
      submitApprovalSource: String(body.approvalSource || "human_review").slice(0, 80),
      journalDetail: "durable candidate submission intent claimed",
    }), job.revision);
  } else {
    if (job.submitPayloadHash && job.submitPayloadHash !== payloadHash) {
      throw stateError("submission payload changed after intent was claimed", "SUBMISSION_PAYLOAD_CHANGED", job);
    }
    edited = job;
  }
  edited = await saveJob(transition(edited, "submitting", {
    journalDetail: "single external submit attempt reserved",
  }), edited.revision);
  const started = await startSubmissionAttempt({
    candidateUserId,
    jobId: job.id,
    attemptId: intent.attemptId,
  });
  if (started.status !== "started") {
    throw stateError(
      "A submission attempt already started for this candidate. Reconcile read-only; never retry the write.",
      "SUBMISSION_ATTEMPT_ALREADY_STARTED",
      edited,
    );
  }
  intent = started.intent;
  let response;
  try {
    response = await trpcPost("agency.submitTalentNetworkCandidate", payload, 1);
  } catch (error) {
    await finishSubmissionAttempt({
      candidateUserId,
      jobId: job.id,
      attemptId: intent.attemptId,
      outcome: "unknown",
      detail: String(error?.code || error?.message || "submit transport failed"),
    }).catch(() => {});
    const saved = await saveJob(transition(edited, "submission_unknown", {
      error: {
        code: "SUBMIT_WRITE_UNKNOWN",
        detail: "Paraform submission result is unknown; reads only until reconciled",
        at: new Date().toISOString(),
      },
      externalWriteMayHaveLanded: true,
      submitAttemptStartedAt: intent.attemptStartedAt,
      journalDetail: "external submit result unknown; mutation retry prohibited",
    }), edited.revision);
    throw stateError("Submission result is unknown. Reconcile read-only; do not retry.", "SUBMIT_WRITE_UNKNOWN", saved);
  }
  await finishSubmissionAttempt({
    candidateUserId,
    jobId: job.id,
    attemptId: intent.attemptId,
    outcome: "accepted",
    detail: "Paraform mutation returned successfully",
  });
  return saveJob(transition(edited, "awaiting_approval", {
    submittedAt: new Date().toISOString(),
    submitAcceptedAt: new Date().toISOString(),
    submitAttemptStartedAt: intent.attemptStartedAt,
    submitReadbackVerified: candidateAlreadySubmitted(response),
    externalWriteMayHaveLanded: false,
    matchCount: null,
    error: null,
    journalDetail: "Paraform accepted submission; approval pending",
  }), edited.revision);
}

export async function reconcileSubmittedJob(
  job,
  {
    saveAwaitingMatchesImpl = saveJob,
    savePendingImpl = saveJob,
    submissionIsVisibleImpl = submissionIsVisible,
    getSubmissionIntentImpl = getSubmissionIntent,
    finishSubmissionAttemptImpl = finishSubmissionAttempt,
  } = {},
) {
  const legacyAccepted = job?.state === "error" && job?.error?.code === "SUBMIT_NOT_VISIBLE";
  const uncertainWrite =
    job?.state === "submission_unknown" ||
    job?.state === "submitting" ||
    (job?.state === "error" && ["SUBMIT_WRITE_FAILED", "SUBMIT_WRITE_UNKNOWN"].includes(job?.error?.code));
  if (job?.state !== "awaiting_approval" && !legacyAccepted && !uncertainWrite) {
    throw stateError("job is not awaiting submission reconciliation", "INVALID_STATE", job);
  }
  const candidateUserId = job.identity?.candidateUserId;
  if (!candidateUserId) throw stateError("candidate identity is missing", "IDENTITY_REQUIRED", job);
  const checkedAt = new Date().toISOString();
  const visible = await submissionIsVisibleImpl(candidateUserId);
  if (visible) {
    const intent = await getSubmissionIntentImpl(candidateUserId).catch(() => null);
    if (intent?.attemptId && intent?.jobId === job.id) {
      await finishSubmissionAttemptImpl({
        candidateUserId,
        jobId: job.id,
        attemptId: intent.attemptId,
        outcome: "confirmed",
        detail: "Talent Network state visible on read-back",
      }).catch(() => {});
    }
    return saveAwaitingMatchesImpl(transition(job, "awaiting_matches", {
      submittedAt: job.submittedAt || job.submitClaimedAt || checkedAt,
      submitAcceptedAt: job.submitAcceptedAt || checkedAt,
      submissionApprovalCheckedAt: checkedAt,
      submitReadbackVerified: true,
      externalWriteMayHaveLanded: false,
      matchLegStartedAt: job.matchLegStartedAt || checkedAt,
      matchCount: null,
      automation: clearVerifiedSubmissionFailures(job),
      error: null,
      journalDetail: "Paraform submission verified",
    }), job.revision);
  }
  if (uncertainWrite) {
    return savePendingImpl(transition(job, "submission_unknown", {
      submissionApprovalCheckedAt: checkedAt,
      submitReadbackVerified: false,
      externalWriteMayHaveLanded: true,
      error: {
        code: "SUBMIT_STILL_UNCONFIRMED",
        detail: "Submission is not visible yet; reads only and no mutation retry",
        at: checkedAt,
      },
      journalDetail: "uncertain submit remains unconfirmed; read-only retry scheduled",
    }), job.revision);
  }
  return savePendingImpl(transition(job, "awaiting_approval", {
    submittedAt: job.submittedAt || job.submitClaimedAt || checkedAt,
    submitAcceptedAt: job.submitAcceptedAt || job.submitClaimedAt || checkedAt,
    submissionApprovalCheckedAt: checkedAt,
    submitReadbackVerified: false,
    externalWriteMayHaveLanded: false,
    error: null,
    journalDetail: "Paraform approval still pending",
  }), job.revision);
}

const VERIFIED_SUBMISSION_FAILURE_CODES = new Set([
  "SUBMIT_NOT_VISIBLE",
  "SUBMIT_STILL_UNCONFIRMED",
  "SUBMIT_WRITE_FAILED",
  "SUBMIT_WRITE_UNKNOWN",
]);

const VERIFIED_SUBMISSION_FAILURE_STEPS = new Set([
  "submit",
  "submit_reconciliation",
]);

export function isVerifiedSubmissionFailure(
  failure,
  {
    defaultStep = "",
  } = {},
) {
  return Boolean(
    failure
    && VERIFIED_SUBMISSION_FAILURE_STEPS.has(
      String(failure.step || defaultStep),
    )
    && VERIFIED_SUBMISSION_FAILURE_CODES.has(String(failure.code || "")),
  );
}

export function clearVerifiedSubmissionFailures(job) {
  const automation = job?.automation || {};
  const stepFailures = Object.fromEntries(
    Object.entries(automation.stepFailures || {})
      .filter(([step, failure]) => !isVerifiedSubmissionFailure({
        ...failure,
        step,
      })),
  );
  return {
    ...automation,
    stepFailures,
    lastFailure: isVerifiedSubmissionFailure(automation.lastFailure)
      ? null
      : automation.lastFailure,
  };
}

// candidateMatching.getRankedRolesForCandidate takes the DOMAIN candidate id
// (capture §1, which also records that the two ids genuinely differ for most
// candidates). The candidate-user id is a different subject.
//
// §1 originally judged the old `candidateId || candidateUserId` fallback
// "correct-by-preference"; this supersedes that. The wrong-subject response
// shape has NOT been observed for this procedure — what is captured is that
// the sibling curated read answers null for the wrong id (§18). Reading a
// different person is unsafe whatever it returns, and if it were to answer
// `ranked` with no roles that would settle as a real zero and, once
// enrollment is approved, send a No Matches email that dedup makes permanent.
// So there is no fallback: a missing candidate id fails closed on the
// IDENTITY_REQUIRED check below.
//
// Note the same key name means the OTHER subject elsewhere:
// curatedRoleList.getCandidateCuratedRoleList({candidate_id}) wants the
// candidate-USER id — capture §6 and §18
// (docs/PARAAI-CAPTURE-2026-07-26.md in the main Raydar repo).
function matchReadInput(job) {
  return {
    candidate_id: job.identity?.candidateId,
    recruiter_user_id: RECRUITER_ID,
  };
}

function phase3ScopeDigest(job) {
  return hashSubmissionPayload({
    kind: "phase3-shadow",
    jobId: String(job.id || ""),
    matchLegStartedAt: String(job.matchLegStartedAt || ""),
  });
}

function phase3ExistingWriteCounter(shadow, field) {
  return (
    shadow
    && typeof shadow === "object"
    && Object.hasOwn(shadow, field)
  )
    ? shadow[field]
    : 0;
}

function phase3StatusHistory(job, status) {
  const prior = Array.isArray(job?.phase3Shadow?.observedStatuses)
    ? job.phase3Shadow.observedStatuses
    : [];
  const statuses = [...new Set([
    ...prior.filter((value) => (
      typeof value === "string"
      && (
        PHASE3_STATUS_TOKEN.test(value)
        || PHASE3_STATUS_DIAGNOSTIC.test(value)
        || ["missing", "unrecognized"].includes(value)
      )
    )),
    status,
  ])];
  return {
    values: statuses.slice(-64),
    overflow: statuses.length > 64,
  };
}

const PHASE3_EVIDENCE_TOKEN = /^[a-z][a-z0-9_]{0,79}$/u;
const PHASE3_PROOF_DIGEST = /^[a-f0-9]{40}$/u;
const PHASE3_NO_MATCH_SEQUENCE_ID = "cmqpje4lh00040cki15nuuqc8";

function phase3EvidenceHistory(job, field, value, validator) {
  const prior = Array.isArray(job?.phase3Shadow?.[field])
    ? job.phase3Shadow[field]
    : [];
  const values = [...new Set([
    ...prior.filter((entry) => (
      typeof entry === "string" && validator(entry)
    )),
    ...(typeof value === "string" && validator(value) ? [value] : []),
  ])];
  return {
    values: values.slice(-64),
    overflow: values.length > 64,
  };
}

function phase3CompleteCallSnapshot(value) {
  const observedAt = String(value?.storeObservedAt || "");
  const observedAtMs = Date.parse(observedAt);
  const proofUpdatedAt = String(value?.proofUpdatedAt || "");
  const proofUpdatedAtMs = Date.parse(proofUpdatedAt);
  const calls = Array.isArray(value?.calls) ? value.calls : null;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== 1
    || value.source !== "candidate_success_index_v1"
    || value.authoritative !== true
    || value.complete !== true
    || value.bootstrapComplete !== true
    || !Number.isInteger(value.proofVersion)
    || value.proofVersion < 1
    || !PHASE3_PROOF_DIGEST.test(
      String(value.proofSemanticDigest || ""),
    )
    || !PHASE3_PROOF_DIGEST.test(
      String(value.bootstrapGenerationDigest || ""),
    )
    || !Number.isFinite(proofUpdatedAtMs)
    || new Date(proofUpdatedAtMs).toISOString() !== proofUpdatedAt
    || typeof value.conflict !== "boolean"
    || !Number.isFinite(observedAtMs)
    || new Date(observedAtMs).toISOString() !== observedAt
    || !calls
    || calls.length < 1
    || calls.length > 2
    || value.conflict !== (calls.length > 1)
    || calls.some((call) => (
      !call
      || typeof call !== "object"
      || Array.isArray(call)
      || call.successful !== true
      || typeof call.humanCall !== "boolean"
      || call.provenanceVerified !== true
      || !Number.isFinite(Date.parse(String(call.endedAt || "")))
      || new Date(Date.parse(String(call.endedAt))).toISOString()
        !== call.endedAt
      || Date.parse(call.endedAt) > observedAtMs
    ))
    || (
      calls.length === 2
      && (
        calls[0].humanCall === calls[1].humanCall
        || calls[0].endedAt !== calls[1].endedAt
      )
    )
  ) {
    return null;
  }
  return value;
}

function phase3SettledZeroBaseline(job) {
  const shadow = job?.phase3Shadow;
  const audit = shadow?.audit;
  const routing = shadow?.intendedRouting;
  const baselineObservedAt = String(
    shadow?.zeroBaselineObservedAt || "",
  );
  const baselineMs = Date.parse(baselineObservedAt);
  const anchorMs = Date.parse(String(job?.matchLegStartedAt || ""));
  if (
    !Number.isFinite(baselineMs)
    || !Number.isFinite(anchorMs)
    || baselineMs < anchorMs
    || audit?.aggregateOnly !== true
    || audit?.observedAt !== baselineObservedAt
    || audit?.match?.decision !== "zero_settled"
    || audit?.match?.matchCount !== 0
    || audit?.match?.settled !== true
    || audit?.match?.timedOut !== false
    || audit?.curation?.targetCount !== 0
    || audit?.curation?.postAddMatchCount !== 0
    || audit?.curation?.postAddMatchCountSource !== "projected"
    || audit?.gates?.allowShadowAudit !== true
    || audit?.gates?.allowCuratedWrite !== false
    || audit?.gates?.allowEnrollment !== false
    || audit?.gates?.candidateFacingWritesAllowed !== false
    || audit?.lateMatch?.allowSecondEnrollment !== false
    || audit?.targetSequenceId !== PHASE3_NO_MATCH_SEQUENCE_ID
    || routing?.targetSequenceId !== PHASE3_NO_MATCH_SEQUENCE_ID
    || routing?.matchCount !== 0
  ) {
    return null;
  }
  return {
    observedAt: baselineObservedAt,
    audit,
    intendedRouting: routing,
  };
}

function phase3ProjectedShadowAudit({
  job,
  observedAt,
  normalized,
  settlement,
  callSnapshot,
  zeroBaseline = null,
} = {}) {
  const scopeDigest = phase3ScopeDigest(job);
  const curationPlan = planCuratedAdds({
    scopeDigest,
    recommendedRoleIds: normalized.endorsedRoleIds,
    possibleRoleIds: normalized.suggestedRoleIds,
    curatedRoleIds: [],
  });
  const postAddReadback = curatedPostAddMatchCount({
    scopeDigest,
    source: "projected",
    curatedRecommendedRoleIds: normalized.endorsedRoleIds,
    curatedPossibleRoleIds: normalized.suggestedRoleIds,
  });
  const callDecision = mostRecentSuccessfulCallDecision({
    scopeDigest,
    snapshotObservedAt: observedAt,
    authoritative: callSnapshot.authoritative,
    complete: callSnapshot.complete,
    calls: callSnapshot.calls,
  });
  const membership = outcomeMembershipDecision({
    scopeDigest,
    authoritative: false,
    complete: false,
    expectedTargetSequenceCount: ALL_OUTCOME_SEQUENCE_IDS.length,
    scannedTargetSequenceCount: 0,
    scannedTargetSequenceIds: [],
    memberships: [],
  });
  const noMatchesEnrollmentRecorded = Boolean(
    zeroBaseline
    || (
      job.enrolledAt
      && job.targetSequenceId === PHASE3_NO_MATCH_SEQUENCE_ID
    ),
  );
  const lateMatch = lateMatchDecision({
    scopeDigest,
    noMatchesEnrollmentRecorded,
    recommendedRoleIds: normalized.endorsedRoleIds,
    possibleRoleIds: normalized.suggestedRoleIds,
    curatedRoleIds: [],
    existingReviewNoteCodes: [],
  });
  return buildAggregateShadowAudit({
    scopeDigest,
    observedAt,
    matchStageEnabled: true,
    matchShadow: true,
    curateEnabled: false,
    enrollApproved: false,
    sequenceHealth: null,
    settlement,
    curationPlan,
    callDecision,
    postAddReadback,
    membership,
    reconciliation: null,
    lateMatch,
  });
}

function phase3NextPoll(job, settlement, observedAt) {
  if (["matches_settled", "timeout"].includes(settlement.decision)) {
    return {
      nextPollAt: null,
      lateMatchMode: false,
      complete: true,
    };
  }
  const lateMatchMode = Boolean(
    settlement.useLateMatchCadence
    || job?.phase3Shadow?.lateMatchMode === true,
  );
  const next = nextMatchPollDecision({
    matchLegStartedAt: job.matchLegStartedAt,
    afterAt: observedAt,
    lateMatchMode,
  });
  return {
    nextPollAt: next.dueAt,
    lateMatchMode,
    complete: next.complete,
  };
}

export async function refreshMatches(
  job,
  {
    config = paraAIConfig(),
    now = Date.now,
    trpcGetImpl = trpcGet,
    saveJobImpl = saveJob,
    saveDecisionImpl = savePhase3ShadowDecision,
    callSnapshot = null,
    callSnapshotImpl = null,
  } = {},
) {
  if (job?.state !== "awaiting_matches") {
    throw stateError("job is not awaiting matches", "INVALID_STATE", job);
  }
  if (
    config.matchReadPinned !== true
    || config.matchReadProc !== PHASE3_MATCH_READ_PROC
  ) {
    throw stateError(
      "PARAAI_MATCH_READ_PROC is not pinned to the captured procedure",
      "PHASE3_MATCH_READ_REQUIRED",
      job,
    );
  }
  if (config.matchStageEnabled !== true || config.matchShadow !== true) {
    throw stateError(
      "Phase 3 match shadow is not enabled",
      "PHASE3_SHADOW_REQUIRED",
      job,
    );
  }
  if (config.curateEnabled !== false || config.enrollApproved !== false) {
    throw stateError(
      "Phase 3 shadow requires curation and enrollment gates to remain false",
      "PHASE3_SHADOW_WRITE_GATES_OPEN",
      job,
    );
  }

  const readStartedMs = Number(
    typeof now === "function" ? now() : now,
  );
  const anchorMs = Date.parse(String(job.matchLegStartedAt || ""));
  if (
    !Number.isFinite(readStartedMs)
    || !Number.isFinite(anchorMs)
    || anchorMs > readStartedMs
  ) {
    throw stateError(
      "a current match-leg anchor is required",
      "MATCH_LEG_ANCHOR_REQUIRED",
      job,
    );
  }
  const input = matchReadInput(job);
  if (!String(input.candidate_id || "").trim()) {
    // identity.candidateId is nullable at its source (`crmItem.candidate_id ||
    // null`), so this is structurally reachable; the capture observed every
    // live subject resolving, so it has not been seen in practice. It is a
    // terminal identity condition, not a transient fault: no retry can invent
    // the domain candidate id, and IDENTITY_REQUIRED is classified neither
    // retryable nor terminal, so throwing here would leave the job parked in
    // awaiting_matches with a past-due poll and no route out. This introduces
    // a NEW review reason for unresolved identity; the shadow schedule is
    // closed inside phase3Shadow, which is the only place production reads it.
    return saveJobImpl(transition(job, "needs_review", {
      reviewReason: "phase3_domain_candidate_id_missing",
      error: {
        code: "IDENTITY_REQUIRED",
        detail:
          "the domain candidate id is required for the match read",
        at: new Date(readStartedMs).toISOString(),
      },
      phase3Shadow: {
        ...(job.phase3Shadow || {}),
        policyVersion: PHASE3_SHADOW_POLICY_VERSION,
        // A completed shadow record with no audit evidence is read as a
        // write-fence breach unless it is marked a technical failure, so
        // omitting these would page the operator with policy_mismatch — "the
        // shadow wrote something it must not" — when the real condition is one
        // candidate with no domain id and zero writes attempted. The write
        // counters are carried forward explicitly rather than relying on the
        // spread, matching every other writer of this record.
        technicalFailure: true,
        technicalFailureCode: "IDENTITY_REQUIRED",
        complete: true,
        nextPollAt: null,
        policyMismatch:
          job?.phase3Shadow?.policyMismatch === true,
        candidateFacingWrites: phase3ExistingWriteCounter(
          job?.phase3Shadow,
          "candidateFacingWrites",
        ),
        curationWrites: phase3ExistingWriteCounter(
          job?.phase3Shadow,
          "curationWrites",
        ),
        enrollments: phase3ExistingWriteCounter(
          job?.phase3Shadow,
          "enrollments",
        ),
      },
      journalDetail:
        "Phase 3 match read requires the domain candidate id",
    }), job.revision);
  }

  const resolveCompleteCallSnapshot = async (stage) => {
    let resolved = callSnapshot;
    if (typeof callSnapshotImpl === "function") {
      try {
        resolved = await callSnapshotImpl(job, { stage });
      } catch (cause) {
        const error = stateError(
          "a complete same-candidate successful-call proof is required",
          "PHASE3_CALL_SNAPSHOT_REQUIRED",
          job,
        );
        error.cause = cause;
        throw error;
      }
    }
    const complete = phase3CompleteCallSnapshot(resolved);
    if (!complete) {
      throw stateError(
        "a complete same-candidate successful-call proof is required",
        "PHASE3_CALL_SNAPSHOT_REQUIRED",
        job,
      );
    }
    return complete;
  };
  const persistCallProofConflict = (
    proof,
    {
      rankedReadObserved = false,
    } = {},
  ) => {
    const statusHistory = rankedReadObserved
      ? phase3StatusHistory(job, "ranked")
      : null;
    const statusKindHistory = rankedReadObserved
      ? phase3EvidenceHistory(
          job,
          "observedStatusKinds",
          "settled",
          (value) => [
            "settled",
            "pending",
            "unknown",
            "malformed",
          ].includes(value),
        )
      : null;
    return saveJobImpl(transition(job, "needs_review", {
      ...(rankedReadObserved ? {
        matchCheckedAt: proof.storeObservedAt,
      } : {}),
      reviewReason: "phase3_call_proof_conflict",
      error: {
        code: "PHASE3_CALL_PROOF_CONFLICT",
        detail: "equal-time successful call types require review",
        at: proof.storeObservedAt,
      },
      phase3Shadow: {
        ...(job.phase3Shadow || {}),
        policyVersion: PHASE3_SHADOW_POLICY_VERSION,
        ...(rankedReadObserved ? {
          observedAt: proof.storeObservedAt,
          observedStatus: "ranked",
          observedStatuses: statusHistory.values,
          observedStatusOverflow: (
            job?.phase3Shadow?.observedStatusOverflow === true
            || statusHistory.overflow
          ),
          observedStatusKinds: statusKindHistory.values,
          observedStatusKindOverflow: (
            job?.phase3Shadow?.observedStatusKindOverflow === true
            || statusKindHistory.overflow
          ),
          statusKind: "settled",
          responseErrorCode: null,
          readCount: Math.max(
            0,
            Number(job?.phase3Shadow?.readCount) || 0,
          ) + 1,
        } : {}),
        callProofCheckedAt: proof.storeObservedAt,
        callProofConflict: true,
        technicalFailure: true,
        technicalFailureCode: "PHASE3_CALL_PROOF_CONFLICT",
        complete: true,
        nextPollAt: null,
        policyMismatch:
          job?.phase3Shadow?.policyMismatch === true,
        candidateFacingWrites: phase3ExistingWriteCounter(
          job?.phase3Shadow,
          "candidateFacingWrites",
        ),
        curationWrites: phase3ExistingWriteCounter(
          job?.phase3Shadow,
          "curationWrites",
        ),
        enrollments: phase3ExistingWriteCounter(
          job?.phase3Shadow,
          "enrollments",
        ),
      },
      journalDetail:
        "Phase 3 successful-call proof conflict requires review",
    }), job.revision);
  };

  // Prove candidate scope before spending a vendor read. A settling response
  // gets a second proof observation after the read so Q37 and the settlement
  // share one store-owned observation boundary.
  const preflightCallSnapshot = await resolveCompleteCallSnapshot(
    "preflight",
  );
  if (preflightCallSnapshot.conflict === true) {
    return persistCallProofConflict(preflightCallSnapshot);
  }
  const response = await trpcGetImpl(config.matchReadProc, input);
  const normalized = normalizePhase3RankedMatchResponse(response);
  const completeCallSnapshot = normalized.settled
    ? await resolveCompleteCallSnapshot("settlement")
    : preflightCallSnapshot;
  if (
    normalized.settled
    && completeCallSnapshot.conflict === true
  ) {
    return persistCallProofConflict(completeCallSnapshot, {
      rankedReadObserved: true,
    });
  }
  const proofObservedAt = String(
    completeCallSnapshot.storeObservedAt || "",
  );
  const proofObservedMs = Date.parse(proofObservedAt);
  const localObservedMs = Number(
    typeof now === "function" ? now() : now,
  );
  const observedMs = normalized.settled
    ? proofObservedMs
    : localObservedMs;
  if (!Number.isFinite(observedMs) || observedMs < anchorMs) {
    throw stateError(
      "the call proof observation timestamp is invalid",
      "PHASE3_CALL_SNAPSHOT_REQUIRED",
      job,
    );
  }
  const observedAt = new Date(observedMs).toISOString();
  const observedSettlement = matchSettlementDecision({
    scopeDigest: phase3ScopeDigest(job),
    matchLegStartedAt: job.matchLegStartedAt,
    observedAt,
    matchCount: normalized.settled ? normalized.count : null,
  });
  const zeroBaseline = phase3SettledZeroBaseline(job);
  const positiveMatch = normalized.settled && normalized.count >= 1;
  const preserveZeroBaseline = Boolean(zeroBaseline && !positiveMatch);
  const settlement = preserveZeroBaseline
    ? Object.freeze({
        ...observedSettlement,
        decision: "zero_settled",
        matchCount: 0,
        settled: true,
        timedOut: false,
        useLateMatchCadence: true,
      })
    : observedSettlement;
  const audit = preserveZeroBaseline
    ? zeroBaseline.audit
    : settlement.settled
      ? phase3ProjectedShadowAudit({
        job,
        observedAt,
        normalized,
        settlement,
        callSnapshot: completeCallSnapshot,
        zeroBaseline,
      })
      : null;
  const poll = phase3NextPoll(job, settlement, observedAt);
  const statusHistory = phase3StatusHistory(job, normalized.status);
  const statusKindHistory = phase3EvidenceHistory(
    job,
    "observedStatusKinds",
    normalized.statusKind,
    (value) => [
      "settled",
      "pending",
      "unknown",
      "malformed",
    ].includes(value),
  );
  const responseErrorHistory = phase3EvidenceHistory(
    job,
    "observedResponseErrors",
    normalized.errorCode,
    (value) => PHASE3_EVIDENCE_TOKEN.test(value),
  );
  const policyMismatch = Boolean(
    job?.phase3Shadow?.policyMismatch === true
    ||
    normalized.statusKind === "malformed"
    || (
      audit
      && (
        audit.gates.allowShadowAudit !== true
        || audit.gates.allowCuratedWrite !== false
        || audit.gates.allowEnrollment !== false
        || audit.gates.candidateFacingWritesAllowed !== false
        || audit.gates.settlementCurationBound !== true
      )
    )
  );
  const projectedRouting = audit
    ? {
        targetSequenceId: audit.targetSequenceId,
        matchCount: audit.curation.postAddMatchCount,
        endorsedCount: normalized.endorsedCount,
        suggestedCount: normalized.suggestedCount,
        intendedCuratedAddCount: audit.curation.intendedAddCount,
        postAddMatchCountSource: audit.curation.postAddMatchCountSource,
        enrollmentAction: "projected",
        lateMatchReview: false,
        reviewNoteCode: null,
        allowSecondEnrollment: false,
      }
    : null;
  const lateMatchDetected = Boolean(
    zeroBaseline && audit?.lateMatch?.detected === true,
  );
  const intendedRouting = preserveZeroBaseline
    ? zeroBaseline.intendedRouting
    : lateMatchDetected
      ? {
          ...projectedRouting,
          enrollmentAction: "none",
          lateMatchReview: true,
          reviewNoteCode: audit.lateMatch.reviewNoteCode,
          allowSecondEnrollment: false,
        }
      : projectedRouting;
  const timedOut = settlement.decision === "timeout";
  const state = timedOut ? "needs_review" : "awaiting_matches";
  const endorsedCount = preserveZeroBaseline
    ? 0
    : normalized.endorsedCount;
  const suggestedCount = preserveZeroBaseline
    ? 0
    : normalized.suggestedCount;
  const matchCount = preserveZeroBaseline
    ? 0
    : normalized.settled
      ? normalized.count
      : null;
  const zeroBaselineObservedAt = zeroBaseline?.observedAt || (
    audit?.match?.decision === "zero_settled"
      ? audit.observedAt
      : null
  );
  const phase3Shadow = {
    ...(job.phase3Shadow || {}),
    policyVersion: PHASE3_SHADOW_POLICY_VERSION,
    observedAt,
    observedStatus: normalized.status,
    observedStatuses: statusHistory.values,
    observedStatusOverflow: (
      job?.phase3Shadow?.observedStatusOverflow === true
      || statusHistory.overflow
    ),
    observedStatusKinds: statusKindHistory.values,
    observedStatusKindOverflow: (
      job?.phase3Shadow?.observedStatusKindOverflow === true
      || statusKindHistory.overflow
    ),
    observedResponseErrors: responseErrorHistory.values,
    observedResponseErrorOverflow: (
      job?.phase3Shadow?.observedResponseErrorOverflow === true
      || responseErrorHistory.overflow
    ),
    unknownStatusObserved: (
      job?.phase3Shadow?.unknownStatusObserved === true
      || normalized.statusKind === "unknown"
    ),
    malformedStatusObserved: (
      job?.phase3Shadow?.malformedStatusObserved === true
      || normalized.statusKind === "malformed"
    ),
    statusKind: normalized.statusKind,
    responseErrorCode: normalized.errorCode,
    readCount: Math.max(
      0,
      Number(job?.phase3Shadow?.readCount) || 0,
    ) + 1,
    endorsedCount,
    suggestedCount,
    matchCount,
    settlementDecision: settlement.decision,
    nextPollAt: poll.nextPollAt,
    lateMatchMode: poll.lateMatchMode,
    complete: poll.complete,
    policyMismatch,
    audit,
    intendedRouting,
    candidateFacingWrites: phase3ExistingWriteCounter(
      job?.phase3Shadow,
      "candidateFacingWrites",
    ),
    curationWrites: phase3ExistingWriteCounter(
      job?.phase3Shadow,
      "curationWrites",
    ),
    enrollments: phase3ExistingWriteCounter(
      job?.phase3Shadow,
      "enrollments",
    ),
    zeroBaselineObservedAt,
    lateMatchDetected,
    enrollmentAction: lateMatchDetected ? "none" : "projected",
    lateMatchReview: lateMatchDetected,
    reviewNoteCode: lateMatchDetected
      ? audit?.lateMatch?.reviewNoteCode || null
      : null,
    allowSecondEnrollment: false,
  };
  const next = transition(job, state, {
    matchCount,
    matchCheckedAt: observedAt,
    phase3Shadow,
    ...(timedOut ? {
      reviewReason: "matches_pending_timeout",
      error: {
        code: "MATCHES_PENDING_TIMEOUT",
        detail: "match generation never settled",
        at: observedAt,
      },
    } : {
      reviewReason: null,
      error: null,
    }),
    journalDetail: timedOut
      ? "Phase 3 shadow match generation timed out"
      : lateMatchDetected
        ? "Phase 3 late-match review recorded; second enrollment prohibited"
      : audit
        ? "Phase 3 aggregate shadow audit recorded"
        : "Phase 3 shadow match read remains unsettled",
  });
  if (audit) {
    return saveDecisionImpl(next, job.revision, {
      candidateUserId: job?.identity?.candidateUserId,
      candidateId: job?.identity?.candidateId,
      expectedProofVersion: completeCallSnapshot.proofVersion,
      expectedProofSemanticDigest:
        completeCallSnapshot.proofSemanticDigest,
      expectedBootstrapGenerationDigest:
        completeCallSnapshot.bootstrapGenerationDigest,
    });
  }
  return saveJobImpl(next, job.revision);
}

async function verifyCandidateEmail(candidateUserId, email) {
  const details = await candidateDetails(candidateUserId);
  return hasEmail(details, email);
}

async function saveEnrollmentError(job, code, detail, extra = {}) {
  const saved = await saveJob(transition(job, "error", {
    error: { code, detail: String(detail).slice(0, 300), at: new Date().toISOString() },
    ...extra,
    journalDetail: code,
  }), job.revision);
  throw stateError(detail, code, saved);
}

export async function enrollJob(job, body = {}, { noMatch = false } = {}) {
  const allowed = noMatch ? job?.state === "needs_review" : ["ready_to_enroll", "needs_review"].includes(job?.state);
  if (!allowed) throw stateError("job is not ready to enroll", "INVALID_STATE", job);
  const expected = noMatch ? `NO MATCHES ${job.id}` : `ENROLL ${job.id}`;
  if (String(body.confirmation || "") !== expected) throw stateError("enroll confirmation mismatch", "CONFIRMATION_MISMATCH", job);
  const config = paraAIConfig();
  if (!config.enrollApproved) throw stateError("PARAAI_ENROLL_APPROVED is false", "ENROLL_APPROVAL_REQUIRED", job);
  if (config.dryRun) throw stateError("PARAAI_DRY_RUN must be explicitly false", "DRY_RUN", job);
  if (!config.lifecycleRegistrationConfigured) throw stateError("lifecycle registration is not configured", "LIFECYCLE_REGISTRATION_REQUIRED", job);

  const email = normalizeEmail(body.email || job.submission?.email);
  if (!email) {
    const saved = await saveJob(transition(job, "no_email", { error: { code: "NO_EMAIL", detail: "A deliverable non-Paraform email is required", at: new Date().toISOString() } }), job.revision);
    throw stateError("A deliverable non-Paraform email is required", "NO_EMAIL", saved);
  }
  const candidateUserId = job.identity?.candidateUserId;
  if (!candidateUserId) throw stateError("candidate identity is missing", "IDENTITY_REQUIRED", job);
  let sequenceName;
  if (noMatch) sequenceName = SEQUENCE_NAMES.none;
  else if (job.state === "ready_to_enroll") sequenceName = targetSequenceName(job.matchCount);
  else sequenceName = String(body.sequenceName || "");
  if (!Object.values(SEQUENCE_NAMES).includes(sequenceName) || (!noMatch && sequenceName === SEQUENCE_NAMES.none)) {
    throw stateError("explicit one-role or multiple-role sequence required", "SEQUENCE_REQUIRED", job);
  }

  const details = await candidateDetails(candidateUserId);
  if (hasFutureScheduledStep(details)) return saveEnrollmentError(job, "FUTURE_NEXT_STEP", "Candidate has a future scheduled next step");
  const sequences = await listSequences();
  const sequence = sequences.find((row) => row?.name === sequenceName);
  if (!sequence?.id) return saveEnrollmentError(job, "SEQUENCE_MISSING", `Target sequence missing: ${sequenceName}`);
  if (!sequence.enabled) return saveEnrollmentError(job, "SEQUENCE_DISABLED", `Target sequence is disabled: ${sequenceName}`);

  const allTargetIds = new Set(sequences.filter((row) => Object.values(SEQUENCE_NAMES).includes(row?.name)).map((row) => row.id));
  let existingTarget = null;
  for (const targetId of allTargetIds) {
    const lead = await findLead(targetId, candidateUserId);
    if (!lead) continue;
    const target = sequences.find((row) => row.id === targetId);
    if (lead.has_replied) return saveEnrollmentError(job, "HAS_REPLIED", `Candidate has replied in ${target?.name || targetId}`);
    if (targetId !== sequence.id) return saveEnrollmentError(job, "ALREADY_ENROLLED", `Candidate already belongs to ${target?.name || targetId}`);
    existingTarget = lead;
  }

  let current = await saveJob(transition(job, "ensuring_email", {
    submission: { ...(job.submission || {}), email },
    targetSequenceName: sequenceName,
    targetSequenceId: sequence.id,
  }), job.revision);
  try {
    await trpcPost("candidateUser.updateCandidateUserEmailForUser", { candidate_user_id: candidateUserId, email });
    if (!(await verifyCandidateEmail(candidateUserId, email))) {
      return saveEnrollmentError(current, "GLOBAL_EMAIL_NOT_VISIBLE", "Candidate email did not stick on read-back");
    }
  } catch (error) {
    if (error?.job) throw error;
    return saveEnrollmentError(current, "GLOBAL_EMAIL_WRITE_FAILED", String(error?.message || error));
  }

  let lead = existingTarget;
  if (!lead) {
    current = await saveJob(transition(current, "enrolling", { enrollClaimedAt: new Date().toISOString() }), current.revision);
    try {
      await trpcPost("campaigns.addToCampaigns", { campaign_ids: [sequence.id], candidate_user_ids: [candidateUserId] }, 1);
    } catch (error) {
      return saveEnrollmentError(current, "ENROLL_WRITE_FAILED", String(error?.message || error), { externalWriteMayHaveLanded: true });
    }
    lead = await findLead(sequence.id, candidateUserId);
    if (!lead) return saveEnrollmentError(current, "ENROLL_NOT_VISIBLE", "Enrollment returned but lead is not visible on read-back", { externalWriteMayHaveLanded: true });
  }

  current = await saveJob(transition(current, "verifying", { ccuId: lead.ccu_id }), current.revision);
  try {
    await trpcPost("campaigns.updateSequenceCandidateEmail", { campaign_to_candidate_user_id: lead.ccu_id, candidate_email: email });
    const check = await findLead(sequence.id, candidateUserId);
    if (normalizeEmail(check?.to_use_email) !== email) {
      return saveEnrollmentError(current, "LEAD_EMAIL_NOT_VISIBLE", "Lead email did not stick on read-back", { ccuId: lead.ccu_id });
    }
  } catch (error) {
    if (error?.job) throw error;
    return saveEnrollmentError(current, "LEAD_EMAIL_WRITE_FAILED", String(error?.message || error), { ccuId: lead.ccu_id });
  }

  const enrolledAt = new Date().toISOString();
  let ledgerRegistered = false;
  let registrationError = null;
  try {
    await registerLifecycleEnrollment({
      botId: job.id,
      candidate: job.candidate?.fullName,
      candidateUserId,
      ccuId: lead.ccu_id,
      email,
      sequenceId: sequence.id,
      sequenceName,
      enrolledAt,
    });
    ledgerRegistered = true;
  } catch (error) {
    registrationError = String(error?.message || error).slice(0, 240);
  }

  const saved = await saveJob(transition(current, "enrolled", {
    enrolledAt,
    ccuId: lead.ccu_id,
    targetSequenceName: sequenceName,
    targetSequenceId: sequence.id,
    ledgerRegistered,
    registrationError,
    error: registrationError ? { code: "LIFECYCLE_REGISTRATION_FAILED", detail: registrationError, at: enrolledAt } : null,
    externalWriteMayHaveLanded: false,
  }), current.revision);
  if (registrationError) throw stateError(`Enrollment succeeded, but lifecycle registration failed: ${registrationError}`, "LIFECYCLE_REGISTRATION_FAILED", saved);
  return saved;
}

export async function loadJob(id) {
  const job = await getJob(id);
  if (!job) throw stateError("job not found", "JOB_NOT_FOUND");
  return job;
}
