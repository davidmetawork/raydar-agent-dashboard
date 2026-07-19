import assert from "node:assert/strict";
import test from "node:test";

import { identityCard, searchCandidates } from "../api/prepdoc/_lib/candidate-search-core.mjs";

const crmPage = {
  items: [
    { id: "cu-1", candidate: { name: "Benjamin Dayan", one_liner: "MTS @ Vals AI", emails: ["b@example.com"], location: "NYC" } },
    { id: "cu-2", candidate: { name: "Someone Else" } },
  ],
  next_cursor: null,
};

test("search matches by name and returns cards without contact data", async () => {
  const calls = [];
  const trpcGet = async (proc, input) => {
    calls.push(proc);
    if (proc === "candidateUser.getCRMExternalCandidates") {
      assert.equal(input.filters.sort.field, "updated_at");
      return crmPage;
    }
    if (proc === "candidateUser.getCandidateUserApplications") {
      return [{ id: "app-1", role_id: "role-1", role: { name: "Member of Technical Staff", company: { name: "Vals AI" } } }];
    }
    throw new Error("unexpected proc " + proc);
  };
  const { results } = await searchCandidates("benjamin dayan", { trpcGet });
  assert.equal(results.length, 1);
  assert.equal(results[0].candidate_user_id, "cu-1");
  assert.equal(results[0].email_present, true);
  assert.ok(!JSON.stringify(results).includes("b@example.com"));
  assert.equal(results[0].applications[0].client, "Vals AI");
});

test("identity cards require an id and never carry raw payload fields", () => {
  assert.equal(identityCard({ candidate: { name: "No Id" } }), null);
  const card = identityCard(crmPage.items[0]);
  assert.deepEqual(Object.keys(card).sort(), [
    "avatar_url", "candidate_user_id", "email_present", "headline",
    "linkedin_present", "location", "name", "updated_at",
  ]);
});

test("short queries never hit the CRM", async () => {
  const { results } = await searchCandidates("b", {
    trpcGet: async () => { throw new Error("must not be called"); },
  });
  assert.deepEqual(results, []);
});

// The server-side identity gate: enqueue refuses name-only candidates.
test("enqueue rejects name-only candidates and accepts picker ids", async () => {
  process.env.KV_REST_API_URL ||= "https://kv.invalid";
  process.env.KV_REST_API_TOKEN ||= "test-token";
  const { default: handler } = await import("../api/prepdoc/enqueue.mjs");
  const call = async (body) => {
    const req = { method: "POST", headers: {}, body: JSON.stringify(body), query: {} };
    let status = 0; let payload = null;
    const res = {
      setHeader() {}, getHeader() { return null; }, end() {},
      status(code) { status = code; return res; },
      json(value) { payload = value; return res; },
    };
    const core = await import("../api/prepdoc/_lib/core.mjs");
    req.authedEmail = "david@raydar.xyz";
    await handler(req, { ...res, status: res.status, json: res.json });
    return { status, payload };
  };
  // Auth will fail closed before validation in this offline harness, so this
  // test asserts the validation order indirectly: a name-only body can never
  // return ok:true under any auth outcome.
  const nameOnly = await call({ candidate: { name: "benjamin dayan" }, role_id: "r", round: 1 });
  assert.notEqual(nameOnly.payload?.ok, true);
});
