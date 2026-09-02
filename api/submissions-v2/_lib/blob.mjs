import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { get, head, issueSignedToken, presignUrl, put } from "@vercel/blob";

const text = (value, limit = 1_000) => String(value ?? "").trim().slice(0, limit);
const token = (env = process.env) => text(env.SUBMISSIONS_V2_BLOB_READ_WRITE_TOKEN, 4_000);

function requireToken(env = process.env) {
  const value = token(env);
  if (!value) throw Object.assign(new Error("Private artifact storage is not configured."), { code: "blob_not_configured", status: 503 });
  return value;
}

export function privatePath(kind, id = randomUUID()) {
  if (!/^[a-z0-9_-]+$/i.test(kind) || !/^[a-z0-9_-]+$/i.test(String(id))) throw Object.assign(new Error("Private object identity is invalid."), { code: "blob_path_invalid", status: 400 });
  return `submissions/resumes/v2/${kind}/${id}`;
}

export function privateReservationId(pathname) {
  const hex = createHash("sha256").update(`submissions-v2:private-reservation:v1\0${String(pathname)}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function createPresignedUpload({ pathname, contentType, maximumSizeInBytes, validForMs = 5 * 60_000 }, { env = process.env } = {}) {
  const validUntil = Date.now() + Math.max(60_000, Math.min(10 * 60_000, validForMs));
  const signed = await issueSignedToken({ token: requireToken(env), pathname, operations: ["put"], validUntil, allowedContentTypes: [contentType], maximumSizeInBytes });
  const result = await presignUrl(signed, { operation: "put", access: "private", pathname, validUntil, allowedContentTypes: [contentType], maximumSizeInBytes, allowOverwrite: false, addRandomSuffix: false, cacheControlMaxAge: 60 });
  return { upload_url: result.presignedUrl, upload_headers: { "content-type": contentType }, expires_at: new Date(validUntil).toISOString() };
}

export async function inspectPrivateObject(pathname, { env = process.env } = {}) {
  const result = await head(pathname, { token: requireToken(env) });
  return { pathname: result.pathname, content_type: result.contentType || null, size: Number(result.size || 0), uploaded_at: result.uploadedAt || null };
}

export async function putPrivateObject(pathname, bytes, contentType, {
  env = process.env,
  putImpl = put,
  readImpl = readPrivateObject,
} = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  try {
    return await putImpl(pathname, body, {
      token: requireToken(env), access: "private", addRandomSuffix: false,
      allowOverwrite: false, contentType, cacheControlMaxAge: 60,
    });
  } catch (writeError) {
    // Deterministic paths make every pipeline write replayable after a crash: an
    // existing byte-identical object is adopted, while any mismatch fails closed.
    try {
      const existing = await readImpl(pathname, { env });
      const expected = createHash("sha256").update(body).digest("hex");
      const actual = createHash("sha256").update(existing.bytes).digest("hex");
      if (expected !== actual) {
        throw Object.assign(new Error("A private object already exists with different content."), {
          code: "blob_object_conflict", status: 409,
        });
      }
      return { pathname, contentType: existing.content_type, adopted: true };
    } catch (readError) {
      if (readError?.code === "blob_object_conflict") throw readError;
      throw writeError;
    }
  }
}

export async function readPrivateObject(pathname, { env = process.env } = {}) {
  const result = await get(pathname, { token: requireToken(env), access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) throw Object.assign(new Error("Private artifact was not found."), { code: "artifact_not_found", status: 404 });
  return { bytes: Buffer.from(await new Response(result.stream).arrayBuffer()), content_type: result.contentType || "application/octet-stream" };
}

function ticketSecret(env = process.env) {
  const value = text(env.SUBMISSIONS_V2_DOWNLOAD_SECRET, 4_000);
  if (value.length < 32) throw Object.assign(new Error("Download signing is not configured."), { code: "download_signing_not_configured", status: 503 });
  return value;
}

function equal(left, right) {
  const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signDownloadTicket(payload, { env = process.env } = {}) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", ticketSecret(env)).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyDownloadTicket(value, { identityEmail, env = process.env, now = Date.now() } = {}) {
  const [encoded, supplied, extra] = String(value || "").split(".");
  if (!encoded || !supplied || extra) throw Object.assign(new Error("Download ticket is invalid."), { code: "download_ticket_invalid", status: 401 });
  const expected = createHmac("sha256", ticketSecret(env)).update(encoded).digest("base64url");
  if (!equal(supplied, expected)) throw Object.assign(new Error("Download ticket is invalid."), { code: "download_ticket_invalid", status: 401 });
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw Object.assign(new Error("Download ticket is invalid."), { code: "download_ticket_invalid", status: 401 }); }
  if (!payload?.ticket_id || !payload?.artifact_id || !payload?.pathname || !payload?.email || Number(payload.expires_at) <= now) throw Object.assign(new Error("Download ticket expired or incomplete."), { code: "download_ticket_expired", status: 401 });
  if (String(payload.email).toLowerCase() !== String(identityEmail || "").toLowerCase()) throw Object.assign(new Error("Download ticket belongs to another user."), { code: "download_ticket_wrong_user", status: 403 });
  return payload;
}
