// Is this school on one of David's curated top-university lists?
//
// WHY NAMES AND NOT IDS. Everything else in the rules engine matches schools
// by Paraform's stable id, and for good reason (Harvard College vs Harvard
// Business School). A curated world-ranking list is the one place ids cannot
// work: an id is only learnable from a profile we have already seen, so an id
// list could never match the first Stanford applicant to arrive after it was
// written — and Paraform gives every sub-college its own id ("UC Berkeley
// College of Engineering" is a separate record from "University of California,
// Berkeley"), so an id list would also need every constituent school of all
// 95 universities. Names are what LinkedIn actually carries.
//
// WHY EXACT MATCH AND NOT SUBSTRINGS. "University of Michigan-Dearborn"
// contains "University of Michigan" and is not a top-50 school; "Berkeley
// City College" contains "Berkeley". Every alias below matches the WHOLE
// normalized name or nothing. Sub-colleges we want (Haas, the Berkeley
// engineering college) get their own explicit alias. A top school spelled a
// way this file has not seen simply does not match — the same fail-closed
// answer the rest of the engine gives — and the fix is to add the alias here.
//
// THE LISTS ARE EDITORIAL AND LIVE HERE ON PURPOSE. Paraform has no ranking
// field, so "top 50 US" is necessarily somebody's list — these are drawn from
// the standard rankings (US News national universities; THE/QS for Canada,
// Europe and Asia; NIRF for India) as of 2026, trimmed to the sizes David
// asked for (50/10/5/10/20). Amending a list is editing this file; every
// entry is one line.
//
// A school on two lists (the IITs are top-5 India AND top-20 Asia) is
// assigned the FIRST group below that claims it, which only affects which
// rule's name appears in the audit — every group rule presses the same
// Interview button.

/** Normalized: lowercased, de-accented, punctuation to spaces, parentheticals
 *  dropped, "&" spelled out, leading "the " removed. */
export function normalizeSchool(name) {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, " ")
    // Apostrophes are removed, not spaced: "Queen's" must read "queens".
    .replace(/['\u2019]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/** group -> list of alias spellings (normalized form). */
const GROUPS = {
  us50: [
    ["princeton university"],
    ["massachusetts institute of technology", "mit"],
    ["harvard university", "harvard college"],
    ["stanford university"],
    ["yale university"],
    ["california institute of technology", "caltech"],
    ["duke university"],
    ["johns hopkins university"],
    ["northwestern university"],
    ["university of pennsylvania", "upenn"],
    ["cornell university"],
    ["university of chicago"],
    ["brown university"],
    ["columbia university", "columbia university in the city of new york"],
    ["dartmouth college"],
    ["university of california los angeles", "ucla"],
    ["university of california berkeley", "uc berkeley",
      "uc berkeley college of engineering",
      "uc berkeley college of computing data science and society",
      "university of california berkeley haas school of business"],
    ["rice university"],
    ["university of notre dame"],
    ["vanderbilt university"],
    ["carnegie mellon university", "carnegie mellon"],
    ["university of michigan", "university of michigan ann arbor"],
    ["washington university in st louis"],
    ["emory university"],
    ["georgetown university"],
    ["university of virginia"],
    ["university of north carolina at chapel hill", "university of north carolina chapel hill"],
    ["university of southern california", "usc"],
    ["university of california san diego", "uc san diego", "ucsd"],
    ["new york university", "nyu"],
    ["university of florida"],
    ["university of texas at austin", "university of texas austin", "ut austin"],
    ["georgia institute of technology", "georgia tech"],
    ["university of california davis", "uc davis"],
    ["university of california irvine", "uc irvine"],
    ["university of illinois urbana champaign", "university of illinois at urbana champaign"],
    ["boston college"],
    ["case western reserve university"],
    ["university of california santa barbara", "uc santa barbara", "ucsb"],
    ["tufts university"],
    ["wake forest university"],
    ["college of william and mary", "william and mary"],
    ["ohio state university"],
    ["purdue university"],
    ["rutgers university new brunswick", "rutgers university"],
    ["university of washington"],
    ["university of wisconsin madison"],
    ["boston university"],
    ["university of rochester"],
    ["university of maryland college park", "university of maryland"],
  ],
  ca10: [
    ["university of toronto"],
    ["university of british columbia", "ubc"],
    ["mcgill university"],
    ["mcmaster university"],
    ["university of alberta"],
    ["university of waterloo"],
    ["western university", "university of western ontario"],
    ["universite de montreal"],
    ["university of calgary"],
    ["queens university"],
  ],
  in5: [
    ["indian institute of technology bombay", "iit bombay"],
    ["indian institute of technology delhi", "iit delhi"],
    ["indian institute of technology madras", "iit madras"],
    ["indian institute of science", "iisc bangalore", "indian institute of science bangalore"],
    ["indian institute of technology kanpur", "iit kanpur"],
  ],
  eu10: [
    ["university of oxford", "oxford university"],
    ["university of cambridge", "cambridge university"],
    ["imperial college london"],
    ["eth zurich", "swiss federal institute of technology zurich"],
    ["university college london", "ucl"],
    ["ecole polytechnique federale de lausanne", "epfl"],
    ["university of edinburgh"],
    ["technical university of munich", "technische universitat munchen"],
    ["london school of economics and political science", "london school of economics", "lse"],
    ["kings college london"],
  ],
  asia20: [
    ["national university of singapore", "nus"],
    ["nanyang technological university", "nanyang technological university singapore"],
    ["university of hong kong"],
    ["peking university"],
    ["tsinghua university"],
    ["zhejiang university"],
    ["fudan university"],
    ["shanghai jiao tong university"],
    ["university of science and technology of china"],
    ["korea advanced institute of science and technology", "kaist"],
    ["seoul national university"],
    ["yonsei university"],
    ["korea university"],
    ["hong kong university of science and technology", "hkust"],
    ["chinese university of hong kong"],
    ["university of tokyo", "tokyo university"],
    ["kyoto university"],
    ["city university of hong kong"],
    ["nanjing university"],
    ["university of malaya", "universiti malaya"],
  ],
};

/** Human labels for the audit and the docs. */
export const TOP_GROUP_LABELS = {
  us50: "Top 50 US",
  ca10: "Top 10 Canada",
  in5: "Top 5 India",
  eu10: "Top 10 Europe",
  asia20: "Top 20 Asia",
};

const INDEX = new Map();
for (const [group, schools] of Object.entries(GROUPS)) {
  for (const aliases of schools) {
    for (const alias of aliases) {
      // First group wins for shared entries — see the header note.
      if (!INDEX.has(alias)) INDEX.set(alias, group);
    }
  }
}

/** One school name -> its group, or null. Total; never throws. */
export function topSchoolGroup(name) {
  const normalized = normalizeSchool(name);
  return normalized ? INDEX.get(normalized) ?? null : null;
}
