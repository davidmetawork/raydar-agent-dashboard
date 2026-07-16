import test from "node:test";
import assert from "node:assert/strict";
import { buildLaneQuery, normalizeNativeHit } from "../api/sourcing/_lib/native.mjs";

test("native Search hits normalize to a small stable review record", () => {
  const first = normalizeNativeHit({
    candidateDbId: "candidate-db-123",
    savedRecordId: "candidate-user-123",
    linkedinSlug: "ada-lovelace",
    name: "Ada Lovelace",
    currentPosition: { title: "Staff Engineer", company_name: "Analytical Engines" },
    location: "London",
  }, { id: "lane-core", name: "Core match" });
  const second = normalizeNativeHit({ candidateDbId: "candidate-db-123", name: "Drifted shape" }, { id: "lane-other", name: "Other" });
  assert.equal(first.id, second.id);
  assert.equal(first.candidateUserId, "candidate-user-123");
  assert.equal(first.title, "Staff Engineer");
  assert.equal(first.company, "Analytical Engines");
  assert.equal(first.state, "discovered");
  assert.equal(first.projectStatus, "pending");
});

test("native Search query includes searchable role signals, exclusions, lane, and approved calibration", () => {
  const query = buildLaneQuery({
    role: { title: "Staff Engineer", company: "Acme" },
    mustHaves: ["Distributed systems"],
    preferences: ["Fintech"],
    searchSignals: { titles: ["Staff Software Engineer"], skills: ["Go"], locations: ["New York"] },
    exclusions: { titles: ["Engineering Manager"], companies: ["Competitor"], criteria: ["No pure people managers"] },
  }, { rationale: "Core technical profile" }, [{ action: "Raise the minimum seniority." }]);
  assert.match(query, /Staff Engineer or Staff Software Engineer candidates/);
  assert.equal(query.includes("at Acme"), false);
  assert.match(query, /Distributed systems/);
  assert.match(query, /Core technical profile/);
  assert.match(query, /Engineering Manager/);
  assert.match(query, /Competitor/);
  assert.equal(query.includes("No pure people managers"), false);
  assert.match(query, /Raise the minimum seniority/);
});

test("native Search respects Paraform's 1,000-character ceiling and keeps subjective exclusions review-only", () => {
  const query = buildLaneQuery({
    role: { title: "Chief of Staff", company: "222place" },
    mustHaves: Array.from({ length: 10 }, (_, index) => `must-have requirement ${index} with detailed evidence`),
    preferences: Array.from({ length: 10 }, (_, index) => `preference ${index} with additional context`),
    searchSignals: { titles: ["Chief of Staff"], skills: ["SQL", "FP&A"], locations: ["New York"] },
    exclusions: {
      titles: ["Consultant", "Investment Banker"],
      criteria: ["Must work on-site", "No frequent job hopping", "No trend chasers"],
    },
  }, { rationale: "Core marketplace operations profile" }, [{ action: "Require stronger SQL ownership." }]);
  assert.equal(query.length <= 1000, true);
  assert.match(query, /Consultant/);
  assert.equal(query.includes("No frequent job hopping"), false);
  assert.match(query, /Require stronger SQL ownership/);
});
