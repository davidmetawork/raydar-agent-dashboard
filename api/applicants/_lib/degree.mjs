// Degree LEVEL out of Paraform's free-text `degree` field.
//
// Paraform's education rows carry no degree-level field and no field-of-study
// field — the whole credential is one free-text blob typed by whoever filled
// in the LinkedIn profile. Everything a rule can say about education level has
// to be read out of that blob, so this module is the single place that reads
// it. Rules store a LEVEL; this turns a string into one.
//
// Sampled live from the review queue on 2026-08-20. All 204 real strings are
// fixtures in test/fixtures/degree-strings.json:
//
//   "Master of Science - MS Computer Science"   "Bachelor's degree"
//   "Bachelor of Technology - BTech CSE"        "Bachelor’s Degree"  <- curly
//   "Computer Science, Bachelor in Science"     <- reversed
//   "Post Graduate Diploma in Management"       "Intermediate MPC"
//   "Full-Stack Coding Bootcamp"                "ARM - Associate Risk Mgmt"
//   "Doctor of Medicine (M.D.)"                 null
//
// ── WHY TWO PASSES ──────────────────────────────────────────────────────────
// Spelled-out credentials are unambiguous; two-letter abbreviations are not.
// "MA" is a master's and also Massachusetts. "BE" is a bachelor's and also an
// English verb. "AS" is an associate degree and also a preposition. A single
// ordered pass mixing both would grade "Bachelor of Science, Boston MA" as a
// MASTER'S, because the masters abbreviation has to outrank the bachelors
// abbreviation and would therefore also outrank the spelled-out word.
//
// So: PASS 1 reads only spelled-out credentials. PASS 2 reads abbreviations,
// and is reached only when pass 1 found nothing. Any string containing a real
// word wins on that word, and the ambiguous two-letter tokens can only ever
// decide a string that has no clearer signal in it.
//
// ── WHY THE ORDER WITHIN EACH PASS IS LOAD-BEARING ─────────────────────────
//   - "Doctor of Medicine (M.D.)" must beat every lower level -> doctorate 1st.
//   - "Bachelor of Arts - BA ... with a Certificate in Financial Policy" is a
//     BACHELOR'S, so bachelors must beat certificate.
//   - "High School Diploma" contains "Diploma", so secondary must beat
//     certificate too.
//   - "Post Graduate Diploma in Management" is a master's-equivalent (Indian
//     PGDM), so masters must beat certificate as well.
//   - "ARM - Associate Risk Mgmt" is a professional designation, NOT a degree.
//     Associate matches only genuine degree phrasing and falls through to
//     certificate, which is the right answer.
//
// `unknown` is a real answer, not a failure: 9% of live rows are either null
// or name a subject with no credential ("Mechanical Engineering", "Science",
// "School"). A rule must never fire on an unknown — see levelMatches().

/** Ordered strongest to weakest. Exported for the rule editor's picker. */
export const DEGREE_LEVELS = [
  "doctorate",
  "masters",
  "bachelors",
  "associate",
  "certificate",
  "secondary",
];

/** Picker labels. `unknown` is deliberately absent — it is not selectable. */
export const DEGREE_LEVEL_LABELS = {
  doctorate: "Doctorate (PhD, MD, JD)",
  masters: "Master's (incl. MBA)",
  bachelors: "Bachelor's / undergraduate",
  associate: "Associate degree",
  certificate: "Certificate / bootcamp",
  secondary: "Secondary school",
};

/**
 * Fold every spelling of the same credential onto one comparable string.
 * Curly apostrophes are the single most common cause of a missed match
 * ("Bachelor’s Degree" and "Bachelor's degree" both occur in this queue), and
 * punctuation becomes a space so "B.Tech", "B-Tech" and "BTech" all reduce to
 * something the word-boundary patterns can see. Apostrophes survive because
 * \b still fires on them: "master's" matches /\bmaster\b/.
 */
export function normalizeDegree(raw) {
  return String(raw ?? "")
    .replace(/[‘’ʼ´`]/g, "'")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Retain Han characters for exact, reviewed credential titles. All fuzzy
    // matching remains ASCII and word-bounded below.
    .replace(/[^a-z0-9'\u3400-\u9fff ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// PASS 1 — spelled-out credentials. Unambiguous, so precedence order rules.
const SPELLED = [
  ["doctorate", /\b(doctor|doctorate|doctoral|ph ?d|dphil|d ?phil)\b/],

  // A "graduate certificate" is a certificate, not a master's. Checked before
  // the masters rules below, which otherwise claim anything with "graduate".
  // NOTE the narrowness: a graduate DIPLOMA is not included, because
  // "Post Graduate Diploma in Management" is the Indian PGDM — a master's
  // equivalent — and it is the commonest such string in this queue.
  ["certificate", /\bgraduate certificate\b/],
  ["masters", /\b(master|masters|post ?graduate|pgdm|graduate diploma|integrated post graduation)\b/],
  ["masters", /\bgraduate\b/],

  ["bachelors", /\b(bachelor|bachelors|undergraduate|undergrad|licenciatura)\b/],

  // "Secondary in Computer Science" is a field of study, not a secondary
  // credential. In particular, LinkedIn can record "A.B. Physics, with
  // Secondary in Computer Science" in one degree field. Let that explicit
  // bachelor's abbreviation reach pass 2; true credentials such as "Senior
  // Secondary" and "Secondary Education" still match here.
  ["secondary", /\b(high ?school|senior secondary|secondary(?!\s+in\b)|matriculation|bachillerato|intermediate|10th|11th|12th|grade 1[012]|class 1[012])\b/],

  // Degree phrasing only. "Associate Risk Mgmt", "Associate Director" and
  // every other job-title use of the word falls through, which is correct.
  ["associate", /\bassociate('s)? (degree|of (science|arts|applied)|in)\b/],

  ["certificate", /\b(certificate|certification|certified|bootcamp|boot ?camp|immersive|nanodegree|micromasters)\b/],
];

// PASS 2 — abbreviations. Only reached when pass 1 found nothing at all, so an
// ambiguous token can never outrank a spelled-out credential.
const ABBREVIATED = [
  ["doctorate", /\b(m ?d|j ?d|ed ?d|d ?b ?a|dvm|dds|pharm ?d|sc ?d)\b/],

  ["masters", /\b(m ?s|m ?sc|m ?a|m ?b ?a|emba|m ?eng|m ?tech|m ?c ?a|m ?p ?h|ll ?m|m ?f ?a|msba|pgd)\b/],

  ["bachelors", /\b(b ?s|b ?a|b ?sc|b ?e|b ?tech|b ?b ?a|b ?a ?sc|b ?eng|b ?com|b ?c ?a|a ?b|s ?b)\b/],

  ["secondary", /\b(hsc|ssc|pu ?c|cbse|icse)\b/],

  ["associate", /\b(a ?a ?s|a ?a|a ?s) (degree|in)\b/],

  // Bare "diploma" lands here rather than in pass 1 so that "High School
  // Diploma" and "Post Graduate Diploma" are already decided by then.
  ["certificate", /\b(diploma|chfc|clu|cfa|cpa|pmp|ryt|arm|cissp|course|training|series [0-9]+)\b/],
];

// These are complete credential tokens seen at the start of a degree field.
// Keeping the short aliases anchored avoids turning ordinary prose containing
// "me" or "mse" into a master's degree.
const EXPLICIT_PREFIX = [
  ["masters", /^(ed ?m|m ?e|m ?ed|m ?l ?s|m ?p ?s|m ?s ?a ?i|m ?s ?e ?e|m ?s ?e)\b/],
  ["bachelors", /^(b ?f ?a|b ?arch|b ?des|bsba|bchelor|laurea triennale|sarjana komputer)\b/],
  ["bachelors", /^理学学士学位/],
];

// Source degree fields also carry clear Associate credentials without the
// word `degree`: `Associate's — Computer Science`, `Associates of Arts`, and
// bare `Associate` all occur in the current corpus. Keep this anchored to the
// complete field and require either credential grammar or an explicit typed
// separator. Job titles such as `Associate Professor`, `Research Associate`,
// and `Associate Director` therefore remain unknown.
const EXPLICIT_ASSOCIATE_PREFIX = /^associate(?:'s|s)?(?:\s+(?:degree|of|in)\b|$)/;
const EXPLICIT_ASSOCIATE_SEPARATOR = /^associate(?:['’ʼ´`]?s)?\s*(?:—|–)\s*\S/i;

// Workable projects a separate field of study into the same string as the
// credential. "Secondary Education" can therefore describe the subject of a
// BS or MS. Honor only an explicit leading credential; true "Senior
// Secondary" and bare "Secondary Education" still reach the secondary rule.
const SECONDARY_EDUCATION_PREFIX = [
  ["masters", /^(m ?s|m ?sc|m ?a)\b.*\bsecondary education\b/],
  ["bachelors", /^(b ?s|b ?sc|b ?a|a ?b|s ?b)\b.*\bsecondary education\b/],
];

/**
 * One of DEGREE_LEVELS, or "unknown". Never throws: a null, a number and an
 * object all answer "unknown" rather than failing a whole facts build.
 */
export function degreeLevel(raw) {
  const text = normalizeDegree(raw);
  if (!text) return "unknown";
  for (const [level, pattern] of SPELLED) {
    // This override belongs at the secondary step: a spelled-out doctorate or
    // master's elsewhere in the same string must still win first.
    if (level === "secondary") {
      for (const [prefixLevel, prefixPattern] of SECONDARY_EDUCATION_PREFIX) {
        if (prefixPattern.test(text)) return prefixLevel;
      }
    }
    if (pattern.test(text)) return level;
  }
  for (const [level, pattern] of ABBREVIATED) if (pattern.test(text)) return level;
  // Every existing spelled-out and abbreviated credential has had a chance
  // to win by strength before a new exact alias fills an unknown.
  for (const [level, pattern] of EXPLICIT_PREFIX) if (pattern.test(text)) return level;
  if (EXPLICIT_ASSOCIATE_PREFIX.test(text)
    || EXPLICIT_ASSOCIATE_SEPARATOR.test(String(raw ?? "").trim())) return "associate";
  return "unknown";
}

// A scalar remains the compatibility contract above: the strongest level
// wins. Consumers that explicitly support a combined credential can use this
// array. Both degree tokens must sit directly on opposite sides of a clear
// connector; words such as "coursework" or a trailing place abbreviation do
// not create an extra level.
const DUAL_TEXT = (raw) => String(raw ?? "")
  .replace(/[‘’ʼ´`]/g, "'")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .replace(/\./g, "");
const BACHELOR_TOKEN = String.raw`\b(?:b\.?\s*(?:a|s|sc|f\.?\s*a|arch|des)\.?|bsba|a\.?\s*b\.?|s\.?\s*b\.?|bachelor(?:'?s)?(?:\s+of\s+(?:arts|science))?)\b`;
const MASTER_TOKEN = String.raw`\b(?:m\.?\s*(?:a|s|sc|ba)\.?|master(?:'?s)?(?:\s+of\s+(?:arts|science|business administration))?)\b`;
const DUAL_CONNECTOR = String.raw`(?:\/|&|\+|\band\b)`;
const EXPLICIT_BACHELOR_MASTER = new RegExp(
  String.raw`(?:${BACHELOR_TOKEN}\s*${DUAL_CONNECTOR}\s*${MASTER_TOKEN}|${MASTER_TOKEN}\s*${DUAL_CONNECTOR}\s*${BACHELOR_TOKEN})`,
  "i",
);
const FULL_BACHELOR_TOKEN = String.raw`\bbachelor(?:'?s)?(?:\s+of\s+(?:arts|science))?\b`;
const FULL_MASTER_TOKEN = String.raw`\bmaster(?:'?s)?(?:\s+of\s+(?:arts|science|business administration))?\b`;
const EXPLICIT_FULL_TITLES_COMMA = new RegExp(
  String.raw`(?:${FULL_BACHELOR_TOKEN}\s*,\s*${FULL_MASTER_TOKEN}|${FULL_MASTER_TOKEN}\s*,\s*${FULL_BACHELOR_TOKEN})`,
  "i",
);
const HAS_BACHELOR_TOKEN = new RegExp(BACHELOR_TOKEN, "i");
const HAS_MASTER_TOKEN = new RegExp(MASTER_TOKEN, "i");
const EXPLICIT_DUAL_DEGREE = /\bdual\s+degree\b/i;

export function degreeLevels(raw) {
  const strongest = degreeLevel(raw);
  if (strongest === "unknown") return [];
  const dualText = DUAL_TEXT(raw);
  const hasBachelorAndMaster = EXPLICIT_BACHELOR_MASTER.test(dualText)
    || EXPLICIT_FULL_TITLES_COMMA.test(dualText)
    || (EXPLICIT_DUAL_DEGREE.test(dualText)
      && HAS_BACHELOR_TOKEN.test(dualText)
      && HAS_MASTER_TOKEN.test(dualText));
  if (hasBachelorAndMaster) {
    const found = new Set([strongest, "masters", "bachelors"]);
    return DEGREE_LEVELS.filter((level) => found.has(level));
  }
  return [strongest];
}

/**
 * THE GUARD THAT KEEPS RULES HONEST. An applicant whose degree we could not
 * read must never satisfy a degree condition, so every level comparison goes
 * through here rather than comparing strings at the call site.
 */
export function levelMatches(level, wanted) {
  const actual = (Array.isArray(level) ? level : [level])
    .filter((item) => item && item !== "unknown");
  if (!actual.length) return false;
  const requested = Array.isArray(wanted) ? wanted : [wanted];
  return actual.some((item) => requested.includes(item));
}
