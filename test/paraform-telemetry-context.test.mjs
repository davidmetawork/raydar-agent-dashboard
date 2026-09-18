import assert from "node:assert/strict";
import test from "node:test";

import {
  paraformTelemetrySource,
  telemetryFetch,
  withParaformTelemetrySource,
} from "../api/_lib/paraform-telemetry-context.mjs";

const env = {
  PARAFORM_TELEMETRY_URL: "https://raydar-paraform-traffic.david183940.chatgpt.site/api/ingest",
  PARAFORM_TELEMETRY_TOKEN: "source-token",
  PARAFORM_TELEMETRY_DISPATCH_TOKEN: "dispatch-token",
};

test("warm-runtime callers retain one reporter per fetch and source", () => {
  const provider = async () => { throw new Error("must not run"); };
  const first = telemetryFetch(provider, "dashboard-booking");
  assert.equal(telemetryFetch(provider, "dashboard-booking"), first);
  assert.equal(telemetryFetch(provider, "dashboard-booking", { env: process.env }), first);
  assert.notEqual(telemetryFetch(provider, "dashboard-health"), first);
  assert.notEqual(telemetryFetch(provider, "dashboard-booking", { env }), first);
});


test("source context overrides the transport default without changing fetch", async () => {
  const observed = withParaformTelemetrySource("dashboard-booking", () => telemetryFetch(
    async () => new Response(JSON.stringify({ result: { data: { json: {} } } }), { status: 200 }),
    "dashboard-sequences",
    { env, telemetryFetchImpl: async () => new Response(null, { status: 202 }) },
  ));
  assert.equal(observed.snapshot().sourceId, "dashboard-booking");
  const response = await observed("https://www.paraform.com/api/trpc/user.getCurrentUser");
  assert.equal(response.status, 200);
});

test("source context restores the explicit fallback after completion", () => {
  assert.equal(paraformTelemetrySource("dashboard-health"), "dashboard-health");
  withParaformTelemetrySource("dashboard-health", () => {
    assert.equal(paraformTelemetrySource("dashboard-sequences"), "dashboard-health");
  });
  assert.equal(paraformTelemetrySource("dashboard-sequences"), "dashboard-sequences");
});
