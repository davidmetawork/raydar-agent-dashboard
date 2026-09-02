import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CLASSIFIER_PINS,
  classifyReply,
  validateClassification,
} from "../api/submissions-v2/_lib/classifier.mjs";

const fixtureUrl = new URL("./fixtures/submissions-v2-classifier-cases.json", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));

function materialize(fixture) {
  const offered_roles = fixture.offered_roles.map((key) => {
    const role = fixtures.roles[key];
    assert.ok(role, `${fixture.id} references missing offered role ${key}`);
    return role;
  });
  const decisions = fixture.expected.map(({ role: key, ...decision }) => {
    const role = fixtures.roles[key];
    assert.ok(role, `${fixture.id} references missing expected role ${key}`);
    return { role_id: role.role_id, ...decision };
  });
  return {
    event: {
      candidate_authored_text: fixture.reply,
      sent_message_text: fixture.sent_message,
      offered_roles,
    },
    decisions,
  };
}

test("classifier fixture inventory is broad, unique, and evidence-grounded", () => {
  assert.equal(fixtures.schema_version, 1);
  assert.ok(fixtures.cases.length >= 30, `expected at least 30 cases, found ${fixtures.cases.length}`);

  const ids = new Set();
  const categoryCounts = new Map();
  const labelCounts = new Map();
  let multipleRoleCases = 0;

  for (const fixture of fixtures.cases) {
    assert.ok(!ids.has(fixture.id), `duplicate fixture id ${fixture.id}`);
    ids.add(fixture.id);
    categoryCounts.set(fixture.category, (categoryCounts.get(fixture.category) || 0) + 1);
    if (fixture.offered_roles.length > 1) multipleRoleCases += 1;

    const { event, decisions } = materialize(fixture);
    assert.equal(validateClassification({ decisions }, event).ok, true, `${fixture.id} must satisfy the production validator`);
    for (const decision of decisions) {
      labelCounts.set(decision.label, (labelCounts.get(decision.label) || 0) + 1);
      assert.ok(event.candidate_authored_text.includes(decision.quote), `${fixture.id} quote must be verbatim candidate text`);
      if (decision.negative_reason) {
        assert.ok(event.candidate_authored_text.includes(decision.negative_reason), `${fixture.id} negative reason must be verbatim candidate text`);
      }
    }
  }

  assert.ok((labelCounts.get("interested") || 0) >= 10);
  assert.ok((labelCounts.get("not_interested") || 0) >= 10);
  assert.ok((labelCounts.get("needs_review") || 0) >= 10);
  assert.ok((categoryCounts.get("needs_review_question") || 0) >= 5);
  assert.ok((categoryCounts.get("needs_review_conditional") || 0) >= 2);
  assert.ok(multipleRoleCases >= 10);
});

test("all labeled examples pass through the pinned classifier contract with deterministic mocked responses", async (t) => {
  for (const fixture of fixtures.cases) {
    await t.test(fixture.id, async () => {
      const { event, decisions } = materialize(fixture);
      let calls = 0;
      const fetchImpl = async (url, init) => {
        calls += 1;
        assert.equal(url, "https://api.openai.com/v1/responses");
        const request = JSON.parse(init.body);
        assert.equal(request.model, CLASSIFIER_PINS.primary);
        assert.equal(request.store, false);
        assert.equal(request.text.format.strict, true);
        const suppliedEvidence = JSON.parse(request.input[1].content[0].text);
        assert.equal(suppliedEvidence.candidate_reply, fixture.reply);
        assert.equal(suppliedEvidence.sent_message, fixture.sent_message);
        assert.deepEqual(suppliedEvidence.offered_roles.map(({ role_id }) => role_id), event.offered_roles.map(({ role_id }) => role_id));
        return {
          ok: true,
          json: async () => ({
            id: `mock-${fixture.id}`,
            output_text: JSON.stringify({ decisions }),
            usage: { input_tokens: 100, output_tokens: 40 },
          }),
        };
      };

      const result = await classifyReply(event, {
        env: { SUBMISSIONS_V2_OPENAI_API_KEY: "deterministic-test-key" },
        fetchImpl,
      });

      assert.equal(calls, 1);
      assert.deepEqual(result.decisions, decisions);
      assert.equal(result.attempts[0].outcome, "accepted");
      assert.equal(result.attempts[0].response_id, `mock-${fixture.id}`);
    });
  }
});

test("verbatim validation rejects invented, outbound-only, case-changed, and altered evidence", async (t) => {
  const event = {
    candidate_authored_text: "Maybe the Backend Engineer role could work, but what is the salary?",
    sent_message_text: "Yes, I am interested in the Backend Engineer role.",
    offered_roles: [fixtures.roles.backend],
  };
  const invalidCases = [
    {
      name: "invented quote",
      decision: { role_id: "role-backend", label: "interested", quote: "Absolutely, submit me.", review_reason: null, negative_reason: null },
      reason: "quote_not_verbatim",
    },
    {
      name: "quote copied only from outbound message",
      decision: { role_id: "role-backend", label: "interested", quote: "Yes, I am interested in the Backend Engineer role.", review_reason: null, negative_reason: null },
      reason: "quote_not_verbatim",
    },
    {
      name: "case-changed quote",
      decision: { role_id: "role-backend", label: "needs_review", quote: "maybe the Backend Engineer role could work", review_reason: "reply_unclear_or_conditional", negative_reason: null },
      reason: "quote_not_verbatim",
    },
    {
      name: "punctuation-altered quote",
      decision: { role_id: "role-backend", label: "needs_review", quote: "Maybe the Backend Engineer role could work.", review_reason: "reply_unclear_or_conditional", negative_reason: null },
      reason: "quote_not_verbatim",
    },
    {
      name: "words omitted within quote",
      decision: { role_id: "role-backend", label: "needs_review", quote: "Maybe the role could work", review_reason: "reply_unclear_or_conditional", negative_reason: null },
      reason: "quote_not_verbatim",
    },
    {
      name: "paraphrased negative reason",
      decision: { role_id: "role-backend", label: "not_interested", quote: "Maybe the Backend Engineer role could work", review_reason: null, negative_reason: "candidate needs salary information" },
      reason: "negative_reason_not_verbatim",
    },
  ];

  for (const fixture of invalidCases) {
    await t.test(fixture.name, () => {
      const validation = validateClassification({ decisions: [fixture.decision] }, event);
      assert.equal(validation.ok, false);
      assert.equal(validation.reason, fixture.reason);
    });
  }
});

test("multiple-role validation rejects roles outside the offer and duplicate role decisions", () => {
  const event = {
    candidate_authored_text: "I am interested in both roles.",
    sent_message_text: "Would you consider both roles?",
    offered_roles: [fixtures.roles.backend, fixtures.roles.product],
  };
  const base = { label: "interested", quote: "I am interested in both roles.", review_reason: null, negative_reason: null };

  assert.equal(validateClassification({ decisions: [{ role_id: "role-sales", ...base }] }, event).reason, "role_outside_offer");
  assert.equal(validateClassification({ decisions: [{ role_id: "role-backend", ...base }, { role_id: "role-backend", ...base }] }, event).reason, "role_outside_offer");
});
