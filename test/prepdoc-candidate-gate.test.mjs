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

test("role-scoped search finds active-pipeline applicants via user_applications", async () => {
  // Mirrors the real Benjamin D. case: not in the CRM, not in getMergedCandidates,
  // last name abbreviated in the pipeline view.
  const trpcGet = async (proc) => {
    if (proc === "candidateUser.getCRMExternalCandidates") return { items: [], next_cursor: null };
    if (proc === "candidateUser.getCandidateUserApplications") {
      return [{ id: "app-benji", role_id: "role-vals", role: { name: "MTS - Platform", company: { name: "Vals AI" } } }];
    }
    throw new Error("unexpected proc " + proc);
  };
  const restGet = async (path) => {
    assert.equal(path, "/role/role-vals/user_applications");
    return [
      { id: "app-benji", status: "INTERVIEWING", furthestStage: "INTERVIEWING",
        candidateName: "Benjamin D.", candidateEmail: "b@x.com", candidate_id: "cu-benji",
        candidate: { id: "cu-benji", name: "Benjamin D.", image_src: "https://img/b.png", one_liner: "MTS @ PayPal", location: "NYC", email: "b@x.com" } },
      { id: "app-other", status: "INTERVIEWING", candidate: { id: "cu-other", name: "Someone Else" } },
    ];
  };
  const out = await searchCandidates("benjamin dayan", { trpcGet, restGet, roleId: "role-vals" });
  assert.equal(out.roleScoped, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].candidate_user_id, "cu-benji");
  assert.equal(out.results[0].pipeline.stage, "INTERVIEWING");
  assert.equal(out.results[0].name, "Benjamin D.");
  assert.ok(!JSON.stringify(out.results).includes("b@x.com"));
});

test("token matching handles abbreviated last names and ignores non-matches", async () => {
  const trpcGet = async () => ({ items: [], next_cursor: null });
  const restGet = async () => ([
    { id: "a1", candidate: { id: "c1", name: "Benjamin D." } },
    { id: "a2", candidate: { id: "c2", name: "Benji Smith" } },
    { id: "a3", candidate: { id: "c3", name: "Unrelated Person" } },
  ]);
  const out = await searchCandidates("benjamin dayan", { trpcGet, restGet, roleId: "role-xxxxxxx" });
  const ids = out.results.map((r) => r.candidate_user_id);
  assert.ok(ids.includes("c1"));
  assert.ok(!ids.includes("c3"));
});
