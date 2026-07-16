import test from "node:test";
import assert from "node:assert/strict";
import { executeNativeSearch } from "../api/sourcing/_lib/native.mjs";

const rubric = {
  role: { title: "Staff Engineer", company: "Acme" },
  mustHaves: ["Distributed systems"],
  searchSignals: { skills: ["Go"] },
};

const lane = { id: "lane-core", name: "Core match", rationale: "Closest match" };
const project = { id: "project-123", name: "Acme · Staff Engineer review" };

test("native Search uses the first-party call order, verifies Project filing, and rechecks resolved identities", async () => {
  const calls = [];
  const saved = [];
  let projectRead = 0;
  const result = await executeNativeSearch({
    rubric,
    lanes: [lane],
    candidateCap: 3,
    reviewProject: project,
    fileToProject: true,
    adapters: {
      createSession: async () => {
        calls.push("createSession");
        return { id: "session-123" };
      },
      submitSearch: async (sessionId, query) => {
        calls.push(`submitSearch:${sessionId}`);
        assert.match(query, /Staff Engineer at Acme/);
        return {
          results: {
            total: 3,
            searchId: "search-123",
            hits: [
              { candidateDbId: "candidate-a", linkedinSlug: "ada", name: "Ada" },
              { candidateDbId: "candidate-b", savedRecordId: "user-booked", linkedinSlug: "bob", name: "Bob" },
            ],
          },
          session: { currentPage: 1, currentPageSize: 2, latestSearchId: "search-123" },
        };
      },
      paginateSearch: async (sessionId, page, pageSize) => {
        calls.push(`paginateSearch:${sessionId}:${page}:${pageSize}`);
        return { results: { hits: [{ candidateDbId: "candidate-c", linkedinSlug: "carol", name: "Carol" }] } };
      },
      enrolledElsewhereSet: async () => {
        calls.push("enrolledElsewhereSet");
        return new Set(["user-carol"]);
      },
      bookedSet: async (ids) => {
        calls.push(`bookedSet:${ids.join(",")}`);
        return new Set(ids.includes("user-booked") ? ["user-booked"] : []);
      },
      saveCandidate: async (slug, projectId, projectName) => {
        calls.push(`saveCandidate:${slug}`);
        assert.equal(projectId, project.id);
        assert.equal(projectName, project.name);
        const candidateUserId = slug === "ada" ? "user-ada" : "user-carol";
        saved.push(candidateUserId);
        return { candidateDbId: `db-${slug}`, savedRecordId: candidateUserId };
      },
      projectMembers: async (projectId) => {
        calls.push(`projectMembers:${projectId}`);
        projectRead++;
        const visible = projectRead === 1 ? saved.slice(0, 1) : saved;
        return visible.map((id) => ({ id }));
      },
      wait: async (milliseconds) => calls.push(`wait:${milliseconds}`),
    },
  });

  assert.deepEqual(calls.slice(0, 3), [
    "createSession",
    "submitSearch:session-123",
    "paginateSearch:session-123:2:2",
  ]);
  assert.equal(projectRead, 2, "eventually consistent Project membership is polled");
  assert.equal(result.discoveredCount, 3);
  assert.equal(result.projectFiledCount, 2);
  assert.equal(result.reviewCount, 1);
  assert.equal(result.dedupedCount, 2);

  const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]));
  assert.equal(byName.get("Ada").state, "in_review");
  assert.equal(byName.get("Ada").projectStatus, "filed");
  assert.equal(byName.get("Bob").dedupReason, "booked_or_later");
  assert.equal(byName.get("Bob").projectStatus, "pending");
  assert.equal(byName.get("Carol").state, "dedup_blocked");
  assert.equal(byName.get("Carol").dedupReason, "already_in_sequence");
  assert.equal(byName.get("Carol").dedupStage, "post_project_readback");
  assert.equal(byName.get("Carol").projectStatus, "filed");
});

test("a Paraform save without Project membership readback never becomes reviewable", async () => {
  let projectReads = 0;
  const result = await executeNativeSearch({
    rubric,
    lanes: [lane],
    candidateCap: 1,
    reviewProject: project,
    fileToProject: true,
    adapters: {
      createSession: async () => ({ id: "session-123" }),
      submitSearch: async () => ({
        results: { total: 1, hits: [{ candidateDbId: "candidate-a", linkedinSlug: "ada", name: "Ada" }] },
        session: { currentPage: 1, currentPageSize: 1 },
      }),
      enrolledElsewhereSet: async () => new Set(),
      bookedSet: async () => new Set(),
      saveCandidate: async () => ({ candidateDbId: "candidate-a", savedRecordId: "user-ada" }),
      projectMembers: async () => {
        projectReads++;
        return [];
      },
      wait: async () => {},
    },
  });

  assert.equal(projectReads, 5);
  assert.equal(result.reviewCount, 0);
  assert.equal(result.projectFiledCount, 0);
  assert.equal(result.candidates[0].state, "discovered");
  assert.equal(result.candidates[0].projectStatus, "readback_failed");
  assert.match(result.candidates[0].projectError, /not found in Project readback/);
});

test("the native execution boundary rejects an oversized cap before any adapter call", async () => {
  let called = false;
  await assert.rejects(
    executeNativeSearch({
      rubric,
      lanes: [lane],
      candidateCap: 101,
      reviewProject: project,
      adapters: { createSession: async () => { called = true; } },
    }),
    /candidateCap must be 1-100/,
  );
  assert.equal(called, false);
});
