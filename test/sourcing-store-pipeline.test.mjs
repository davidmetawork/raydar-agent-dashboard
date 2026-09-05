import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const storeUrl = pathToFileURL(new URL("../api/sourcing/_lib/store.mjs", import.meta.url).pathname);

async function withConfiguredStore(run) {
  const priorUrl = process.env.KV_REST_API_URL;
  const priorToken = process.env.KV_REST_API_TOKEN;
  const priorFetch = globalThis.fetch;
  process.env.KV_REST_API_URL = "https://kv.example.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  try {
    const store = await import(`${storeUrl.href}?pipeline-test=${Date.now()}-${Math.random()}`);
    await run(store);
  } finally {
    if (priorUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = priorUrl;
    if (priorToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = priorToken;
    if (priorFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = priorFetch;
  }
}

test("KV pipeline classifies provider failures without exposing their payload", async () => {
  await withConfiguredStore(async ({ pipeline }) => {
    const cases = [
      ["quota", "quota exceeded; opaque-provider-payload", "STATE_STORE_PIPELINE_COMMAND_0_QUOTA_LIMITED"],
      ["size", "request payload too large; opaque-provider-payload", "STATE_STORE_PIPELINE_COMMAND_0_SIZE_LIMITED"],
      ["permission", "permission denied; opaque-provider-payload", "STATE_STORE_PIPELINE_COMMAND_0_AUTH_DENIED"],
    ];
    for (const [_name, providerError, code] of cases) {
      globalThis.fetch = async () => ({ ok: true, json: async () => [{ error: providerError }] });
      await assert.rejects(
        pipeline([["HGETALL", "inbox:v3:sequences"]]),
        (error) => error.code === code
          && error.message === "state store pipeline command was rejected"
          && !error.message.includes("opaque-provider-payload"),
      );
    }

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => { throw new SyntaxError("opaque-provider-payload"); },
    });
    await assert.rejects(
      pipeline([["HGETALL", "inbox:v3:sequences"]]),
      (error) => error.code === "STATE_STORE_RESPONSE_JSON_INVALID"
        && error.message === "state store response was unreadable"
        && !error.message.includes("opaque-provider-payload"),
    );
  });
});
