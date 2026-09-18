import assert from "node:assert/strict";
import test from "node:test";

import {
  PARAFORM_TELEMETRY_SOURCE_IDS,
  paraformTelemetrySource,
  telemetryFetch,
  withParaformTelemetrySource,
} from "../api/_lib/paraform-telemetry-context.mjs";

const env = {
  PARAFORM_TELEMETRY_URL: "https://raydar-paraform-traffic.david183940.chatgpt.site/api/ingest",
  PARAFORM_TELEMETRY_TOKEN: "source-token",
  PARAFORM_TELEMETRY_DISPATCH_TOKEN: "dispatch-token",
};

test("V2 source is present in the shared registered collector source set", () => {
  assert.ok(PARAFORM_TELEMETRY_SOURCE_IDS.includes("submissions-v2"));
  assert.equal(paraformTelemetrySource("submissions-v2"), "submissions-v2");
  assert.throws(
    () => withParaformTelemetrySource("submissions-v2-worker", () => null),
    /PARAFORM_TELEMETRY_SOURCE_INVALID/u,
  );
});

test("V2 source context overrides a shared-core fallback and preserves the provider response", async () => {
  const collectorCalls = [];
  const observed = withParaformTelemetrySource("submissions-v2", () => telemetryFetch(
    async () => new Response(JSON.stringify({ result: { data: { json: {} } } }), { status: 200 }),
    "paraai",
    {
      env,
      telemetryFetchImpl: async (_url, init) => {
        collectorCalls.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      },
    },
  ));
  assert.equal(observed.snapshot().sourceId, "submissions-v2");
  const response = await observed("https://www.paraform.com/api/trpc/user.getCurrentUser");
  assert.equal(response.status, 200);
  await observed.flush();
  assert.equal(collectorCalls[0].sourceId, "submissions-v2");
});
