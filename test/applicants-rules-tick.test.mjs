import test from "node:test";
import assert from "node:assert/strict";

import { createTickHandler, decideRow } from "../api/applicants/rules-tick.mjs";
import { createRulesHandler } from "../api/applicants/rules.mjs";
import { factsFromProfile } from "../api/applicants/_lib/facts.mjs";
import { isRuleActor, ruleIdFromActor } from "../api/applicants/_lib/decision-record.mjs";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

const HARVARD_RULE = {
  id: "rule-harvard", name: "Harvard undergrads", action: "interview", state: "live",
  version: 2, scope: { roleIds: [] },
  conditions: [
    { field: "school.id", op: "any_of", value: ["sch_harvard"] },
    { field: "school.level", op: "any_of", value: ["bachelors"] },
  ],
};
const BLOCK_RULE = {
  id: "rule-block", name: "No staffing agencies", action: "pass", state: "live",
  version: 1, scope: { roleIds: [] },
  conditions: [{ field: "job.title", op: "contains", value: "Recruiter" }],
};

const profile = ({ school = "sch_harvard", degree = "Bachelor of Arts - AB", title = "Engineer" } = {}) => ({
  education: [{ schoolId: school, school: "Harvard University", degree, end: "2016-01-01" }],
  experiences: [{ companyId: "co1", companyName: "Acme", roleTitle: title, current: true }],
});

const row = (cuId, extra = {}) => ({
  key: `${cuId}:role1`, cuId, roleId: "role1", tier: "C",
  name: "Applicant", roleTitle: "Engineer", company: "Acme Corp",
  appliedAt: "2026-08-15T00:00:00.000Z", ...extra,
});

/** In-memory KV standing in for the apphub namespace. */
function store({ rules = [], pausedAll = false, queue = [], decisions = {}, facts = {}, counts = null } = {}) {
  const state = {
    "apphub:rules": { rev: 3, pausedAll, rules, updatedAt: null },
    "apphub:queue": { rows: queue },
    "apphub:counts": counts,
    "apphub:decisions": { ...decisions },
    "apphub:facts": facts,
    "apphub:rulestats": {},
    "apphub:ruleruns": {},
    "apphub:schools": { sch_harvard: "Harvard University" },
    "apphub:companies": { co1: "Acme" },
  };
  const writes = [];
  return {
    state, writes,
    deps: {
      isAuthorized: () => true,
      kvReady: () => true,
      readJson: async (key) => state[key] ?? null,
      writeJson: async (key, value) => { state[key] = value; writes.push([key, value]); },
      readHash: async (key) => ({ ...(state[key] ?? {}) }),
      readMany: async (key, fields) => {
        const out = {};
        for (const field of fields) if (state[key]?.[field] != null) out[field] = state[key][field];
        return out;
      },
      writeHash: async (key, fields) => {
        state[key] = { ...(state[key] ?? {}), ...fields };
        writes.push([key, fields]);
      },
      now: () => NOW,
    },
  };
}

function response() {
  return {
    statusCode: undefined, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const request = (over = {}) => ({ method: "GET", headers: {}, query: {}, ...over });

// ── the happy path ─────────────────────────────────────────────────────────

test("an armed rule writes the same decision record a human click writes", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.decided, 1);

  const decision = s.state["apphub:decisions"]["cu1:role1"];
  assert.equal(decision.action, "interview");
  assert.equal(decision.at, "2026-08-20T12:00:00.000Z");
  // Same five keys the human path writes — that identity is the integration.
  assert.deepEqual(Object.keys(decision).sort(), ["action", "at", "by", "name", "roleTitle"]);
  assert.ok(isRuleActor(decision.by));
  assert.equal(ruleIdFromActor(decision.by), "rule-harvard");
});

test("the audit records the rule, its version and the literal fact", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  await createTickHandler(s.deps)(request(), response());

  const audit = s.state["apphub:ruleruns"]["cu1:role1"];
  assert.equal(audit.ruleId, "rule-harvard");
  assert.equal(audit.ruleVersion, 2);
  assert.equal(audit.action, "interview");
  assert.deepEqual(audit.evidence.map((e) => e.field), ["school.id", "school.level"]);
  assert.equal(audit.evidence[0].matched, "Harvard University");
});

test("counters accumulate across ticks", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1"), row("cu2")],
    facts: {
      cu1: factsFromProfile(profile(), { now: NOW }),
      cu2: factsFromProfile(profile(), { now: NOW }),
    },
  });
  await createTickHandler(s.deps)(request(), response());
  assert.equal(s.state["apphub:rulestats"]["rule-harvard"].fired, 2);

  // Second tick: both are decided now, so nothing new fires and the count holds.
  const res = response();
  await createTickHandler(s.deps)(request(), res);
  assert.equal(res.body.decided, 0);
  assert.equal(s.state["apphub:rulestats"]["rule-harvard"].fired, 2);
});

// ── the refusals ───────────────────────────────────────────────────────────

test("a tick never overwrites an existing decision", async () => {
  const human = { action: "pass", at: "2026-08-19T00:00:00.000Z", by: "david@raydar.xyz", name: "Applicant", roleTitle: "Engineer" };
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    decisions: { "cu1:role1": human },
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(), res);
  assert.equal(res.body.decided, 0);
  assert.deepEqual(s.state["apphub:decisions"]["cu1:role1"], human, "the human's call must stand");
});

test("a human click landing mid-tick still wins", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1"), row("cu2")],
    facts: {
      cu1: factsFromProfile(profile(), { now: NOW }),
      cu2: factsFromProfile(profile(), { now: NOW }),
    },
  });
  // Simulate the click landing after the tick's opening read: the human's
  // decision appears in the store, so the last-moment re-read sees it.
  let reads = 0;
  const readHash = s.deps.readHash;
  s.deps.readHash = async (key) => {
    if (key === "apphub:decisions") {
      reads += 1;
      if (reads > 1) {
        s.state["apphub:decisions"]["cu1:role1"] = { action: "pass", at: "2026-08-20T12:00:00.000Z", by: "david@raydar.xyz", name: "Applicant", roleTitle: "Engineer" };
      }
    }
    return readHash(key);
  };
  const res = response();
  await createTickHandler(s.deps)(request(), res);
  assert.equal(res.body.decided, 1, "only the untouched applicant is decided");
  assert.equal(res.body.concededToHuman, 1);
  assert.equal(s.state["apphub:decisions"]["cu1:role1"].by, "david@raydar.xyz", "the click stands");
  assert.equal(s.state["apphub:decisions"]["cu2:role1"].action, "interview");
  assert.ok(!s.state["apphub:ruleruns"]["cu1:role1"], "no audit row for a conceded key");
});

test("the global pause parks the tick", async () => {
  const s = store({
    rules: [HARVARD_RULE], pausedAll: true,
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(), res);
  assert.equal(res.body.parked, "all_rules_paused");
  assert.equal(res.body.decided, 0);
  assert.deepEqual(s.state["apphub:decisions"], {});
});

test("a latched count-drop tripwire parks the tick", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
    counts: { updatedAt: "2026-08-20T11:00:00.000Z", alert: { queue: { baseline: 2244, seen: 22 } } },
  });
  const res = response();
  await createTickHandler(s.deps)(request(), res);
  assert.equal(res.body.parked, "snapshot_counts_alert");
  assert.equal(res.body.decided, 0);
  assert.deepEqual(s.state["apphub:decisions"], {});
});

test("an off rule never fires and a watching rule only counts", async () => {
  const s = store({
    rules: [
      { ...HARVARD_RULE, id: "rule-off", state: "off" },
      { ...HARVARD_RULE, id: "rule-watch", state: "watching" },
    ],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(), res);
  assert.equal(res.body.decided, 0);
  assert.deepEqual(s.state["apphub:decisions"], {});
  assert.equal(res.body.wouldFire["rule-watch"], 1);
  assert.equal(res.body.wouldFire["rule-off"], undefined);
});

test("an applicant with no facts is skipped and counted, never decided", async () => {
  const s = store({ rules: [HARVARD_RULE], queue: [row("cu1")], facts: {} });
  const res = response();
  await createTickHandler(s.deps)(request(), res);
  assert.equal(res.body.decided, 0);
  assert.equal(res.body.skipped.no_facts_yet, 1);
});

test("an unauthorized caller gets 401 and changes nothing", async () => {
  const s = store({ rules: [HARVARD_RULE], queue: [row("cu1")] });
  s.deps.isAuthorized = () => false;
  const res = response();
  await createTickHandler(s.deps)(request(), res);
  assert.equal(res.statusCode, 401);
  assert.equal(s.writes.length, 0);
});

// ── precedence ─────────────────────────────────────────────────────────────

test("a Pass rule beats an Interview rule and the loser is still recorded", async () => {
  const s = store({
    rules: [HARVARD_RULE, BLOCK_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile({ title: "Technical Recruiter" }), { now: NOW }) },
  });
  await createTickHandler(s.deps)(request(), response());

  assert.equal(s.state["apphub:decisions"]["cu1:role1"].action, "pass");
  const audit = s.state["apphub:ruleruns"]["cu1:role1"];
  assert.equal(audit.ruleId, "rule-block");
  assert.deepEqual(audit.alsoMatched, [{ id: "rule-harvard", name: "Harvard undergrads", action: "interview" }]);
});

test("decideRow picks Pass regardless of rule order", () => {
  const subject = { row: row("cu1"), facts: factsFromProfile(profile({ title: "Recruiter" }), { now: NOW }) };
  for (const rules of [[HARVARD_RULE, BLOCK_RULE], [BLOCK_RULE, HARVARD_RULE]]) {
    assert.equal(decideRow(rules, subject, { now: NOW }).action, "pass");
  }
});

test("a rule scoped to another role does not fire", async () => {
  const s = store({
    rules: [{ ...HARVARD_RULE, scope: { roleIds: ["role9"] } }],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(), res);
  assert.equal(res.body.decided, 0);
});

// ── the rules endpoint ─────────────────────────────────────────────────────

function rulesDeps(s, email = "david@raydar.xyz") {
  return {
    corsHandler: () => false,
    authHandler: async (req) => { req.authedEmail = email; return true; },
    kvReady: () => true,
    readJson: s.deps.readJson,
    writeJson: s.deps.writeJson,
    readHash: s.deps.readHash,
    readMany: s.deps.readMany,
    now: () => "2026-08-20T12:00:00.000Z",
    newId: () => "rule-new",
  };
}

test("saving a rule stamps the author, versions it, and bumps the revision", async () => {
  const s = store({ rules: [] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { op: "save", rev: 3, rule: { name: "Harvard undergrads", action: "interview", state: "off", conditions: HARVARD_RULE.conditions } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rule.id, "rule-new");
  assert.equal(res.body.rule.version, 1);
  assert.equal(res.body.rule.createdBy, "david@raydar.xyz");
  assert.equal(res.body.rev, 4);
});

test("a save against a stale revision is refused rather than clobbering", async () => {
  const s = store({ rules: [] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { op: "save", rev: 1, rule: { name: "x", action: "pass", conditions: HARVARD_RULE.conditions } },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "rules_changed");
});

test("editing an existing rule keeps the previous wording in its history", async () => {
  const s = store({ rules: [{ ...HARVARD_RULE, version: 1, createdAt: "2026-08-01T00:00:00.000Z", createdBy: "sam@raydar.xyz", updatedAt: "2026-08-01T00:00:00.000Z", updatedBy: "sam@raydar.xyz", versions: [] }] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: {
      op: "save", rev: 3,
      rule: { ...HARVARD_RULE, name: "Ivy undergrads", conditions: [{ field: "school.level", op: "any_of", value: ["bachelors"] }] },
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rule.name, "Ivy undergrads");
  assert.equal(res.body.rule.version, 2);
  assert.equal(res.body.rule.createdBy, "sam@raydar.xyz", "authorship of the original is preserved");
  assert.equal(res.body.rule.versions.length, 1);
  assert.equal(res.body.rule.versions[0].name, "Harvard undergrads");
});

test("preview reports matches and skips without writing anything", async () => {
  const s = store({
    queue: [row("cu1"), row("cu2"), row("cu3")],
    facts: {
      cu1: factsFromProfile(profile(), { now: NOW }),
      cu2: factsFromProfile(profile({ degree: "Master of Business Administration - MBA" }), { now: NOW }),
      // cu3 is the 44%: a real applicant with an empty Paraform record.
      cu3: factsFromProfile({ education: [], experiences: [] }, { now: NOW }),
    },
  });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { op: "preview", rule: { name: "Harvard undergrads", action: "interview", conditions: HARVARD_RULE.conditions } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pending, 3);
  assert.equal(res.body.matched, 1, "only the Harvard bachelor's");
  assert.equal(res.body.skipped.no_profile_history, 1, "the empty record is reported, not hidden");
  assert.equal(res.body.samples[0].key, "cu1:role1");
  assert.equal(s.writes.length, 0, "preview must never write");
});

test("preview refuses an invalid draft instead of previewing nonsense", async () => {
  const s = store({ queue: [] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { op: "preview", rule: { name: "x", action: "interview", conditions: [{ field: "school.mascot", op: "contains", value: "crimson" }] } },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "rule_invalid");
});

test("pausing everything is one flag, and it survives a stale revision", async () => {
  const s = store({ rules: [HARVARD_RULE] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { op: "pauseAll", rev: 1, paused: true },
  }, res);
  assert.equal(res.statusCode, 200, "the kill switch must never be blocked by a stale rev");
  assert.equal(res.body.pausedAll, true);
});

test("the list omits directories unless asked, and includes them when asked", async () => {
  const s = store({ rules: [HARVARD_RULE] });
  const plain = response();
  await createRulesHandler(rulesDeps(s))(request({ method: "GET" }), plain);
  assert.equal(plain.body.directories, undefined);

  const full = response();
  await createRulesHandler(rulesDeps(s))(request({ method: "GET", query: { with: "directories" } }), full);
  assert.deepEqual(full.body.directories.schools, { sch_harvard: "Harvard University" });
});

test("deleting a rule that does not exist is a 404, not a silent success", async () => {
  const s = store({ rules: [HARVARD_RULE] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {}, body: { op: "delete", rev: 3, id: "rule-nope" },
  }, res);
  assert.equal(res.statusCode, 404);
});
