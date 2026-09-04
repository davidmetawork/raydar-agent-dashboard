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

test("Interview controls fail closed on a hard hold, not on a delivery hint", () => {
  // The gate is the shared hard-hold code list (api/applicants/_lib/
  // generation.mjs interviewDecisionHold), mirrored into the page as
  // interviewHold(). `interviewAllowed` is a delivery-readiness hint and is
  // deliberately NOT a decision gate any more.
  assert.match(applicants, /const hold = interviewHold\(row\);\s*\n\s*const interviewReady = !hold;/);
  assert.match(applicants, /function interviewHold\(row\) \{\s*\n\s*if \(!row\) return "application_missing";/);
  assert.match(applicants, /"Interview held: " \+ hold/);
  assert.doesNotMatch(applicants, /row\.interviewAllowed === true/);
});
