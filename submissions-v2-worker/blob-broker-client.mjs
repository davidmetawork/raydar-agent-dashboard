import { createHash } from "node:crypto";
import { ResumePipelineError } from "../api/submissions-v2/_lib/resume/pipeline-runtime.mjs";

const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

function configuration(env = process.env) {
  const url = String(env.SUBMISSIONS_V2_BLOB_BROKER_URL || "").trim();
  const key = String(env.SUBMISSIONS_V2_BLOB_BROKER_KEY || "").trim();
  if (!/^https:\/\//u.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//u.test(url)) {
    throw new ResumePipelineError("blob_broker_url_invalid", "The worker Blob capability broker URL is not configured safely.", { retryable: false });
  }
  if (Buffer.byteLength(key, "utf8") < 32) throw new ResumePipelineError("blob_broker_key_invalid", "The worker Blob capability broker key is not configured.", { retryable: false });
  return { url, key };
}

function trustedPresignedUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "blob.vercel-storage.com" && !url.hostname.endsWith(".blob.vercel-storage.com")) return null;
  return url.toString();
}

export function createBlobBrokerClient({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const config = configuration(env);

  async function capability(operation, pathname, extra = {}) {
    const response = await fetchImpl(config.url, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
      body: JSON.stringify({ operation, pathname, ...extra }),
    });
    const body = await response.json().catch(() => null);
    const expiresAt = Date.parse(body?.expires_at || "");
    const presignedUrl = trustedPresignedUrl(body?.presigned_url);
    if (!response.ok || body?.ok !== true || body?.operation !== operation || body?.pathname !== pathname
      || !presignedUrl || !Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 90_000) {
      throw new ResumePipelineError("blob_broker_capability_failed", "The private-object broker did not return a valid exact capability.", { retryable: response.status >= 500 });
    }
    return presignedUrl;
  }

  const client = {
    async readPrivateObject(pathname) {
      const url = await capability("get", pathname);
      const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { "cache-control": "no-store" } });
      if (response.status === 404) throw Object.assign(new ResumePipelineError("artifact_not_found", "The private artifact was not found.", { retryable: false }), { status: 404 });
      if (!response.ok) throw new ResumePipelineError("blob_read_failed", "The private artifact could not be read.", { retryable: response.status >= 500 });
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > MAX_OBJECT_BYTES) throw new ResumePipelineError("blob_read_too_large", "The private artifact exceeded its bounded size.", { retryable: false });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_OBJECT_BYTES) throw new ResumePipelineError("blob_read_too_large", "The private artifact exceeded its bounded size.", { retryable: false });
      return { bytes, content_type: response.headers.get("content-type") || "application/octet-stream" };
    },

    async putPrivateObject(pathname, value, contentType) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (!bytes.length || bytes.length > MAX_OBJECT_BYTES) throw new ResumePipelineError("blob_write_size_invalid", "The private artifact exceeded its bounded size.", { retryable: false });
      const url = await capability("put", pathname, { content_type: contentType, size_bytes: bytes.length });
      const response = await fetchImpl(url, { method: "PUT", redirect: "error", headers: { "content-type": contentType }, body: bytes });
      if (response.ok) return { pathname, contentType };
      try {
        const existing = await client.readPrivateObject(pathname);
        const expected = createHash("sha256").update(bytes).digest("hex");
        const actual = createHash("sha256").update(existing.bytes).digest("hex");
        if (expected !== actual) throw new ResumePipelineError("blob_object_conflict", "A private object already exists with different content.", { retryable: false });
        return { pathname, contentType: existing.content_type, adopted: true };
      } catch (readError) {
        if (readError?.code === "blob_object_conflict") throw readError;
        throw new ResumePipelineError("blob_write_failed", "The private artifact could not be written.", { retryable: response.status >= 500 });
      }
    },
  };
  return client;
}

export const blobBrokerClientInternals = Object.freeze({ configuration, trustedPresignedUrl });
