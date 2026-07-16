import test from "node:test";
import assert from "node:assert/strict";
import {
  auditSequence,
  buildSequenceSteps,
  buildSequenceSubject,
  canonicalRoleName,
  chooseCatalogMatch,
  deterministicSequenceSections,
  FIRST_NAME_TOKEN,
  FOLLOWUP_ONE_HTML,
  FOLLOWUP_TWO_HTML,
  selectOutreachAccounts,
} from "../api/sourcing/_lib/provisioning.mjs";
import { buildSequenceContext } from "../api/sourcing/_lib/model.mjs";
import { provisionRoleAssets } from "../api/sourcing/_lib/provision.mjs";

const context = {
  roleId: "role-222place",
  title: "Chief of Staff",
  company: "222place",
  companyUrl: "https://222.place",
  shareUrl: "https://www.paraform.com/share/222place/role-222place",
  fundingAmount: "$14M",
  stage: "Series A",
  industry: "consumer marketplace",
  workplace: "5 days in-office in SoHo, New York",
  salaryLowerBound: 170000,
  salaryUpperBound: 250000,
  engineering: false,
  techStack: ["SQL"],
};

const sections = {
  openingHtml: "a consumer marketplace rebuilding how people form meaningful relationships in real life across <strong>17 cities</strong>",
  tractionHtml: "The company is backed by General Catalyst, Y Combinator, Upfront Ventures, NEA, and the founder of Dropbox",
  rolePitchHtml: "They're hiring a <strong>Chief of Staff</strong> to work directly with all three co-founders in SoHo. You'll own recruiting for <strong>6-8 critical roles</strong>, use SQL for root-cause analysis, lead FP&amp;A and board work, and drive ambiguous strategic and operational projects. This is <strong>on-site in SoHo, NYC, five days a week</strong>, with direct founder access and meaningful ownership across company building",
  stack: "",
};

test("canonical names and exact catalog matches win over legacy names", () => {
  const role = { company: "Acme", title: "Staff Engineer" };
  assert.equal(canonicalRoleName(role), "Acme - Staff Engineer");
  const match = chooseCatalogMatch([
    { id: "legacy-1", name: "Outreach for Staff Engineer" },
    { id: "exact-1", name: "Acme - Staff Engineer" },
  ], role);
  assert.equal(match.item.id, "exact-1");
  assert.equal(match.kind, "exact");
});

test("live inbox discovery keeps approved Raydar aliases and excludes the primary inbox", () => {
  const selected = selectOutreachAccounts([
    { id: "a-1", email: "david@raydar.xyz" },
    { id: "a-2", email: "david@heyraydar.com" },
    { id: "a-3", email: "davidp@runraydar.com" },
    { id: "a-4", email: "someone@heyraydar.com" },
    { id: "a-5", email: "david@unapproved.example" },
  ]);
  assert.deepEqual(selected.map((item) => item.email), ["david@heyraydar.com", "davidp@runraydar.com"]);
});

test("fresh sequence follows the locked subject, merge-chip, and follow-up contract", () => {
  let next = 0;
  const built = buildSequenceSteps(context, sections, { idFactory: () => `step-${++next}` });
  assert.equal(buildSequenceSubject(context), "<p>$14M Series A - Chief of Staff - Consumer Marketplace</p>");
  assert.deepEqual(built.steps.map((step) => step.wait_time), [3, 4, 2]);
  assert.equal(built.steps[0].id, "step-1");
  assert.match(built.steps[0].body, new RegExp(FIRST_NAME_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(built.steps[0].body, /<a[^>]+href="https:\/\/222\.place"><strong>222place<\/strong><\/a>/);
  assert.match(built.steps[0].body, /<strong>Comp: \$170K-\$250K Base \+ Competitive Equity &amp; Benefits<\/strong>/);
  assert.equal(built.steps[1].body, FOLLOWUP_ONE_HTML);
  assert.equal(built.steps[2].body, FOLLOWUP_TWO_HTML);
  assert.equal(built.steps[1].subject, "");
  assert.equal(built.steps[2].subject, "");
  assert.equal(built.steps[0].body.includes("—"), false);
});

test("new-sequence readback catches activation, primary inbox, or content drift", () => {
  const built = buildSequenceSteps(context, sections, { idFactory: () => crypto.randomUUID() });
  const campaign = {
    name: "222place - Chief of Staff",
    project_id: "project-222",
    role_id: null,
    auto_add_project_candidates: false,
    enabled: false,
    has_sent_emails: false,
    timezone: "America/Los_Angeles",
    time_start: "09:00",
    time_end: "18:00",
    daily_limit: 20,
    include_signature: false,
    enable_tracking: true,
    prioritize_existing_candidates: false,
    days_to_send: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    start_date: "2026-07-16T19:00:00.000Z",
    campaign_to_accounts: [{ account: { email: "david@heyraydar.com" } }],
    steps: built.steps,
  };
  const clean = auditSequence(campaign, {
    name: campaign.name,
    projectId: campaign.project_id,
    company: "222place",
    expectedEmails: ["david@heyraydar.com"],
    expectedSteps: built.steps,
    startDate: new Date("2026-07-16T10:00:00-07:00"),
  });
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(clean.dangers, []);
  const unsafe = auditSequence({ ...campaign, enabled: true, campaign_to_accounts: [{ account: { email: "david@raydar.xyz" } }] }, {
    name: campaign.name,
    projectId: campaign.project_id,
    company: "222place",
    expectedEmails: ["david@heyraydar.com"],
    expectedSteps: built.steps,
  });
  assert.match(unsafe.dangers.join(" "), /enabled|started/);
  assert.match(unsafe.dangers.join(" "), /primary/);
});

test("role detail normalization gives structured values precedence for sequence facts", () => {
  const normalized = buildSequenceContext({
    id: "role-1",
    name: "Chief of Staff",
    workplaceType: "On-site",
    workPlaceText: "5 days in-office",
    salaryLowerBound: 170000,
    salaryUpperBound: 250000,
    companyTip: "We recently raised our Series A with $16.2M total.",
    company: {
      name: "222place",
      websiteUrl: "https://222.place",
      fundingAmount: "$14M",
      normalized_industries: ["consumer", "marketplace"],
    },
  });
  assert.equal(normalized.fundingAmount, "$14M");
  assert.equal(normalized.stage, "Series A");
  assert.equal(normalized.industry, "consumer marketplace");
  assert.equal(normalized.shareUrl, "https://www.paraform.com/share/222place/role-1");
});

test("deterministic role-fact composition remains playbook-valid without an AI provider", () => {
  const deterministicContext = {
    ...context,
    companySummary: "We're an early stage startup building the future of social.",
    responsibilities: [
      "Owning the internal recruiting process for 6-8 critical roles.",
      "Conducting deep data analysis using SQL to investigate metrics and root causes.",
      "Leading financial forecasting, board work, and high-priority operational projects.",
    ],
  };
  const fallback = deterministicSequenceSections(deterministicContext);
  const built = buildSequenceSteps(deterministicContext, fallback, { idFactory: () => crypto.randomUUID() });
  assert.equal(fallback.model, "deterministic-role-facts");
  assert.equal(built.intro.words >= 100 && built.intro.words <= 180, true);
  assert.equal(built.steps[0].body.includes("—"), false);
});

function mockProvisioningAdapter({ failSteps = false } = {}) {
  const projects = [];
  const sequences = [];
  const campaigns = new Map();
  const calls = { createProject: 0, createSequence: 0, updateSettings: 0, updateSteps: 0, deleteSequence: 0 };
  const gmail = [{ id: "inbox-1", email: "david@heyraydar.com" }];
  return {
    projects,
    sequences,
    campaigns,
    calls,
    adapter: {
      listProjects: async () => projects,
      listSequences: async () => sequences,
      createProject: async (name) => {
        calls.createProject++;
        const row = { id: "project-222", name };
        projects.push(row);
        return row;
      },
      getCampaign: async (id) => campaigns.get(id),
      listGmailAccounts: async () => gmail,
      draftSections: async () => sections,
      createSequenceShell: async ({ name, projectId }) => {
        calls.createSequence++;
        const row = { id: "sequence-222", name, enabled: false };
        sequences.push(row);
        campaigns.set(row.id, { id: row.id, name, project_id: projectId, role_id: "role-222place", steps: [] });
        return row;
      },
      updateSequenceSettings: async (id, settings) => {
        calls.updateSettings++;
        const campaign = campaigns.get(id);
        Object.assign(campaign, {
          role_id: null,
          auto_add_project_candidates: false,
          enabled: false,
          has_sent_emails: false,
          timezone: "America/Los_Angeles",
          start_type: "DATE_TIME",
          start_date: settings.startDate.toISOString(),
          days_to_send: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
          time_start: "09:00",
          time_end: "18:00",
          daily_limit: 20,
          include_signature: false,
          enable_tracking: true,
          prioritize_existing_candidates: false,
          campaign_to_accounts: [{ account: { id: "inbox-1", email: "david@heyraydar.com" } }],
        });
      },
      updateSequenceSteps: async (id, stepsToSave) => {
        calls.updateSteps++;
        if (failSteps) throw new Error("synthetic step write failure");
        campaigns.get(id).steps = stepsToSave;
      },
      deleteSequence: async (id) => {
        calls.deleteSequence++;
        campaigns.delete(id);
        const index = sequences.findIndex((item) => item.id === id);
        if (index >= 0) sequences.splice(index, 1);
      },
    },
  };
}

test("provisioning is find-or-create idempotent and never starts the campaign", async () => {
  const mock = mockProvisioningAdapter();
  const input = {
    roleId: "role-222place",
    workspace: { rubric: { role: { company: "222place", title: "Chief of Staff" } }, sequenceContext: context },
    now: new Date("2026-07-16T17:00:00.000Z"),
    adapters: mock.adapter,
  };
  const first = await provisionRoleAssets(input);
  const second = await provisionRoleAssets(input);
  assert.equal(first.projectCreated, true);
  assert.equal(first.sequenceCreated, true);
  assert.equal(first.sequenceAudit.campaignStarted, false);
  assert.equal(first.sequenceAudit.primaryInboxExcluded, true);
  assert.equal(second.projectCreated, false);
  assert.equal(second.sequenceCreated, false);
  assert.equal(mock.calls.createProject, 1);
  assert.equal(mock.calls.createSequence, 1);
  assert.equal(mock.calls.updateSteps, 1);
});

test("a partial sequence write is deleted so retry cannot reuse an incomplete shell", async () => {
  const mock = mockProvisioningAdapter({ failSteps: true });
  await assert.rejects(() => provisionRoleAssets({
    roleId: "role-222place",
    workspace: { rubric: { role: { company: "222place", title: "Chief of Staff" } }, sequenceContext: context },
    now: new Date("2026-07-16T17:00:00.000Z"),
    adapters: mock.adapter,
  }), /synthetic step write failure/);
  assert.equal(mock.calls.deleteSequence, 1);
  assert.equal(mock.sequences.length, 0);
  assert.equal(mock.campaigns.size, 0);
});
