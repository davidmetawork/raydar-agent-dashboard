import { ResumePipelineError } from "../api/submissions-v2/_lib/resume/pipeline-runtime.mjs";

const BLOB_BROKER_PATH = "/api/submissions-v2/internal/blob-capability";
const SEQUENCE_BROKER_PATH = "/api/submissions-v2/internal/sequence-inbox-batch";

const error = (code, safeMessage, retryable = true) => new ResumePipelineError(
  code,
  safeMessage,
  { retryable },
);

export function sequenceInboxBrokerConfiguration(env = process.env) {
  let blobBroker;
  try { blobBroker = new URL(String(env.SUBMISSIONS_V2_BLOB_BROKER_URL || "").trim()); }
  catch { throw error("sequence_inbox_broker_url_invalid", "The Sequence Inbox broker URL is not configured safely.", false); }
  if (blobBroker.protocol !== "https:" || blobBroker.username || blobBroker.password
    || blobBroker.hash || blobBroker.search || blobBroker.pathname !== BLOB_BROKER_PATH) {
    throw error("sequence_inbox_broker_url_invalid", "The Sequence Inbox broker URL is not configured safely.", false);
  }
  const key = String(env.SUBMISSIONS_V2_BLOB_BROKER_KEY || "").trim();
  if (Buffer.byteLength(key, "utf8") < 32) {
    throw error("sequence_inbox_broker_key_invalid", "The Sequence Inbox broker key is not configured.", false);
  }
  return { url: new URL(SEQUENCE_BROKER_PATH, blobBroker.origin).toString(), key };
}

export async function readSequenceInboxBrokerBatch({
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal,
  cursor = null,
  caughtUp = false,
  catalogDigest = null,
  watermark = null,
  limit = 8,
} = {}) {
  const config = sequenceInboxBrokerConfiguration(env);
  const boundedLimit = Math.max(1, Math.min(8, Number(limit) || 8));
  const response = await fetchImpl(config.url, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${config.key}`,
      "cache-control": "no-store",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      cursor,
      caught_up: caughtUp === true,
      catalog_digest: catalogDigest,
      watermark,
      limit: boundedLimit,
    }),
    signal: AbortSignal.any([
      signal || new AbortController().signal,
      AbortSignal.timeout(110_000),
    ]),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true || !body.result || !Array.isArray(body.result.records)
    || !Array.isArray(body.result.deferred) || !body.result.coverage
    || typeof body.result.coverage !== "object") {
    const code = /^[-_a-z0-9]{1,100}$/u.test(body?.error || "")
      ? body.error
      : "sequence_inbox_broker_failed";
    throw error(code, "The Sequence Inbox broker did not return a valid bounded page.", response.status >= 500);
  }
  return body.result;
}

export const sequenceInboxBrokerClientInternals = Object.freeze({
  BLOB_BROKER_PATH,
  SEQUENCE_BROKER_PATH,
});
