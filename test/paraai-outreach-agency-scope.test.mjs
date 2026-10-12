// Para AI interview-request outreach covers the agency (David, 2026-10-12):
// David's own requests (his unchanged read) plus Vanessa's, Alzen's and Noah's
// (a second read filtered to their user ids); Kyra's seat never.
import assert from "node:assert/strict";
import test from "node:test";

import {
  outreachScopeConfig,
  recruiterKey,
  requestScope,
  teammateRowScope,
  teammateUserIds,
  TEAMMATE_USER_IDS,
} from "../api/paraai/_lib/outreach-scope.mjs";
import {
  measureAgencyRead,
  sweepExpiryEscalations,
  outreachBatch,
  readSubmissionRequestHistoryWithScope,
  requestOrdinal,
  teammateNudgeUnseen,
  teammateWriteRefused,
} from "../api/paraai/_lib/outreach.mjs";
import { passCauseFor } from "../api/paraai/_lib/outreach-reply-pass.mjs";

const ME = "user-david";
const SCOPE = outreachScopeConfig({});
const V = TEAMMATE_USER_IDS.vanessa;
const A = TEAMMATE_USER_IDS.alzen;
const N = TEAMMATE_USER_IDS.noah;

function row(id, { sentTo = ME, recruiter = { id: sentTo }, candidate = `cand-${id}`, status = "pending", created = "2026-10-10T10:00:00.000Z" } = {}) {
  return {
    id,
    status,
    created_at: created,
    sent_to_user_id: sentTo,
    recruiter,
    candidate: { id: `c-${candidate}`, candidate_user_id: candidate, name: "Pat Q." },
    role: { id: `role-${id}`, name: "Founding Engineer", company: { name: "Acme" } },
  };
}

const seat = (userId, name) => (id, extra = {}) => row(id, { sentTo: userId, recruiter: { id: userId, name }, ...extra });
const vanessa = seat(V, "Vanessa Vallador");
const alzen = seat(A, "Alzen Flores");
const noah = seat(N, "Noah Kingsdale");
const kyra = seat("user-kyra", "Kyra Phillips");

function paraform(responses) {
  const calls = [];
  const impl = async (proc, input) => {
    calls.push({ proc, input });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}

function kvStore() {
  const map = new Map();
  const impl = async ([command, key, value, ...options]) => {
    if (command === "GET") return map.get(key) ?? null;
    if (command === "SET") {
      if (options.includes("NX") && map.has(key)) return null;
      map.set(key, value);
      return "OK";
    }
    return null;
  };
  return { impl, map };
}

// The own read answers first, the teammates' read second.
const read = (own, mates, { scope = SCOPE, kv = kvStore(), teammates = true } = {}) => {
  const vendor = paraform([
    { currentUserId: ME, requests: own },
    ...(mates === undefined ? [] : [mates instanceof Error ? mates : { currentUserId: ME, requests: mates }]),
  ]);
  return readSubmissionRequestHistoryWithScope({ scope, teammates, trpcGetImpl: vendor.impl, kvImpl: kv.impl })
    .then((result) => ({ ...result, calls: vendor.calls, kv }));
};

test("the agency view is on by default and covers Vanessa, Alzen and Noah", () => {
  assert.equal(SCOPE.agencyView, true);
  assert.deepEqual(SCOPE.teammates, ["vanessa", "alzen", "noah"]);
  assert.equal(SCOPE.teammateReadSeconds, 600);
  assert.equal(outreachScopeConfig({ PARAAI_OUTREACH_AGENCY_VIEW: "off" }).agencyView, false);
  // Set but empty means David only.
  assert.deepEqual(outreachScopeConfig({ PARAAI_OUTREACH_TEAMMATES: "" }).teammates, []);
  assert.deepEqual(teammateUserIds(SCOPE), [
    { key: "vanessa", userId: V },
    { key: "alzen", userId: A },
    { key: "noah", userId: N },
  ]);
});

test("Kyra can never be configured in or asked for", () => {
  const scope = outreachScopeConfig({
    PARAAI_OUTREACH_TEAMMATES: "vanessa, Kyra ,noah",
    PARAAI_OUTREACH_TEAMMATE_IDS: "kyra:userkyra000001",
  });
  assert.deepEqual(scope.teammates, ["vanessa", "noah"]);
  assert.equal(scope.teammateUserIds.kyra, undefined);
  assert.deepEqual(teammateUserIds({ ...scope, teammates: ["kyra", "vanessa"], teammateUserIds: { kyra: "x", vanessa: V } }), [
    { key: "vanessa", userId: V },
  ]);
  // A row that names her is left out even under a requested id.
  const disguised = row("k1", { sentTo: V, recruiter: { id: V, name: "Kyra Phillips" } });
  assert.equal(teammateRowScope(disguised, { ids: teammateUserIds(SCOPE), currentUserId: ME }).excluded, "protected_recruiter");
  assert.equal(requestScope(kyra("k2"), { scope: SCOPE, currentUserId: ME }).excluded, "protected_recruiter");
});

test("a teammate row is covered only for a seat that was asked for, under its own name", () => {
  const ids = teammateUserIds(SCOPE);
  const verdict = (r) => teammateRowScope(r, { ids, currentUserId: ME });
  assert.equal(verdict(vanessa("v1")).covered, true);
  assert.equal(verdict(vanessa("v1")).key, "vanessa");
  assert.equal(verdict(alzen("a1")).covered, true);
  assert.equal(verdict(noah("n1")).covered, true);
  // Name missing: the id the seat was asked for decides.
  assert.equal(verdict(row("v2", { sentTo: V, recruiter: { id: V } })).covered, true);
  assert.equal(verdict(seat("user-cleo", "Cleo Zimri")("c1")).excluded, "recruiter_not_requested");
  assert.equal(verdict(row("x1", { sentTo: V, recruiter: { id: V, name: "Noah Kingsdale" } })).excluded, "recruiter_names_disagree");
  assert.equal(verdict(row("x2", { sentTo: V, recruiter: { id: N } })).excluded, "recruiter_ids_disagree");
  assert.equal(verdict({ ...row("x3"), sent_to_user_id: undefined, recruiter: null }).excluded, "recruiter_unidentifiable");
  assert.equal(verdict(row("d1")).excluded, "own_row_in_teammate_read");
});

test("a recruiter is named from a name or an email", () => {
  assert.equal(recruiterKey({ name: "Vanessa Vallador" }), "vanessa");
  assert.equal(recruiterKey({ email: "alzen.flores@raydargroup.com" }), "alzen");
  assert.equal(recruiterKey({}), "");
  const ids = teammateUserIds(SCOPE);
  const surnameEmail = row("e1", { sentTo: V, recruiter: { id: V, name: "Vanessa Vallador", email: "vvallador@raydargroup.com" } });
  assert.equal(teammateRowScope(surnameEmail, { ids, currentUserId: ME }).covered, true);
  const kyraEmail = row("e2", { sentTo: N, recruiter: { id: N, email: "kyra@raydargroup.com" } });
  assert.equal(teammateRowScope(kyraEmail, { ids, currentUserId: ME }).excluded, "protected_recruiter");
});

test("David's read is unchanged; the teammates' read asks for their seats only", async () => {
  const { requests, scope, calls } = await read(
    [row("d1"), row("d2")],
    [vanessa("v1"), alzen("a1"), noah("n1"), kyra("k1"), row("d1")],
  );
  assert.deepEqual(calls.map((c) => c.input), [
    { agencyView: false, recruiterFilter: [] },
    { agencyView: true, recruiterFilter: [V, A, N] },
  ]);
  assert.deepEqual(requests.map((r) => r.id), ["d1", "d2", "v1", "a1", "n1"]);
  assert.deepEqual(requests.map((r) => r.ownRequest), [true, true, false, false, false]);
  assert.deepEqual(requests.map((r) => r.recruiterKey), ["david", "david", "vanessa", "alzen", "noah"]);
  assert.equal(scope.teammatesRead, true);
  assert.equal(scope.byRecruiter.vanessa.coveredPending, 1);
  assert.equal(scope.byRecruiter.kyra.excluded.recruiter_not_requested, 1);
});

test("a failed teammates' read leaves David whole; a throttle still stops the tick", async () => {
  for (const failure of [
    Object.assign(new Error("FORBIDDEN"), { status: 403 }),
    Object.assign(new Error("down"), { status: 502 }),
    Object.assign(new Error("timeout"), { name: "TimeoutError", code: 23 }),
  ]) {
    const result = await read([row("d1")], failure);
    assert.deepEqual(result.requests.map((r) => r.id), ["d1"]);
    assert.equal(result.scope.reason, "teammate_read_failed");
  }
  for (const stop of [
    Object.assign(new Error("throttled"), { code: "PARAFORM_THROTTLED" }),
    Object.assign(new Error("429"), { status: 429 }),
    Object.assign(new Error("cool"), { code: "PARAFORM_REQUEST_LANES_COOLING_DOWN" }),
    Object.assign(new Error("pace"), { code: "PARAFORM_REQUEST_LANES_RATE_LIMITED" }),
  ]) {
    await assert.rejects(read([row("d1")], stop));
  }
});

test("the tick reads teammates at most once per interval; off means David only", async () => {
  const kv = kvStore();
  const first = await read([row("d1")], [vanessa("v1")], { kv, teammates: "due" });
  assert.equal(first.calls.length, 2);
  const second = await read([row("d1")], undefined, { kv, teammates: "due" });
  assert.equal(second.calls.length, 1);
  assert.equal(second.scope.reason, "teammate_read_not_due");
  assert.deepEqual(second.requests.map((r) => r.id), ["d1"]);
  const off = await read([row("d1")], undefined, { scope: outreachScopeConfig({ PARAAI_OUTREACH_AGENCY_VIEW: "off" }) });
  assert.equal(off.calls.length, 1);
  const own = await read([row("d1")], undefined, { teammates: false });
  assert.equal(own.calls.length, 1);
});

test("a teammate's candidate gets a first email even with older unanswered requests", async () => {
  const { requests } = await read(
    [
      row("d-old", { candidate: "pat", created: "2026-10-01T10:00:00.000Z" }),
      row("d-new", { candidate: "pat", created: "2026-10-10T10:00:00.000Z" }),
    ],
    [
      vanessa("v-old", { candidate: "michael", status: "expired", created: "2026-10-01T10:00:00.000Z" }),
      vanessa("v-new", { candidate: "michael", created: "2026-10-10T10:00:00.000Z" }),
      vanessa("v-pat", { candidate: "pat", created: "2026-10-05T10:00:00.000Z" }),
    ],
  );
  const byId = Object.fromEntries(requests.map((r) => [r.id, r]));
  assert.equal(requestOrdinal(byId["v-new"], requests, null), 1);
  // David's own rows count exactly as before (v-pat was never emailed).
  assert.equal(requestOrdinal(byId["d-new"], requests, null), 2);
  const emailed = { matches: { "v-pat": { sentAt: "2026-10-05T11:00:00.000Z", ownRequest: false } } };
  assert.equal(requestOrdinal(byId["d-new"], requests, emailed), 3);
  assert.equal(requestOrdinal(byId["v-pat"], requests, null), 2);
  // The emailed teammate row still counts when a later read cannot see it.
  const davidOnly = requests.filter((r) => r.ownRequest !== false);
  assert.equal(requestOrdinal(byId["d-new"], davidOnly, emailed), 3);
  // Out of sight, it is placed by when the request was made, not when we wrote.
  const lateEmail = { matches: { "v-pat": { sentAt: "2026-10-11T00:00:00.000Z", requestCreatedAt: "2026-10-05T10:00:00.000Z", ownRequest: false } } };
  assert.equal(requestOrdinal(byId["d-new"], requests, lateEmail), 3);
  assert.equal(requestOrdinal(byId["d-new"], davidOnly, lateEmail), 3);
  // Old records (no ownRequest field) never add phantom rows.
  assert.equal(requestOrdinal(byId["d-new"], davidOnly, { matches: { gone: { sentAt: "2026-10-02T00:00:00.000Z" } } }), 2);
});

test("a teammate's nudge waits while its request is out of sight; David's never does", () => {
  const state = (ownRequest) => ({
    followup: { ownerMatchId: "m1" },
    matches: { m1: { sentAt: "2026-10-10T00:00:00.000Z", ...(ownRequest === false ? { ownRequest: false } : {}) } },
  });
  assert.equal(teammateNudgeUnseen(state(false), new Set(["other"])), true);
  assert.equal(teammateNudgeUnseen(state(false), new Set(["m1"])), false);
  assert.equal(teammateNudgeUnseen(state(true), new Set(["other"])), false);
  assert.equal(teammateNudgeUnseen(state(false), null), false);
});

test("David's requests take the batch first; teammates sit out while Paraform refuses them", () => {
  const own = (id) => ({ id, ownRequest: true });
  const mate = (id) => ({ id, ownRequest: false });
  const eligible = [mate("v1"), own("d1"), mate("v2"), own("d2")];
  assert.deepEqual(outreachBatch(eligible, { batchSize: 3 }).map((r) => r.id), ["d1", "d2", "v1"]);
  assert.deepEqual(outreachBatch(eligible, { batchSize: 3, teammatesPaused: true }).map((r) => r.id), ["d1", "d2"]);
  const refused = (fields) => teammateWriteRefused(Object.assign(new Error("x"), fields));
  assert.equal(refused({ status: 403, code: "-32003", outreachStage: "digest_mutation" }), true);
  assert.equal(refused({ status: 404, code: "HTTP_404", outreachStage: "contact_discovery" }), true);
  assert.equal(refused({ status: 502, code: "HTTP_502", outreachStage: "digest_mutation" }), false);
  assert.equal(refused({ code: "PARAFORM_THROTTLED", outreachStage: "digest_mutation" }), false);
  // Gmail and the delivery stages never trip it.
  assert.equal(refused({ status: 400, code: "GMAIL_REQUEST_FAILED", outreachStage: "contact_discovery" }), false);
  assert.equal(refused({ status: 404, code: "HTTP_404", outreachStage: "thread_anchor" }), false);
  assert.equal(refused({ status: 400, code: "HTTP_400", outreachStage: "gmail_delivery" }), false);
});

test("the reply pass never passes a teammate's request this lane did not email about", () => {
  const now = Date.parse("2026-10-12T18:00:00.000Z");
  const state = {
    candidateUserId: "michael",
    offMarket: {
      verdict: "OFF_MARKET",
      detectedAt: "2026-10-11T10:00:00.000Z",
      expiresAt: "2027-04-11T10:00:00.000Z",
      source: "model",
    },
    matches: { "v-emailed": { sentAt: "2026-10-09T10:00:00.000Z" } },
  };
  const teammate = (id) => ({ id, status: "pending", candidateUserId: "michael", roleId: `r-${id}`, ownRequest: false, createdAtMs: now - 86_400_000 });
  assert.equal(passCauseFor(state, teammate("v-other"), now), null);
  assert.equal(passCauseFor(state, teammate("v-emailed"), now)?.cause, "off_market");
  assert.equal(passCauseFor(state, { ...teammate("d-own"), ownRequest: true }, now)?.cause, "off_market");
});

test("the agency-read measurement reports timing, size, split and staff ids, never candidates", async () => {
  let t = 1_000;
  const seen = [];
  const ok = await measureAgencyRead({
    scope: SCOPE,
    clock: () => (t += 500),
    readImpl: async (json, options) => {
      seen.push({ json, options });
      return { currentUserId: ME, requests: [row("d1"), vanessa("v1"), kyra("k1")] };
    },
  });
  assert.deepEqual(seen[0], { json: { agencyView: true, recruiterFilter: [] }, options: { timeoutMs: 100_000 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.ms, 500);
  assert.equal(ok.rows, 3);
  assert.deepEqual(ok.userIds, { david: [ME], vanessa: [V], kyra: ["user-kyra"] });
  assert.ok(!JSON.stringify(ok).includes("Pat Q."));
  const failed = await measureAgencyRead({
    scope: SCOPE,
    readImpl: async () => { throw Object.assign(new Error("slow"), { name: "TimeoutError", code: 23 }); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "23");
});

test("a teammate's request near its deadline warns only after the lane was held on it", async () => {
  const now = Date.parse("2026-10-12T18:00:00.000Z");
  const nearly = new Date(now - 6.5 * 86_400_000).toISOString();
  const request = (id, ownRequest) => ({ id, status: "pending", createdAt: nearly, createdAtMs: Date.parse(nearly), ownRequest, reachedOut: false, candidateUserId: `c-${id}`, roleId: `r-${id}` });
  const warned = [];
  const escalateImpl = async (r, code) => { warned.push([r.id, code]); return { notified: true, rung: 12 }; };
  await sweepExpiryEscalations({
    history: [request("own", true), request("mate", false), request("held-mate", false)],
    exceptions: [{ status: "open", requestId: "held-mate", code: "OUTREACH_NO_EMAIL" }],
    now,
    escalateImpl,
  });
  assert.deepEqual(warned, [["own", null], ["held-mate", "OUTREACH_NO_EMAIL"]]);
});
