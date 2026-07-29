import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_SCHEDULING_URL,
  HUMAN_SCHEDULING_URL,
  findLegacySchedulingLinks,
  rewriteLegacySchedulingLinks,
} from "../api/seq/_lib/scheduling-links.mjs";
import {
  migratePlansTransaction,
  planSequence,
} from "../scripts/migrate-sequence-scheduling-links.mjs";

test("semantic link rewrite maps Agent and Human links to distinct native routes", () => {
  const input = [
    '<a href="https://www.paraform.com/cal/raydar/15min">Book Time</a>',
    '<a href="http://calendly.com/raydar-xyz">here</a>',
    "https://calendly.com/raydar.xyz",
    "calendly.com/noah-raydar/new-role-chat?back=1",
  ].join(" ");
  const result = rewriteLegacySchedulingLinks(input);
  assert.equal(result.replacements.agent, 1);
  assert.equal(result.replacements.human, 3);
  assert.equal(result.value.includes(AGENT_SCHEDULING_URL), true);
  assert.equal(result.value.match(new RegExp(HUMAN_SCHEDULING_URL, "g")).length, 3);
  assert.match(result.value, />Book an Agent Call with Raydar<\/a>/);
  assert.match(result.value, />Book a Human Call with Raydar<\/a>/);
  assert.equal(findLegacySchedulingLinks(result.value).known.length, 0);
});

test("person-specific and generic Human Call copy is normalized to Raydar", () => {
  const input = [
    `<p>P.S. if opposed to the agent chat please grab a time with me directly <a href="http://calendly.com/raydar-xyz">here</a></p>`,
    "<p>Interested?&nbsp;Grab&nbsp;a&nbsp;time&nbsp;here:&nbsp;calendly.com/raydar-xyz</p>",
  ].join("");
  const result = rewriteLegacySchedulingLinks(input);
  assert.equal(/with me directly/i.test(result.value), false);
  assert.match(result.value, /Raydar's Human Call option:/);
  assert.match(result.value, /Interested\? Book a Human Call with Raydar here:/);
  assert.equal(
    (result.value.match(/Book a Human Call with Raydar/g) || []).length,
    2,
  );
});

test("rewrite does not touch Calendly cancellation/rescheduling URLs", () => {
  const input = [
    "https://calendly.com/cancellations/booking-1",
    "https://calendly.com/reschedulings/booking-1",
  ].join(" ");
  const result = rewriteLegacySchedulingLinks(input);
  assert.equal(result.changed, false);
  assert.deepEqual(result.replacements, { agent: 0, human: 0 });
});

test("unknown scheduler paths are inventoried and never guessed", () => {
  const found = findLegacySchedulingLinks(
    '<a href="https://calendly.com/some-other-team/event">Book</a>',
  );
  assert.deepEqual(found.known, []);
  assert.deepEqual(found.unknown, ["https://calendly.com/some-other-team/event"]);
});

test("migration plan includes enabled and disabled sequences with exact step mapping", () => {
  const sequence = { id: "seq-disabled", name: "Template", enabled: false };
  const campaign = {
    steps: [
      {
        id: "step-1",
        step_number: 1,
        subject: "",
        body: '<p><a href="https://www.paraform.com/cal/raydar/15min">Agent</a> or <a href="http://calendly.com/raydar-xyz">Human</a></p>',
        attachments: [],
      },
      {
        id: "step-2",
        step_number: 2,
        subject: "",
        body: "<p>No link</p>",
        attachments: [],
      },
    ],
  };
  const plan = planSequence(sequence, campaign);
  assert.equal(plan.enabled, false);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.replacements, { agent: 1, human: 1 });
  assert.deepEqual(plan.copyNormalizations, {
    callouts: 0,
    agentLabels: 1,
    humanLabels: 1,
  });
  assert.deepEqual(plan.changedSteps, [{ step: 1, fields: ["body"] }]);
  assert.equal(plan.afterSteps[0].body.includes(AGENT_SCHEDULING_URL), true);
  assert.equal(plan.afterSteps[0].body.includes(HUMAN_SCHEDULING_URL), true);
  assert.notEqual(plan.beforeDigest, plan.afterDigest);
  assert.deepEqual(plan.beforeSteps, campaign.steps, "rollback input must be exact");
});

test("a write/read-back failure restores even the currently attempted sequence", async () => {
  const plan = {
    id: "seq-1",
    name: "Sequence 1",
    beforeSteps: [{ id: "step-1", body: "legacy" }],
    afterSteps: [{ id: "step-1", body: "native" }],
  };
  const writes = [];
  let first = true;
  await assert.rejects(
    () => migratePlansTransaction([plan], {
      writeAndVerify: async (_entry, steps) => {
        writes.push(steps[0].body);
        if (first) {
          first = false;
          throw new Error("SEQUENCE_READBACK_MISMATCH");
        }
      },
    }),
    /SEQUENCE_READBACK_MISMATCH/,
  );
  assert.deepEqual(writes, ["native", "legacy"]);
});

test("a post-migration inventory failure restores every sequence in reverse order", async () => {
  const plans = ["one", "two"].map((id) => ({
    id,
    name: id,
    beforeSteps: [{ body: `${id}-legacy` }],
    afterSteps: [{ body: `${id}-native` }],
  }));
  const writes = [];
  await assert.rejects(
    () => migratePlansTransaction(plans, {
      writeAndVerify: async (entry, steps) => {
        writes.push(`${entry.id}:${steps[0].body}`);
      },
      verifyComplete: async () => {
        throw new Error("POST_MIGRATION_LEGACY_LINKS_REMAIN");
      },
    }),
    /POST_MIGRATION_LEGACY_LINKS_REMAIN/,
  );
  assert.deepEqual(writes, [
    "one:one-native",
    "two:two-native",
    "two:two-legacy",
    "one:one-legacy",
  ]);
});
