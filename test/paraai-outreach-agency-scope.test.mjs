// Para AI interview-request outreach covers the agency (David, 2026-10-12):
// David's own requests plus Vanessa's, Alzen's and Noah's; Kyra's seat never.
import assert from "node:assert/strict";
import test from "node:test";

import {
  outreachScopeConfig,
  recruiterKey,
  requestScope,
  unidentifiable,
} from "../api/paraai/_lib/outreach-scope.mjs";
import {
  readSubmissionRequestHistoryWithScope,
  requestOrdinal,
} from "../api/paraai/_lib/outreach.mjs";
import { passCauseFor } from "../api/paraai/_lib/outreach-reply-pass.mjs";

const ME = "user-david";
const SCOPE = outreachScopeConfig({});

function row(id, { sentTo = ME, recruiter = null, candidate = `cand-${id}`, status = "pending", created = "2026-10-10T10:00:00.000Z" } = {}) {
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

const vanessa = (id, extra = {}) => row(id, { sentTo: "user-vanessa", recruiter: { id: "user-vanessa", name: "Vanessa Vallador" }, ...extra });
const alzen = (id, extra = {}) => row(id, { sentTo: "user-alzen", recruiter: { id: "user-alzen", name: "Alzen Flores" }, ...extra });
const noah = (id, extra = {}) => row(id, { sentTo: "user-noah", recruiter: { id: "user-noah", name: "Noah Kingsdale" }, ...extra });
const kyra = (id, extra = {}) => row(id, { sentTo: "user-kyra", recruiter: { id: "user-kyra", name: "Kyra Phillips" }, ...extra });

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

test("the agency view is on by default and covers Vanessa, Alzen and Noah", () => {
  assert.deepEqual(SCOPE, { agencyView: true, teammates: ["vanessa", "alzen", "noah"] });
  assert.equal(outreachScopeConfig({ PARAAI_OUTREACH_AGENCY_VIEW: "off" }).agencyView, false);
});

test("Kyra can never be configured in", () => {
  const scope = outreachScopeConfig({ PARAAI_OUTREACH_TEAMMATES: "vanessa, Kyra ,noah" });
  assert.deepEqual(scope.teammates, ["vanessa", "noah"]);
  // Even if the list were bypassed, her rows read protected.
  const forced = { agencyView: true, teammates: ["kyra"] };
  assert.equal(requestScope(kyra("k1"), { scope: forced, currentUserId: ME }).covered, false);
  assert.equal(requestScope(kyra("k1"), { scope: forced, currentUserId: ME }).excluded, "protected_recruiter");
  const wyman = row("k2", { sentTo: "user-k", recruiter: { id: "user-k", name: "Kyra Wyman" } });
  assert.equal(requestScope(wyman, { scope: SCOPE, currentUserId: ME }).excluded, "protected_recruiter");
});

test("each row is judged by its recruiter", () => {
  const verdict = (r) => requestScope(r, { scope: SCOPE, currentUserId: ME });
  assert.equal(verdict(row("d1")).own, true);
  assert.equal(verdict(vanessa("v1")).covered, true);
  assert.equal(verdict(vanessa("v1")).own, false);
  assert.equal(verdict(alzen("a1")).covered, true);
  assert.equal(verdict(noah("n1")).covered, true);
  const cleo = row("c1", { sentTo: "user-cleo", recruiter: { id: "user-cleo", name: "Cleo Zimri" } });
  assert.equal(verdict(cleo).excluded, "recruiter_not_listed");
  const nameless = row("x1", { sentTo: "user-x", recruiter: { id: "user-x" } });
  assert.equal(verdict(nameless).excluded, "recruiter_unknown");
  assert.equal(unidentifiable(verdict(nameless)), false);
  const blind = { ...row("x2"), sent_to_user_id: undefined };
  assert.equal(unidentifiable(verdict(blind)), true);
  // With the agency view off, every row is David's, as before.
  assert.equal(requestScope(vanessa("v1"), { scope: { agencyView: false, teammates: [] } }).own, true);
});

test("a recruiter is named from a name or an email", () => {
  assert.equal(recruiterKey({ name: "Vanessa Vallador" }), "vanessa");
  assert.equal(recruiterKey({ email: "alzen.flores@raydargroup.com" }), "alzen");
  assert.equal(recruiterKey({}), "");
  const byEmail = row("e1", { sentTo: "user-n", recruiter: { id: "user-n", email: "noah@raydargroup.com" } });
  assert.equal(requestScope(byEmail, { scope: SCOPE, currentUserId: ME }).covered, true);
  const byDirectory = row("e2", { sentTo: "user-v", recruiter: null });
  const directory = new Map([["user-v", { name: "Vanessa Vallador", email: "" }]]);
  assert.equal(requestScope(byDirectory, { scope: SCOPE, currentUserId: ME, directory }).covered, true);
});

test("the agency read keeps David's and the teammates' requests and drops Kyra's", async () => {
  const { impl, calls } = paraform([{
    currentUserId: ME,
    requests: [row("d1"), vanessa("v1"), alzen("a1"), noah("n1"), kyra("k1"), kyra("k2", { status: "expired" })],
  }]);
  const { requests, scope } = await readSubmissionRequestHistoryWithScope({ scope: SCOPE, trpcGetImpl: impl });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { agencyView: true, recruiterFilter: [] });
  assert.deepEqual(requests.map((r) => r.id), ["d1", "v1", "a1", "n1"]);
  assert.deepEqual(requests.map((r) => r.ownRequest), [true, false, false, false]);
  assert.deepEqual(requests.map((r) => r.recruiterKey), ["david", "vanessa", "alzen", "noah"]);
  assert.equal(scope.fallback, null);
  assert.deepEqual(scope.byRecruiter.kyra, { rows: 2, pending: 1, covered: false, excluded: "protected_recruiter" });
  assert.equal(scope.byRecruiter.david.pending, 1);
});

test("a row nobody can be named on falls back to David's scoped read", async () => {
  const blind = { ...row("x1"), sent_to_user_id: undefined };
  const { impl, calls } = paraform([
    { currentUserId: ME, requests: [row("d1"), blind, vanessa("v1")] },
    { requests: [row("d1"), row("d2")] },
  ]);
  const { requests, scope } = await readSubmissionRequestHistoryWithScope({ scope: SCOPE, trpcGetImpl: impl });
  assert.deepEqual(calls.map((c) => c.input.agencyView), [true, false]);
  assert.deepEqual(requests.map((r) => r.id), ["d1", "d2"]);
  assert.equal(scope.fallback, "recruiter_identity_missing");
  assert.ok(Array.isArray(scope.shape.rowKeys));
});

test("a refused agency read falls back; a throttle or outage still stops the tick", async () => {
  const refused = Object.assign(new Error("FORBIDDEN"), { status: 403 });
  const first = paraform([refused, { requests: [row("d1")] }]);
  const result = await readSubmissionRequestHistoryWithScope({ scope: SCOPE, trpcGetImpl: first.impl });
  assert.deepEqual(result.requests.map((r) => r.id), ["d1"]);
  assert.equal(result.scope.fallback, "agency_read_refused");

  const throttled = Object.assign(new Error("throttled"), { code: "PARAFORM_THROTTLED" });
  const second = paraform([throttled]);
  await assert.rejects(
    readSubmissionRequestHistoryWithScope({ scope: SCOPE, trpcGetImpl: second.impl }),
    /throttled/,
  );
  assert.equal(second.calls.length, 1);
  const outage = Object.assign(new Error("down"), { status: 502 });
  await assert.rejects(readSubmissionRequestHistoryWithScope({ scope: SCOPE, trpcGetImpl: paraform([outage]).impl }));
});

test("with the agency view off the lane reads David's requests only, once", async () => {
  const { impl, calls } = paraform([{ requests: [row("d1")] }]);
  const { requests } = await readSubmissionRequestHistoryWithScope({ scope: { agencyView: false, teammates: [] }, trpcGetImpl: impl });
  assert.deepEqual(calls.map((c) => c.input), [{ agencyView: false, recruiterFilter: [] }]);
  assert.equal(requests[0].ownRequest, true);
});

test("a teammate's candidate gets a first email even with older unanswered requests", async () => {
  const { impl } = paraform([{
    currentUserId: ME,
    requests: [
      vanessa("v-old", { candidate: "michael", status: "expired", created: "2026-10-01T10:00:00.000Z" }),
      vanessa("v-new", { candidate: "michael", created: "2026-10-10T10:00:00.000Z" }),
      row("d-old", { candidate: "pat", created: "2026-10-01T10:00:00.000Z" }),
      vanessa("v-pat", { candidate: "pat", created: "2026-10-05T10:00:00.000Z" }),
      row("d-new", { candidate: "pat", created: "2026-10-10T10:00:00.000Z" }),
    ],
  }]);
  const { requests } = await readSubmissionRequestHistoryWithScope({ scope: SCOPE, trpcGetImpl: impl });
  const byId = Object.fromEntries(requests.map((r) => [r.id, r]));
  // Never emailed about v-old: v-new is the first email.
  assert.equal(requestOrdinal(byId["v-new"], requests, null), 1);
  // David's own rows count exactly as before (v-pat was never emailed).
  assert.equal(requestOrdinal(byId["d-new"], requests, null), 2);
  // Once the lane has emailed about v-pat, it is part of the conversation.
  const emailed = { matches: { "v-pat": { sentAt: "2026-10-05T11:00:00.000Z" } } };
  assert.equal(requestOrdinal(byId["d-new"], requests, emailed), 3);
  assert.equal(requestOrdinal(byId["v-pat"], requests, null), 2);
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
