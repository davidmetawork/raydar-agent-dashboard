// Is this school in the United States?
//
// WHY THIS EXISTS. "A bachelor's from an accredited US university" was the
// first rule David asked for that the catalog could not express: nothing in a
// facts record said where a school is. The nearest stand-in was the
// APPLICANT's own location, which answers a different question — measured
// 2026-08-25, four of the thirty-four people a "bachelor's + computer + lives
// in the United States" rule matched hold an Indian Bachelor of Technology.
//
// The answer was already in the payload the prewarmer fetches. Paraform's
// per-education `school` object carries `primary_location` and `website`;
// neither profile writer mapped them until now.
//
// THREE STEPS, IN THIS ORDER, AND THE ORDER IS LOAD-BEARING.
//
//   1. A location whose last segment names a country that is NOT the United
//      States is a FULL STOP — no later signal can overturn it. This step
//      exists because of PES University, Bengaluru: it holds `pes.edu`, a
//      legacy .edu registered before the 2001 rules closed the domain to
//      non-US institutions, and on 2026-08-25 it auto-interviewed an Indian
//      B.Tech holder. An explicit country always beats a domain suffix.
//   2. A `.edu` website. The registry restricts new .edu registrations to
//      institutions accredited by an agency the US Department of Education
//      recognises, so it is the one signal that speaks to "accredited" as
//      well as "US" — for every school whose location did not already say
//      otherwise. It must be matched on the END of the hostname:
//      `srmist.edu.in` and `umt.edu.pk` are neither .edu nor US.
//   3. A location whose LAST segment names the country. "Austin, Texas,
//      United States" is the common shape.
//
// WHAT IS DELIBERATELY REFUSED. A bare state, spelled out or abbreviated,
// is not enough. "Tbilisi, Georgia" is a country; "Sriperumbudur, TN" is
// Tamil Nadu, not Tennessee; "Toronto, ON, CA" is Canada, not California. A
// rule that auto-interviews people cannot be built on a coin-flip, so an
// unrecognised location returns false and the applicant simply does not
// match — the same fail-closed answer the rest of the engine gives.
//
// The tail this leaves is real and measured: across 41 sampled education
// rows, 16 named the US in `primary_location`, 18 had a .edu site, 19 had one
// or the other — and Wagner College, CSU Dominguez Hills and Essex County
// College carried NEITHER, because Paraform holds no location and no website
// for them. Those skip. Never guess an interview.

const lower = (value) => String(value ?? "").trim().toLowerCase();

/** Country names, as the LAST comma-separated segment of a location. */
const US_COUNTRY = new Set([
  "united states",
  "united states of america",
  "usa",
  "u.s.a.",
  "u.s.",
  "us",
]);

/**
 * Country names that appear as the last segment of a LinkedIn school location.
 * Deliberately a country list and nothing else: it is only ever asked "does
 * this name a country other than the US", so an unlisted country simply falls
 * through to the .edu test, which is the behaviour that existed before.
 * Grown from the countries actually seen in this queue plus the rest of the
 * world's larger senders of applicants.
 */
const COUNTRIES = new Set([
  "afghanistan", "albania", "algeria", "argentina", "armenia", "australia", "austria",
  "azerbaijan", "bahrain", "bangladesh", "belarus", "belgium", "bolivia", "bosnia and herzegovina",
  "brazil", "bulgaria", "cambodia", "cameroon", "canada", "chile", "china", "colombia",
  "costa rica", "croatia", "cuba", "cyprus", "czechia", "czech republic", "denmark",
  "dominican republic", "ecuador", "egypt", "el salvador", "estonia", "ethiopia", "finland",
  "france", "georgia", "germany", "ghana", "greece", "guatemala", "honduras", "hong kong",
  "hungary", "iceland", "india", "indonesia", "iran", "iraq", "ireland", "israel", "italy",
  "jamaica", "japan", "jordan", "kazakhstan", "kenya", "kuwait", "kyrgyzstan", "laos",
  "latvia", "lebanon", "libya", "lithuania", "luxembourg", "malaysia", "malta", "mexico",
  "moldova", "mongolia", "montenegro", "morocco", "myanmar", "nepal", "netherlands",
  "new zealand", "nicaragua", "nigeria", "north macedonia", "norway", "oman", "pakistan",
  "palestine", "panama", "paraguay", "peru", "philippines", "poland", "portugal", "qatar",
  "romania", "russia", "russian federation", "rwanda", "saudi arabia", "senegal", "serbia",
  "singapore", "slovakia", "slovenia", "somalia", "south africa", "south korea", "korea",
  "spain", "sri lanka", "sudan", "sweden", "switzerland", "syria", "taiwan", "tanzania",
  "thailand", "tunisia", "turkey", "türkiye", "uganda", "ukraine", "united arab emirates",
  "united kingdom", "england", "scotland", "wales", "northern ireland", "uruguay",
  "uzbekistan", "venezuela", "vietnam", "yemen", "zambia", "zimbabwe",
  // Common full and abbreviated forms in provider school locations.
  "uae", "u.a.e", "state of qatar",
]);

/** True when the website's hostname ends in `.edu` — never a substring. */
export function isDotEdu(website) {
  const raw = String(website ?? "").trim();
  if (!raw) return false;
  let host;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return false;
  }
  return /\.edu$/i.test(host);
}

/** True when the location's last segment names the United States. */
export function locationSaysUS(location) {
  const parts = lower(location).split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return false;
  // Trailing full stops vary in the wild ("U.S.A." and "U.S.A" both occur), so
  // the bare and dotted forms are both asked of the same set.
  const last = parts[parts.length - 1].replace(/\.$/, "");
  return US_COUNTRY.has(last) || US_COUNTRY.has(`${last}.`);
}

/**
 * Does the location's last segment name a country at all? Only a recognised
 * country name counts — a street address, a bare city or a US state does not,
 * so those fall through to the .edu test rather than vetoing it.
 */
export function locationNamesForeignCountry(location) {
  const parts = lower(location).split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;      // "Utica, ny" has no country to read
  const last = parts[parts.length - 1].replace(/\.$/, "");
  if (US_COUNTRY.has(last) || US_COUNTRY.has(`${last}.`)) return false;
  return COUNTRIES.has(last);
}

/**
 * One school row -> is it in the US? Total: anything unrecognised is `false`,
 * never null, so the evaluator has a plain boolean to compare and an unknown
 * school can never satisfy a rule.
 */
export function schoolInUS({ website = null, location = null } = {}) {
  if (locationNamesForeignCountry(location)) return false;
  return isDotEdu(website) || locationSaysUS(location);
}
