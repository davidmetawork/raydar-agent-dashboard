import { timingSafeEqual } from "node:crypto";
import { issueSignedToken, presignUrl } from "@vercel/blob";

const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "application/json",
  "application/pdf",
  "text/plain; charset=utf-8",
]);
const PRIVATE_OBJECT_PATH = /^submissions\/resumes\/v2\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/u;

const clean = (value, limit = 4_000) => String(value ?? "").trim().slice(0, limit);

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function equal(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeBlobBroker(req, { env = process.env } = {}) {
  const expected = clean(env.SUBMISSIONS_V2_BLOB_BROKER_KEY);
  if (Buffer.byteLength(expected, "utf8") < 32) throw problem("blob_broker_auth_not_configured", "The worker Blob capability broker is not configured.", 503);
  const supplied = clean(req?.headers?.authorization).replace(/^Bearer\s+/iu, "");
  if (!equal(supplied, expected)) throw problem("blob_broker_auth_required", "Worker Blob capability authentication is required.", 401);
  return true;
}

export function validateBlobCapabilityRequest(input = {}) {
  const operation = clean(input.operation, 20).toLowerCase();
  const pathname = clean(input.pathname, 1_000);
  if (!new Set(["get", "head", "put"]).has(operation)) throw problem("blob_capability_operation_invalid", "Only exact read, inspect, or create capabilities are available.", 400);
  if (!PRIVATE_OBJECT_PATH.test(pathname) || pathname.includes("..") || pathname.includes("*")) {
    throw problem("blob_capability_path_invalid", "The private-object path is outside the Submissions V2 namespace.", 400);
  }
  if (operation !== "put") return { operation, pathname, contentType: null, sizeBytes: null };
  const contentType = clean(input.content_type, 100).toLowerCase();
  const sizeBytes = Number(input.size_bytes);
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw problem("blob_capability_content_type_invalid", "The private-object content type is not allowed.", 400);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_OBJECT_BYTES) throw problem("blob_capability_size_invalid", "The private object exceeds its bounded size.", 400);
  return { operation, pathname, contentType, sizeBytes };
}

export async function issueWorkerBlobCapability(input, {
  env = process.env,
  now = () => Date.now(),
  issueImpl = issueSignedToken,
  presignImpl = presignUrl,
} = {}) {
  const request = validateBlobCapabilityRequest(input);
  const token = clean(env.SUBMISSIONS_V2_BLOB_READ_WRITE_TOKEN);
  if (!token) throw problem("blob_not_configured", "Private artifact storage is not configured.", 503);
  const validUntil = now() + 60_000;
  const issueOptions = {
    token,
    pathname: request.pathname,
    operations: [request.operation],
    validUntil,
  };
  if (request.operation === "put") {
    issueOptions.allowedContentTypes = [request.contentType];
    issueOptions.maximumSizeInBytes = request.sizeBytes;
  }
  const signed = await issueImpl(issueOptions);
  const presignOptions = {
    operation: request.operation,
    access: "private",
    pathname: request.pathname,
    validUntil,
  };
  if (request.operation === "get") presignOptions.useCache = false;
  if (request.operation === "put") Object.assign(presignOptions, {
    allowedContentTypes: [request.contentType],
    maximumSizeInBytes: request.sizeBytes,
    allowOverwrite: false,
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
  });
  const result = await presignImpl(signed, presignOptions);
  return {
    operation: request.operation,
    pathname: request.pathname,
    presigned_url: result.presignedUrl,
    expires_at: new Date(validUntil).toISOString(),
  };
}

export const blobCapabilityInternals = Object.freeze({ ALLOWED_CONTENT_TYPES, MAX_OBJECT_BYTES, PRIVATE_OBJECT_PATH });
