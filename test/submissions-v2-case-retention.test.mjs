import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decryptJson, encryptJson } from "../api/submissions-v2/_lib/private-data.mjs";
import { createService } from "../api/submissions-v2/_lib/service.mjs";
import { routeSubmissionsV2 } from "../api/submissions-v2/_lib/router.mjs";

const encryptionKey = Buffer.alloc(32, 17).toString("base64url");
const env = {
  SUBMISSIONS_V2_ENCRYPTION_KEY: encryptionKey,
  SUBMISSIONS_V2_RETENTION_HMAC_KEY: "retention-test-secret".repeat(3),
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function response() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

test("soft deletion stores only an encrypted 30-day recovery manifest before hiding a case", async () => {
  const pairId = "11111111-1111-4111-8111-111111111111";
  const snapshot = {
    manifest_version: 1,
    pair: {
      id: pairId, candidate_user_id: "private-candidate", role_id: "private-role",
      first_signal_id: "22222222-2222-4222-8222-222222222222", state_version: 7,
      intent_state: "interested", workflow_state: "preparing_resume", submission_status: "none",
      current_artifact_id: null, resume_ready_at: null, case_hidden_at: null,
    },
    artifacts: [], supplements: [], active_generations: [], active_jobs: [], private_object_keys: [],
  };
  let stored;
  let committed;
  const repository = {
    reserveCaseRetentionCommand: async () => ({ replay: false, command_id: "33333333-3333-4333-8333-333333333333" }),
    caseDeletionManifest: async () => snapshot,
    reservePrivateObject: async ({ reservationId, objectKey, expectedDigest }) => ({ id: reservationId, object_key: objectKey, expected_digest: expectedDigest, write_fencing_token: 1 }),
    renewPrivateObjectWrite: async () => ({}),
    softDeleteCase: async (input) => { committed = input; return { case_id: pairId, state: "soft_deleted", state_version: 8 }; },
    failCaseRetentionCommand: async () => assert.fail("successful deletion should not fail its command"),
  };
  const service = createService({
    repository, env, now: () => Date.parse("2026-09-01T20:00:00.000Z"),
    blob: { putPrivateObject: async (pathname, bytes, contentType) => { stored = { pathname, bytes, contentType }; } },
  });
  const result = await service.softDeleteCase({
    actorEmail: "admin@raydar.xyz", idempotencyKey: "delete-case-0001", pairId,
    body: { expected_version: 7, reason: "Candidate requested private removal" },
  });
  assert.equal(result.state, "soft_deleted");
  assert.equal(stored.contentType, "application/json");
  assert.equal(stored.bytes.includes(Buffer.from("private-candidate")), false);
  assert.equal(stored.bytes.includes(Buffer.from("Candidate requested")), false);
  assert.equal(committed.recoveryDeadline, "2026-10-01T20:00:00.000Z");
  assert.match(committed.tombstoneCaseHmac, /^[0-9a-f]{64}$/);
  assert.notEqual(committed.tombstoneCaseHmac, pairId);
  assert.equal(committed.tombstoneCandidateHmac, sha256("submissions-v2-candidate-suppression:v1\0private-candidate"));
  assert.equal(committed.manifestDigest, sha256(stored.bytes));
  const decoded = decryptJson(JSON.parse(stored.bytes.toString("utf8")), {
    env, context: `case-deletion:${committed.deletionId}`,
  });
  assert.equal(decoded.reason, "Candidate requested private removal");
  assert.deepEqual(decoded.snapshot, snapshot);
});

test("case deletion and restoration retries replay the durable command without new object work", async () => {
  let touched = false;
  const service = createService({
    env,
    repository: {
      reserveCaseRetentionCommand: async () => ({ replay: true, result: { case_id: "pair", state: "soft_deleted", state_version: 2 } }),
      caseDeletionManifest: async () => { touched = true; },
    },
    blob: { putPrivateObject: async () => { touched = true; }, readPrivateObject: async () => { touched = true; } },
  });
  const deleted = await service.softDeleteCase({ actorEmail: "admin@raydar.xyz", idempotencyKey: "delete-replay", pairId: "pair", body: { expected_version: 1, reason: "requested" } });
  const restored = await service.restoreCase({ actorEmail: "admin@raydar.xyz", idempotencyKey: "restore-replay", pairId: "pair", body: { expected_version: 2 } });
  assert.equal(deleted.replay, true);
  assert.equal(restored.replay, true);
  assert.equal(touched, false);
});

test("restoration verifies and decrypts the exact manifest before repository recovery", async () => {
  const pairId = "44444444-4444-4444-8444-444444444444";
  const deletionId = "55555555-5555-4555-8555-555555555555";
  const manifest = {
    manifest_version: 1, deletion_id: deletionId, pair_id: pairId,
    requested_at: "2026-09-01T20:00:00.000Z", recovery_deadline: "2026-10-01T20:00:00.000Z",
    reason: "private", reason_digest: sha256("private"),
    snapshot: { pair: { id: pairId, state_version: 4 }, artifacts: [], supplements: [] },
  };
  const bytes = Buffer.from(JSON.stringify(encryptJson(manifest, { env, context: `case-deletion:${deletionId}` })));
  let restored;
  const service = createService({
    env, now: () => Date.parse("2026-09-10T20:00:00.000Z"),
    repository: {
      reserveCaseRetentionCommand: async () => ({ replay: false, command_id: "66666666-6666-4666-8666-666666666666" }),
      caseDeletionForRestore: async () => ({
        id: deletionId, state_version: 5, recovery_deadline: manifest.recovery_deadline,
        encrypted_manifest_object_key: "submissions/resumes/v2/case_manifests/test", manifest_digest: sha256(bytes),
      }),
      restoreCase: async (input) => { restored = input; return { state: "restored", state_version: 6 }; },
      failCaseRetentionCommand: async () => assert.fail("successful restoration should not fail its command"),
    },
    blob: { readPrivateObject: async () => ({ bytes }) },
  });
  const result = await service.restoreCase({ actorEmail: "admin@raydar.xyz", idempotencyKey: "restore-case-0001", pairId, body: { expected_version: 5 } });
  assert.equal(result.state, "restored");
  assert.deepEqual(restored.manifest, manifest);
  assert.equal(restored.deletionId, deletionId);
});

test("corrupt recovery manifests fail closed and durably fail the reserved command", async () => {
  let failed;
  const service = createService({
    env, now: () => Date.parse("2026-09-10T20:00:00.000Z"),
    repository: {
      reserveCaseRetentionCommand: async () => ({ replay: false, command_id: "command-corrupt" }),
      caseDeletionForRestore: async () => ({
        id: "deletion-corrupt", state_version: 2, recovery_deadline: "2026-10-01T00:00:00.000Z",
        encrypted_manifest_object_key: "private/corrupt", manifest_digest: "0".repeat(64),
      }),
      failCaseRetentionCommand: async (input) => { failed = input; },
    },
    blob: { readPrivateObject: async () => ({ bytes: Buffer.from("corrupt") }) },
  });
  await assert.rejects(
    service.restoreCase({ actorEmail: "admin@raydar.xyz", idempotencyKey: "restore-corrupt", pairId: "pair-corrupt", body: { expected_version: 2 } }),
    (error) => error.code === "case_manifest_digest_mismatch",
  );
  assert.equal(failed.commandId, "command-corrupt");
  assert.equal(failed.errorCode, "case_manifest_digest_mismatch");
});

test("restoration stops at the 30-day deadline before reading private storage", async () => {
  let read = false;
  let failed;
  const service = createService({
    env, now: () => Date.parse("2026-10-02T00:00:00.000Z"),
    repository: {
      reserveCaseRetentionCommand: async () => ({ replay: false, command_id: "command-expired" }),
      caseDeletionForRestore: async () => ({
        id: "deletion-expired", state_version: 2, recovery_deadline: "2026-10-01T00:00:00.000Z",
        encrypted_manifest_object_key: "private/expired", manifest_digest: "0".repeat(64),
      }),
      failCaseRetentionCommand: async (input) => { failed = input; },
    },
    blob: { readPrivateObject: async () => { read = true; } },
  });
  await assert.rejects(
    service.restoreCase({ actorEmail: "admin@raydar.xyz", idempotencyKey: "restore-expired", pairId: "pair-expired", body: { expected_version: 2 } }),
    (error) => error.code === "case_recovery_expired" && error.status === 410,
  );
  assert.equal(read, false);
  assert.equal(failed.errorCode, "case_recovery_expired");
});

test("delete and restore paths are POST-only, admin-only, and idempotency-required", async () => {
  const old = {
    human: process.env.SUBMISSIONS_V2_HUMAN_API_KEY,
    admins: process.env.SUBMISSIONS_V2_ADMIN_EMAILS,
  };
  process.env.SUBMISSIONS_V2_HUMAN_API_KEY = "retention-handler-key".repeat(2);
  process.env.SUBMISSIONS_V2_ADMIN_EMAILS = "david@raydar.xyz";
  try {
    for (const action of ["delete", "restore"]) {
      const method = response();
      await routeSubmissionsV2({ method: "GET", headers: {}, query: { route: ["admin", "cases", "pair", action] } }, method);
      assert.equal(method.statusCode, 405);
      const denied = response();
      await routeSubmissionsV2({ method: "POST", headers: { authorization: `Bearer ${"retention-handler-key".repeat(2)}` }, query: { route: ["admin", "cases", "pair", action] }, body: {} }, denied);
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.payload.error, "admin_required");
      process.env.SUBMISSIONS_V2_ADMIN_EMAILS = "internal-api@raydar.xyz";
      const noIdempotency = response();
      await routeSubmissionsV2({ method: "POST", headers: { authorization: `Bearer ${"retention-handler-key".repeat(2)}` }, query: { route: ["admin", "cases", "pair", action] }, body: {} }, noIdempotency);
      assert.equal(noIdempotency.statusCode, 400);
      assert.equal(noIdempotency.payload.error, "idempotency_key_required");
      process.env.SUBMISSIONS_V2_ADMIN_EMAILS = "david@raydar.xyz";
    }
  } finally {
    if (old.human === undefined) delete process.env.SUBMISSIONS_V2_HUMAN_API_KEY; else process.env.SUBMISSIONS_V2_HUMAN_API_KEY = old.human;
    if (old.admins === undefined) delete process.env.SUBMISSIONS_V2_ADMIN_EMAILS; else process.env.SUBMISSIONS_V2_ADMIN_EMAILS = old.admins;
  }
  const source = await readFile(new URL("../api/submissions-v2/_lib/router.mjs", import.meta.url), "utf8");
  assert.match(source, /requireAdmin\(req, res, \{ mutation: true \}\)/);
  assert.match(source, /requireIdempotency/);
});
