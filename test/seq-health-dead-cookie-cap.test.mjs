// A dead Paraform cookie must not push /api/seq/health past System Health's
// probe timeout (PR 230 review round 2, 2026-09-25).
//
// The real paraformHealth() runs against a fetch stub where Paraform answers
// 401 to everything (a dead cookie) and nothing else is reachable, so no
// Paraform, KV or Slack call leaves this process. The throttle ladder is
// shortened through its own env knobs so the test stays quick, while the
// handler's live-read cap is set well under the shortened ladder: the same
// proportions as production (a ~42 s ladder against a 9 s cap and a 12 s
// probe timeout).
import test from "node:test";
import assert from "node:assert/strict";

for (const name of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "NOTIFY_SLACK_CHANNEL", "HEALTH_ALERTS_ENABLED"]) {
  delete process.env[name];
}
process.env.PARAFORM_COOKIE = "dummy-not-a-real-cookie";
process.env.PARAFORM_THROTTLE_DELAYS_MS = "300,300,300";
process.env.PARAFORM_PROBE_DELAY_MS = "150";

const realFetch = globalThis.fetch;
const hosts = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input?.url || input));
  hosts.push(url.host);
  if (/paraform/.test(url.host)) {
    return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
  }
  throw new Error(`unexpected network call in test: ${url.host}`);
};
test.after(() => { globalThis.fetch = realFetch; });

const { paraformHealth } = await import("../api/seq/_lib/core.mjs");
const { handleSequenceHealth, SEQ_HEALTH_LIVE_READ_BUDGET_MS } = await import("../api/seq/health.mjs");
const { CATALOG } = await import("../api/health/_lib/catalog.mjs");

const notPaused = async () => ({ paused: false });
const fakeRes = () => {
  const res = { statusCode: 200, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => res;
  return res;
};

test("production cap sits under the seq-guardian probe timeout", () => {
  const probe = CATALOG.find((c) => c.id === "seq-guardian").probe;
  assert.ok(SEQ_HEALTH_LIVE_READ_BUDGET_MS <= probe.timeoutMs - 3000);
});

test("dead cookie: seq health answers inside its cap although paraformHealth rides the full ladder", async () => {
  const budgetMs = 250;
  let ladderMs = null;
  let ladder;
  const reader = () => {
    const started = Date.now();
    ladder = paraformHealth({ pauseState: notPaused }).then((h) => { ladderMs = Date.now() - started; return h; });
    return ladder;
  };
  const res = fakeRes();
  const t0 = Date.now();
  await handleSequenceHealth({ method: "GET", url: "/api/seq/health", headers: {} }, res, {
    healthReader: reader,
    staleness: async () => ({ stale: false, sessionExpiredConfirmedAt: null }),
    webhookProof: async () => ({}),
    liveReadBudgetMs: budgetMs,
  });
  const answeredMs = Date.now() - t0;
  assert.ok(answeredMs < budgetMs + 400, `answered in ${answeredMs} ms`);
  assert.equal(res.body.paraform, "timeout");
  assert.equal(res.body.ok, false);
  assert.equal(res.body.cookieSet, true);

  // The uncapped read it replaced: the ladder does finish, as expired, but
  // far past the cap.
  const h = await ladder;
  assert.equal(h.paraform, "expired");
  assert.ok(ladderMs > budgetMs * 3, `ladder took ${ladderMs} ms`);
  assert.deepEqual([...new Set(hosts)].filter((host) => !/paraform/.test(host)), []);
});
