import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRoleRubric,
  normalizeActiveRoles,
  normalizeSearchIdeas,
  proposeNextRun,
  summarizeFeedback,
} from "../api/sourcing/_lib/model.mjs";

test("active roles keep approved recruiter roles and sort by company/title", () => {
  const roles = normalizeActiveRoles({ roles: [
    { user_status: "PENDING", role: { id: "role-3", title: "Ignore me" } },
    { user_status: "APPROVED", role: { id: "role-2", title: "Engineer", company: { name: "Beta" } } },
    { user_status: "APPROVED", role: { id: "role-1", title: "Designer", company_name: "Acme" } },
  ] });
  assert.deepEqual(roles.map((role) => role.id), ["role-1", "role-2"]);
});

test("role rubric separates must-haves, preferences, filters, and exclusions", () => {
  const rubric = buildRoleRubric({
    detail: { id: "role-1", title: "Staff Engineer", company: { name: "Acme" }, locations: ["New York"] },
    requirements: { requirements: [
      { text: "Distributed systems", required: true },
      { text: "Fintech experience", type: "OPTIONAL" },
      { description: "Avoid pure people managers", type: "DEALBREAKER", priority: 2 },
      { description: "Avoid low-agency profiles", type: "REQUIRED", group: "TRAITS_TO_AVOID", priority: 3 },
    ] },
    filters: {
      job_titles: ["Staff Software Engineer"],
      exclude_job_titles: ["Engineering Manager"],
      skills: ["Go"],
      ideal_companies: [{ name: "Stripe" }],
      avoid_companies: [{ name: "Acme competitor" }],
      experience_range: { min: 7, max: 12 },
    },
  });
  assert.equal(rubric.role.title, "Staff Engineer");
  assert.deepEqual(rubric.mustHaves, ["Distributed systems"]);
  assert.deepEqual(rubric.preferences, ["Fintech experience"]);
  assert.deepEqual(rubric.searchSignals.skills, ["Go"]);
  assert.equal(rubric.searchSignals.experience, "7-12 years");
  assert.deepEqual(rubric.exclusions.titles, ["Engineering Manager"]);
  assert.deepEqual(rubric.exclusions.criteria, ["Avoid pure people managers", "Avoid low-agency profiles"]);
});

test("role rubric can use the detailed-role payload without extra Paraform reads", () => {
  const rubric = buildRoleRubric({
    detail: {
      id: "role-1",
      title: "Chief of Staff",
      requirements: [
        { description: "Scaled founder-led operations", type: "REQUIRED", priority: 1 },
        { description: "Avoid career consultants", type: "DEALBREAKER", priority: 2 },
      ],
      candidateFilters: { job_titles: ["Chief of Staff"], locations: ["New York"] },
    },
  });
  assert.deepEqual(rubric.mustHaves, ["Scaled founder-led operations"]);
  assert.deepEqual(rubric.exclusions.criteria, ["Avoid career consultants"]);
  assert.deepEqual(rubric.searchSignals.titles, ["Chief of Staff"]);
});

test("native ideas normalize into small, structured lanes", () => {
  const ideas = normalizeSearchIdeas({ ideas: [{
    title: "Core profile",
    reason: "Closest interpretation of the brief",
    filters: { locations: ["Remote"], workExperienceGroups: ["Platform Engineer"] },
  }] });
  assert.equal(ideas[0].name, "Core profile");
  assert.deepEqual(ideas[0].filters.targetTitles, ["Platform Engineer"]);
});

test("bad feedback yields evidence-backed proposals but never auto-applies", () => {
  const feedback = [
    { verdict: "good" },
    { verdict: "bad", reason: "wrong_title" },
    { verdict: "bad", reason: "wrong_title" },
    { verdict: "bad", reason: "too_junior" },
    { verdict: "bad", reason: "too_junior" },
    { verdict: "maybe" },
  ];
  const summary = summarizeFeedback(feedback);
  assert.equal(summary.bad, 4);
  assert.equal(summary.reasons[0].count, 2);
  const next = proposeNextRun(feedback);
  assert.equal(next.autoApply, false);
  assert.equal(next.proposals.length, 2);
});
