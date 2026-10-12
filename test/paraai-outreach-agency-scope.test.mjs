// Para AI interview-request outreach covers the agency (David, 2026-10-12):
// David's own requests plus Vanessa's, Alzen's and Noah's; Kyra's seat never.
import assert from "node:assert/strict";
import test from "node:test";

import {
  outreachScopeConfig,
  recruiterKey,
  requestScope,
} from "../api/paraai/_lib/outreach-scope.mjs";
import {
  outreachBatch,
  readSubmissionRequestHistoryWithScope,
  requestOrdinal,
  teammateNudgeUnseen,
  teammateWriteRefused,
} from "../api/paraai/_lib/outreach.mjs";
import { passCauseFor } from "../api/paraai/_lib/outreach-reply-pass.mjs";

const ME = "user-david";
const SCOPE = outreachScopeConfig({});

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
const vanessa = seat("user-vanessa", "Vanessa Vallador");
const alzen = seat("user-alzen", "Alzen Flores");
const noah = seat("user-noah", "Noah Kingsdale");
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
  const commands = [];
  const impl = async ([command, key, value]) => {
    commands.push(command);
    if (command === "GET") return map.get(key) ?? null;
    if (command === "SET") { map.set(key, value); return "OK"; }
    return null;
  };
  return { impl, map, commands };
}

const read = (responses, { scope = SCOPE, kv = kvStore() } = {}) => {
  const vendor = paraform(responses);
  return readSubmissionRequestHistoryWithScope({ scope, trpcGetImpl: vendor.impl, kvImpl: kv.impl })
    .then((result) => ({ ...result, calls: vendor.calls, kv }));
};

test("the agency view is on by default and covers Vanessa, Alzen and Noah", () => {
  assert.deepEqual(SCOPE, { agencyView: true, teammates: ["vanessa", "alzen", "noah"] });
  assert.equal(outreachScopeConfig({ PARAAI_OUTREACH_AGENCY_VIEW: "off" }).agencyView, false);
  // Set but empty means David only.
  assert.deepEqual(outreachScopeConfig({ PARAAI_OUTREACH_TEAMMATES: "" }).teammates, []);
});

test("Kyra can never be configured in", () => {
  const scope = outreachScopeConfig({ PARAAI_OUTREACH_TEAMMATES: "vanessa, Kyra ,noah" });
  assert.deepEqual(scope.teammates, ["vanessa", "noah"]);
  const forced = { agencyView: true, teammates: ["kyra"] };
  assert.equal(requestScope(kyra("k1"), { scope: forced, currentUserId: ME }).covered, false);
  assert.equal(requestScope(kyra("k1"), { scope: forced, currentUserId: ME }).excluded, "protected_recruiter");
  const wyman = seat("user-k", "Kyra Wyman")("k2");
  assert.equal(requestScope(wyman, { scope: SCOPE, currentUserId: ME }).excluded, "protected_recruiter");
});

test("each row is judged by its recruiter, by id first", () => {
  const verdict = (r) => requestScope(r, { scope: SCOPE, currentUserId: ME });
  assert.equal(verdict(row("d1")).own, true);
  assert.equal(verdict(row("d1", { recruiter: { id: ME, name: "Anyone" } })).own, true);
  assert.equal(verdict(vanessa("v1")).covered, true);
  assert.equal(verdict(vanessa("v1")).own, false);
  assert.equal(verdict(alzen("a1")).covered, true);
  assert.equal(verdict(noah("n1")).covered, true);
  assert.equal(verdict(seat("user-cleo", "Cleo Zimri")("c1")).excluded, "recruiter_not_listed");
  assert.equal(verdict(row("x1", { sentTo: "user-x" })).excluded, "recruiter_unknown");
  assert.equal(verdict({ ...row("x2"), sent_to_user_id: undefined, recruiter: null }).unidentifiable, true);
  // Two ids, or two names, cannot be trusted either way.
  const ids = row("x3", { sentTo: "user-kyra", recruiter: { id: "user-vanessa", name: "Vanessa Vallador" } });
  assert.equal(verdict(ids).unidentifiable, true);
  const directory = new Map([["user-kyra", { name: "Kyra Phillips", email: "" }]]);
  const names = row("x4", { sentTo: "user-kyra", recruiter: { name: "Vanessa V" } });
  const mixed = requestScope(names, { scope: SCOPE, currentUserId: ME, directory });
  assert.equal(mixed.covered, false);
  assert.equal(mixed.unidentifiable, true);
  // No currentUserId: nothing can be called David's.
  assert.equal(requestScope(row("d1"), { scope: SCOPE, currentUserId: "" }).unidentifiable, true);
  // With the agency view off, every row is David's, as before.
  assert.equal(requestScope(vanessa("v1"), { scope: { agencyView: false, teammates: [] } }).own, true);
});

test("a recruiter is named from a name, an email or the directory", () => {
  assert.equal(recruiterKey({ name: "Vanessa Vallador" }), "vanessa");
  assert.equal(recruiterKey({ email: "alzen.flores@raydargroup.com" }), "alzen");
  assert.equal(recruiterKey({}), "");
  const byEmail = row("e1", { sentTo: "user-n", recruiter: { id: "user-n", email: "noah@raydargroup.com" } });
  assert.equal(requestScope(byEmail, { scope: SCOPE, currentUserId: ME }).covered, true);
  // An address that is not the first name never contradicts the name.
  const surnameEmail = row("e3", { sentTo: "user-v2", recruiter: { id: "user-v2", name: "Vanessa Vallador", email: "vvallador@raydargroup.com" } });
  assert.equal(requestScope(surnameEmail, { scope: SCOPE, currentUserId: ME }).covered, true);
  // ...but a Kyra address still marks the row protected.
  const kyraEmail = row("e4", { sentTo: "user-k3", recruiter: { id: "user-k3", name: "K. P.", email: "kyra@raydargroup.com" } });
  assert.equal(requestScope(kyraEmail, { scope: SCOPE, currentUserId: ME }).excluded, "protected_recruiter");
  const byDirectory = row("e2", { sentTo: "user-v", recruiter: null });
  const directory = new Map([["user-v", { name: "Vanessa Vallador", email: "" }]]);
  assert.equal(requestScope(byDirectory, { scope: SCOPE, currentUserId: ME, directory }).covered, true);
});

test("the agency read keeps David's and the teammates' requests and drops Kyra's", async () => {
  const { requests, scope, calls } = await read([{
    currentUserId: ME,
    requests: [row("d1"), vanessa("v1"), alzen("a1"), noah("n1"), kyra("k1"), kyra("k2", { status: "expired" })],
  }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { agencyView: true, recruiterFilter: [] });
  assert.deepEqual(requests.map((r) => r.id), ["d1", "v1", "a1", "n1"]);
  assert.deepEqual(requests.map((r) => r.ownRequest), [true, false, false, false]);
  assert.deepEqual(requests.map((r) => r.recruiterKey), ["david", "vanessa", "alzen", "noah"]);
  assert.equal(scope.fallback, null);
  assert.deepEqual(scope.byRecruiter.kyra, { rows: 2, pending: 1, coveredPending: 0, excluded: { protected_recruiter: 1 } });
  assert.equal(scope.byRecruiter.david.coveredPending, 1);
});

test("a teammate's request for a candidate on Kyra's seat is left out; David's is not", async () => {
  const { requests, scope } = await read([{
    currentUserId: ME,
    requests: [
      kyra("k1", { candidate: "shared" }),
      vanessa("v1", { candidate: "shared" }),
      row("d1", { candidate: "shared" }),
      vanessa("v2", { candidate: "other" }),
    ],
  }]);
  assert.deepEqual(requests.map((r) => r.id), ["d1", "v2"]);
  assert.equal(scope.byRecruiter.vanessa.excluded.candidate_on_uncovered_seat, 1);
});

test("Kyra's candidates stay out even when her row carries no name", async () => {
  // Her id is learned from a named row and applied to a nameless one.
  const named = await read([{
    currentUserId: ME,
    requests: [
      row("d1"),
      kyra("k1", { candidate: "a" }),
      row("k2", { sentTo: "user-kyra", recruiter: { id: "user-kyra" }, candidate: "b" }),
      vanessa("v1", { candidate: "b" }),
    ],
  }]);
  assert.deepEqual(named.requests.map((r) => r.id), ["d1"]);
  assert.equal(named.scope.byRecruiter.unknown.excluded.protected_recruiter, 1);
  // With no named row at all, any uncovered seat guards the candidate.
  const nameless = await read([{
    currentUserId: ME,
    requests: [
      row("d1"),
      row("k3", { sentTo: "user-k9", recruiter: { id: "user-k9", email: "kphillips@raydargroup.com" }, candidate: "c" }),
      vanessa("v2", { candidate: "c" }),
      vanessa("v3", { candidate: "d" }),
    ],
  }]);
  assert.deepEqual(nameless.requests.map((r) => r.id), ["d1", "v3"]);
});

test("anything ambiguous falls back to David's scoped read, and is remembered for an hour", async () => {
  const blind = { ...row("x1"), sent_to_user_id: undefined, recruiter: null };
  const first = await read([
    { currentUserId: ME, requests: [row("d1"), blind, vanessa("v1")] },
    { requests: [row("d1"), row("d2")] },
  ]);
  assert.deepEqual(first.calls.map((c) => c.input.agencyView), [true, false]);
  assert.deepEqual(first.requests.map((r) => r.id), ["d1", "d2"]);
  assert.equal(first.scope.fallback, "recruiter_identity_missing");
  assert.ok(Array.isArray(first.scope.shape.rowKeys));
  // The next read skips the agency view: one Paraform read, not two.
  const vendor = paraform([{ requests: [row("d1")] }]);
  const second = await readSubmissionRequestHistoryWithScope({ scope: SCOPE, trpcGetImpl: vendor.impl, kvImpl: first.kv.impl });
  assert.deepEqual(vendor.calls.map((c) => c.input.agencyView), [false]);
  assert.equal(second.scope.fallback, "agency_read_failed_recently");

  // An agency read with no row of David's is not trusted: empty, someone
  // else's currentUserId, or rows under another field.
  for (const response of [
    { currentUserId: ME, requests: [] },
    { currentUserId: "user-someone", requests: [row("d1"), vanessa("v1")] },
    { currentUserId: ME, requests: [vanessa("v1"), alzen("a1")] },
    { currentUserId: ME, items: [row("d1")] },
  ]) {
    const result = await read([response, { requests: [row("d1")] }]);
    assert.equal(result.scope.fallback, "no_own_rows");
    assert.deepEqual(result.requests.map((r) => r.id), ["d1"]);
    assert.deepEqual(result.calls.map((c) => c.input.agencyView), [true, false]);
  }
  const noUser = await read([{ requests: [row("d1"), vanessa("v1")] }, { requests: [row("d1")] }]);
  assert.equal(noUser.scope.fallback, "current_user_unknown");
  assert.deepEqual(noUser.requests.map((r) => r.id), ["d1"]);
});

test("a refused, slow or broken agency read falls back; a throttle still stops the tick", async () => {
  for (const failure of [
    Object.assign(new Error("FORBIDDEN"), { status: 403 }),
    Object.assign(new Error("down"), { status: 502 }),
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
  ]) {
    const result = await read([failure, { requests: [row("d1")] }]);
    assert.deepEqual(result.requests.map((r) => r.id), ["d1"]);
    assert.equal(result.scope.fallback, "agency_read_failed");
  }
  for (const stop of [
    Object.assign(new Error("throttled"), { code: "PARAFORM_THROTTLED" }),
    Object.assign(new Error("429"), { status: 429 }),
    Object.assign(new Error("cool"), { code: "PARAFORM_REQUEST_LANES_COOLING_DOWN" }),
    Object.assign(new Error("pace"), { code: "PARAFORM_REQUEST_LANES_RATE_LIMITED" }),
  ]) {
    const vendor = paraform([stop]);
    await assert.rejects(readSubmissionRequestHistoryWithScope({ scope: SCOPE, trpcGetImpl: vendor.impl, kvImpl: kvStore().impl }));
    assert.equal(vendor.calls.length, 1);
  }
});

test("with the agency view off the lane reads David's requests only, once", async () => {
  const { requests, calls } = await read([{ requests: [row("d1")] }], { scope: { agencyView: false, teammates: [] } });
  assert.deepEqual(calls.map((c) => c.input), [{ agencyView: false, recruiterFilter: [] }]);
  assert.equal(requests[0].ownRequest, true);
});

test("a teammate's candidate gets a first email even with older unanswered requests", async () => {
  const { requests } = await read([{
    currentUserId: ME,
    requests: [
      vanessa("v-old", { candidate: "michael", status: "expired", created: "2026-10-01T10:00:00.000Z" }),
      vanessa("v-new", { candidate: "michael", created: "2026-10-10T10:00:00.000Z" }),
      row("d-old", { candidate: "pat", created: "2026-10-01T10:00:00.000Z" }),
      vanessa("v-pat", { candidate: "pat", created: "2026-10-05T10:00:00.000Z" }),
      row("d-new", { candidate: "pat", created: "2026-10-10T10:00:00.000Z" }),
    ],
  }]);
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
