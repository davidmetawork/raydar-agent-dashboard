import test from "node:test";
import assert from "node:assert/strict";

import {
  alertText,
  MAX_ALERT_SEQUENCES,
  lintCampaign,
  lintStepField,
  needsAlert,
  planReads,
  problemDigest,
  runMergeFieldCheck,
  STATE_SCHEMA,
  visibleTextWithoutMergeFields,
} from "../api/seq/_lib/merge-field-check.mjs";
import { sequenceMergeFields, EVALUATORS } from "../api/health/_lib/evaluators.mjs";
import { CATALOG } from "../api/health/_lib/catalog.mjs";

// The stored shape of a real merge field, as Paraform's editor saves it.
const FIELD = (value) =>
  `<span data-value="${value}" data-type="token" contenteditable="false" style="background-color: rgb(219, 217, 241); padding: 2px 4px; border-radius: 4px;">${value}</span>`;
const GOOD_BODY = `<p>Hi ${FIELD("Candidate First Name")},</p><p>Roles for you: ${FIELD("Curated List Link")}</p>`;
// The 2026-09-29 breakage: typed text where the merge field belongs.
const TYPED_BODY = "<p>Hi {Candidate First Name},</p><p>I'm working on a role.</p>";
const TEMPLATE_ID = "ms87yhip8wozzyrkpq6sx51b";

const step = (n, body, subject = "<p>A role</p>", extra = {}) =>
  ({ id: `step-${n}`, step_number: n, step_kind: "EMAIL", subject, body, ...extra });
const campaign = (id, steps) => ({ id, name: id, steps });

// ---------- detection ----------

test("a real merge field is clean; the typed form is flagged", () => {
  assert.deepEqual(lintStepField(GOOD_BODY), []);
  assert.deepEqual(lintStepField(TYPED_BODY), [{ kind: "typed_braces", text: "{Candidate First Name}" }]);
  // Rendered text reads the same either way: only the stored HTML differs.
  assert.equal(visibleTextWithoutMergeFields(GOOD_BODY).includes("Candidate First Name"), false);
});

test("every placeholder shape the check promises to catch", () => {
  const kinds = (html) => lintStepField(html).map((f) => `${f.kind}:${f.text}`);
  assert.deepEqual(kinds("<p>Hi {{first_name}}</p>"), ["typed_braces:{{first_name}}"]);
  assert.deepEqual(kinds("<p>Hi [First Name],</p>"), ["typed_brackets:[First Name]"]);
  assert.deepEqual(kinds("<p>[XX] years at [Company 2]</p>"), ["typed_brackets:[XX]", "typed_brackets:[Company 2]"]);
  assert.deepEqual(kinds("<p>[FirstName] [first_name] [FNAME]</p>").length, 3);
  assert.deepEqual(kinds("<p>Hi &lt;&lt;First Name&gt;&gt;,</p>"), ["typed_angles:<<First Name>>"]);
  assert.deepEqual(kinds("<p>*INSERT ROLE* at Acme</p>"), ["insert_marker:*INSERT ROLE*"]);
  assert.deepEqual(kinds("<p>Hi &#123;First&#125;</p>"), ["typed_braces:{First}"]);
  // A merge field that lost its span is sent as its name.
  assert.deepEqual(kinds("<p>Hi Candidate First Name,</p>"), ["bare_variable:Candidate First Name"]);
  // One placeholder is one finding, not also a bare name.
  assert.deepEqual(kinds("<p>Hi {Candidate First Name}</p>"), ["typed_braces:{Candidate First Name}"]);
  assert.deepEqual(kinds("<p>At Most Recent Company Name</p>"), ["bare_variable:Most Recent Company Name"]);
  // A span Paraform cannot fill.
  assert.deepEqual(kinds(`<p>Hi ${FIELD("Candidate Nickname")}</p>`), ["unknown_variable:Candidate Nickname"]);
});

test("markup, styles and attribute order do not cause false alarms", () => {
  assert.deepEqual(lintStepField("<style>p{margin:0}</style><p style=\"a:{b}\">Hello</p>"), []);
  assert.deepEqual(lintStepField("<!-- {draft} --><p>Hello</p>"), []);
  const reversed = '<span data-type="token" data-value="Candidate First Name">Candidate First Name</span>';
  assert.deepEqual(lintStepField(`<p>Hi ${reversed}</p>`), []);
  assert.deepEqual(lintStepField("<p>$3.1M Seed - Founding Engineer (remote) - 50% equity</p>"), []);
  assert.deepEqual(lintStepField("<p>[Hybrid] role, [plus equity], [First round], [see the job here]; our Referral Link and Schedule Link</p>"), []);
  // Unclosed markup stays fast (the first version took over a minute on this).
  const started = Date.now();
  lintStepField(`<p>${'<span data-type="token">x '.repeat(4000)}</p>`);
  assert.ok(Date.now() - started < 1000);
  // An empty span left inside a real field, and a ">" inside a style value.
  const nested = '<span data-value="Candidate First Name" data-type="token"><span></span>Candidate First Name</span>';
  assert.deepEqual(lintStepField(`<p>Hi ${nested}</p>`), []);
  const quoted = '<span style="a>b" data-value="Curated List Link" data-type="token">Curated List Link</span>';
  assert.deepEqual(lintStepField(`<p>${quoted}</p>`), []);
  assert.deepEqual(lintStepField(null), []);
});

test("lintCampaign names the step and field, skips tasks, and exempts only the template's INSERT marker", () => {
  const broken = campaign("seq-1", [
    step(1, TYPED_BODY),
    step(2, GOOD_BODY, "<p>Re: {Candidate First Name}</p>"),
    step(3, "<p>Call [Name] today</p>", "", { step_kind: "TASK" }),
  ]);
  assert.deepEqual(lintCampaign(broken).map((p) => [p.step, p.stepId, p.field, p.kind, p.text]), [
    [1, "step-1", "body", "typed_braces", "{Candidate First Name}"],
    [2, "step-2", "subject", "typed_braces", "{Candidate First Name}"],
  ]);

  const template = campaign(TEMPLATE_ID, [step(1, "<p>About the *INSERT ROLE* role</p>", "<p>*INSERT ROLE*</p>")]);
  assert.equal(lintCampaign(template).length, 2);
  assert.deepEqual(lintCampaign(template, { exemptInsertIds: [TEMPLATE_ID] }), []);
  // Anything else wrong in the template still counts: its copies inherit it.
  const templateTypo = campaign(TEMPLATE_ID, [step(1, "<p>Hi {Candidate First Name}, *INSERT ROLE*</p>")]);
  assert.deepEqual(lintCampaign(templateTypo, { exemptInsertIds: [TEMPLATE_ID] }).map((p) => p.kind), ["typed_braces"]);
});

test("the problem digest ignores order and changes with the problems", () => {
  const a = lintCampaign(campaign("s", [step(1, TYPED_BODY), step(2, TYPED_BODY)]));
  assert.equal(problemDigest(a), problemDigest([...a].reverse()));
  assert.notEqual(problemDigest(a), problemDigest(a.slice(1)));
  assert.equal(problemDigest([]), null);
});

// ---------- read plan ----------

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-09-29T20:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

test("the plan reads live and switched-on sequences first, and leaves clean switched-off ones alone", () => {
  const catalog = [
    { id: "old-off", name: "old-off", enabled: false },
    { id: "new-off", name: "new-off", enabled: false },
    { id: "new-live", name: "new-live", enabled: true },
    { id: "turned-on", name: "turned-on", enabled: true },
    { id: "renamed", name: "renamed v2", enabled: false },
    { id: "flagged", name: "flagged", enabled: false },
    { id: "live-stale", name: "live-stale", enabled: true },
    { id: "live-fresh", name: "live-fresh", enabled: true },
  ];
  const records = {
    "old-off": { name: "old-off", enabled: false, checkedAt: ago(90 * 24 * HOUR), problems: [] },
    "turned-on": { name: "turned-on", enabled: false, checkedAt: ago(HOUR), problems: [] },
    renamed: { name: "renamed", enabled: false, checkedAt: ago(HOUR), problems: [] },
    flagged: { name: "flagged", enabled: false, checkedAt: ago(3 * HOUR), problems: [{}] },
    "live-stale": { name: "live-stale", enabled: true, checkedAt: ago(7 * HOUR), problems: [] },
    "live-fresh": { name: "live-fresh", enabled: true, checkedAt: ago(HOUR), problems: [] },
  };
  const { reads, deferred } = planReads(catalog, records, { now: NOW });
  assert.deepEqual(reads.map((r) => `${r.id}:${r.reason}`), [
    "new-live:new_live",
    "turned-on:switched_on",
    "new-off:new",
    "renamed:renamed",
    "flagged:flagged_recheck",
    "live-stale:live_recheck",
  ]);
  assert.equal(deferred, 0);

  const capped = planReads(catalog, records, { now: NOW, maxReads: 2 });
  assert.deepEqual(capped.reads.map((r) => r.id), ["new-live", "turned-on"]);
  assert.equal(capped.deferred, 4);
});

test("an incident alerts once while off, once more when switched on, and closes when clean", () => {
  const record = { problems: [{}], digest: "d1", alerted: null };
  assert.equal(needsAlert(record, false), true);
  record.alerted = { digest: "d1", live: false };
  assert.equal(needsAlert(record, false), false);
  assert.equal(needsAlert(record, true), true, "switched on: candidates now receive it");
  record.alerted = { digest: "d1", live: true };
  assert.equal(needsAlert(record, true), false);
  assert.equal(needsAlert(record, false), false, "switching off is not a new incident");
  assert.equal(needsAlert({ ...record, digest: "d2" }, true), true, "a different problem is");
  assert.equal(needsAlert({ problems: [], digest: null, alerted: null }, true), false);
});

test("the alert names the sequence and step, links Paraform, and escapes Slack control characters", () => {
  const text = alertText([
    { id: "off-1", name: "D - Acme - Engineer v1", live: false, problems: [{ step: 1, field: "body", kind: "typed_braces", text: "{Candidate First Name}" }] },
    { id: "live-1", name: "N - Growth & Partners v1", live: true, problems: [{ step: 2, field: "subject", kind: "typed_angles", text: "<<First Name>>" }] },
  ]);
  const lines = text.split("\n");
  assert.match(lines[0], /1 LIVE sequence/);
  assert.equal(lines[1], "• *LIVE*: <https://www.paraform.com/sequences?detail=live-1|N - Growth &amp; Partners v1>: Step 2 subject `&lt;&lt;First Name&gt;&gt;`");
  assert.equal(lines[2], "• off: <https://www.paraform.com/sequences?detail=off-1|D - Acme - Engineer v1>: Step 1 body `{Candidate First Name}`");
  assert.match(lines.at(-1), /Nothing was changed automatically/);
});

// ---------- one pass, end to end ----------

function harness({ catalog, campaigns, send = async () => true, initialState = null, pause = { paused: false } } = {}) {
  const calls = { list: 0, reads: [], sends: [], sleeps: [], saves: 0 };
  let stored = initialState ? JSON.stringify(initialState) : null;
  let time = NOW;
  const deps = {
    loadState: async () => (stored == null ? null : JSON.parse(stored)),
    saveState: async (state) => { calls.saves++; stored = JSON.stringify(state); },
    pauseState: async () => pause,
    sessionReady: async () => true,
    listCatalog: async () => { calls.list++; return structuredClone(catalog()); },
    readCampaign: async (id) => {
      calls.reads.push(id);
      const value = campaigns()[id];
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    send: async (text) => { calls.sends.push(text); return send(text); },
    exemptInsertIds: [TEMPLATE_ID],
    clock: () => time,
    sleep: async (ms) => { calls.sleeps.push(ms); time += ms; },
    spacingMs: 2000,
  };
  return {
    calls,
    state: () => JSON.parse(stored),
    advance: (ms) => { time += ms; },
    run: (extra = {}) => runMergeFieldCheck({ ...deps, ...extra }),
  };
}

test("first pass finds the live typed placeholder, posts once naming it, and never writes to Paraform", async () => {
  let enabled = { henry: true, assemble: false, clean: true };
  const campaigns = {
    henry: campaign("henry", [step(1, TYPED_BODY), step(2, TYPED_BODY), step(3, GOOD_BODY)]),
    assemble: campaign("assemble", [step(1, TYPED_BODY)]),
    clean: campaign("clean", [step(1, GOOD_BODY)]),
    [TEMPLATE_ID]: campaign(TEMPLATE_ID, [step(1, "<p>*INSERT ROLE*</p>")]),
  };
  const names = { henry: "N - Henry Labs - Founding Engineer v1", assemble: "D - Assemble - Engineer v1", clean: "Clean v1", [TEMPLATE_ID]: "No Scheduled Call - Raydar - 1st Round Interview" };
  const catalog = () => Object.keys(campaigns).map((id) => ({ id, name: names[id], enabled: Boolean(enabled[id]) }));
  const h = harness({ catalog, campaigns: () => campaigns });

  const first = await h.run();
  assert.equal(first.ok, true);
  assert.equal(first.status, "complete");
  assert.equal(first.reads, 4);
  assert.equal(first.flaggedLive, 1);
  assert.equal(first.flaggedOff, 1);
  assert.equal(first.alertsPosted, 2);
  assert.equal(h.calls.list, 1);
  assert.deepEqual(h.calls.reads.slice(0, 2).sort(), ["clean", "henry"], "live sequences first");
  assert.ok(h.calls.sleeps.every((ms) => ms === 2000) && h.calls.sleeps.length === 4, "reads are spaced");
  assert.equal(h.calls.sends.length, 1, "one post per pass");
  assert.match(h.calls.sends[0], /\*LIVE\*: <[^|]+detail=henry\|N - Henry Labs - Founding Engineer v1>: Step 1 body `\{Candidate First Name\}`; Step 2 body/);
  assert.match(h.calls.sends[0], /off: <[^|]+detail=assemble\|D - Assemble - Engineer v1>/);
  assert.doesNotMatch(h.calls.sends[0], /No Scheduled Call/, "the template's INSERT marker is intended");

  // Nothing changed: the next pass reads nothing and stays quiet.
  h.advance(30 * 60 * 1000);
  const second = await h.run();
  assert.equal(second.reads, 0);
  assert.equal(h.calls.sends.length, 1);

  // Switching the broken sequence on is the moment it starts sending.
  enabled = { ...enabled, assemble: true };
  h.advance(30 * 60 * 1000);
  const third = await h.run();
  assert.deepEqual(h.calls.reads.slice(-1), ["assemble"]);
  assert.equal(third.flaggedLive, 2);
  assert.equal(h.calls.sends.length, 2);
  assert.match(h.calls.sends[1], /^:rotating_light: 1 LIVE sequence/);
  assert.match(h.calls.sends[1], /detail=assemble/);
  assert.doesNotMatch(h.calls.sends[1], /detail=henry/, "henry already alerted as live");

  // Fixed in Paraform: the flagged recheck reads it clean and closes the incident silently.
  campaigns.henry = campaign("henry", [step(1, GOOD_BODY), step(2, GOOD_BODY), step(3, GOOD_BODY)]);
  h.advance(2 * HOUR);
  const fourth = await h.run();
  assert.equal(fourth.flaggedLive, 1);
  assert.equal(h.calls.sends.length, 2, "no recovery post");
  assert.equal(h.state().records.henry.alerted, null);
});

test("off, edited, back on: switching on again forces a fresh read", async () => {
  const campaigns = { s1: campaign("s1", [step(1, GOOD_BODY)]) };
  let enabled = true;
  const h = harness({ catalog: () => [{ id: "s1", name: "S1", enabled }], campaigns: () => campaigns });
  await h.run();
  enabled = false;
  h.advance(30 * 60 * 1000);
  await h.run();
  assert.equal(h.calls.reads.length, 1, "switching off needs no read");
  campaigns.s1 = campaign("s1", [step(1, TYPED_BODY)]);
  enabled = true;
  h.advance(30 * 60 * 1000);
  const back = await h.run();
  assert.equal(h.calls.reads.length, 2, "read again well inside the 6h live recheck");
  assert.equal(back.flaggedLive, 1);
  assert.equal(h.calls.sends.length, 1);
});

test("a failed Slack post is retried next pass; a dry run neither posts nor marks", async () => {
  const campaigns = { s1: campaign("s1", [step(1, TYPED_BODY)]) };
  const catalog = () => [{ id: "s1", name: "S1", enabled: true }];
  let slackUp = false;
  const h = harness({ catalog, campaigns: () => campaigns, send: async () => slackUp });

  const dry = await h.run({ alert: false });
  assert.equal(dry.dryRun, true);
  assert.equal(h.calls.sends.length, 0);
  assert.equal(h.state().records.s1.alerted, null);

  const failed = await h.run();
  assert.equal(failed.alertFailed, true);
  assert.equal(h.state().records.s1.alerted, null);

  slackUp = true;
  const retried = await h.run();
  assert.equal(retried.alertsPosted, 1);
  assert.equal(h.calls.sends.length, 2);
  assert.equal(h.calls.reads.length, 1, "the retry needed no new read");
});

test("paused, stateless or a bad catalog: no campaign reads, and the last counts stay visible", async () => {
  const campaigns = { s1: campaign("s1", [step(1, TYPED_BODY)]) };
  let rows = [{ id: "s1", name: "S1", enabled: true }];
  const h = harness({ catalog: () => rows, campaigns: () => campaigns, send: async () => true });
  await h.run();
  assert.equal(h.calls.reads.length, 1);

  const paused = await h.run({ pauseState: async () => ({ paused: true, state: "configured" }) });
  assert.equal(paused.status, "paused");
  assert.equal(paused.flaggedLive, 1, "carried from the last real pass");
  assert.equal(h.calls.list, 1, "paused means no Paraform request at all");

  const noState = await h.run({ loadState: async () => { throw new Error("KV down"); } });
  assert.equal(noState.error, "state_unavailable");
  assert.equal(h.calls.list, 1);

  // A catalog that suddenly lost most sequences is a bad read: keep the state.
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, name: `x${i}`, enabled: false }));
  const h2 = harness({ catalog: () => rows, campaigns: () => ({}) , initialState: {
    schema: STATE_SCHEMA,
    records: Object.fromEntries(many.map((r) => [r.id, { name: r.name, enabled: false, checkedAt: ago(HOUR), problems: [] }])),
  } });
  rows = [{ id: "x0", name: "x0", enabled: false }];
  const shrank = await h2.run();
  assert.equal(shrank.error, "catalog_shrank");
  assert.equal(Object.keys(h2.state().records).length, 40);
  const believed = await h2.run();
  assert.equal(believed.status, "complete", "the same size twice in a row is a real delete");
  assert.deepEqual(Object.keys(h2.state().records), ["x0"]);

  // An empty catalog is never believed, however often it comes back.
  rows = [];
  const h3 = harness({ catalog: () => rows, campaigns: () => ({}), initialState: h2.state() });
  assert.equal((await h3.run()).error, "catalog_shrank");
  assert.equal((await h3.run()).error, "catalog_shrank");
  assert.deepEqual(Object.keys(h3.state().records), ["x0"]);
});

test("a dead session or throttle stops the pass but keeps what was read", async () => {
  const expired = Object.assign(new Error("AUTH_EXPIRED"), { code: "AUTH_EXPIRED" });
  const campaigns = { a: campaign("a", [step(1, TYPED_BODY)]), b: expired, c: campaign("c", [step(1, GOOD_BODY)]) };
  const catalog = () => ["a", "b", "c"].map((id) => ({ id, name: id, enabled: true }));
  const h = harness({ catalog, campaigns: () => campaigns });
  const result = await h.run();
  assert.equal(result.status, "error");
  assert.equal(result.error, "paraform_expired");
  assert.deepEqual(h.calls.reads, ["a", "b"]);
  assert.equal(result.flaggedLive, 1);
  assert.equal(h.calls.sends.length, 1, "what was read still alerts");
  assert.equal(h.state().lastOkAt, null);
});

test("the soft deadline and the read cap defer the rest to the next pass", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
  const campaigns = Object.fromEntries(ids.map((id) => [id, campaign(id, [step(1, GOOD_BODY)])]));
  const catalog = () => ids.map((id) => ({ id, name: id, enabled: false }));
  const h = harness({ catalog, campaigns: () => campaigns });
  const first = await h.run({ deadlineMs: 5000 });
  assert.equal(first.reads, 3);
  assert.equal(first.deferred, 7);
  assert.equal(first.status, "partial");
  const second = await h.run({ plan: { maxReads: 4 } });
  assert.equal(second.reads, 4);
  assert.equal(second.deferred, 3);
  assert.equal(second.neverChecked, 3);
});

test("a pass where every read fails is not a good pass", async () => {
  const boom = new Error("Unexpected token < in JSON");
  const campaigns = { a: boom, b: boom };
  const h = harness({ catalog: () => ["a", "b"].map((id) => ({ id, name: id, enabled: true })), campaigns: () => campaigns });
  const result = await h.run();
  assert.equal(result.status, "error");
  assert.equal(result.error, "read_errors");
  assert.equal(result.readErrors, 2);
  assert.equal(h.state().lastOkAt, null);
});

test("a 429 stops the pass at once; three failed reads in a row stop it too", async () => {
  const ids = ["a", "b", "c", "d", "e"];
  const catalog = () => ids.map((id) => ({ id, name: id, enabled: true }));
  const throttled = Object.assign(new Error("PARAFORM_HTTP_429"), { code: "PARAFORM_HTTP_429" });
  const h429 = harness({ catalog, campaigns: () => Object.fromEntries(ids.map((id) => [id, throttled])) });
  assert.equal((await h429.run()).error, "paraform_throttled");
  assert.equal(h429.calls.reads.length, 1);
  for (const error of [new Error("FORBIDDEN"), new Error("HTTP 502")]) {
    const h = harness({ catalog, campaigns: () => Object.fromEntries(ids.map((id) => [id, error])) });
    const result = await h.run();
    assert.equal(result.error, "read_errors");
    assert.equal(h.calls.reads.length, 3, `${error.message}: a storm stops after three`);
  }
});

test("sequences that keep failing cannot starve the live rechecks", async () => {
  const forbidden = new Error("FORBIDDEN");
  const campaigns = { p1: forbidden, p2: forbidden, p3: forbidden, live: campaign("live", [step(1, GOOD_BODY)]) };
  const catalog = () => [
    ...["p1", "p2", "p3"].map((id) => ({ id, name: id, enabled: true })),
    { id: "live", name: "live", enabled: true },
  ];
  const h = harness({ catalog, campaigns: () => campaigns, initialState: {
    schema: STATE_SCHEMA,
    records: { live: { name: "live", enabled: true, checkedAt: ago(7 * HOUR), problems: [] } },
  } });
  const first = await h.run();
  assert.equal(first.error, "read_errors");
  assert.deepEqual(h.calls.reads, ["p1", "p2", "p3"]);
  h.advance(30 * 60 * 1000);
  await h.run();
  assert.equal(h.calls.reads[3], "live", "failed sequences now wait behind every other read");
});

test("a sequence whose read keeps failing goes to the back instead of blocking every pass", async () => {
  const throttled = Object.assign(new Error("PARAFORM_THROTTLED"), { code: "PARAFORM_THROTTLED" });
  const campaigns = { stuck: throttled, b: campaign("b", [step(1, GOOD_BODY)]), c: campaign("c", [step(1, GOOD_BODY)]) };
  const h = harness({ catalog: () => ["stuck", "b", "c"].map((id) => ({ id, name: id, enabled: true })), campaigns: () => campaigns });
  await h.run();
  assert.deepEqual(h.calls.reads, ["stuck"]);
  h.advance(30 * 60 * 1000);
  const second = await h.run();
  assert.deepEqual(h.calls.reads.slice(1), ["b", "c", "stuck"]);
  assert.equal(second.reads, 2);
});

test("more than one post's worth: only the named sequences are marked, the rest post next pass", async () => {
  const ids = Array.from({ length: MAX_ALERT_SEQUENCES + 5 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const campaigns = Object.fromEntries(ids.map((id) => [id, campaign(id, [step(1, TYPED_BODY)])]));
  const h = harness({ catalog: () => ids.map((id) => ({ id, name: id, enabled: false })), campaigns: () => campaigns });
  const first = await h.run({ plan: { maxReads: 100 } });
  assert.equal(first.alertsDue, MAX_ALERT_SEQUENCES + 5);
  assert.equal(first.alertsPosted, MAX_ALERT_SEQUENCES);
  assert.match(h.calls.sends[0], /\+5 more, named in the next post/);
  const second = await h.run();
  assert.equal(second.alertsPosted, 5);
  assert.match(h.calls.sends[1], /detail=s34/);
  assert.doesNotMatch(h.calls.sends[1], /detail=s00/);
  await h.run();
  assert.equal(h.calls.sends.length, 2);
});

test("if the state cannot be saved, nothing is posted (no repeat post every pass)", async () => {
  const campaigns = { s1: campaign("s1", [step(1, TYPED_BODY)]) };
  const h = harness({ catalog: () => [{ id: "s1", name: "S1", enabled: true }], campaigns: () => campaigns });
  const saveFails = async () => { throw new Error("KV write failed"); };
  for (let i = 0; i < 3; i++) {
    const result = await h.run({ saveState: saveFails });
    assert.equal(result.error, "state_save_failed");
  }
  assert.equal(h.calls.sends.length, 0);
});

test("catalog quirks: duplicate ids read once, null names do not look renamed, a live template loses its exemption", async () => {
  const campaigns = {
    dup: campaign("dup", [step(1, GOOD_BODY)]),
    nameless: campaign("nameless", [step(1, GOOD_BODY)]),
    [TEMPLATE_ID]: campaign(TEMPLATE_ID, [step(1, "<p>*INSERT ROLE*</p>")]),
  };
  let templateLive = false;
  const catalog = () => [
    { id: "dup", name: "Dup", enabled: false },
    { id: "dup", name: "Dup", enabled: false },
    { id: "nameless", name: null, enabled: false },
    { id: TEMPLATE_ID, name: "Template", enabled: templateLive },
  ];
  const h = harness({ catalog, campaigns: () => campaigns });
  const first = await h.run();
  assert.equal(first.reads, 3);
  assert.equal(first.flaggedOff, 0);
  h.advance(30 * 60 * 1000);
  assert.equal((await h.run()).reads, 0, "nothing changed, nothing read");
  templateLive = true;
  h.advance(30 * 60 * 1000);
  const live = await h.run();
  assert.equal(live.flaggedLive, 1, "a switched-on template would send *INSERT ROLE*");
  assert.match(h.calls.sends[0], /\*LIVE\*.*INSERT ROLE/);
});

// ---------- System Health tile ----------

const summary = (lastPass, extra = {}) => ({
  ok: true,
  check: "seq-merge-field-check",
  lastOkAt: new Date().toISOString(),
  lastPass: { at: new Date().toISOString(), status: "complete", flaggedLive: 0, flaggedOff: 0, neverChecked: 0, ...lastPass },
  ...extra,
});

test("tile: DOWN for a live problem, DEGRADED for switched-off or stale, UNKNOWN when it cannot tell", () => {
  assert.equal(sequenceMergeFields({ body: summary({}) }).state, "OK");
  assert.equal(sequenceMergeFields({ body: summary({ flaggedLive: 1 }) }).state, "DOWN");
  assert.equal(sequenceMergeFields({ body: summary({ flaggedLive: 1, status: "paused" }) }).state, "DOWN");
  assert.equal(sequenceMergeFields({ body: summary({ flaggedOff: 2 }) }).state, "DEGRADED");
  assert.equal(sequenceMergeFields({ body: summary({ alertFailed: true }) }).state, "DEGRADED");
  assert.equal(sequenceMergeFields({ body: summary({ status: "error", error: "paraform_throttled" }, { lastOkAt: new Date(Date.now() - 4 * HOUR).toISOString() }) }).state, "DEGRADED");
  assert.equal(sequenceMergeFields({ body: summary({ status: "paused" }) }).state, "UNKNOWN");
  assert.equal(sequenceMergeFields({ body: { ok: true, check: "seq-merge-field-check", lastPass: null } }).state, "UNKNOWN");
  assert.equal(sequenceMergeFields({ body: { ok: false, error: "state_unavailable" } }).state, "UNKNOWN");
  assert.equal(sequenceMergeFields({ body: { ok: true } }).state, "UNKNOWN");
  assert.equal(EVALUATORS.sequenceMergeFields, sequenceMergeFields);
  const row = CATALOG.find((c) => c.id === "seq-merge-fields");
  assert.equal(row.tier, 2, "the cron posts the named alert; the tile must not page too");
  assert.equal(row.probe.evaluate, "sequenceMergeFields");
});

// ---------- endpoint boundary ----------

test("endpoint: the public read is KV-only counts; a run needs the cron secret or a sign-in", async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  process.env.KV_REST_API_URL = "https://kv.test";
  process.env.KV_REST_API_TOKEN = "kv-token";
  process.env.CRON_SECRET = "cron-secret-value";
  process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
  const state = {
    schema: STATE_SCHEMA,
    lastOkAt: "2026-09-29T19:41:00.000Z",
    lastPass: { at: "2026-09-29T19:41:00.000Z", status: "complete", flaggedLive: 1, flaggedOff: 0, neverChecked: 0 },
    records: { s1: { name: "N - Secret Name v1", enabled: true, checkedAt: "2026-09-29T19:41:00.000Z", problems: [{ step: 1, field: "body", kind: "typed_braces", text: "{Candidate First Name}" }], digest: "d" } },
  };
  const hosts = [];
  globalThis.fetch = async (url, init) => {
    hosts.push(new URL(String(url)).host);
    const command = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: command[0] === "GET" ? JSON.stringify(state) : "OK" }), { status: 200 });
  };
  try {
    const { default: handler } = await import("../api/seq/merge-field-check.mjs");
    const call = async (url, headers = {}) => {
      let status = 200;
      let body;
      const res = {
        setHeader() {},
        status(code) { status = code; return this; },
        json(value) { body = value; return this; },
        end() { return this; },
      };
      await handler({ method: "GET", url, headers }, res);
      return { status, body };
    };

    const open = await call("/api/seq/merge-field-check");
    assert.equal(open.status, 200);
    assert.equal(open.body.lastPass.flaggedLive, 1);
    assert.doesNotMatch(JSON.stringify(open.body), /Secret Name|Candidate First Name/, "public read carries no names");

    for (const url of ["/api/seq/merge-field-check?run=1", "/api/seq/merge-field-check?detail=1"]) {
      const denied = await call(url, { "x-vercel-cron": "1" });
      assert.equal(denied.status, 401, `${url} without a sign-in`);
    }
    assert.ok(hosts.every((host) => host === "kv.test"), "no Paraform request on any unauthenticated path");
  } finally {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
