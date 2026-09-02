import test from "node:test";
import assert from "node:assert/strict";
import { curatedBatchPlan, diffCuratedSnapshots } from "../api/submissions-v2/_lib/curated.mjs";
import {
  candidateIndexRow, normalizeSearch, readActiveRoleIndex, readCandidateIndexPage,
  readCuratedCandidate, readCuratedPopulation, roleIndexRow,
} from "../api/submissions-v2/_lib/paraform-sources.mjs";
import { authorizeNotificationBroker, notificationText, postSafeNotification } from "../api/submissions-v2/_lib/notifications.mjs";

test("normalizes diacritics for local candidate search", () => assert.equal(normalizeSearch("  José  Álvarez "), "jose alvarez"));

test("candidate index stores keyed email HMAC but no plaintext email", () => {
  const row = candidateIndexRow({ id: "candidate-1", name: "Jane Candidate", email: "jane@example.com" }, { env: { SUBMISSIONS_V2_EMAIL_HMAC_VERSION: "v1", SUBMISSIONS_V2_EMAIL_HMAC_KEY: "x".repeat(32) } });
  assert.equal(row.email_hmac_version, "v1");
  assert.equal(JSON.stringify(row).includes("jane@example.com"), false);
});

test("role index constructs the exact Paraform role destination", () => {
  const row = roleIndexRow({ id: "role-1", company_name: "Acme", title: "Engineer", active: true });
  assert.equal(row.paraform_url, "https://www.paraform.com/browse?role=role-1");
  assert.equal(row.active, true);
});

test("malformed successful Paraform index payloads fail closed instead of becoming authoritative empty sets", async () => {
  await assert.rejects(
    () => readCandidateIndexPage(0, 100, { trpcGetImpl: async () => ({}) }),
    (error) => error.code === "candidate_index_shape_invalid",
  );
  await assert.rejects(
    () => readCandidateIndexPage(0, 100, { trpcGetImpl: async () => ({ items: [], next_cursor: undefined }) }),
    (error) => error.code === "candidate_index_cursor_invalid",
  );
  await assert.rejects(
    () => readActiveRoleIndex({ trpcGetImpl: async () => ({}) }),
    (error) => error.code === "role_index_shape_invalid",
  );
  assert.deepEqual((await readActiveRoleIndex({ trpcGetImpl: async () => [] })).rows, []);
  await assert.rejects(
    () => readCuratedPopulation({ trpcGetImpl: async () => null }),
    (error) => error.code === "curated_population_shape_invalid",
  );
  await assert.rejects(
    () => readCuratedCandidate("candidate-1", { trpcGetImpl: async () => ({}) }),
    (error) => error.code === "curated_status_shape_invalid",
  );
  assert.deepEqual(await readCuratedPopulation({ trpcGetImpl: async () => [] }), []);
  assert.deepEqual(await readCuratedCandidate("candidate-1", { trpcGetImpl: async () => [] }), []);
  assert.throws(() => curatedBatchPlan(null), (error) => error.code === "curated_population_shape_invalid");
});

test("first curated sight seeds without action and later decisive transition acts once", () => {
  const first = diffCuratedSnapshots(new Map(), [{ candidate_user_id: "c", role_id: "r", status: "PENDING", observed_at: "2026-09-01T00:00:00Z" }], { seed: true });
  assert.equal(first.transitions.length, 0);
  const second = diffCuratedSnapshots(first.next, [{ candidate_user_id: "c", role_id: "r", status: "APPLIED_TO_ROLE", observed_at: "2026-09-01T00:05:00Z", digest: "d" }]);
  assert.equal(second.transitions[0].intent, "interested");
  assert.equal(diffCuratedSnapshots(second.next, [{ candidate_user_id: "c", role_id: "r", status: "APPLIED_TO_ROLE", observed_at: "2026-09-01T00:10:00Z", digest: "d" }]).transitions.length, 0);
});

test("curated batches are stable and capped", () => {
  const plan = curatedBatchPlan([{ candidateUserId: "z" }, { candidateUserId: "a" }, { candidateUserId: "m" }], { batchSize: 2 });
  assert.deepEqual(plan.rows.map((row) => row.candidateUserId), ["a", "m"]);
  assert.equal(plan.next_cursor, 2);
});

test("Slack copy contains no raw quote or email and disables unfurls", async () => {
  const text = notificationText("not_interested", { candidate_name: "Jane <!channel>", company: "Acme <@U123>", role_title: "Engineer", monitor_url: "https://monitor.raydar.xyz/#submissions-v2" });
  let request;
  const result = await postSafeNotification(text, { env: { SUBMISSIONS_V2_SLACK_BOT_TOKEN: "token" }, destinationId: "C123ABC", fetchImpl: async (_url, init) => { request = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true, ts: "1" }) }; } });
  assert.equal(request.unfurl_links, false);
  assert.equal(request.unfurl_media, false);
  assert.equal(request.mrkdwn, false);
  assert.equal(request.link_names, false);
  assert.doesNotMatch(request.text, /<!channel>|<@U123>/u);
  assert.equal(result.receipt, "1");
});

test("isolated workers can use the exact Monitor notification broker", async () => {
  let request;
  const key = "k".repeat(32);
  const result = await postSafeNotification("Safe notice", {
    env: {
      SUBMISSIONS_V2_NOTIFICATION_BROKER_URL: "https://monitor.raydar.xyz/api/submissions-v2/internal/notification",
      SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY: key,
    },
    destinationId: "C123ABC",
    fetchImpl: async (url, init) => {
      request = { url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ ok: true, receipt: "2", channel: "C123ABC" }) };
    },
  });
  assert.equal(request.url, "https://monitor.raydar.xyz/api/submissions-v2/internal/notification");
  assert.equal(request.headers.authorization, `Bearer ${key}`);
  assert.deepEqual(request.body, { destination_id: "C123ABC", text: "Safe notice" });
  assert.equal(result.receipt, "2");
});

test("notification broker requires an exact strong bearer", () => {
  const key = "k".repeat(32);
  assert.throws(() => authorizeNotificationBroker({ headers: { authorization: "Bearer wrong" } }, { env: { SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY: key } }), (error) => error.code === "notification_broker_auth_required");
  assert.equal(authorizeNotificationBroker({ headers: { authorization: `Bearer ${key}` } }, { env: { SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY: key } }), true);
});
