import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEGREE_LEVELS,
  DEGREE_LEVEL_LABELS,
  degreeLevel,
  degreeLevels,
  levelMatches,
  normalizeDegree,
} from "../api/applicants/_lib/degree.mjs";

// Every distinct `degree` string observed in a live read-only sample of the
// C-tier and unrated review queue on 2026-08-20, with its hand-audited level.
// This is the regression contract: if a pattern change re-grades any real
// string, this fails and the change has to be justified against the corpus.
const CORPUS = JSON.parse(
  readFileSync(new URL("./fixtures/degree-strings.json", import.meta.url), "utf8"),
).cases;

test("the live corpus classifies exactly as audited", () => {
  assert.ok(CORPUS.length >= 130, "corpus should hold the full sampled set");
  const drift = CORPUS
    .map((row) => ({ ...row, got: degreeLevel(row.degree) }))
    .filter((row) => row.got !== row.level);
  assert.deepEqual(drift, [], "no live degree string may change level silently");
});

test("the corpus covers every level the picker offers", () => {
  const seen = new Set(CORPUS.map((row) => row.level));
  for (const level of DEGREE_LEVELS) {
    assert.ok(seen.has(level), `corpus has no example of ${level}`);
  }
  assert.ok(seen.has("unknown"), "corpus must include unreadable strings too");
});

test("every level has a picker label, and unknown deliberately has none", () => {
  for (const level of DEGREE_LEVELS) {
    assert.equal(typeof DEGREE_LEVEL_LABELS[level], "string");
  }
  assert.equal(DEGREE_LEVEL_LABELS.unknown, undefined);
});

// ── the collisions the ordering exists to resolve ──────────────────────────
// Each of these is a string that a naive matcher grades wrongly.

test("a bachelor's that mentions a certificate is still a bachelor's", () => {
  assert.equal(
    degreeLevel("Bachelor of Arts - BA Mathematics & Economics with a Certificate in Financial Policy and Analysis"),
    "bachelors",
  );
});

test("a high school diploma is secondary, not a certificate", () => {
  assert.equal(degreeLevel("High School Diploma"), "secondary");
  assert.equal(degreeLevel("High School American Diploma & Colombian Bachillerato"), "secondary");
  assert.equal(degreeLevel("Senior Secondary Science and Maths"), "secondary");
  assert.equal(degreeLevel("Secondary Education CBSE"), "secondary");
});

test("an explicit bachelor's beats a secondary field of study", () => {
  for (const degree of [
    "A.B. Physics, with Secondary in Computer Science",
    "B.A. Mathematics with Secondary in Economics",
    "S.B. Computer Science, Secondary in Statistics",
    "BSc Physics with Secondary in Data Science",
  ]) {
    assert.equal(degreeLevel(degree), "bachelors", degree);
  }
  assert.equal(degreeLevel("Secondary in Computer Science"), "unknown");
});

test("an explicit credential beats the projected Secondary Education subject", () => {
  assert.equal(degreeLevel("BS — Secondary Education"), "bachelors");
  assert.equal(degreeLevel("MS — Secondary Education: Pedagogy and Practice"), "masters");
  assert.equal(degreeLevel("Senior Secondary Science and Maths"), "secondary");
  assert.equal(degreeLevel("Secondary Education CBSE"), "secondary");
});

test("reviewed explicit bachelor's aliases do not require subject inference", () => {
  for (const degree of [
    "BFA — Graphic Design",
    "B.F.A. — Communication Design",
    "B.Arch — Architecture",
    "B.Des. — Knitwear Design & Technology",
    "BDes — Interior Design",
    "BSBA — Business Management",
    "Bchelor — Business Administration",
    "Laurea triennale — Disegno di moda/abbigliamento",
    "Sarjana Komputer — Double Degree Program",
    "理学学士学位 — 计算机与科学",
  ]) {
    assert.equal(degreeLevel(degree), "bachelors", degree);
  }
  assert.equal(degreeLevel("BachelorTechnology"), "unknown", "unreviewed glued text stays unknown");
  assert.equal(degreeLevel("Engineering Degree — Computer Science"), "unknown");
});

test("reviewed explicit master's aliases cannot become bachelor's", () => {
  for (const degree of [
    "M.B.A.",
    "PGDBM, (M.B.A.) — IT Business Management",
    "Ed.M. — Education Policy",
    "M.E. — Engineering Management",
    "M.Ed — Educational Technology",
    "M.L.S. — Legal Studies",
    "ME — Industrial Engineering",
    "MPS — Information Science",
    "MSAI — Artificial Intelligence",
    "MSE — Bioengineering",
    "MSEE — Electrical Engineering",
  ]) {
    assert.equal(degreeLevel(degree), "masters", degree);
  }
});

test("explicit dual credentials expose both levels without changing the scalar", () => {
  for (const degree of [
    "B.A./M.A. — Motion Media Design",
    "B.S. and M.S. — Engineering",
    "M.S. & B.S. — Engineering Mechanics",
    "Master’s and Bachelor of Science — Economics",
    "BS/MS dual — Electrical Engineering",
    "Dual Degree: BS MS — Electrical Engineering",
    "Bachelor of Arts, Master of Arts",
  ]) {
    assert.equal(degreeLevel(degree), "masters", degree);
    assert.deepEqual(degreeLevels(degree), ["masters", "bachelors"], degree);
  }
});

test("multiple-level detection requires explicit credential tokens around a connector", () => {
  assert.deepEqual(degreeLevels("Bachelor of Science, Boston MA"), ["bachelors"]);
  assert.deepEqual(degreeLevels("Bachelor of Arts, MA"), ["bachelors"]);
  assert.deepEqual(degreeLevels("BSc, MSc — Computer Science"), ["masters"]);
  assert.deepEqual(degreeLevels("B A, MBA — Human Resources"), ["masters"]);
  assert.deepEqual(degreeLevels("Bachelor of Science with master's coursework"), ["masters"]);
  assert.deepEqual(degreeLevels("MBA / MA Dual Degree"), ["masters"]);
  assert.deepEqual(degreeLevels("INTEGRATED DUAL DEGREE — Computer Science"), []);
  assert.deepEqual(degreeLevels(null), []);
});

test("new exact aliases cannot outrank a stronger explicit credential", () => {
  assert.equal(degreeLevel("BFA / Master of Science"), "masters");
  assert.deepEqual(degreeLevels("BFA / Master of Science"), ["masters", "bachelors"]);
  assert.equal(degreeLevel("M.E. — Doctor of Philosophy"), "doctorate");
  assert.deepEqual(degreeLevels("M.E. — Doctor of Philosophy"), ["doctorate"]);
  assert.equal(degreeLevel("BA/MA/PhD"), "doctorate");
  assert.deepEqual(degreeLevels("BA/MA/PhD"), ["doctorate", "masters", "bachelors"]);
});

test("an Indian post graduate diploma is a master's, but a graduate certificate is not", () => {
  assert.equal(degreeLevel("Post Graduate Diploma in Management Finance"), "masters");
  assert.equal(degreeLevel("PGDM Marketing"), "masters");
  assert.equal(degreeLevel("Graduate Certificate in Data Science"), "certificate");
});

test("a professional designation containing 'Associate' is not an associate degree", () => {
  assert.equal(degreeLevel("ARM - Associate Risk Mgmt"), "certificate");
  assert.equal(degreeLevel("Associate's degree Business Administration"), "associate");
  assert.equal(degreeLevel("Associate of Applied Science in Nursing"), "associate");
});

test("clear Associate degree prefixes cover current source spellings", () => {
  for (const degree of [
    "Associate",
    "Associate's — Computer Science",
    "Associate — Graphic Design",
    "Associates — Applied Science",
    "Associates Degree — Communications",
    "Associate of Fine Arts",
    "Associate of Economics — Consumer Behavior",
    "Associates of Science — Computer Information Technology",
    "Associates in Arts — Computer Science",
  ]) {
    assert.equal(degreeLevel(degree), "associate", degree);
  }
});

test("Associate job titles remain unknown", () => {
  for (const title of [
    "Associate Professor",
    "Research Associate",
    "Associate Director",
    "Associate - Director",
    "Associate: Director",
    "Associate Product Manager",
    "Assistant Associate Professor",
  ]) {
    assert.equal(degreeLevel(title), "unknown", title);
  }
  assert.equal(
    degreeLevel("Associate — Business Administration and Entrepreneurial Certificate"),
    "certificate",
    "the explicit certificate remains the stronger credential",
  );
});

test("a spelled-out credential beats a two-letter token elsewhere in the string", () => {
  // The reason the classifier runs two passes: "MA" is Massachusetts here.
  assert.equal(degreeLevel("Bachelor of Science, Boston MA"), "bachelors");
  assert.equal(degreeLevel("Bachelor of Arts, Springfield MS"), "bachelors");
});

test("a doctorate outranks everything else in the same string", () => {
  assert.equal(degreeLevel("Doctor of Medicine (M.D.)"), "doctorate");
  assert.equal(degreeLevel("PhD Computer Science, MS Computer Science"), "doctorate");
});

test("abbreviation-only strings still resolve", () => {
  assert.equal(degreeLevel("BS Chemistry"), "bachelors");
  assert.equal(degreeLevel("B.tech Information Technology"), "bachelors");
  assert.equal(degreeLevel("BE Computer Engineering"), "bachelors");
  assert.equal(degreeLevel("MSBA (Business Analytics)"), "masters");
  assert.equal(degreeLevel("Executive MBA"), "masters");
  assert.equal(degreeLevel("DBA"), "doctorate");
  assert.equal(degreeLevel("PUC"), "secondary");
});

test("word order does not matter", () => {
  assert.equal(degreeLevel("Computer Science, Bachelor in Science"), "bachelors");
});

// ── normalisation ─────────────────────────────────────────────────────────

test("curly and straight apostrophes are the same credential", () => {
  assert.equal(degreeLevel("Bachelor’s Degree"), degreeLevel("Bachelor's degree"));
  assert.equal(normalizeDegree("Bachelor’s Degree"), "bachelor's degree");
});

test("punctuation and accents fold away", () => {
  assert.equal(normalizeDegree("B.Tech — Computer Sci."), "b tech computer sci");
  assert.equal(degreeLevel("Licenciatura en Informática"), "bachelors");
});

// ── unknown is a real answer, and it never satisfies a rule ───────────────

test("a subject with no credential is unknown, not a guess", () => {
  for (const raw of ["Mechanical Engineering", "Science", "School", "", null, undefined]) {
    assert.equal(degreeLevel(raw), "unknown", `expected unknown for ${JSON.stringify(raw)}`);
  }
});

test("malformed input answers unknown instead of throwing", () => {
  for (const raw of [42, {}, [], true, NaN]) {
    assert.doesNotThrow(() => degreeLevel(raw));
  }
});

test("an unknown level can never satisfy a degree condition", () => {
  assert.equal(levelMatches("unknown", ["bachelors", "masters"]), false);
  assert.equal(levelMatches("unknown", "unknown"), false, "not even by asking for unknown");
  assert.equal(levelMatches(null, ["bachelors"]), false);
  assert.equal(levelMatches(undefined, ["bachelors"]), false);
});

test("levelMatches accepts a bare level or a list", () => {
  assert.equal(levelMatches("bachelors", "bachelors"), true);
  assert.equal(levelMatches("bachelors", ["masters", "bachelors"]), true);
  assert.equal(levelMatches("bachelors", ["masters"]), false);
  assert.equal(levelMatches("bachelors", []), false);
  assert.equal(levelMatches(["masters", "bachelors"], "bachelors"), true);
  assert.equal(levelMatches(["masters", "bachelors"], ["doctorate", "masters"]), true);
  assert.equal(levelMatches(["masters"], "bachelors"), false);
  assert.equal(levelMatches([], "bachelors"), false);
  assert.equal(levelMatches(["unknown"], "unknown"), false);
});
