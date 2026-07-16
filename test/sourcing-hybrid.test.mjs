import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveNativeFilters,
  normalizeNativeFilters,
  normalizeRankingConfig,
} from "../sourcing-filters.mjs";
import { candidateEvaluationProfile, evaluateCandidates } from "../api/sourcing/_lib/ranking.mjs";
import { executeHybridSearch } from "../api/sourcing/_lib/native.mjs";

test("Paraform filters preserve native clause semantics and reject reversed ranges", () => {
  const filters = normalizeNativeFilters({
    keyword: "machine learning infrastructure",
    workExperienceGroups: [{
      titles: ["Staff Engineer", "Staff Engineer"], companies: ["Stripe"], scope: "current",
      companyFundingStages: ["series_b", "not-real"], companyFundingStageSemantic: "tenure",
      companyTalentDensityTiers: ["S", "A"],
    }],
    skills: ["Go", "Distributed systems"], skillsMode: "strict",
    yoeMin: 7, yoeMax: 12,
    educationGroups: [{ schools: ["MIT"], degreeTypes: ["BACHELOR"] }],
  });
  assert.equal(filters.skillsMode, "strict");
  assert.deepEqual(filters.workExperienceGroups[0].titles, ["Staff Engineer"]);
  assert.deepEqual(filters.workExperienceGroups[0].companyFundingStages, ["series_b"]);
  assert.equal(filters.workExperienceGroups[0].companyFundingStageSemantic, "tenure");
  assert.deepEqual(filters.educationGroups[0].degreeTypes, ["BACHELOR"]);
  assert.throws(() => normalizeNativeFilters({ yoeMin: 12, yoeMax: 7 }), /cannot be greater/);
});

test("role rubrics seed editable native filters and conservative ranking defaults", () => {
  const filters = deriveNativeFilters({
    role: { title: "Chief of Staff", location: "New York" },
    searchSignals: { skills: ["SQL"], companies: ["DoorDash"], experience: "7-12 years" },
    exclusions: { titles: ["Consultant"] },
  });
  assert.deepEqual(filters.workExperienceGroups[0].titles, ["Chief of Staff"]);
  assert.deepEqual(filters.workExperienceGroups[0].companies, ["DoorDash"]);
  assert.deepEqual(filters.excludeWorkExperienceGroups[0].titles, ["Consultant"]);
  assert.deepEqual(filters.locations, ["New York"]);
  assert.deepEqual(normalizeRankingConfig({}, 100), { poolSize: 100, saveLimit: 30, minimumScore: 75 });
});

test("candidate evaluation profiles remove direct identity and contact fields", () => {
  const safe = candidateEvaluationProfile({
    name: "Ada Lovelace", email: "ada@example.com", linkedinSlug: "ada",
    currentPosition: { title: "Staff Engineer", company_name: "Analytical Engines" },
    skills: ["Go"],
  }, { title: "Staff Engineer", company: "Analytical Engines", location: "London" }, 0);
  const json = JSON.stringify(safe);
  assert.equal(json.includes("Ada Lovelace"), false);
  assert.equal(json.includes("ada@example.com"), false);
  assert.equal(json.includes("linkedinSlug"), false);
  assert.match(json, /Staff Engineer/);
  assert.match(json, /Go/);
});

test("structured output ranking maps every opaque candidate reference", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  let requestBody = null;
  const ranked = await evaluateCandidates([
    { raw: { name: "Ada", skills: ["Go"] }, candidate: { candidateId: "db-a", title: "Staff Engineer" } },
  ], { rubric: { mustHaves: ["Go"] }, agentCriteria: "MUST: Go", adjustments: [] }, {
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          model: "gpt-test",
          output_text: JSON.stringify({ evaluations: [{
            candidateRef: "profile-1", score: 92, hardRequirementsMet: true, confidence: "high",
            strengths: ["Shows Go"], concerns: [], reason: "Strong evidence.",
          }] }),
        }),
      };
    },
  });
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(ranked.evaluations[0].candidateId, "db-a");
  assert.equal(ranked.evaluations[0].score, 92);
});

test("hybrid Search evaluates the pool and saves only qualified top profiles", async () => {
  const calls = [];
  const saved = [];
  const result = await executeHybridSearch({
    rubric: { role: { title: "Staff Engineer" }, mustHaves: ["Go"] },
    nativeFilters: { skills: ["Go"], skillsMode: "strict" },
    agentCriteria: "MUST: production Go",
    rankingConfig: { poolSize: 3, saveLimit: 2, minimumScore: 80 },
    reviewProject: { id: "project-123", name: "Acme - Staff Engineer" },
    fileToProject: true,
    adapters: {
      createSession: async () => ({ id: "session-1" }),
      applyFilters: async (sessionId, filters) => {
        calls.push(["apply", sessionId, filters]);
        return {
          results: { total: 3, searchId: "search-1", hits: [
            { candidateDbId: "db-a", linkedinSlug: "ada", name: "Ada", title: "Staff Engineer" },
            { candidateDbId: "db-b", linkedinSlug: "bob", name: "Bob", title: "Senior Engineer" },
            { candidateDbId: "db-c", linkedinSlug: "cal", name: "Cal", title: "Junior Engineer" },
          ] },
          session: { currentPage: 1, currentPageSize: 3 },
        };
      },
      enrolledElsewhereSet: async () => new Set(),
      bookedSet: async () => new Set(),
      evaluateCandidates: async (items) => ({
        model: "gpt-test", batches: 1,
        evaluations: items.map(({ candidate }) => ({
          candidateId: candidate.candidateId,
          score: { "db-a": 96, "db-b": 85, "db-c": 65 }[candidate.candidateId],
          hardRequirementsMet: candidate.candidateId !== "db-c",
          confidence: "high", strengths: ["Relevant"], concerns: [], reason: "Evidence.",
        })),
      }),
      saveCandidate: async (slug) => {
        saved.push(slug);
        return { candidateDbId: `db-${slug}`, savedRecordId: `user-${slug}` };
      },
      projectMembers: async () => saved.map((slug) => ({ id: `user-${slug}` })),
      wait: async () => {},
    },
  });
  assert.equal(calls[0][0], "apply");
  assert.deepEqual(calls[0][2], { skills: ["Go"], skillsMode: "strict" });
  assert.deepEqual(saved, ["ada", "bob"]);
  assert.equal(result.evaluatedCount, 3);
  assert.equal(result.qualifiedCount, 2);
  assert.equal(result.selectedCount, 2);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.projectFiledCount, 2);
  assert.equal(result.candidates.every((candidate) => candidate.agentEvaluation.score >= 80), true);
});
