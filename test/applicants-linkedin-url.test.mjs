import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");
const helperStart = applicants.indexOf("function linkedinProfileUrl(value)");
const helperBlockStart = applicants.indexOf("function linkedinRawUrlPath(value)");
const helperBlockEnd = applicants.indexOf("\nfunction initials", helperStart);
assert.ok(helperBlockStart >= 0 && helperBlockEnd > helperStart, "LinkedIn link boundary is extractable");
const helperSource = applicants.slice(helperBlockStart, helperBlockEnd);
const { linkedinProfileUrl, preferredLinkedinProfileUrl, liAnchor, nameLinks } = runInNewContext(
  `${helperSource}; ({ linkedinProfileUrl, preferredLinkedinProfileUrl, liAnchor, nameLinks })`,
  {
    URL,
    decodeURIComponent,
    encodeURIComponent,
    ICON_LI: "<svg>linkedin</svg>",
    ICON_PF: "<svg>paraform</svg>",
    esc: (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]),
  },
);

test("LinkedIn helper canonicalizes every supported Paraform profile shape", () => {
  assert.equal(linkedinProfileUrl("synthetic-person"), "https://www.linkedin.com/in/synthetic-person");
  for (const value of [
    "linkedin.com/in/SyntheticPerson",
    "www.linkedin.com/in/SyntheticPerson/",
    "http://uk.linkedin.com/in/SyntheticPerson/?trk=profile#top",
    "https://www.linkedin.com/in/SyntheticPerson",
  ]) assert.equal(linkedinProfileUrl(value), "https://www.linkedin.com/in/SyntheticPerson", value);
  assert.equal(
    linkedinProfileUrl("https://www.linkedin.com/pub/Synthetic-Person/12/345/678?trk=profile"),
    "https://www.linkedin.com/pub/Synthetic-Person/12/345/678",
  );
  assert.equal(
    linkedinProfileUrl("<https://www.linkedin.com/in/SyntheticPerson>"),
    "https://www.linkedin.com/in/SyntheticPerson",
  );
  assert.equal(
    linkedinProfileUrl("https://www.linkedin.com/in/SyntheticPerson."),
    "https://www.linkedin.com/in/SyntheticPerson",
  );
});

test("LinkedIn helper is idempotent and never creates a double prefix", () => {
  const canonical = "https://www.linkedin.com/in/synthetic-person";
  assert.equal(linkedinProfileUrl(canonical), canonical);
  assert.equal(linkedinProfileUrl(linkedinProfileUrl(canonical)), canonical);
  assert.doesNotMatch(linkedinProfileUrl(canonical), /\/in\/https?:/i);
});

test("LinkedIn helper fails closed on unsafe or non-profile values", () => {
  for (const value of [
    "",
    "not a handle",
    "javascript:alert(1)",
    "ftp://www.linkedin.com/in/example",
    "https://linkedin.com.evil.example/in/example",
    "https://user:pass@www.linkedin.com/in/example",
    "https://www.linkedin.com:8443/in/example",
    "https://www.linkedin.com/company/example",
    "https://www.linkedin.com/jobs/view/123",
    "https://www.linkedin.com/in/example/extra",
    "https://www.linkedin.com/in/https://www.linkedin.com/in/example",
    "https://www.linkedin.com/in/example%2Fother",
    "https://www.linkedin.com/in/example%252Fother",
    "https://www.linkedin.com/in/jané",
    "https://www.linkedin.com/in/example\\other",
    "example?truncated=true",
    "example#truncated",
    "AEMAAAabcdefghijklmnop",
    "https://www.linkedin.com/in/AEMAAAabcdefghijklmnop",
    "@example",
  ]) {
    assert.equal(linkedinProfileUrl(value), "", value);
  }
});

test("rendered row links use the exact canonical href", () => {
  const expected = "https://www.linkedin.com/in/SyntheticPerson";
  for (const value of ["SyntheticPerson", "https://uk.linkedin.com/in/SyntheticPerson?trk=profile"]) {
    const rendered = liAnchor(value);
    assert.match(rendered, new RegExp(`href="${expected}"`), value);
    assert.match(rendered, /rel="noopener noreferrer"/);
  }
  assert.equal(liAnchor("https://linkedin.example/in/SyntheticPerson"), "");
  const row = nameLinks({ linkedin: "https://www.linkedin.com/in/SyntheticPerson", cuId: "synthetic-id" });
  assert.match(row, new RegExp(`href="${expected}"`));
  assert.doesNotMatch(row, /\/in\/https?:/iu);
});

test("modal preference falls back when cached profile identity is invalid", () => {
  assert.equal(
    preferredLinkedinProfileUrl("https://linkedin.example/in/stale", "SyntheticPerson"),
    "https://www.linkedin.com/in/SyntheticPerson",
  );
  assert.match(
    applicants,
    /const linkedin = preferredLinkedinProfileUrl\(p\.linkedin, row\.linkedin\);/,
  );
});

test("row, modal, and No LinkedIn filtering share the canonicalizer", () => {
  assert.match(applicants, /function liAnchor\(value\) \{\s*const url = linkedinProfileUrl\(value\);/);
  assert.match(applicants, /function nameLinks\(row\) \{\s*return '[^']*' \+ liAnchor\(row\.linkedin\)/);
  assert.match(applicants, /'<span class="links">' \+ liAnchor\(linkedin\) \+ pfAnchor\(row\.cuId\)/);
  assert.match(applicants, /return !linkedinProfileUrl\(row\.linkedin\);/);
  assert.doesNotMatch(applicants, /"https:\/\/linkedin\.com\/in\/" \+ row\.linkedin/);
});

test("empty cached history is not mislabeled as a missing LinkedIn profile", () => {
  // A source that reported an empty history is a real, publishable outcome and
  // must read differently from a profile we simply have not cached yet.
  assert.match(applicants, /The source reported no work or education history\./);
  assert.match(applicants, /No work or education history is listed in this profile\./);
  assert.doesNotMatch(applicants, /No LinkedIn history on file/);
});
