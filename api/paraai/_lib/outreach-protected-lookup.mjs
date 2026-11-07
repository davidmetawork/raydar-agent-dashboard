// Rating-protected subs: who the note is about (David, 2026-11-04).
//
// Paraform's rating-protected requests never appear in David's request
// history (measured 2026-11-04: 0 of 46 stored notes in the read), so the
// lane cannot admit one from that read. Instead the note itself names the
// person: this finds them on Paraform by the name in the note's subject and
// accepts them only when exactly one person by that name has the note's exact
// role on their Paraform record (David's rule). Anything else (nobody, two
// people, an unreadable role) is recorded and never sent; the unsent watch
// then pages with that reason, and staff can pick the person by hand.
//
// Lookup v3 (2026-11-06): of 51 notes on open roles, 11 failed the name
// lookup and none was a real "nobody": 8 showed the surname as an initial
// ("Trish J."), 1 had degree letters after a comma, and 2 were common names
// refused by the namesake cap before anyone's role was checked. So v3 cleans
// the note's name, accepts an initial surname, tries a role-scoped search
// first, checks every namesake's CRM row for the role before the cap, and
// keeps the people it saw as `options` for a one-click staff pick. Paraform
// has no id read for these requests (application.getQuickSubmitFormData
// returned nothing, 2026-11-06), so identity is still name plus role.
//
// Lookup v4 (2026-11-07, David's rules): of 56 notes, 11 were held. In all 6
// held with options, option 0 was the ONLY namesake with the note's role on
// their record, held only because Paraform showed the surname cut short
// ("Avery Q.") or because too many namesakes could not all be
// application-read; the other 5 were stopped on a PAUSED or closed role.
// David's rules, binding: (1) the note's "Why I think it fits" background
// identifies the person: if only one namesake worked at an employer the note
// names, that is the person; (2) the person who has the role attached is
// likely the person; (3) a role on hold, paused or closed still gets the
// email; (4) these situations are never held for David to pick. So v4:
//   - one person with the role (row link or a near-note application)
//     resolves, whatever their surname looks like and however many namesakes
//     were left unread, unless the background names another namesake's
//     employer and not theirs ("background_conflict", held);
//   - several with the role: the one whose employers the note names, if
//     exactly one namesake matches; otherwise "ambiguous";
//   - nobody with the role: the one namesake whose employers the note names,
//     when every name search finished ("background_only"); several: ambiguous;
//   - a role that is not ACTIVE is recorded (roleStatus) and the lookup goes
//     on; a resolved note on it sends.
// The background is matched by employer name (employersOf, backgroundMatches:
// conservative whole-phrase, capitalised matches, the role's own company,
// Paraform, schools and the note's own name words excluded; only a mention in
// an employment context, "at X" or "X's", decides anything).
// Review fixes (2026-11-07): Paraform's own id for the request on a person's
// application (ctarMatch) beats the background; a cut-short holder or a
// background-only match needs the short-form search to have finished, and a
// background-only match needs the unread cut-short namesakes read first.
// Still held: ambiguous, background_conflict, too_many, incomplete,
// not_found (offered on protected-subs.html).
//
// A resolved note (or a staff "send" pick) becomes a request row of the tick
// (`synthetic: true`), so the normal send path applies every guard. Such a
// row never gets Paraform's reached-out marker, never reaches the digest
// write, and never goes to the reply pass, which could dismiss the request
// on Paraform.

import {
  getProtectedLookups,
  getProtectedPick,
  pruneProtectedLookups,
  saveProtectedLookup,
} from "./outreach-store.mjs";
import {
  REQUEST_LANE_COOLDOWN_CODE,
  REQUEST_LANE_RATE_LIMITED_CODE,
} from "./request-lane-throttle.mjs";

// Same window the unsent watch uses: a note older than a week is past acting on.
export const PROTECTED_LOOKUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// "Nobody found" is retried (Paraform may add the role a little after the
// note), at most this many times, this far apart.
export const PROTECTED_LOOKUP_MAX_ATTEMPTS = 3;
export const PROTECTED_LOOKUP_RETRY_MS = 10 * 60 * 1000;
// v3 (2026-11-06): a note that did not resolve is checked again once a day
// while it is in the window (Paraform may add the role, or reopen it, later).
export const PROTECTED_LOOKUP_RECHECK_MS = 24 * 60 * 60 * 1000;
// At most this many people are kept on a lookup for staff to pick from.
export const PROTECTED_LOOKUP_MAX_OPTIONS = 10;
const CRM_PAGE_LIMIT = 50;
const CRM_SORT = Object.freeze({ field: "updated_at", direction: "desc" });
const CRM_SEARCH = "candidateUser.getCRMExternalCandidates";
// The role-scoped search reads 1 page; each name search at most 3, and the
// name searches together at most 3 (2026-11-06 review: a lookup must leave
// room in the pace cap for the reads its own tick already made).
const ROLE_SEARCH_MAX_PAGES = 1;
const NAME_SEARCH_MAX_PAGES = 3;
const NAME_SEARCH_TOTAL_PAGES = 3;
// More namesakes needing an applications read than this: the lookup cannot
// prove there is only one, so it never resolves on their applications.
const MAX_NAME_MATCHES = 4;
// The lane shares a 10-a-minute pace cap with the reads the same tick made
// before the lookup (its history read, sends), so one lookup never makes more
// reads than this: the applications reads get what is left. 2026-11-06
// review: 10 was the whole cap, so the hardest notes were refused every time.
export const PROTECTED_LOOKUP_MAX_READS = 7;
// Paraform puts the person on the role minutes before the note (measured
// 2026-11-04: 6 minutes). An older application on the role is someone else's
// story (a past applicant by the same name), so it does not count, unless
// Paraform's own id for it is the note's protected-sub id.
const APPLICATION_BEFORE_NOTE_MS = 7 * 24 * 60 * 60 * 1000;
const APPLICATION_AFTER_NOTE_MS = 60 * 60 * 1000;
// Bumped when the lookup changes, so the earlier notes are measured again.
// v4 (2026-11-07): background match, one role holder resolves, closed roles go on.
export const PROTECTED_LOOKUP_VERSION = 4;
// A note whose "Why I think it fits" text was not read yet (stored before v4)
// waits for the scan to read it, this many failed reads at most
// (outreach-protected.mjs backfills it), so the first v4 lookup sees it.
export const PROTECTED_FIT_TEXT_MAX_TRIES = 3;
// A pacing refusal is retried later without using an attempt, this many times.
const MAX_THROTTLED = 12;
// Not resolved, checked again once a day rather than retried soon. v4 no
// longer makes role_inactive or unconfirmed_name (2026-11-07); older records
// with them are re-run once as an older version.
const DAILY_STATUSES = new Set(["ambiguous", "background_conflict", "too_many", "incomplete"]);

// The same refusals that stop the tick's other Paraform work.
const STOP_CODES = new Set([
  REQUEST_LANE_COOLDOWN_CODE,
  REQUEST_LANE_RATE_LIMITED_CODE,
  "PARAFORM_THROTTLED",
  "AUTH_EXPIRED",
  "HTTP_429",
]);

const clean = (value) => String(value ?? "").trim();
const iso = (ms) => new Date(ms).toISOString();

function isStopError(error) {
  const status = Number(error?.status);
  return STOP_CODES.has(clean(error?.code)) || status === 429 || status === 401;
}

// Latin letters NFKD does not take apart, folded by hand ("Łukasz" is "lukasz").
const LETTER_FOLD = { "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ı": "i", "ß": "ss", "æ": "ae", "œ": "oe", "þ": "th", "ð": "d" };

// Lowercase, accents and punctuation off, so "José O'Neil" matches "jose oneil".
// Letters of any script are kept (2026-11-06 review): dropping a Cyrillic or
// CJK surname left only the first name, which matched any namesake.
export function nameTokens(value) {
  return clean(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[łøđħıßæœþð]/g, (letter) => LETTER_FOLD[letter])
    .replace(/['’.]/g, "")
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(Boolean);
}

// First and last name both equal (a middle name on either side is fine).
export function sameName(left, right) {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length < 2 || b.length < 2) return a.length > 0 && a.join(" ") === b.join(" ");
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

// Degree and suffix letters after a name (2026-11-06: "Name, M.A.Sc.,
// P.Eng."). Some are also real surnames (Ma, Ba), so those count as letters
// only when written with dots or in capitals ("M.A.", "MA").
const CREDENTIALS = new Set(["phd", "md", "mba", "msc", "masc", "bsc", "ba", "bs", "ms", "ma", "peng", "pe", "cpa", "cfa", "pmp", "jr", "sr", "ii", "iii", "iv"]);
const SURNAME_LIKE = new Set(["ma", "ba", "bs", "ms", "md", "pe"]);

function credentialWord(word) {
  const token = nameTokens(word).join("");
  if (!CREDENTIALS.has(token)) return false;
  if (!SURNAME_LIKE.has(token)) return true;
  return word.includes(".") || (word === word.toUpperCase() && /[A-Z]/.test(word));
}

// The note's name, cleaned for search and matching: everything after the
// first comma, parenthesised nicknames and trailing degree letters go. A
// last name shown only as an initial ("Trish J.", "David O") is nameForm
// "initial": Paraform shows protected subs that way (2026-11-06).
export function parseNoteName(value) {
  const words = clean(value).split(",")[0].replace(/\([^)]*\)/g, " ").split(/\s+/).filter((word) => nameTokens(word).length);
  while (words.length > 2 && credentialWord(words[words.length - 1])) words.pop();
  if (words.length === 2 && credentialWord(words[1]) && !SURNAME_LIKE.has(nameTokens(words[1]).join(""))) words.pop();
  const tokens = nameTokens(words.join(" "));
  const firstWord = words[0] ? words[0].replace(/[.]+$/, "") : "";
  const last = tokens[tokens.length - 1] || "";
  if (tokens.length >= 2 && /^[a-z]$/.test(last)) {
    return { tokens, nameForm: "initial", first: tokens[0], lastInitial: last, firstWord, search: `${firstWord} ${last.toUpperCase()}` };
  }
  return { tokens, nameForm: "full", first: tokens[0] || "", lastInitial: null, firstWord, search: words.join(" ") };
}

// A surname written as one word, two words or hyphenated is the same
// surname ("Ben-Atar", "Ben Atar", "Benatar").
function sameSurname(a, b) {
  if (a[a.length - 1] === b[b.length - 1]) return true;
  const flat = (token) => token.replace(/-/g, "");
  const tails = (parts) => new Set(parts.map((_, index) => flat(parts.slice(index).join(""))));
  return tails(b).has(flat(a[a.length - 1])) || tails(a).has(flat(b[b.length - 1]));
}

// Could this Paraform row be the person the note names? First names equal,
// and the surname equal (in any spelling above) or, for an initial, starting
// with that letter. Only a candidate: the role still has to be on the record.
// The Paraform name is cleaned the same way as the note's (2026-11-06
// review): otherwise "Avery Quill Jr" on Paraform never matched the note
// "Avery Quill Jr", and his father "Avery Quill" did.
export function compatibleName(parsed, rowName) {
  const note = typeof parsed === "string" ? parseNoteName(parsed) : parsed;
  const a = note?.tokens || [];
  const b = parseNoteName(rowName).tokens;
  if (!a.length || !b.length) return false;
  if (note.nameForm === "initial") {
    return b.length >= 2 && b[0] === note.first && b[b.length - 1].startsWith(note.lastInitial);
  }
  // Paraform cuts about 13% of its own display names to "First L."
  // (measured 2026-11-06; Conor's notes carry the full name), so a row
  // whose surname is one letter fits a note whose surname starts with it.
  if (rowSurnameInitial(b) && a.length >= 2) return a[0] === b[0] && a[a.length - 1].startsWith(b[b.length - 1]);
  if (a.length < 2 || b.length < 2) return a.join(" ") === b.join(" ");
  return a[0] === b[0] && sameSurname(a.slice(1), b.slice(1));
}

function rowSurnameInitial(tokens) {
  return tokens.length >= 2 && /^[a-z]$/.test(tokens[tokens.length - 1]);
}

// Does a LinkedIn handle spell this surname? As a whole word of the handle
// ("avery-quillon-7b2"), or at the end of its letters ("averyquillon"), never
// inside a longer word ("raylinden" does not spell "lin") (2026-11-06 review).
function handleSpells(linkedinUser, surname) {
  if (surname.length < 3) return false;
  const words = String(linkedinUser || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.includes(surname) || words.join("").endsWith(surname);
}

// Is the surname known in full on both sides? A match on an initial (in
// the note or in Paraform's name) resolves on its own only when the
// person's LinkedIn handle spells the note's surname (2026-11-06 design);
// otherwise it is held for a staff pick with that person first.
export function nameFullyConfirmed(parsed, rowName, linkedinUser) {
  const note = typeof parsed === "string" ? parseNoteName(parsed) : parsed;
  if (note?.nameForm === "initial") return false;
  const row = parseNoteName(rowName).tokens;
  const last = (note?.tokens || []).at(-1) || "";
  if (!rowSurnameInitial(row) || row.at(-1) === last) return true;
  return handleSpells(linkedinUser, last.replace(/-/g, ""));
}

function crmName(item) {
  const person = item?.candidate && typeof item.candidate === "object" ? item.candidate : {};
  return clean(
    person.name
    || item?.full_name
    || [item?.first_name, item?.last_name].filter(Boolean).join(" ")
    || item?.name
    || item?.candidate_name,
  );
}

function crmId(item) {
  return clean(item?.candidate_user_id || item?.cu_id || item?.candidateUserId || item?.id);
}

function crmLinkedin(item) {
  const person = item?.candidate && typeof item.candidate === "object" ? item.candidate : {};
  return clean(item?.linkedin_user || person.linkedin_user) || null;
}

// ── Background match (v4, 2026-11-07) ───────────────────────────────────────
// Conor's notes say where the person worked ("Why I think it fits: senior
// backend engineer on Hooli's messaging team, after building storage for
// Initech"), and Paraform's CRM rows list each person's experiences (99% of
// rows). A namesake whose employer the note names is the person (David's
// rule 1).
// Kept conservative (2026-11-07 review):
//   - an employer counts only as a whole phrase written with a capital (or a
//     digit) in the note, so "block" or "meta" as ordinary words never match;
//   - a mention is STRONG only in an employment context: "at X", "@X",
//     "joined X", "ex-X", "formerly X", "for X", "X's", "X (2021", "X since
//     2021", "X engineer"; for a tool, platform or skill name (AWS, Google
//     Cloud, Salesforce, Snowflake, Python...) only "at", "@", "joined", "ex"
//     and "formerly" count, so "Kafka on AWS" or "lived in Salesforce" never
//     do. Every other mention is WEAK. Only strong mentions drive a decision
//     (resolve on the background alone, pick among holders, hold a holder as
//     a conflict); a weak one only keeps a role holder from being held;
//   - the first word of a longer name alone ("Initrode" for "Initrode Cloud
//     Services") is only ever weak;
//   - schools are never employers here (a degree is not a job), aliases in
//     brackets under 4 letters ("(AWS)") are dropped, and a name made only of
//     the note's own name words ("Edward Jones" for a note about an Edward,
//     whose background starts "Edward has...") never counts by those words.

// Accents off, case kept ("Zürich" is "Zurich", "Łódź" is "Lodz").
function foldKeepCase(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[łøđħıßæœþðŁØĐĦÆŒÞÐ]/g, (letter) => {
      const lower = letter.toLowerCase();
      const folded = LETTER_FOLD[lower] || lower;
      return letter === lower ? folded : folded.charAt(0).toUpperCase() + folded.slice(1);
    });
}

// Not an employer anyone can be told apart by.
const GENERIC_EMPLOYERS = new Set([
  "stealth", "stealth mode", "stealth startup", "self employed", "freelance", "freelancer",
  "independent", "independent consultant", "consultant", "confidential", "various", "n a", "none",
  "startup", "unemployed", "open to work", "career break",
]);
// A school on a row is study (or a TA job), and notes name schools for
// degrees ("MS from Columbia"): never an employer for this match.
const SCHOOL_WORDS = new Set(["university", "universidad", "universite", "universitat", "universita", "college", "school", "academy", "polytechnic", "polytechnique"]);
// Legal suffixes, stripped (repeatedly) from the end of a name for matching.
const LEGAL_SUFFIX = /[\s,]+(?:inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|gmbh|plc|s\.?\s?a)\.?\s*$/i;
// Tools, platforms and skills that notes name as things the person used.
// They count only after "at", "@", "joined", "ex" or "formerly".
const TOOLISH = new Set([
  "aws", "amazon web services", "gcp", "google", "google cloud", "google cloud platform", "azure", "microsoft azure",
  "salesforce", "snowflake", "databricks", "kafka", "confluent", "hubspot", "stripe", "twilio", "github", "gitlab",
  "atlassian", "jira", "slack", "mongodb", "datadog", "elastic", "cloudflare", "vercel", "heroku", "docker",
  "kubernetes", "terraform", "hashicorp", "okta", "shopify", "zendesk", "workday", "servicenow", "tableau", "looker",
  "segment", "figma", "notion", "openai", "anthropic", "oracle", "sap", "python", "java", "rust", "kotlin", "swift",
  "react", "golang", "scala", "ruby", "rails", "node", "postgres", "postgresql", "redis", "spark", "linux", "unity",
]);
// The first-word rule below never uses these: words that start sentences or
// job titles in a note, that many employers share, or that are places or
// skills ("Based in Boston", "Strong Python engineer").
const FIRST_WORD_STOP = new Set([
  "about", "after", "american", "before", "building", "capital", "central", "cloud", "college", "consulting",
  "currently", "digital", "during", "earlier", "engineering", "executive", "financial", "first", "founding",
  "general", "global", "group", "health", "independent", "institute", "international", "media", "mobile",
  "national", "network", "networks", "north", "partners", "platform", "previously", "principal", "product",
  "royal", "school", "senior", "services", "smart", "software", "solutions", "south", "staff", "state",
  "stealth", "strategic", "studio", "systems", "technologies", "technology", "united", "university",
  "ventures", "where", "which", "while", "world",
  "atlanta", "austin", "berlin", "boston", "boulder", "brooklyn", "chicago", "dallas", "denver", "dublin",
  "houston", "london", "miami", "montreal", "munich", "paris", "phoenix", "portland", "seattle", "singapore",
  "sydney", "tokyo", "toronto", "vancouver", "california", "texas", "canada", "europe", "pacific", "atlantic",
  "python", "kotlin", "swift", "scala", "react", "golang", "spark", "kafka", "linux", "ruby",
]);
// Nor for a name with one of these words: a hospital, a foundation or an
// institute is named after a place or a school ("Stanford Health Care").
const FIRST_WORD_NEVER_WITH = new Set(["health", "hospital", "foundation", "institute", "medical", "clinic", "museum", "church"]);
const EMPLOY_BEFORE_ANY = /(?:^|[^\p{L}\p{N}])(?:at|joined|joining|ex|formerly)[\s-]+(?:the\s+)?$|@\s*$/iu;
const EMPLOY_BEFORE_COMPANY = /(?:^|[^\p{L}\p{N}])for\s+(?:the\s+)?$/iu;
const EMPLOY_AFTER_COMPANY = /^(?:\s*\(\s*(?:19|20)\d\d|\s*,?\s+(?:since|from)\s+(?:19|20)\d\d|\s+(?:engineer|engineers|engineering|swe|sde|ae|pm|alum|alumni|alumnus|veteran|employee|designer|recruiter|researcher|scientist)(?![\p{L}\p{N}]))/iu;

const letterCount = (value) => value.replace(/[^\p{L}]/gu, "").length;

// The ways an employer name can be written in a note, as lowercase token
// lists: the name without legal suffixes and without a parenthesised part
// (main), then each parenthesised part of 4 letters or more ("Meta
// (Facebook)"). Generic names, schools and names under 3 letters give nothing.
function employerForms(name) {
  const folded = foldKeepCase(clean(name));
  const parts = [{ text: folded.replace(/\([^)]*\)/g, " "), main: true }];
  for (const match of folded.matchAll(/\(([^)]*)\)/g)) parts.push({ text: match[1], main: false });
  const forms = [];
  for (const part of parts) {
    let text = part.text.trim();
    for (let next = text.replace(LEGAL_SUFFIX, ""); next !== text && next.trim(); next = text.replace(LEGAL_SUFFIX, "")) text = next.trim();
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const key = tokens.join(" ");
    if (!tokens.length || letterCount(key) < (part.main ? 3 : 4) || GENERIC_EMPLOYERS.has(key)) continue;
    if (tokens.some((token) => SCHOOL_WORDS.has(token))) return [];
    forms.push({ tokens, key, main: part.main });
  }
  return forms;
}

function experienceEmployer(entry) {
  if (!entry || typeof entry !== "object") return "";
  const company = entry.company;
  return clean(
    entry.company_name
    || (company && typeof company === "object" ? company.name : company)
    || entry.companyName
    || entry.name,
  );
}

// Every distinct employer on a CRM row's experiences (on the row, or under
// row.candidate), as written on Paraform; generic ones and schools left out.
export function employersOf(item) {
  const lists = [item?.experiences, item?.candidate?.experiences].filter(Array.isArray);
  const seen = new Set();
  const names = [];
  for (const entry of lists.flat()) {
    const name = experienceEmployer(entry);
    const forms = employerForms(name);
    if (!forms.length) continue;
    const key = forms.map((form) => form.key).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// How the (folded) note text names these tokens as a whole phrase starting
// with a capital or a digit (a possessive "'s" may follow): "strong" in an
// employment context (see above), "weak" otherwise, null when it does not.
function phraseInText(text, tokens, { toolish = false } = {}) {
  const body = tokens.map(escapeRegex).join("[^\\p{L}\\p{N}]{1,3}");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${body})(['’]s)?(?![\\p{L}\\p{N}])`, "giu");
  let found = null;
  for (const match of text.matchAll(pattern)) {
    if (!/^[\p{Lu}\p{N}]/u.test(match[1])) continue;
    found = "weak";
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    if (EMPLOY_BEFORE_ANY.test(before)) return "strong";
    if (!toolish && (match[2] || EMPLOY_BEFORE_COMPANY.test(before) || EMPLOY_AFTER_COMPANY.test(after))) return "strong";
  }
  return found;
}

// The employers on this row that the note's background names, each with
// `strong` (named in an employment context, see above). The role's own
// company and Paraform never count (`exclude`, compared without case,
// accents or legal suffixes), nor a name made only of the note's own name
// words (`nameWords`). An employer counts when its name (or a bracketed
// alias) is in the text as a whole, capitalised phrase; or, weakly only, for
// a name of more than one word, when its first word alone is, provided that
// word has at least 5 letters, is not a name word of the note and is not a
// common word that starts sentences or titles ("Initrode Cloud Services" is
// weak for "Initrode Cloud storage APIs"; "Strategic Education" never counts
// for "Strategic Account Executive").
export function backgroundMatches(item, fitText, { exclude = [], nameWords = [] } = {}) {
  const text = foldKeepCase(fitText);
  if (!text.trim()) return [];
  const excluded = new Set(["paraform", ...exclude.flatMap((name) => employerForms(name).map((form) => form.key))]);
  const names = new Set(nameWords.flatMap((word) => nameTokens(word)).flatMap((token) => [token, ...token.split("-")]).filter(Boolean));
  const matches = [];
  for (const name of employersOf(item)) {
    const forms = employerForms(name);
    if (forms.some((form) => excluded.has(form.key))) continue;
    let best = null;
    for (const form of forms) {
      if (form.tokens.every((token) => names.has(token))) continue;
      const found = phraseInText(text, form.tokens, { toolish: TOOLISH.has(form.key) });
      if (found === "strong") { best = "strong"; break; }
      best = best || found;
    }
    const main = forms.find((form) => form.main);
    if (!best && main && main.tokens.length > 1) {
      const first = main.tokens[0];
      const usable = letterCount(first) >= 5 && !FIRST_WORD_STOP.has(first) && !excluded.has(first) && !names.has(first)
        && !main.tokens.some((token) => FIRST_WORD_NEVER_WITH.has(token));
      if (usable && phraseInText(text, [first], { toolish: true })) best = "weak";
    }
    if (best) matches.push({ name, strong: best === "strong" });
  }
  return matches;
}

// The employer names the note's background names on this row, strong or
// weak; `{ strongOnly: true }` keeps the strong ones (those decide).
export function backgroundHits(item, fitText, { strongOnly = false, ...options } = {}) {
  return backgroundMatches(item, fitText, options)
    .filter((match) => !strongOnly || match.strong)
    .map((match) => match.name);
}

function applicationRoleId(row) {
  return clean(row?.role_id || row?.role?.id || row?.roleId);
}

// Where a person's CRM row names the role (measured 2026-11-04: the
// applications read omits roles Paraform added the person to as "Sourced",
// which is how a protected sub arrives). Returns the path to the first value
// equal to the role id and the date on the object holding it, if any.
export function roleLinkInRow(node, roleId, path = "", depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const entries = Array.isArray(node) ? node.map((value, index) => [index, value]) : Object.entries(node);
  for (const [key, value] of entries) {
    if (typeof value === "string" && value === roleId) {
      return { path: `${path}${Array.isArray(node) ? "[]" : `.${key}`}`, atMs: Array.isArray(node) ? null : applicationTimeMs(node) };
    }
  }
  for (const [key, value] of entries) {
    if (value && typeof value === "object") {
      const found = roleLinkInRow(value, roleId, `${path}${Array.isArray(node) ? "[]" : `.${key}`}`, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function rowUpdatedMs(item) {
  const person = item?.candidate && typeof item.candidate === "object" ? item.candidate : {};
  for (const value of [item?.updated_at, item?.updatedAt, person.updated_at, person.updatedAt]) {
    const ms = Date.parse(clean(value));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function applicationTimeMs(row) {
  for (const value of [row?.created_at, row?.createdAt, row?.updated_at, row?.updatedAt, row?.submitted_at]) {
    const ms = Date.parse(clean(value));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// A record from an older lookup that did not resolve starts over under this
// one, attempts counted from 0 (2026-11-06: the 16 earlier failures).
function carriedLookup(previous) {
  if (!previous || previous.status === "resolved") return previous || null;
  return Number(previous.version || 1) < PROTECTED_LOOKUP_VERSION ? null : previous;
}

// A stored note whose "Why I think it fits" text has not been read yet
// (undefined; "" means read and absent) and can still be: its note message
// is known and fewer than PROTECTED_FIT_TEXT_MAX_TRIES reads failed.
export function awaitingFitText(sub) {
  return sub?.fitText === undefined
    && Boolean(clean(sub?.noteMessageId))
    && Number(sub?.fitTextTries || 0) < PROTECTED_FIT_TEXT_MAX_TRIES;
}

// Which subs to look up this tick: notes in the window (a week unless set)
// that the request read does not hold, never looked up or due again, not
// skipped and not picked by staff. Notes from the send cutoff on come first
// (oldest first); then at most `backfill` earlier ones (newest first), only
// recorded, never sent. Notes from `firstFromMs` on (the switch-on) go
// before the backlog's.
export function protectedLookupQueue({ subs, historyIds, lookups = {}, notBeforeMs, now = Date.now(), backfill = 0, windowMs = PROTECTED_LOOKUP_WINDOW_MS, skip = null, firstFromMs = null, picks = {} } = {}) {
  const due = (sub) => {
    const record = lookups[sub.requestId];
    if (!record) return true;
    if (record.status === "resolved") return false;
    if (Number(record.version || 1) < PROTECTED_LOOKUP_VERSION) return true;
    if (record.status === "no_name") return false;
    const last = Date.parse(record.lastTriedAt || "");
    // Pacing refusals ran out for this check: tried again a day after the
    // last try, never dropped for good (2026-11-06 review).
    if (Number(record.throttled || 0) >= MAX_THROTTLED) {
      return Number.isFinite(last) && last <= now - PROTECTED_LOOKUP_RECHECK_MS;
    }
    if (Number.isFinite(last) && last > now - PROTECTED_LOOKUP_RETRY_MS) return false;
    // Once a day after the last finished check (a pacing refusal does not
    // finish one), whatever the attempts.
    const checked = Date.parse(record.checkedAt || record.lastTriedAt || "");
    const dayOld = !Number.isFinite(checked) || checked <= now - PROTECTED_LOOKUP_RECHECK_MS;
    if (DAILY_STATUSES.has(record.status)) return dayOld;
    const attemptsLeft = Number(record.attempts || 0) < PROTECTED_LOOKUP_MAX_ATTEMPTS;
    if (record.status === "not_found") return attemptsLeft || dayOld;
    // An error once its quick retries are spent is tried again daily, from
    // the failed try (2026-11-06): attempts add up across daily checks, so a
    // held note's one failed re-check must not end its checks for good.
    if (record.status === "error") {
      return attemptsLeft || (Number.isFinite(last) && last <= now - PROTECTED_LOOKUP_RECHECK_MS);
    }
    return attemptsLeft;
  };
  // An earlier note counts as measured by this lookup once a check finished,
  // or its errors and pacing refusals ran out. Resolved stays final.
  const measured = (record) => record?.status === "resolved" || (Boolean(record)
    && Number(record.version || 1) >= PROTECTED_LOOKUP_VERSION
    && (!["throttled", "error"].includes(record.status)
      || Number(record.attempts || 0) >= PROTECTED_LOOKUP_MAX_ATTEMPTS
      || Number(record.throttled || 0) >= MAX_THROTTLED));
  const fresh = [];
  const earlier = [];
  let earlierRecorded = 0;
  for (const sub of subs?.values?.() || []) {
    const receivedMs = Date.parse(sub?.receivedAt || "");
    if (!Number.isFinite(receivedMs) || receivedMs < now - windowMs) continue;
    if (historyIds?.has?.(sub.requestId)) continue;
    if (skip?.has?.(sub.requestId)) continue;
    // Staff picked (or skipped) this note: never looked up again.
    if (picks?.[sub.requestId]) continue;
    // v4 (2026-11-07): a note stored before its background was read waits
    // for the scan to read it (a few tries), so its lookup can use it.
    if (awaitingFitText(sub)) continue;
    const afterSwitchOn = notBeforeMs != null && receivedMs >= notBeforeMs;
    if (afterSwitchOn) {
      if (due(sub)) fresh.push(sub);
    } else if (measured(lookups[sub.requestId])) {
      earlierRecorded += 1;
    } else {
      earlier.push(sub);
    }
  }
  const backlog = (sub) => (firstFromMs != null && Date.parse(sub.receivedAt) < firstFromMs ? 1 : 0);
  // A note never looked up (no record, or only pacing refusals) goes before
  // re-checks, retries and re-queues of older notes (2026-11-06 review: those
  // kept a new note waiting past its one-hour unsent page).
  const lookedAt = (sub) => {
    const record = lookups[sub.requestId];
    return record && (record.checkedAt || (record.status && record.status !== "throttled")) ? 1 : 0;
  };
  fresh.sort((a, b) => backlog(a) - backlog(b) || lookedAt(a) - lookedAt(b) || Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  earlier.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  return [...fresh, ...earlier.slice(0, Math.max(0, backfill - earlierRecorded))];
}

// The people a lookup saw, role holders first (then those whose employers
// the note names), for staff to pick from. v4 adds `backgroundHits`: the
// employers on the person's record that the note's background names.
function lookupOptions(people) {
  const rank = (option) => (option.roleRecent ? 0 : option.roleOnRecord ? 1 : 2);
  return [...people.values()]
    .map((person) => {
      const atMs = person.link?.atMs ?? person.appAtMs ?? null;
      return {
        candidateUserId: person.candidateUserId,
        name: crmName(person.item) || null,
        linkedinUser: crmLinkedin(person.item),
        roleOnRecord: Boolean(person.link) || Boolean(person.onRole?.length),
        roleRecent: Boolean(person.link?.recent) || Boolean(person.appConfirmed),
        roleAt: atMs != null ? iso(atMs) : null,
        checked: Boolean(person.link?.recent) || person.onRole != null,
        ...(person.bg?.length ? { backgroundHits: person.bg } : {}),
      };
    })
    .map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option) - rank(b.option)
      || Number(!a.option.backgroundHits) - Number(!b.option.backgroundHits)
      || a.index - b.index)
    .slice(0, PROTECTED_LOOKUP_MAX_OPTIONS)
    .map(({ option }) => option);
}

// One note: the role, then a role-scoped search, then the people by that
// name, then whose record has the role. Calls go one at a time through the
// lane's throttled reader, at most PROTECTED_LOOKUP_MAX_READS of them; a
// pace-cap or cooldown refusal throws (the runner records it as throttled).
export async function lookupProtectedSub(sub, { trpcGetImpl, now = Date.now(), previous = null } = {}) {
  const prior = carriedLookup(previous);
  const base = {
    requestId: sub.requestId,
    roleId: clean(sub.roleId) || null,
    lastTriedAt: iso(now),
    checkedAt: iso(now),
    attempts: Number(prior?.attempts || 0) + 1,
    // A finished check starts the pacing-refusal count over (2026-11-06
    // review): it counts refusals of one check, not of the note's life.
    throttled: 0,
    version: PROTECTED_LOOKUP_VERSION,
  };
  const parsed = parseNoteName(sub.candidateName);
  if (!parsed.tokens.length) return { ...base, status: "no_name" };
  base.nameForm = parsed.nameForm;
  if (!base.roleId) return { ...base, status: "role_unreadable" };
  let reads = 0;
  const read = (proc, input) => { reads += 1; return trpcGetImpl(proc, input); };
  const role = await read("role.getRoleByIdSimple", { role_id: base.roleId, id: base.roleId });
  const roleName = clean(role?.title ?? role?.name);
  const companyName = clean(role?.company?.name ?? role?.company_name ?? role?.companyName) || clean(sub.companyName);
  const returnedId = clean(role?.id || role?.role_id || role?.roleId);
  if (!roleName || !companyName || returnedId !== base.roleId) return { ...base, reads, status: "role_unreadable" };
  // v4 (2026-11-07, David's rule 3): a role on hold, paused or closed still
  // gets the email, so its status is only recorded and the lookup goes on.
  const roleStatus = clean(role?.status).toUpperCase();

  const receivedMs = Date.parse(clean(sub.receivedAt));
  const nearNote = (at) => Number.isFinite(receivedMs) && at != null
    && at >= receivedMs - APPLICATION_BEFORE_NOTE_MS && at <= receivedMs + APPLICATION_AFTER_NOTE_MS;
  // The role on the person's CRM row counts when that link is dated near
  // the note, or, undated, when the row itself changed since a week before
  // the note (Paraform adding the role is what changed it).
  const rowLink = (item) => {
    const link = roleLinkInRow(item, base.roleId);
    if (!link) return null;
    const updatedMs = rowUpdatedMs(item);
    const recent = link.atMs != null
      ? nearNote(link.atMs)
      : updatedMs != null && Number.isFinite(receivedMs) && updatedMs >= receivedMs - APPLICATION_BEFORE_NOTE_MS;
    return { ...link, recent };
  };
  const people = new Map();
  const addPerson = (item) => {
    const candidateUserId = crmId(item);
    if (!candidateUserId || people.has(candidateUserId) || !compatibleName(parsed, crmName(item))) return false;
    people.set(candidateUserId, { candidateUserId, item, link: rowLink(item) });
    return true;
  };
  // The note's background (v4): "" when the note has none, so nobody matches.
  const fitText = clean(sub.fitText);
  const bgExclude = [companyName, clean(sub.companyName)].filter(Boolean);
  // The note's own name words never count as an employer (2026-11-07
  // review: every namesake shares the first name and a background often
  // starts with it, so "Edward Jones" matched "Edward has been...").
  const nameWords = [...parsed.tokens, parsed.firstWord, clean(sub.candidateName)].filter(Boolean);
  // `bg`: employers named in an employment context (these decide);
  // `bgAny`: also the weak mentions (these only keep a holder from a hold).
  const hitsOf = (person) => {
    if (!person.bgAll) {
      person.bgAll = fitText ? backgroundMatches(person.item, fitText, { exclude: bgExclude, nameWords }) : [];
      person.bg = person.bgAll.filter((match) => match.strong).map((match) => match.name);
      person.bgAny = person.bgAll.map((match) => match.name);
    }
    return person.bg;
  };
  // Every namesake seen so far whose employers the note names (strongly).
  const bgPeople = () => [...people.values()].filter((person) => hitsOf(person).length);
  const evidence = {
    roleName,
    companyName,
    roleStatus: roleStatus || null,
    nameForm: parsed.nameForm,
    background: fitText ? "read" : sub.fitText === undefined ? "missing" : "none",
  };
  const chosen = (person, via) => ({
    candidateUserId: person.candidateUserId,
    linkedinUser: crmLinkedin(person.item),
    ctarMatch: Boolean(person.ctarMatch),
    via,
  });
  const finish = (status, extra = {}) => {
    const bgMatches = bgPeople().length;
    return { ...base, ...evidence, reads, bgMatches, ...extra, status, options: lookupOptions(people) };
  };

  // 1. Role-scoped search by first name. Paraform has not been measured
  // honouring filters.roles here (2026-11-06), so it counts only when every
  // row it returns carries the role; otherwise it is ignored entirely.
  let roleSearch = "ignored";
  const scopedRows = [];
  let roleSearchPages = 0;
  try {
    let cursor = null;
    let scoped = true;
    let complete = false;
    while (roleSearchPages < ROLE_SEARCH_MAX_PAGES) {
      const response = await read(CRM_SEARCH, {
        limit: CRM_PAGE_LIMIT,
        ...(cursor != null ? { cursor } : {}),
        filters: { sort: { ...CRM_SORT }, general_search: parsed.firstWord, roles: [base.roleId] },
      });
      roleSearchPages += 1;
      const items = Array.isArray(response?.items) ? response.items : [];
      if (items.some((item) => !roleLinkInRow(item, base.roleId))) { scoped = false; break; }
      scopedRows.push(...items);
      cursor = response?.next_cursor ?? null;
      if (cursor == null || items.length < CRM_PAGE_LIMIT) { complete = true; break; }
    }
    roleSearch = !scoped ? "ignored" : !scopedRows.length ? "empty" : complete ? "scoped" : "unfinished";
  } catch (error) {
    if (isStopError(error)) throw error;
    roleSearch = "error";
  }
  Object.assign(evidence, { roleSearch, roleSearchPages });
  if (roleSearch === "scoped" || roleSearch === "unfinished") for (const item of scopedRows) addPerson(item);
  // Two recent holders on the role is already a hold, unless the note's
  // background names exactly one of them (v4: the search goes on, and the
  // rules below decide on every namesake). One is never resolved
  // here (2026-11-06 review): Paraform's handling of filters.roles is not
  // measured, and someone on the role with an older link may have applied
  // just now, so the name search and the applications reads below still run.
  if (roleSearch === "scoped") {
    const holders = [...people.values()].filter((person) => person.link?.recent);
    if (holders.length > 1 && holders.filter((person) => hitsOf(person).length).length !== 1) {
      Object.assign(evidence, { nameMatches: people.size, confirmed: holders.length, crmRoleLinks: people.size, crmRolePath: holders[0]?.link.path || null });
      return finish("ambiguous");
    }
  }

  // 2. The name search, which must reach its end. An initial surname is
  // searched as "<first> <initial>", then by the first name alone only if
  // that found nobody compatible.
  // A full name is also searched as "<first> <surname initial>", which finds
  // a person Paraform shows as "First L." (2026-11-06); that second search
  // is tried only with pages to spare, and not finishing it does not undo
  // the full-name search (the lookup worked that way before it existed).
  const surnameInitial = parsed.nameForm === "full" && parsed.tokens.length >= 2
    ? parsed.tokens[parsed.tokens.length - 1].slice(0, 1) : "";
  const shortForm = /^[a-z]$/.test(surnameInitial) ? `${parsed.firstWord} ${surnameInitial.toUpperCase()}` : "";
  const cutShort = (person) => parsed.nameForm === "full" && rowSurnameInitial(parseNoteName(crmName(person.item)).tokens);
  const terms = parsed.nameForm === "initial" ? [parsed.search, parsed.firstWord] : [parsed.search, ...(shortForm ? [shortForm] : [])];
  let namePages = 0;
  let complete = false;
  let shortFormSearch = null;
  for (const [index, term] of terms.entries()) {
    if (index > 0 && !complete) break;
    const optional = index > 0 && term === shortForm;
    // Its pages come only from what the full-name result leaves spare: never
    // from the applications reads its namesakes need (2026-11-06 review).
    const fullUnchecked = [...people.values()].filter((person) => !person.link?.recent && !cutShort(person)).length;
    const pageCap = optional
      ? Math.min(NAME_SEARCH_TOTAL_PAGES - namePages, PROTECTED_LOOKUP_MAX_READS - reads - Math.min(fullUnchecked, MAX_NAME_MATCHES))
      : NAME_SEARCH_MAX_PAGES;
    if (optional && pageCap <= 0) { shortFormSearch = "skipped"; break; }
    let foundHere = 0;
    let cursor = null;
    let pages = 0;
    complete = false;
    while (pages < Math.min(NAME_SEARCH_MAX_PAGES, pageCap) && namePages < NAME_SEARCH_TOTAL_PAGES) {
      const response = await read(CRM_SEARCH, {
        limit: CRM_PAGE_LIMIT,
        ...(cursor != null ? { cursor } : {}),
        filters: { sort: { ...CRM_SORT }, general_search: term },
      });
      pages += 1;
      namePages += 1;
      const items = Array.isArray(response?.items) ? response.items : [];
      for (const item of items) {
        if (compatibleName(parsed, crmName(item)) && crmId(item)) foundHere += 1;
        addPerson(item);
      }
      cursor = response?.next_cursor ?? null;
      if (cursor == null || items.length < CRM_PAGE_LIMIT) { complete = true; break; }
    }
    if (optional) {
      shortFormSearch = complete ? "done" : "unfinished";
      complete = true;
      break;
    }
    if (foundHere && parsed.nameForm === "initial") break;
  }
  const all = [...people.values()];
  const linked = all.filter((person) => person.link);
  Object.assign(evidence, {
    nameMatches: people.size,
    crmPages: namePages,
    ...(shortFormSearch ? { shortFormSearch } : {}),
    crmRoleLinks: linked.length,
    crmRolePath: linked[0]?.link.path || null,
  });
  // The search did not reach its end: another person by that name could be
  // the one, so this is never a match.
  if (!complete) return finish("incomplete");

  // 3. Role before the namesake cap: the CRM rows are free to check; only
  // people without a recent row link need an applications read, and the cap
  // (and the lookup's read budget) limits only those reads.
  const rowHolders = all.filter((person) => person.link?.recent);
  // A full-named note's cut-short namesakes ("Avery Q.") without the role on
  // their row only come from the short-form search; they stay options but do
  // not take applications reads or block a full-name match, so the extra
  // search never turns a note that resolved before into a hold (2026-11-06).
  const unchecked = all.filter((person) => !person.link?.recent && !cutShort(person));
  const cutShortUncheckedPeople = all.filter((person) => !person.link?.recent && cutShort(person));
  const cutShortUnchecked = cutShortUncheckedPeople.length;
  if (cutShortUnchecked) evidence.cutShortUnchecked = cutShortUnchecked;

  // Every search really reached its end (2026-11-07 review): the short-form
  // search being cut off at its page cap does not undo the full-name search,
  // but a cut-short namesake past that cap was never seen.
  const searchFinished = complete && shortFormSearch !== "unfinished";

  // 4. The decision, v4 (2026-11-07, David's rules; see the header).
  // `holders` are the people with the role near the note: a recent CRM row
  // link, or an application read near the note (or with the note's own id).
  // `bg` are the namesakes whose employers the note's background names in an
  // employment context (strong; weak mentions only keep a holder from a hold).
  //   The note's own id on one person's application (ctarMatch): that is the
  //     person ("ctar"), whatever the background says; on two: "ambiguous".
  //   One holder: resolved ("role", or "role+background" when the note names
  //     their employer), whatever their surname looks like and however many
  //     full-name namesakes were left unread; held as "background_conflict"
  //     when the note names another namesake's employer and not theirs, and
  //     "incomplete" when their surname is cut short, the short-form search
  //     did not finish, and the background does not confirm them.
  //   Several holders: resolved on the one the note's background names, if
  //     exactly one namesake matches it ("background"); else "ambiguous".
  //   No holder: resolved on the one namesake the background names, every
  //     name search having finished ("background_only", via "background");
  //     two or more: "ambiguous"; none: null, and the caller's status stands.
  const decide = (holders, extra = {}) => {
    const ctar = holders.filter((entry) => entry.person.ctarMatch);
    if (ctar.length === 1) return finish("resolved", { ...extra, ...chosen(ctar[0].person, ctar[0].via), confirmedBy: "ctar" });
    if (ctar.length > 1) return finish("ambiguous", extra);
    const bg = bgPeople();
    const only = bg.length === 1 ? bg[0] : null;
    if (holders.length === 1) {
      const [{ person, via }] = holders;
      hitsOf(person);
      if (bg.length && !bg.includes(person) && !person.bgAny.length) return finish("background_conflict", extra);
      if (cutShort(person) && !searchFinished && roleSearch !== "scoped" && !bg.includes(person)) return finish("incomplete", extra);
      return finish("resolved", { ...extra, ...chosen(person, via), confirmedBy: bg.includes(person) ? "role+background" : "role" });
    }
    if (holders.length > 1) {
      const holder = only && holders.find((entry) => entry.person === only);
      if (holder) return finish("resolved", { ...extra, ...chosen(holder.person, holder.via), confirmedBy: "background" });
      return finish("ambiguous", extra);
    }
    if (only && searchFinished) return finish("resolved", { ...extra, ...chosen(only, "background"), confirmedBy: "background_only" });
    if (only) return finish("incomplete", extra);
    if (bg.length > 1) return finish("ambiguous", extra);
    return null;
  };

  const appsBudget = Math.max(0, Math.min(MAX_NAME_MATCHES, PROTECTED_LOOKUP_MAX_READS - reads));
  if (unchecked.length > appsBudget) {
    // Namesakes whose applications cannot all be read. v3 held even one row
    // holder here (an unread namesake might have the role in applications
    // only); v4 decides on what is free to see, the row holders and the
    // background, with no applications reads: one row holder resolves (rule
    // 2) unless the background contradicts it, and with no row holder the
    // one namesake the background names resolves (rule 1: the background
    // beats a role link that might sit unread in someone's applications).
    const extra = { confirmed: rowHolders.length, namesakesUnchecked: unchecked.length };
    const decided = decide(rowHolders.map((person) => ({ person, via: "crm_row" })), extra);
    if (decided) return decided;
    return finish("too_many", extra);
  }
  let onRoleRows = 0;
  const readApplications = async (person) => {
    const rows = await read("candidateUser.getCandidateUserApplications", { candidate_user_id: person.candidateUserId });
    const onRole = (Array.isArray(rows) ? rows : []).filter((row) => applicationRoleId(row) === base.roleId);
    onRoleRows += onRole.length;
    const exact = Boolean(clean(sub.ctarId)) && onRole.some((row) => (
      clean(row?.id) === clean(sub.ctarId) || clean(row?.candidate_to_approved_role_id) === clean(sub.ctarId)
    ));
    const times = onRole.map(applicationTimeMs).filter((ms) => ms != null);
    person.onRole = onRole;
    person.ctarMatch = exact;
    person.appConfirmed = exact || times.some(nearNote);
    person.appAtMs = times.length ? Math.max(...times) : null;
  };
  for (const person of unchecked) await readApplications(person);
  const holders = [
    ...rowHolders.map((person) => ({ person, via: "crm_row" })),
    ...unchecked.filter((person) => person.appConfirmed).map((person) => ({ person, via: "application" })),
  ];
  // Any reads the budget has left go to the cut-short namesakes not yet read
  // when the decision would rest on them being nobody: one holder whose own
  // surname is cut short (a second person with the role there is then seen,
  // and rule 2 applies, not a guess), or no holder and a resolve on the
  // background alone (2026-11-07 review: one of them may carry the note's
  // own application id). With one holder, those the budget cannot reach do
  // not hold the note (rule 1 of v4); with no holder they do ("incomplete").
  const bgOnly = !holders.length && bgPeople().length === 1 ? bgPeople()[0] : null;
  if (cutShortUnchecked && ((holders.length === 1 && cutShort(holders[0].person)) || bgOnly)) {
    let cutShortRead = 0;
    for (const person of cutShortUncheckedPeople) {
      if (reads >= PROTECTED_LOOKUP_MAX_READS) break;
      await readApplications(person);
      cutShortRead += 1;
      if (person.appConfirmed) holders.push({ person, via: "application" });
    }
    evidence.cutShortRead = cutShortRead;
    const unread = cutShortUncheckedPeople.filter((person) => person.onRole == null && person !== bgOnly);
    if (bgOnly && !holders.length && unread.length) {
      Object.assign(evidence, { onRoleRows, confirmed: 0 });
      return finish("incomplete", { cutShortUnread: unread.length });
    }
  }
  Object.assign(evidence, { onRoleRows, confirmed: holders.length });
  return decide(holders) || finish("not_found");
}

// Looks up at most `maxLookups` notes (one by default: a lookup is up to
// seven reads against the shared 10-a-minute pace cap), within `budgetMs`.
// It runs after the tick's sends. Notes staff picked are never looked up.
// Returns every stored lookup plus this tick's.
export async function runProtectedLookups({
  subs,
  historyIds,
  notBeforeMs,
  now = Date.now(),
  trpcGetImpl,
  backfill = 0,
  maxLookups = 1,
  windowMs = PROTECTED_LOOKUP_WINDOW_MS,
  skip = null,
  firstFromMs = null,
  picks = {},
  budgetMs = 25_000,
  clock = Date.now,
  store = {},
} = {}) {
  const s = { list: getProtectedLookups, save: saveProtectedLookup, prune: pruneProtectedLookups, getPick: getProtectedPick, ...store };
  const summary = { looked: 0, stopped: null };
  // An unreadable store would re-run (and overwrite) every lookup: skip.
  const lookups = await s.list().catch(() => null);
  if (!lookups) return { lookups: {}, ...summary, error: "lookup_store_unreadable" };
  if (typeof trpcGetImpl !== "function" || !subs?.size) return { lookups, ...summary };
  // Records for notes no longer stored or older than two windows go.
  const stale = Object.keys(lookups).filter((requestId) => {
    const sub = subs.get(requestId);
    const receivedMs = Date.parse(sub?.receivedAt || "");
    return !sub || !Number.isFinite(receivedMs) || receivedMs < now - 2 * windowMs;
  });
  if (stale.length) await s.prune(stale).catch(() => {});
  const started = clock();
  const queue = protectedLookupQueue({ subs, historyIds, lookups, notBeforeMs, now, backfill, windowMs, skip, firstFromMs, picks: picks || {} });
  for (const sub of queue.slice(0, maxLookups)) {
    if (clock() - started > budgetMs) { summary.stopped = "budget"; break; }
    const previous = lookups[sub.requestId] || null;
    let record;
    try {
      record = await lookupProtectedSub(sub, { trpcGetImpl, now, previous });
    } catch (error) {
      const code = clean(error?.code);
      const throttled = STOP_CODES.has(code) || Number(error?.status) === 429;
      // An older lookup's failure starts over (attempts from 0); the record
      // is this lookup's from now on, but its last finished check stays.
      const prior = carriedLookup(previous);
      // An older lookup's role, company and options stay on the record, so a
      // refused re-check never leaves the page with nothing (2026-11-06 review).
      const kept = prior || Object.fromEntries(["roleName", "companyName", "roleStatus", "nameForm", "options"]
        .filter((key) => previous?.[key] != null)
        .map((key) => [key, previous[key]]));
      record = {
        ...kept,
        requestId: sub.requestId,
        roleId: clean(sub.roleId) || null,
        lastTriedAt: new Date(now).toISOString(),
        version: PROTECTED_LOOKUP_VERSION,
        // A pacing refusal moves the note to the back of the queue without
        // using an attempt; any other error uses one.
        ...(throttled
          ? { status: prior?.status && prior.status !== "error" ? prior.status : "throttled", throttled: Number(prior?.throttled || 0) + 1 }
          : { status: "error", error: (code || clean(error?.name) || "error").slice(0, 60), attempts: Number(prior?.attempts || 0) + 1 }),
      };
      if (throttled) summary.stopped = code || "throttled";
    }
    record.afterSwitchOn = notBeforeMs != null && Date.parse(sub.receivedAt) >= notBeforeMs;
    summary.looked += 1;
    // `picks` was read at the start of the tick. A staff pick saved since
    // (while the sends or this lookup ran) wins: a lookup saved over it could
    // match the note to someone else and leave the pick unable to send or be
    // replaced (2026-11-06 second review). An unreadable pick saves nothing.
    const currentPick = await s.getPick(sub.requestId).catch(() => undefined);
    if (currentPick !== null) {
      summary.pickedMeanwhile = (summary.pickedMeanwhile || 0) + 1;
      if (summary.stopped) break;
      continue;
    }
    lookups[sub.requestId] = record;
    await s.save(record).catch(() => {});
    if (summary.stopped) break;
  }
  return { lookups, ...summary };
}

// Request rows for the resolved (or staff-picked) notes from the send cutoff
// on that the read does not hold and are not skipped. A staff "send" pick
// stands in for the lookup's answer (role and company still from the lookup
// record); a "skip" pick means no row. Every field the send path needs is
// present, or no row.
export function syntheticProtectedRequests({ subs, lookups = {}, historyIds, notBeforeMs, now = Date.now(), windowMs = PROTECTED_LOOKUP_WINDOW_MS, skip = null, states = [], picks = {} } = {}) {
  if (notBeforeMs == null) return [];
  // A person already emailed about this role under another request is not
  // emailed again (the backlog, 2026-11-05, holds notes for such roles).
  const emailedRoles = new Map();
  for (const state of states || []) {
    for (const match of Object.values(state?.matches || {})) {
      if (!match?.sentAt || !clean(match.roleId)) continue;
      const key = `${clean(state.candidateUserId)}\0${clean(match.roleId)}`;
      if (!emailedRoles.has(key)) emailedRoles.set(key, new Set());
      emailedRoles.get(key).add(clean(match.requestId));
    }
  }
  const rows = [];
  for (const sub of subs?.values?.() || []) {
    const lookup = lookups[sub.requestId];
    if (!lookup) continue;
    // Any staff pick overrides the lookup: "send" names the person, anything
    // else (a "skip", or a pick without a person) means no row.
    const pick = picks?.[sub.requestId] || null;
    if (pick && (pick.action !== "send" || !clean(pick.candidateUserId))) continue;
    // A send pick is no looser than the pick check (2026-11-06 review): a
    // role since read as unreadable, or a lookup that now names someone
    // else, means no row (a closed role does not, v4).
    if (pick && pickLookupProblem(lookup, pick)) continue;
    if (!pick && lookup.status !== "resolved") continue;
    const candidateUserId = pick ? clean(pick.candidateUserId) : lookup.candidateUserId;
    const linkedinUser = pick ? clean(pick.linkedinUser) || null : lookup.linkedinUser || null;
    if (historyIds?.has?.(sub.requestId)) continue;
    if (skip?.has?.(sub.requestId)) continue;
    const receivedMs = Date.parse(sub.receivedAt || "");
    if (!Number.isFinite(receivedMs) || receivedMs < notBeforeMs || receivedMs < now - windowMs) continue;
    const required = [sub.requestId, candidateUserId, sub.roleId, lookup.roleName, lookup.companyName, sub.submitUrl];
    if (required.some((value) => !clean(value))) continue;
    const roleKey = `${clean(candidateUserId)}\0${clean(sub.roleId)}`;
    const emailedFor = emailedRoles.get(roleKey);
    if (emailedFor && !emailedFor.has(sub.requestId)) continue;
    // Two notes for one person and role in one read: only the first.
    if (!emailedFor) emailedRoles.set(roleKey, new Set([sub.requestId]));
    rows.push({
      id: sub.requestId,
      status: "pending",
      synthetic: true,
      candidateUserId,
      candidateName: clean(sub.candidateName) || null,
      linkedinUser,
      roleId: sub.roleId,
      roleName: lookup.roleName,
      companyName: lookup.companyName,
      createdAt: new Date(receivedMs).toISOString(),
      createdAtMs: receivedMs,
      reachedOut: false,
      reachedOutAt: null,
      reachedOutAtMs: null,
      recipientTypes: [],
      ownRequest: true,
      protectedSub: {
        submitUrl: sub.submitUrl,
        ctarId: sub.ctarId || null,
        receivedAt: sub.receivedAt,
        sender: sub.sender || null,
        noteThreadId: sub.noteThreadId || null,
        via: pick ? "staff_pick" : lookup.via || null,
        ...(pick ? { pickedBy: clean(pick.pickedBy) || null } : {}),
      },
    });
  }
  return rows;
}

// Why the lookup record stops a staff "send" pick, or null (2026-11-06 review).
// A role on hold, paused or closed no longer stops one (v4, 2026-11-07,
// David's rule 3: those notes still get the email).
export function pickLookupProblem(lookup, pick) {
  if (!lookup) return "the note's lookup record is missing";
  if (lookup.status === "role_unreadable" || !clean(lookup.roleName) || !clean(lookup.companyName)) {
    return "the role could not be read on Paraform";
  }
  if (lookup.status === "resolved" && clean(lookup.candidateUserId) !== clean(pick?.candidateUserId)) {
    return "the lookup has since matched the note to someone else";
  }
  return null;
}

// Why a staff "send" pick made no row, or null when nothing in the lookup or
// the states stops it: for the unsent page and the picks page (2026-11-06
// review), so neither says "held for a pick" or "sends soon" when it won't.
export function protectedPickBlocked({ sub, lookup, pick, states = [] } = {}) {
  if (pick?.action !== "send" || !clean(pick.candidateUserId)) return null;
  const problem = pickLookupProblem(lookup, pick);
  if (problem) return problem;
  for (const state of states || []) {
    if (clean(state?.candidateUserId) !== clean(pick.candidateUserId)) continue;
    for (const [key, match] of Object.entries(state?.matches || {})) {
      const requestId = clean(match?.requestId) || key;
      if (match?.sentAt && clean(match.roleId) === clean(sub?.roleId) && requestId !== sub?.requestId) {
        return "that person was already emailed about this role under another request";
      }
    }
  }
  return null;
}

// Whether a protected row still matches the note's pick as read again just
// before the send claims it (2026-11-06 review: a skip or a new pick can land
// while a tick runs on the picks it read at its start). `current` undefined
// means the pick could not be read: nothing sends. A staff-pick row needs
// that same send pick; an automatic row needs no pick at all.
export function protectedPickStillSends(request, current) {
  if (current === undefined) return false;
  if (request?.protectedSub?.via === "staff_pick") {
    return current?.action === "send" && clean(current.candidateUserId) === clean(request.candidateUserId);
  }
  if (request?.synthetic) return current == null;
  // A row from Paraform's own request read that a note names (2026-11-06
  // second review): a staff skip, or a pick of someone else, stops it too,
  // so "skipped: this note will not be emailed" holds on that path as well.
  return current == null || (current.action === "send" && clean(current.candidateUserId) === clean(request?.candidateUserId));
}

// Every stored lookup; an unreadable store reads as none (so no row).
export async function getProtectedLookupsSafe() {
  return getProtectedLookups().catch(() => ({}));
}

// Why a note the read does not hold was not emailed, for the unsent watch.
export function lookupReason(lookup) {
  const held = "; held for a staff pick";
  const initial = lookup?.nameForm === "initial" ? " (the note shows the last name only as an initial)" : "";
  switch (lookup?.status) {
    case "not_found": return `no one on Paraform by that name has this role on their record${initial}${held}`;
    case "ambiguous": return Number(lookup.confirmed || 0) < 2 && Number(lookup.bgMatches || 0) > 1
      ? `more than one person on Paraform by that name worked at the employers the note names, and none has this role on their record${initial}${held}`
      : `more than one person on Paraform by that name has this role on their record${initial}${held}`;
    case "background_conflict": return `the one person on Paraform by that name with this role on their record did not work at the employers the note names, while another person by that name did${held}`;
    // Older lookups only (v3 and before); v4 decides these itself.
    case "unconfirmed_name": return `one person has this role on their record, but their last name is shown only as an initial, so it is not certain they are the person in the note${held}`;
    case "role_unreadable": return "the role in the note could not be read on Paraform";
    case "role_inactive": return `an older lookup stopped because Paraform shows the role as ${lookup.roleStatus || "not active"}; it is looked up again`;
    case "too_many": return Number(lookup.confirmed || 0) > 0
      ? `too many people on Paraform share that name to check every one; one has this role on their CRM row (listed first), so confirm it${held}`
      : `too many people on Paraform share that name, and none has this role on their CRM row, to be sure who it is${held}`;
    case "incomplete": return `the Paraform search by that name did not finish, so another person by that name could be the one${held}`;
    case "throttled": return "the candidate lookup is waiting on Paraform's request pacing";
    case "no_name": return "the note does not name the candidate";
    case "error": return `the candidate lookup failed (${lookup.error || "error"})`;
    case "resolved": return null;
    default: return "Paraform's request list does not show this request and the candidate lookup has not finished";
  }
}
