import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

test("Applicants installs the complete compact-card index from the feed", () => {
  assert.match(applicants, /STATE\.cards = body\.cards \|\| \{\}/);
  assert.match(applicants, /fetch\("\/api\/applicants\/feed"/);
  assert.doesNotMatch(applicants, /\/api\/applicants\/cards\?cus=/);
});

test("scrolling is local DOM virtualization, not data pagination or hydration", () => {
  assert.match(applicants, /function renderVirtual\(el\)/);
  assert.match(applicants, /spec\.rows\.slice\(start, end\)/);
  assert.match(applicants, /class="virtual-space"/);
  assert.doesNotMatch(applicants, /const PAGE =|STATE\.limit|Loading more|data-sentinel|pumpHydration|pumpCards/);
});

test("the full profile endpoint is reached only from an explicit profile open", () => {
  assert.match(applicants, /function openProfile\(key\)[\s\S]*?fetchProfile\(id\)/);
  assert.match(applicants, /Open full profile/);
});

test("Interview controls fail closed on the Core readiness bit", () => {
  assert.match(applicants, /const interviewReady = row\.interviewAllowed === true/);
  assert.match(applicants, /row\?\.interviewAllowed !== true/);
  assert.match(applicants, /Required profile checks are not ready/);
});
