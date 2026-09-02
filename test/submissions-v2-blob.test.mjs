import test from "node:test";
import assert from "node:assert/strict";
import { privatePath, privateReservationId, putPrivateObject, signDownloadTicket, verifyDownloadTicket } from "../api/submissions-v2/_lib/blob.mjs";
import { authorizeBlobBroker, issueWorkerBlobCapability, validateBlobCapabilityRequest } from "../api/submissions-v2/_lib/blob-capabilities.mjs";
import { blobBrokerClientInternals, createBlobBrokerClient } from "../submissions-v2-worker/blob-broker-client.mjs";

const env = { SUBMISSIONS_V2_DOWNLOAD_SECRET: "d".repeat(40) };

test("private object keys contain no candidate identity", () => assert.match(privatePath("artifacts", "artifact_123"), /^submissions\/resumes\/v2\/artifacts\/artifact_123$/));

test("one deterministic private path always has one stable reservation identity", () => {
  const path = privatePath("events", "event_123");
  assert.equal(privateReservationId(path), privateReservationId(path));
  assert.match(privateReservationId(path), /^[a-f0-9-]{36}$/u);
  assert.notEqual(privateReservationId(path), privateReservationId(privatePath("events", "event_124")));
});

test("download ticket is short-lived and bound to one user and artifact", () => {
  const ticket = signDownloadTicket({ ticket_id: "ticket", artifact_id: "artifact", pathname: "submissions/resumes/v2/artifacts/a", email: "recruiter@raydar.xyz", expires_at: Date.now() + 300_000 }, { env });
  assert.equal(verifyDownloadTicket(ticket, { identityEmail: "recruiter@raydar.xyz", env }).artifact_id, "artifact");
  assert.throws(() => verifyDownloadTicket(ticket, { identityEmail: "other@raydar.xyz", env }), /another user/);
});

test("expired and modified tickets fail closed", () => {
  const ticket = signDownloadTicket({ ticket_id: "ticket", artifact_id: "artifact", pathname: "submissions/resumes/v2/artifacts/a", email: "recruiter@raydar.xyz", expires_at: Date.now() - 1 }, { env });
  assert.throws(() => verifyDownloadTicket(ticket, { identityEmail: "recruiter@raydar.xyz", env }), /expired/);
  assert.throws(() => verifyDownloadTicket(`${ticket}x`, { identityEmail: "recruiter@raydar.xyz", env }), /invalid/);
});

test("deterministic private writes adopt only byte-identical crash replays", async () => {
  const blobEnv = { SUBMISSIONS_V2_BLOB_READ_WRITE_TOKEN: "blob-token" };
  const writeError = Object.assign(new Error("already exists"), { code: "blob_exists" });
  const adopted = await putPrivateObject("submissions/resumes/v2/artifacts/a", Buffer.from("same"), "application/pdf", {
    env: blobEnv,
    putImpl: async () => { throw writeError; },
    readImpl: async () => ({ bytes: Buffer.from("same"), content_type: "application/pdf" }),
  });
  assert.equal(adopted.adopted, true);
  await assert.rejects(() => putPrivateObject("submissions/resumes/v2/artifacts/a", Buffer.from("new"), "application/pdf", {
    env: blobEnv,
    putImpl: async () => { throw writeError; },
    readImpl: async () => ({ bytes: Buffer.from("old"), content_type: "application/pdf" }),
  }), (error) => error.code === "blob_object_conflict");
});

test("worker broker issues only exact one-minute non-delete capabilities", async () => {
  assert.throws(() => validateBlobCapabilityRequest({ operation: "delete", pathname: "submissions/resumes/v2/artifacts/a" }), (error) => error.code === "blob_capability_operation_invalid");
  assert.throws(() => validateBlobCapabilityRequest({ operation: "get", pathname: "submissions/resumes/v2/*" }), (error) => error.code === "blob_capability_path_invalid");
  assert.throws(() => validateBlobCapabilityRequest({ operation: "put", pathname: "submissions/resumes/v2/artifacts/a", content_type: "text/html", size_bytes: 10 }), (error) => error.code === "blob_capability_content_type_invalid");
  const calls = [];
  const now = 1_800_000_000_000;
  const result = await issueWorkerBlobCapability({
    operation: "put", pathname: "submissions/resumes/v2/artifacts/a",
    content_type: "application/pdf", size_bytes: 12,
  }, {
    env: { SUBMISSIONS_V2_BLOB_READ_WRITE_TOKEN: "server-only-token" }, now: () => now,
    issueImpl: async (options) => { calls.push(options); return { clientSigningToken: "sign", delegationToken: "delegation", validUntil: options.validUntil }; },
    presignImpl: async (_signed, options) => { calls.push(options); return { presignedUrl: "https://store.blob.vercel-storage.com/artifacts/a?signed=1" }; },
  });
  assert.equal(result.operation, "put");
  assert.equal(Date.parse(result.expires_at), now + 60_000);
  assert.deepEqual(calls[0].operations, ["put"]);
  assert.equal(calls[0].pathname, "submissions/resumes/v2/artifacts/a");
  assert.equal(calls[1].allowOverwrite, false);
  assert.equal(calls[1].maximumSizeInBytes, 12);
});

test("broker authentication and worker client never accept a broad or delete credential", async () => {
  const key = "b".repeat(32);
  assert.equal(authorizeBlobBroker({ headers: { authorization: `Bearer ${key}` } }, { env: { SUBMISSIONS_V2_BLOB_BROKER_KEY: key } }), true);
  assert.throws(() => authorizeBlobBroker({ headers: {} }, { env: { SUBMISSIONS_V2_BLOB_BROKER_KEY: key } }), (error) => error.code === "blob_broker_auth_required");
  assert.equal(blobBrokerClientInternals.trustedPresignedUrl("https://store.blob.vercel-storage.com/a?signed=1")?.startsWith("https://"), true);
  assert.equal(blobBrokerClientInternals.trustedPresignedUrl("https://example.com/a"), null);
  const requests = [];
  const bytes = Buffer.from("private-data");
  const client = createBlobBrokerClient({
    env: { SUBMISSIONS_V2_BLOB_BROKER_URL: "https://monitor.raydar.xyz/api/submissions-v2/internal/blob-capability", SUBMISSIONS_V2_BLOB_BROKER_KEY: key },
    fetchImpl: async (url, init) => {
      requests.push([url, init]);
      if (String(url).startsWith("https://monitor.raydar.xyz")) return new Response(JSON.stringify({
        ok: true, operation: "get", pathname: "submissions/resumes/v2/artifacts/a",
        presigned_url: "https://store.blob.vercel-storage.com/artifacts/a?signed=1",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(bytes.length) } });
    },
  });
  const read = await client.readPrivateObject("submissions/resumes/v2/artifacts/a");
  assert.deepEqual(read.bytes, bytes);
  assert.equal(requests[0][1].body.includes("delete"), false);
  assert.equal(JSON.stringify(requests).includes("BLOB_READ_WRITE_TOKEN"), false);
});
