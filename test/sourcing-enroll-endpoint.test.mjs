import test from "node:test";
import assert from "node:assert/strict";

process.env.KV_REST_API_URL = "https://kv.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.SOURCING_ACCESS_KEY = "test-access-key";
process.env.PARAFORM_COOKIE = "test-cookie";
process.env.PARAFORM_SOURCING_SEQUENCE_WRITES_APPROVED = "true";

const { default: enrollHandler } = await import("../api/sourcing/enroll.mjs");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

const trpcResponse = (value, status = 200) => new Response(JSON.stringify({ result: { data: { json: value } } }), {
  status,
  headers: { "content-type": "application/json" },
});

test("an interrupted post-write enrollment remains queued and reconciles without a duplicate vendor write", async (t) => {
  const originalFetch = globalThis.fetch;
  const store = new Map();
  const sequenceMembers = new Set();
  const calls = [];
  let addCalls = 0;
  let failEnrolledSaveOnce = true;
  const runKey = "sourcing:v1:run:run-123";
  store.set(runKey, JSON.stringify({
    id: "run-123",
    roleId: "role-123",
    revision: 0,
    mapping: { sequenceId: "sequence-123", sequenceName: "Acme outreach" },
    candidates: [{
      id: "candidate-123",
      candidateId: "source-123",
      candidateUserId: "user-123",
      state: "good",
      projectStatus: "filed",
    }],
  }));

  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith("https://kv.test")) {
      const command = JSON.parse(options.body);
      if (command[0] === "SET") {
        const [, key, value] = command;
        if (command.includes("NX") && store.has(key)) return new Response(JSON.stringify({ result: null }));
        store.set(key, value);
        calls.push(`kv:set:${key.includes(":lock:") ? "lock" : "value"}`);
        return new Response(JSON.stringify({ result: "OK" }));
      }
      if (command[0] === "GET") {
        return new Response(JSON.stringify({ result: store.get(command[1]) || null }));
      }
      if (command[0] === "EVAL") {
        const script = command[1];
        const key = command[3];
        if (script.includes("current.revision")) {
          const expectedRevision = Number(command[4]);
          const next = JSON.parse(command[5]);
          const current = JSON.parse(store.get(key));
          assert.equal(current.revision, expectedRevision);
          calls.push(`kv:save:${next.candidates[0].state}`);
          if (next.candidates[0].state === "enrolled" && failEnrolledSaveOnce) {
            failEnrolledSaveOnce = false;
            return new Response("store unavailable", { status: 500 });
          }
          store.set(key, JSON.stringify(next));
          return new Response(JSON.stringify({ result: 1 }));
        }
        if (script.includes("DEL")) {
          if (store.get(key) === command[4]) store.delete(key);
          calls.push("kv:unlock");
          return new Response(JSON.stringify({ result: 1 }));
        }
      }
      throw new Error(`unexpected KV command: ${JSON.stringify(command)}`);
    }

    if (url.includes("/trpc/campaigns.getListOfCampaignsOptimized")) {
      calls.push("paraform:list-sequences");
      return trpcResponse([{ id: "sequence-123", name: "Acme outreach" }]);
    }
    if (url.includes("/trpc/campaigns.getCampaignLeads")) {
      calls.push("paraform:membership-read");
      return trpcResponse({
        leads: [...sequenceMembers].map((id, index) => ({ cu_id: id, ccu_id: `lead-${index + 1}` })),
        totalCount: sequenceMembers.size,
      });
    }
    if (url.includes("/trpc/candidateUser.getCandidateProfileInfo")) {
      calls.push("paraform:relationship-read");
      return trpcResponse({ candidate_user_relationship_status: "NEW" });
    }
    if (url.includes("/trpc/campaigns.addToCampaigns")) {
      const payload = JSON.parse(options.body).json;
      calls.push("paraform:add-to-sequence");
      addCalls++;
      for (const id of payload.candidate_user_ids) sequenceMembers.add(id);
      return trpcResponse({ blocked_candidates: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const firstResponse = responseRecorder();
  await enrollHandler({
    method: "POST",
    headers: { "x-app-key": "test-access-key" },
    body: {
      runId: "run-123",
      candidateIds: ["candidate-123"],
      confirmation: "ENROLL 1",
      expectedRevision: 0,
    },
  }, firstResponse);

  assert.equal(firstResponse.statusCode, 502);
  assert.equal(firstResponse.body.retryable, true);
  const queued = JSON.parse(store.get(runKey));
  assert.equal(queued.revision, 1);
  assert.equal(queued.candidates[0].state, "enrollment_queued");
  assert.equal(sequenceMembers.has("user-123"), true, "the vendor write succeeded");

  const retryResponse = responseRecorder();
  await enrollHandler({
    method: "POST",
    headers: { "x-app-key": "test-access-key" },
    body: {
      runId: "run-123",
      candidateIds: ["candidate-123"],
      confirmation: "ENROLL 1",
      expectedRevision: 1,
    },
  }, retryResponse);

  assert.equal(retryResponse.statusCode, 200);
  assert.equal(retryResponse.body.enrolled, 1);
  assert.equal(retryResponse.body.run.candidates[0].state, "enrolled");
  assert.equal(addCalls, 1, "retry readback must not issue a second addToCampaigns call");
  assert.ok(calls.indexOf("kv:save:enrollment_queued") < calls.indexOf("paraform:add-to-sequence"));
  assert.ok(calls.indexOf("paraform:add-to-sequence") < calls.indexOf("kv:save:enrolled"));
  assert.equal([...store.keys()].some((key) => key.includes(":lock:run:run-123")), false);
});
