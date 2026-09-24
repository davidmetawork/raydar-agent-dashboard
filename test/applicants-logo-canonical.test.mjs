import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { mapEducation, mapExperience } from "../api/applicants/profile.mjs";
import { normalizeApplicantRowV2 } from "../api/applicants/_lib/profile-v2.mjs";
import { richProfileLogo } from "../api/applicants/_lib/rich-profile.mjs";

// A company/school logo is rendered as <img src>, which loads the RESOLVED
// path. A check on the raw string's prefix alone lets a dot segment walk out
// of Paraform's company-logos folder into another public bucket.
const PREFIX = "https://storage.googleapis.com/paraform-company-logo-urls/company-logos/";
const FOLDER = "/paraform-company-logo-urls/company-logos/";

// Each of these starts with the allowed prefix but resolves outside the folder.
const ESCAPES = [
  `${PREFIX}../../another-bucket/x.png`,
  `${PREFIX}%2e%2e/%2e%2e/another-bucket/x.png`,
  `${PREFIX}%2E%2E/%2E%2E/another-bucket/x.png`,
  `${PREFIX}.%2e/.%2e/another-bucket/x.png`,
  `${PREFIX}..\\..\\another-bucket\\x.png`,
  `${PREFIX}.\t./.\n./another-bucket/x.png`,
  `${PREFIX}../../paraform-company-logo-urls-look-alike/company-logos/x.png`,
];
// Non-canonical but still inside the folder: the browser refuses these too
// (the rule is "already canonical"); the server normalises them.
const IN_FOLDER_NON_CANONICAL = [`${PREFIX}sub/../x.png`, `${PREFIX}./x.png`];
const LOOK_ALIKES = [
  "https://storage.googleapis.com/paraform-company-logo-urls-look-alike/company-logos/x.png",
  "https://storage.googleapis.com/paraform-company-logo-urls/company-logos-look-alike/x.png",
  "https://storage.googleapis.com.look-alike.example/paraform-company-logo-urls/company-logos/x.png",
  "https://storage.googleapis.com/paraform-images/company-logos/x.png",
];
const CANONICAL = [`${PREFIX}synthetic.png`, `${PREFIX}clzabc123/logo-v2.webp`, `${PREFIX}a%20b.png`];

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");
const start = applicants.indexOf("const PARAFORM_TIERS");
const end = applicants.indexOf("function renderModal", start);
assert.ok(start >= 0 && end > start, "logo helpers are extractable from the shipped page");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const page = runInNewContext(`${applicants.slice(start, end)}; ({ allowedParaformLogo, entityLogoHtml })`, { esc, URL });

test("every escape fixture really resolves outside the logo folder", () => {
  for (const url of ESCAPES) assert.ok(!new URL(url).pathname.startsWith(FOLDER), url);
  for (const url of IN_FOLDER_NON_CANONICAL) assert.ok(new URL(url).pathname.startsWith(FOLDER), url);
});

test("the page refuses logo links that leave, or could leave, the folder", () => {
  for (const url of [...ESCAPES, ...IN_FOLDER_NON_CANONICAL, ...LOOK_ALIKES]) {
    assert.equal(page.allowedParaformLogo(url), "", url);
    assert.doesNotMatch(page.entityLogoHtml({ logo: url }, "company"), /<img/, url);
  }
  for (const url of CANONICAL) {
    assert.equal(page.allowedParaformLogo(url), url);
    assert.equal(page.allowedParaformLogo(`  ${url}  `), url);
    assert.match(page.entityLogoHtml({ logo: url }, "school"), /<img src="/);
  }
});

test("profile.mjs keeps only in-folder Paraform logos from the live read", () => {
  const ranks = new Map();
  const logoOf = (logoSrc) => [
    mapExperience({ company_id: 1, company: { id: 1, name: "Co", logo_src: logoSrc } }, ranks).logo,
    mapEducation({ school: { id: 2, name: "U", logo_src: logoSrc } }, ranks).logo,
  ];
  for (const url of [...ESCAPES, ...LOOK_ALIKES, `${PREFIX}x.png?token=x`, `http${PREFIX.slice(5)}x.png`, "", null, undefined]) {
    assert.deepEqual(logoOf(url), [null, null], String(url));
  }
  for (const url of CANONICAL) assert.deepEqual(logoOf(url), [url, url]);
  // An in-folder dot segment is resolved, and the page accepts the result.
  for (const url of IN_FOLDER_NON_CANONICAL) {
    const [experience, education] = logoOf(url);
    assert.equal(experience, `${PREFIX}x.png`);
    assert.equal(education, experience);
    assert.equal(page.allowedParaformLogo(experience), experience);
  }
});

test("the other server logo filters already refuse every escape", () => {
  const row = (logo) => normalizeApplicantRowV2({
    key: "core:application-logo",
    application: { applicationId: "a", tenantScopeId: "t", personId: "p", sourceObservationId: "o" },
    profile: { facts: {
      experiences: { state: "verified", entries: [{ recordId: "e", companyId: "c", state: "verified", logo }] },
      education: { state: "verified", entries: [{ recordId: "s", schoolId: "s", state: "verified", logo }] },
    } },
  }).profile.facts;
  for (const url of [...ESCAPES, ...LOOK_ALIKES]) {
    assert.equal(richProfileLogo(url), null, url);
    const facts = row(url);
    assert.equal(facts.experiences.entries[0].logo, null, url);
    assert.equal(facts.education.entries[0].logo, null, url);
  }
  for (const url of CANONICAL) {
    assert.equal(richProfileLogo(url), url);
    assert.equal(row(url).experiences.entries[0].logo, url);
  }
});
