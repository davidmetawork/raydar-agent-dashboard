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
// TWO SIGNALS, IN THIS ORDER, AND THE ORDER IS LOAD-BEARING.
//
//   1. A `.edu` website. The registry restricts .edu to institutions
//      accredited by an agency the US Department of Education recognises, so
//      this is the ONE signal that speaks to "accredited" as well as "US".
//      It must be matched on the END of the hostname: `srmist.edu.in` and
//      `umt.edu.pk` are real schools in this queue and neither is a .edu.
//   2. A location whose LAST segment names the country. "Austin, Texas,
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
 * One school row -> is it in the US? Total: anything unrecognised is `false`,
 * never null, so the evaluator has a plain boolean to compare and an unknown
 * school can never satisfy a rule.
 */
export function schoolInUS({ website = null, location = null } = {}) {
  return isDotEdu(website) || locationSaysUS(location);
}
