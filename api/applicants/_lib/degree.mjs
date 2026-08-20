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
    .replace(/[^a-z0-9' ]+/g, " ")
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

  ["secondary", /\b(high ?school|senior secondary|secondary|matriculation|bachillerato|intermediate|10th|11th|12th|grade 1[012]|class 1[012])\b/],

  // Degree phrasing only. "Associate Risk Mgmt", "Associate Director" and
  // every other job-title use of the word falls through, which is correct.
  ["associate", /\bassociate('s)? (degree|of (science|arts|applied)|in)\b/],

  ["certificate", /\b(certificate|certification|certified|bootcamp|boot ?camp|immersive|nanodegree|micromasters)\b/],
];

// PASS 2 — abbreviations. Only reached when pass 1 found nothing at all, so an
// ambiguous token can never outrank a spelled-out credential.
const ABBREVIATED = [
  ["doctorate", /\b(m ?d|j ?d|ed ?d|d ?b ?a|dvm|dds|pharm ?d|sc ?d)\b/],

  ["masters", /\b(m ?s|m ?sc|m ?a|mba|emba|m ?eng|m ?tech|m ?c ?a|m ?p ?h|ll ?m|m ?f ?a|msba|pgd)\b/],

  ["bachelors", /\b(b ?s|b ?a|b ?sc|b ?e|b ?tech|b ?b ?a|b ?a ?sc|b ?eng|b ?com|b ?c ?a|a ?b|s ?b)\b/],

  ["secondary", /\b(hsc|ssc|pu ?c|cbse|icse)\b/],

  ["associate", /\b(a ?a ?s|a ?a|a ?s) (degree|in)\b/],

  // Bare "diploma" lands here rather than in pass 1 so that "High School
  // Diploma" and "Post Graduate Diploma" are already decided by then.
  ["certificate", /\b(diploma|chfc|clu|cfa|cpa|pmp|ryt|arm|cissp|course|training|series [0-9]+)\b/],
];

/**
 * One of DEGREE_LEVELS, or "unknown". Never throws: a null, a number and an
 * object all answer "unknown" rather than failing a whole facts build.
 */
export function degreeLevel(raw) {
  const text = normalizeDegree(raw);
  if (!text) return "unknown";
  for (const [level, pattern] of SPELLED) if (pattern.test(text)) return level;
  for (const [level, pattern] of ABBREVIATED) if (pattern.test(text)) return level;
  return "unknown";
}

/**
 * THE GUARD THAT KEEPS RULES HONEST. An applicant whose degree we could not
 * read must never satisfy a degree condition, so every level comparison goes
 * through here rather than comparing strings at the call site.
 */
export function levelMatches(level, wanted) {
  if (!level || level === "unknown") return false;
  const list = Array.isArray(wanted) ? wanted : [wanted];
  return list.includes(level);
}
