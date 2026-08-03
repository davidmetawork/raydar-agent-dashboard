import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_SCHEDULING_URL,
  HUMAN_SCHEDULING_URL,
  findLegacySchedulingLinks,
  hasCandidateSchedulingLink,
  rewriteLegacySchedulingLinks,
} from "../api/seq/_lib/scheduling-links.mjs";
import {
  BOOKING_STOP_REVIEWED_CATALOG_FLOOR,
} from "../api/seq/_lib/booking-stop.mjs";
import {
  inventoryUrlsFromText,
  inventorySchedulingIdentityContext,
  loadPlans,
  migratePlansTransaction,
  planSequence,
  READBACK_DELAYS_MS,
  readCampaignFresh,
  requireCutoverReadiness,
  sequenceSourceAttribution,
  updateAndVerify,
} from "../scripts/migrate-sequence-scheduling-links.mjs";

const ORIGINAL_ENV = {
  url: process.env.RAYDAR_SCHEDULER_INTEGRATION_URL,
  key: process.env.RAYDAR_SCHEDULER_INTEGRATION_READ_KEY,
};

test.after(() => {
  if (ORIGINAL_ENV.url === undefined) {
    delete process.env.RAYDAR_SCHEDULER_INTEGRATION_URL;
  } else {
    process.env.RAYDAR_SCHEDULER_INTEGRATION_URL = ORIGINAL_ENV.url;
  }
  if (ORIGINAL_ENV.key === undefined) {
    delete process.env.RAYDAR_SCHEDULER_INTEGRATION_READ_KEY;
  } else {
    process.env.RAYDAR_SCHEDULER_INTEGRATION_READ_KEY = ORIGINAL_ENV.key;
  }
});

function cutoverFetch({
  dashboardOverrides = {},
  schedulerOverrides = {},
  routeHeaderMode = "correct",
} = {}) {
  process.env.RAYDAR_SCHEDULER_INTEGRATION_URL =
    "https://raydar-scheduler.vercel.app";
  process.env.RAYDAR_SCHEDULER_INTEGRATION_READ_KEY = "r".repeat(48);
  return async (url, options = {}) => {
    const value = String(url);
    if (value === AGENT_SCHEDULING_URL || value === HUMAN_SCHEDULING_URL) {
      const expectedRoute =
        value === AGENT_SCHEDULING_URL ? "agent" : "human";
      const headers = routeHeaderMode === "missing"
        ? {}
        : {
            "x-raydar-scheduler-route":
              routeHeaderMode === "correct" ? expectedRoute : "wrong",
          };
      return Response.json(
        { ok: true },
        { headers },
      );
    }
    if (value === "https://monitor.raydar.xyz/api/seq/health") {
      return Response.json({
        ok: true,
        cookieSet: true,
        paraform: "live",
        bookingStop: {
          stale: false,
          raydarScheduler: {
            enabled: true,
            applyEnabled: true,
            webhookConfigured: true,
            webhookVerified: true,
            pauseCanaryConfigured: true,
            pauseCanaryVerified: true,
            lastWebhookApply: true,
            lastWebhookDeferred: false,
            lastWebhookAgeMinutes: 2,
            lastWebhookMatched: 1,
            lastWebhookPaused: 1,
            latestWebhookAgeMinutes: 1,
            latestWebhookApply: true,
            latestWebhookDeferred: false,
            latestWebhookMatched: 0,
            latestWebhookPaused: 0,
            indexConfigured: true,
            lastSweepCalendlyComplete: true,
            lastSweepEnabled: true,
            lastSweepComplete: true,
            bookingsLastPass: 1,
            lastSweepSequenceCatalogCount: 75,
            lastSweepSequenceScopeScanned: 75,
            lastSweepScopeSchema: "raydar-booking-stop-scope-v2",
            lastSweepScopeDigest: "a".repeat(64),
            lastSweepScopeCatalogFloor:
              BOOKING_STOP_REVIEWED_CATALOG_FLOOR,
            lastSweepLinkSequences: 62,
            lastSweepEnabledLinkSequences: 32,
            lastSweepCoveredEnabledLinkSequences: 32,
            lastSweepLinkScopeComplete: true,
            latestSweepAttemptAgeMinutes: 3,
            latestSweepAttemptStatus: "success",
            latestSweepAttemptCurrent: true,
            leadIndexAgeMinutes: 3,
            leadIndexCurrent: true,
            ...dashboardOverrides,
          },
        },
      });
    }
    if (value === "https://raydar-scheduler.vercel.app/api/health") {
      assert.equal(
        options.headers.authorization,
        `Bearer ${process.env.RAYDAR_SCHEDULER_INTEGRATION_READ_KEY}`,
      );
      return Response.json({
        schema: "raydar-scheduler-health-v1",
        readyForCutover: true,
        migrationComplete: false,
        ...schedulerOverrides,
      });
    }
    throw new Error(`unexpected URL ${value}`);
  };
}

test("link cutover requires a recent signed webhook proof and authenticated scheduler readiness", async () => {
  await requireCutoverReadiness(cutoverFetch(), "a".repeat(64));
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch(), "b".repeat(64)),
    /BOOKING_STOP_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      dashboardOverrides: { webhookVerified: false },
    })),
    /BOOKING_STOP_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      dashboardOverrides: { applyEnabled: false },
    })),
    /BOOKING_STOP_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      dashboardOverrides: {
        pauseCanaryVerified: false,
        lastWebhookMatched: 0,
        lastWebhookPaused: 0,
      },
    })),
    /BOOKING_STOP_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      dashboardOverrides: {
        latestSweepAttemptStatus: "failure",
        latestSweepAttemptCurrent: false,
      },
    })),
    /BOOKING_STOP_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      dashboardOverrides: { lastSweepCalendlyComplete: false },
    })),
    /BOOKING_STOP_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      dashboardOverrides: { lastWebhookAgeMinutes: 61 },
    })),
    /BOOKING_STOP_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      dashboardOverrides: {
        latestWebhookApply: false,
        latestWebhookDeferred: true,
      },
    })),
    /BOOKING_STOP_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      dashboardOverrides: {
        lastSweepCoveredEnabledLinkSequences: 31,
      },
    })),
    /BOOKING_STOP_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      schedulerOverrides: { readyForCutover: false },
    })),
    /SCHEDULER_NOT_CUTOVER_READY/u,
  );
  await assert.rejects(
    () => requireCutoverReadiness(cutoverFetch({
      schedulerOverrides: { migrationComplete: undefined },
    })),
    /SCHEDULER_NOT_CUTOVER_READY/u,
  );
  for (const routeHeaderMode of ["missing", "wrong"]) {
    await assert.rejects(
      () => requireCutoverReadiness(cutoverFetch({ routeHeaderMode })),
      /SCHEDULER_ROUTE_UNAVAILABLE/u,
    );
  }
});

test("semantic link rewrite maps Agent and Intro links to distinct native routes", () => {
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
  assert.match(result.value, />Book an Intro Call with Raydar<\/a>/);
  assert.equal(findLegacySchedulingLinks(result.value).known.length, 0);
});

test("sequence plans add stable non-PII per-campaign attribution to both routes", () => {
  const sequence = {
    id: "sequence-id-with-private-server-identity",
    name: "Synthetic sequence",
    enabled: true,
  };
  const campaign = {
    steps: [{
      id: "step-1",
      step_number: 1,
      subject: null,
      body: [
        "https://www.paraform.com/cal/raydar/15min",
        "https://calendly.com/raydar-xyz",
      ].join(" "),
    }],
  };
  const plan = planSequence(sequence, campaign);
  const agentSource = sequenceSourceAttribution(sequence.id, "agent");
  const humanSource = sequenceSourceAttribution(sequence.id, "human");
  assert.match(agentSource, /^paraform_sequence_agent\.[a-f0-9]{16}$/u);
  assert.match(humanSource, /^paraform_sequence_human\.[a-f0-9]{16}$/u);
  assert.notEqual(agentSource, sequence.id);
  assert.notEqual(humanSource, sequence.id);
  assert.equal(
    plan.afterSteps[0].body,
    `${AGENT_SCHEDULING_URL}?src=${agentSource} `
      + `${HUMAN_SCHEDULING_URL}?src=${humanSource}`,
  );
  assert.deepEqual(plan.sourceAttribution, {
    agent: agentSource,
    human: humanSource,
  });
  assert.equal(
    planSequence(sequence, { steps: plan.afterSteps }).changed,
    false,
  );
});

test("source attribution is bounded and rejects malformed caller input", () => {
  const valid = rewriteLegacySchedulingLinks(
    "https://calendly.com/raydar-xyz",
    { humanSourceAttribution: "paraform_sequence_human.0123456789abcdef" },
  );
  assert.equal(
    valid.value,
    `${HUMAN_SCHEDULING_URL}?src=paraform_sequence_human.0123456789abcdef`,
  );
  for (const source of [
    "candidate@example.com",
    "has spaces",
    `sequence.${"a".repeat(65)}`,
  ]) {
    assert.throws(
      () => rewriteLegacySchedulingLinks(
        "https://calendly.com/raydar-xyz",
        { humanSourceAttribution: source },
      ),
      /SCHEDULING_SOURCE_ATTRIBUTION_INVALID/u,
    );
  }
});

test("noncanonical native variants are normalized and remain in pause scope", () => {
  const variants = [
    "http://book.raydar.xyz/agent?utm_source=email",
    "book.raydar.xyz/intro#choose",
    "book.raydar.xyz/human#choose",
    "HTTPS://BOOK.RAYDAR.XYZ:443/AGENT/",
  ];
  for (const variant of variants) {
    assert.equal(hasCandidateSchedulingLink(variant), true);
  }
  const rewritten = rewriteLegacySchedulingLinks(variants.join(" "));
  assert.equal(rewritten.value.includes("http://"), false);
  assert.equal(rewritten.value.includes("HTTPS://"), false);
  assert.equal(
    rewritten.value,
    `${AGENT_SCHEDULING_URL} ${HUMAN_SCHEDULING_URL} ${HUMAN_SCHEDULING_URL} ${AGENT_SCHEDULING_URL}`,
  );
  assert.equal(
    rewriteLegacySchedulingLinks(
      "https://book.raydar.xyz/agent?redirect=foo.com",
    ).value,
    AGENT_SCHEDULING_URL,
  );
  assert.equal(
    rewriteLegacySchedulingLinks(
      "https://book.raydar.xyz/human?a=1&amp;b=2",
    ).value,
    HUMAN_SCHEDULING_URL,
  );
  assert.equal(
    rewriteLegacySchedulingLinks(
      "https://book.raydar.xyz/agent?at=12:30",
    ).value,
    AGENT_SCHEDULING_URL,
  );
});

test("person-specific and generic Intro Call copy is normalized to Raydar", () => {
  const input = [
    `<p>P.S. if opposed to the agent chat please grab a time with me directly <a href="http://calendly.com/raydar-xyz">here</a></p>`,
    "<p>Interested?&nbsp;Grab&nbsp;a&nbsp;time&nbsp;here:&nbsp;calendly.com/raydar-xyz</p>",
  ].join("");
  const result = rewriteLegacySchedulingLinks(input);
  assert.equal(/with me directly/i.test(result.value), false);
  assert.match(result.value, /Raydar's Intro Call option:/);
  assert.match(result.value, /Interested\? Book an Intro Call with Raydar here:/);
  assert.equal(
    (result.value.match(/Book an Intro Call with Raydar/g) || []).length,
    2,
  );
  assert.deepEqual(inventorySchedulingIdentityContext(result.value), []);
});

test("callout copy is never rewritten without a recognized Intro Call URL", () => {
  for (const input of [
    "Interested? Grab a time here: tomorrow at noon.",
    "If opposed to the agent chat please grab a time with me directly by replying.",
    `Interested? Grab a time here: ${AGENT_SCHEDULING_URL}`,
  ]) {
    const result = rewriteLegacySchedulingLinks(input);
    assert.equal(result.value, input);
    assert.equal(result.changed, false);
    assert.equal(result.copyNormalizations.callouts, 0);
  }
});

test("link-adjacent personal identities fail semantic inventory without exposing copy", () => {
  for (const input of [
    "Pick a time on my calendar: https://calendly.com/raydar-xyz",
    "Book a call with David at https://book.raydar.xyz/human",
    "I'll call you after you use https://book.raydar.xyz/human",
    "<p>Schedule a call with me.</p><p><a href=https://book.raydar.xyz/human>Pick a time</a></p>",
    "You will be speaking with Vanessa.\n\nBook here: https://book.raydar.xyz/human",
    "David will call you.\n\nChoose a time: https://book.raydar.xyz/human",
  ]) {
    const findings = inventorySchedulingIdentityContext(input);
    assert.ok(findings.length > 0);
    assert.equal(JSON.stringify(findings).includes(input), false);
    assert.equal(
      findings.every((finding) =>
        typeof finding.contextDigest === "string"
        && finding.contextDigest.length === 64),
      true,
    );
  }
});

test("rewrite does not touch Calendly cancellation/rescheduling URLs", () => {
  const input = [
    "https://calendly.com/cancellations/booking-1",
    "https://calendly.com/reschedulings/booking-1",
  ].join(" ");
  const result = rewriteLegacySchedulingLinks(input);
  assert.equal(result.changed, false);
  assert.deepEqual(result.replacements, { agent: 0, human: 0 });
  assert.deepEqual(findLegacySchedulingLinks(input).unknown, []);
  assert.equal(hasCandidateSchedulingLink(input), false);
});

test("unknown scheduler paths are inventoried and never guessed", () => {
  const found = findLegacySchedulingLinks(
    '<a href="https://calendly.com/some-other-team/event">Book</a>',
  );
  assert.deepEqual(found.known, []);
  assert.deepEqual(found.unknown, ["https://calendly.com/some-other-team/event"]);
});

test("terminal prose punctuation does not turn known legacy links into unknowns", () => {
  for (const input of [
    "Book https://calendly.com/raydar-xyz.",
    "Book (https://www.paraform.com/cal/raydar/15min).",
  ]) {
    const found = findLegacySchedulingLinks(input);
    assert.equal(found.known.length, 1);
    assert.deepEqual(found.unknown, []);
  }
});

test("rewrites are token-bound and never corrupt lookalike hosts or email text", () => {
  const hostile = [
    "https://notcalendly.com/raydar-xyz",
    "https://calendarparaform.com/cal/raydar/15min",
    "foo@calendly.com/raydar-xyz",
  ];
  for (const value of hostile) {
    const rewritten = rewriteLegacySchedulingLinks(value);
    assert.equal(rewritten.value, value);
    assert.equal(rewritten.changed, false);
    assert.deepEqual(findLegacySchedulingLinks(value), {
      known: [],
      unknown: [],
    });
  }
  assert.equal(
    rewriteLegacySchedulingLinks("//calendly.com/raydar-xyz").value,
    HUMAN_SCHEDULING_URL,
  );
  assert.equal(
    rewriteLegacySchedulingLinks(
      "https://paraform.com:443/cal/raydar/15min?utm_source=email",
    ).value,
    AGENT_SCHEDULING_URL,
  );
  assert.equal(
    rewriteLegacySchedulingLinks(
      "https://calendly.com:443/raydar-xyz#choose",
    ).value,
    HUMAN_SCHEDULING_URL,
  );
  for (const [value, expected] of [
    ["http://book.raydar.xyz:80/agent", AGENT_SCHEDULING_URL],
    ["http://book.raydar.xyz:80/human", HUMAN_SCHEDULING_URL],
    [
      "http://paraform.com:80/cal/raydar/15min",
      AGENT_SCHEDULING_URL,
    ],
    ["http://calendly.com:80/raydar-xyz", HUMAN_SCHEDULING_URL],
  ]) {
    assert.equal(rewriteLegacySchedulingLinks(value).value, expected);
  }
  for (const value of [
    "https://team.calendly.com/raydar-xyz",
    "https://team.paraform.com/cal/raydar/15min",
    "https://calendly.com:8443/raydar-xyz",
    "https://book.raydar.xyz:8443/agent",
  ]) {
    assert.equal(rewriteLegacySchedulingLinks(value).changed, false);
    assert.equal(hasCandidateSchedulingLink(value), false);
    assert.equal(
      inventoryUrlsFromText(value)[0].classification.endsWith("-unclassified")
        || inventoryUrlsFromText(value)[0].classification.endsWith("-unreviewed"),
      true,
    );
  }
});

test("browser-valid concealed destinations are never silently accepted", () => {
  for (const value of [
    "https://user@calendly.com/raydar-xyz",
    "https://user:pass@calendly.com/raydar-xyz",
    "https://calendly.com\\raydar-xyz",
    "https://book.raydar.xyz/foo/../agent",
  ]) {
    const inventory = inventoryUrlsFromText(value);
    assert.equal(inventory.length, 1);
    assert.equal(
      inventory[0].classification.endsWith("-unclassified")
        || inventory[0].classification.endsWith("-unreviewed"),
      true,
    );
  }
});

test("generic URL inventory strips queries and classifies scheduling surfaces", () => {
  const urls = inventoryUrlsFromText([
    '<a href="https://book.raydar.xyz/agent?utm_source=email">Agent</a>',
    "https://cal.com/another-team/intro?secret=must-not-appear",
    "Book a time at https://example.test/sales.",
    "Learn more at https://raydargroup.com/about.",
    "Schedule a call to discuss https://litellm.ai.",
  ].join(" "));
  assert.deepEqual(urls, [
    { host: "book.raydar.xyz", path: "/agent", classification: "native" },
    {
      host: "cal.com",
      path: "/another-team/intro",
      classification: "scheduling-provider-unclassified",
    },
    {
      host: "example.test",
      path: "/sales",
      classification: "scheduling-context-unclassified",
    },
    {
      host: "raydargroup.com",
      path: "/about",
      classification: "other-unreviewed",
    },
    {
      host: "litellm.ai",
      path: "/",
      classification: "other-reviewed",
    },
  ]);
  assert.equal(JSON.stringify(urls).includes("must-not-appear"), false);
});

test("every otherwise unknown URL requires explicit review, including short links", () => {
  for (const input of [
    '<a href="https://example.com/demo">Choose a time</a>',
    "Select availability: https://lu.ma/raydar-intro",
    "https://tinyurl.com/raydar — find a slot",
    "https://short.example/opaque",
  ]) {
    assert.equal(
      inventoryUrlsFromText(input).some((url) =>
        url.classification.endsWith("-unclassified")
        || url.classification.endsWith("-unreviewed")),
      true,
    );
  }
});

test("catalog loading fails closed on empty, duplicate, and malformed campaign data", async () => {
  await assert.rejects(
    () => loadPlans({ listSequences: async () => [] }),
    /SEQUENCE_CATALOG_INVALID/u,
  );
  await assert.rejects(
    () => loadPlans({
      listSequences: async () => [
        { id: "duplicate", name: "One", enabled: false },
        { id: "duplicate", name: "Two", enabled: true },
      ],
      readCampaign: async () => ({ steps: [] }),
      minimumSequenceCount: 1,
    }),
    /SEQUENCE_CATALOG_INVALID/u,
  );
  await assert.rejects(
    () => loadPlans({
      listSequences: async () => [
        { id: "valid", name: "One", enabled: false },
      ],
      readCampaign: async () => ({ steps: null }),
      minimumSequenceCount: 1,
    }),
    /SEQUENCE_CAMPAIGN_INVALID/u,
  );
  await assert.rejects(
    () => loadPlans({
      listSequences: async () => [
        { id: "enabled-empty", name: "Enabled Empty", enabled: true },
      ],
      readCampaign: async () => ({ steps: [] }),
      minimumSequenceCount: 1,
    }),
    /SEQUENCE_CAMPAIGN_INVALID/u,
  );
  const disabledEmpty = await loadPlans({
    listSequences: async () => [
      { id: "disabled-empty", name: "Untitled sequence", enabled: false },
    ],
    readCampaign: async () => ({ steps: [] }),
    minimumSequenceCount: 1,
  });
  assert.equal(disabledEmpty.sequenceCount, 1);
  assert.equal(disabledEmpty.totalStepCount, 0);
  assert.equal(disabledEmpty.plans[0].changed, false);
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
  let observedError = null;
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
    (error) => {
      observedError = error;
      return /SEQUENCE_READBACK_MISMATCH/u.test(error.message);
    },
  );
  assert.deepEqual(writes, ["native", "legacy"]);
  assert.equal(observedError.sequenceId, "seq-1");
  assert.equal(observedError.sequenceIndex, 0);
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

function realisticPlan() {
  return planSequence(
    { id: "seq-safe", name: "Safety", enabled: false },
    {
      steps: [{
        id: "step-safe-1",
        step_number: 1,
        subject: "Choose a time",
        body: '<a href="https://www.paraform.com/cal/raydar/15min">Book</a>',
        wait_time: 2,
        step_kind: "email",
        task_type: null,
        weight: 100,
        attachments: [{ id: "attachment-1", name: "role.pdf" }],
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-29T00:00:00.000Z",
        sent_email_count: 4,
        replied_count: 1,
      }],
    },
  );
}

test("apply refuses immediately current non-text drift before issuing a write", async () => {
  const plan = realisticPlan();
  const current = structuredClone(plan.beforeSteps);
  current[0].wait_time = 3;
  let writes = 0;
  await assert.rejects(
    () => updateAndVerify(plan, plan.afterSteps, {
      direction: "apply",
      readCampaign: async () => ({ steps: current }),
      writeSteps: async () => { writes++; },
    }),
    /SEQUENCE_PREWRITE_DRIFT/u,
  );
  assert.equal(writes, 0);
});

test("full readback rejects dropped attachments and changed wait semantics", async () => {
  for (const damage of ["attachments", "wait_time"]) {
    const plan = realisticPlan();
    let written = null;
    let reads = 0;
    let observedError = null;
    await assert.rejects(
      () => updateAndVerify(plan, plan.afterSteps, {
        direction: "apply",
        readbackDelaysMs: [0],
        readCampaign: async () => {
          reads++;
          if (reads === 1) return { steps: structuredClone(plan.beforeSteps) };
          const damaged = structuredClone(written);
          if (damage === "attachments") delete damaged[0].attachments;
          else damaged[0].wait_time = 99;
          return { steps: damaged };
        },
        writeSteps: async (_id, steps) => { written = structuredClone(steps); },
      }),
      (error) => {
        observedError = error;
        return error.code === "SEQUENCE_READBACK_MISMATCH";
      },
    );
    assert.deepEqual(observedError.readbackMismatch, {
      expectedStepCount: 1,
      actualStepCount: 1,
      steps: [{
        index: 0,
        expectedStepNumber: 1,
        actualStepNumber: 1,
        fields: [damage],
      }],
    });
  }
});

test("readback polls through Paraform eventual consistency", async () => {
  const plan = realisticPlan();
  let written = null;
  let reads = 0;
  const slept = [];
  await updateAndVerify(plan, plan.afterSteps, {
    direction: "apply",
    readbackDelaysMs: [0, 25, 50],
    sleepImpl: async (delayMs) => { slept.push(delayMs); },
    readCampaign: async () => {
      reads++;
      if (reads <= 2) return { steps: structuredClone(plan.beforeSteps) };
      return { steps: structuredClone(written) };
    },
    writeSteps: async (_id, steps) => { written = structuredClone(steps); },
  });
  assert.equal(reads, 3);
  assert.deepEqual(slept, [25]);
});

test("provider readback bypasses stale campaign caches", async () => {
  let observed = null;
  const campaign = { id: "seq_readback", steps: [] };
  const result = await readCampaignFresh(campaign.id, {
    nonce: "nonce-readback-1",
    fetchImpl: async (url, options) => {
      observed = { url: String(url), options };
      return Response.json({ result: { data: { json: campaign } } });
    },
  });
  assert.deepEqual(result, campaign);
  assert.match(observed.url, /raydar_readback=nonce-readback-1/u);
  assert.equal(observed.options.cache, "no-store");
  assert.equal(observed.options.headers["cache-control"], "no-cache");
});

test("default readback window covers two minutes of provider lag", () => {
  assert.equal(READBACK_DELAYS_MS[0], 0);
  assert.ok(READBACK_DELAYS_MS.reduce((sum, delay) => sum + delay, 0) >= 120_000);
});

test("provider-managed delivery counters do not create false readback drift", async () => {
  const plan = realisticPlan();
  let written = null;
  let reads = 0;
  await updateAndVerify(plan, plan.afterSteps, {
    direction: "apply",
    readCampaign: async () => {
      reads++;
      if (reads === 1) return { steps: structuredClone(plan.beforeSteps) };
      const readback = structuredClone(written);
      Object.assign(readback[0], {
        bounced_count: 1,
        clicked_count: 2,
        interested_count: 3,
        opened_count: 4,
      });
      return { steps: readback };
    },
    writeSteps: async (_id, steps) => { written = structuredClone(steps); },
  });
  assert.equal(reads, 2);
});

test("provider no-due task normalization accepts only zero and null", async () => {
  const sourceSteps = structuredClone(realisticPlan().beforeSteps);
  sourceSteps[0].task_due_days = 0;
  const plan = planSequence(
    { id: "seq-task-due", name: "Task due", enabled: false },
    { steps: sourceSteps },
  );
  const current = structuredClone(plan.beforeSteps);
  current[0].task_due_days = null;
  let written = null;
  let reads = 0;

  await updateAndVerify(plan, plan.afterSteps, {
    direction: "apply",
    readCampaign: async () => ({
      steps: structuredClone(++reads === 1 ? current : written),
    }),
    writeSteps: async (_id, steps) => { written = structuredClone(steps); },
  });
  assert.equal(written[0].task_due_days, null);

  const drifted = structuredClone(plan.beforeSteps);
  drifted[0].task_due_days = 1;
  await assert.rejects(
    () => updateAndVerify(plan, plan.afterSteps, {
      direction: "apply",
      readCampaign: async () => ({ steps: drifted }),
      writeSteps: async () => {},
    }),
    /SEQUENCE_PREWRITE_DRIFT/u,
  );
});

test("rollback restores only text while preserving concurrent non-text fields", async () => {
  const plan = realisticPlan();
  const current = structuredClone(plan.afterSteps);
  current[0].wait_time = 9;
  current[0].attachments.push({ id: "attachment-2", name: "details.pdf" });
  current[0].updated_at = "2026-07-29T12:00:00.000Z";
  let written = null;
  let reads = 0;

  await updateAndVerify(plan, plan.beforeSteps, {
    direction: "rollback",
    readCampaign: async () => {
      reads++;
      return {
        steps: structuredClone(reads === 1 ? current : written),
      };
    },
    writeSteps: async (_id, steps) => { written = structuredClone(steps); },
  });

  assert.equal(written[0].body, plan.beforeSteps[0].body);
  assert.equal(written[0].subject, plan.beforeSteps[0].subject);
  assert.equal(written[0].wait_time, 9);
  assert.deepEqual(written[0].attachments, current[0].attachments);
  assert.equal(written[0].updated_at, current[0].updated_at);
});

test("versioned read attachments are losslessly adapted to the write API", async () => {
  const plan = realisticPlan();
  const current = structuredClone(plan.afterSteps);
  const attachmentArray = structuredClone(current[0].attachments);
  current[0].attachments = { version: 1, attachments: attachmentArray };
  const readback = structuredClone(current);
  readback[0].subject = plan.beforeSteps[0].subject;
  readback[0].body = plan.beforeSteps[0].body;
  let written = null;
  let reads = 0;

  await updateAndVerify(plan, plan.beforeSteps, {
    direction: "rollback",
    readCampaign: async () => ({
      steps: structuredClone(++reads === 1 ? current : readback),
    }),
    writeSteps: async (_id, steps) => { written = structuredClone(steps); },
  });

  assert.deepEqual(written[0].attachments, attachmentArray);
  assert.equal(Array.isArray(written[0].attachments), true);
  assert.deepEqual(readback[0].attachments, current[0].attachments);
});

test("rollback is a verified no-op when the provider already has the preimage", async () => {
  const plan = realisticPlan();
  let writes = 0;
  await updateAndVerify(plan, plan.beforeSteps, {
    direction: "rollback",
    readCampaign: async () => ({ steps: structuredClone(plan.beforeSteps) }),
    writeSteps: async () => { writes++; },
  });
  assert.equal(writes, 0);
});

test("apply and rollback preserve exact null and absent text-field state", async () => {
  const beforeSteps = [
    {
      id: "email",
      step_number: 1,
      subject: null,
      body: "Book https://calendly.com/raydar-xyz",
      step_kind: "email",
    },
    {
      id: "task-null",
      step_number: 2,
      subject: null,
      body: null,
      step_kind: "task",
      task_type: "linkedin",
    },
    {
      id: "wait-absent",
      step_number: 3,
      step_kind: "wait",
      wait_time: 2,
    },
  ];
  const plan = planSequence(
    { id: "seq-shape", name: "Shape", enabled: false },
    { steps: structuredClone(beforeSteps) },
  );

  let serverSteps = structuredClone(beforeSteps);
  const writes = [];
  const run = async (desired, direction) => {
    let reads = 0;
    await updateAndVerify(plan, desired, {
      direction,
      readCampaign: async () => {
        reads++;
        return { steps: structuredClone(serverSteps) };
      },
      writeSteps: async (_id, steps) => {
        writes.push(structuredClone(steps));
        serverSteps = structuredClone(steps);
      },
    });
    assert.equal(reads, 2);
  };

  await run(plan.afterSteps, "apply");
  assert.equal(serverSteps[0].subject, null);
  assert.equal(serverSteps[1].subject, null);
  assert.equal(serverSteps[1].body, null);
  assert.equal(Object.hasOwn(serverSteps[2], "subject"), false);
  assert.equal(Object.hasOwn(serverSteps[2], "body"), false);
  assert.equal(
    serverSteps[0].body,
    `Book ${HUMAN_SCHEDULING_URL}?src=${
      sequenceSourceAttribution("seq-shape", "human")
    }`,
  );

  await run(plan.beforeSteps, "rollback");
  assert.deepEqual(serverSteps, beforeSteps);
  assert.equal(Object.hasOwn(writes[1][2], "subject"), false);
  assert.equal(Object.hasOwn(writes[1][2], "body"), false);
});

test("rollback detects null-to-empty and absent-to-empty text drift", async () => {
  const plan = planSequence(
    { id: "seq-shape-drift", name: "Shape Drift", enabled: false },
    {
      steps: [
        {
          id: "email",
          step_number: 1,
          subject: null,
          body: "Book https://calendly.com/raydar-xyz",
        },
        { id: "task", step_number: 2, subject: null, body: null },
        { id: "wait", step_number: 3, wait_time: 2 },
      ],
    },
  );
  for (const mutate of [
    (steps) => { steps[1].body = ""; },
    (steps) => { steps[2].subject = ""; },
  ]) {
    const drifted = structuredClone(plan.afterSteps);
    mutate(drifted);
    let writes = 0;
    await assert.rejects(
      () => updateAndVerify(plan, plan.beforeSteps, {
        direction: "rollback",
        readCampaign: async () => ({ steps: drifted }),
        writeSteps: async () => { writes++; },
      }),
      /ROLLBACK_CURRENT_STATE_DRIFT/u,
    );
    assert.equal(writes, 0);
  }
});
