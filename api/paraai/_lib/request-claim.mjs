// One action per Paraform submission request, ever — across every Raydar lane.
//
// The reply lane and the expired-match lane can both legitimately target the
// same submission_request_id (a candidate answers on day 6, the request expires
// on day 7). Two NX claims in two different key prefixes provide no mutual
// exclusion at all, so arbitration lives here, in one neutral key both lanes
// take before any Paraform write.
//
// Migration: the reply lane shipped writing paraai:reply:claim:<hash>. Those
// claims are real and already in production, so a claim attempt reads the
// legacy key first and refuses when it is present. New claims are only ever
// written to the neutral key.
import { createHash, randomUUID } from "node:crypto";

const KV_URL = String(
  process.env.PARAAI_REPLY_KV_REST_API_URL
  || process.env.KV_REST_API_URL
  || "",
).replace(/\/+$/, "");
const KV_TOKEN = process.env.PARAAI_REPLY_KV_REST_API_TOKEN
  || process.env.KV_REST_API_TOKEN
  || "";

export const claimStoreConfigured = () => Boolean(KV_URL && KV_TOKEN);

const parse = (value, fallback = null) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

// The neutral namespace uses its own salt; the legacy lookup has to reproduce
// the reply store's salt exactly or it would read a different key and wrongly
// report a request as unclaimed.
const neutralHash = (value) => createHash("sha256")
  .update(`paraai-request-v1 ${String(value || "")}`)
  .digest("hex");
const legacyReplyHash = (value) => createHash("sha256")
  .update(`paraai-reply-v1 ${String(value || "")}`)
  .digest("hex");

export const claimKey = (requestId) => `paraai:request-claim:${neutralHash(requestId)}`;
export const legacyReplyClaimKey = (requestId) => `paraai:reply:claim:${legacyReplyHash(requestId)}`;

async function kvDefault(args) {
  if (!claimStoreConfigured()) {
    const error = new Error("Para AI request claim store not configured");
    error.code = "REQUEST_CLAIM_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetch(KV_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KV_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8_000),
  });
  const raw = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (!response.ok) {
    const detail = String(parsed?.error || parsed?.message || raw || "request rejected")
      .replace(/\s+/g, " ")
      .slice(0, 180);
    const error = new Error(`request claim store HTTP ${response.status}: ${detail}`);
    error.code = "REQUEST_CLAIM_STORE_FAILED";
    error.status = response.status;
    throw error;
  }
  if (parsed?.error) {
    const error = new Error(String(parsed.error));
    error.code = "REQUEST_CLAIM_COMMAND_FAILED";
    throw error;
  }
  return parsed?.result ?? null;
}

// Read-only: who, if anyone, already owns this request.
export async function readSubmissionRequestClaim(requestId, { kvImpl = kvDefault } = {}) {
  if (!requestId) throw new Error("requestId required");
  const neutral = parse(await kvImpl(["GET", claimKey(requestId)]), null);
  if (neutral) return { ...neutral, namespace: "request-claim" };
  const legacy = parse(await kvImpl(["GET", legacyReplyClaimKey(requestId)]), null);
  if (legacy) return { ...legacy, namespace: "reply-claim" };
  return null;
}

// Claim BEFORE the Paraform write, and never release it: a crash mid-write must
// not be able to produce a second attempt at the same request. Returns false
// when the request is already spoken for by either namespace.
export async function claimSubmissionRequest(requestId, action, lane, { kvImpl = kvDefault } = {}) {
  if (!requestId) throw new Error("requestId required");
  const legacy = parse(await kvImpl(["GET", legacyReplyClaimKey(requestId)]), null);
  if (legacy) return false;
  const payload = JSON.stringify({
    action: String(action || ""),
    lane: String(lane || ""),
    claimId: randomUUID(),
    claimedAt: new Date().toISOString(),
  });
  const result = await kvImpl(["SET", claimKey(requestId), payload, "NX"]);
  return result === "OK" || result === true;
}

export { neutralHash, legacyReplyHash };
