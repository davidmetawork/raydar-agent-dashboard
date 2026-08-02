import { timingSafeEqual } from "node:crypto";

import { rearmRaydarPauseCanary } from "./_lib/pause-canary-rearm.mjs";

const MAX_BODY_BYTES = 1_024;
const SHA256 = /^[a-f0-9]{64}$/u;
const KEY = /^\S{32,}$/u;

const json = (value, status = 200) => Response.json(value, {
  status,
  headers: { "cache-control": "no-store" },
});

function authorized(header, env) {
  const key = env.RAYDAR_PAUSE_CANARY_REARM_KEY;
  if (!KEY.test(String(key ?? "")) || typeof header !== "string") {
    return false;
  }
  const actual = Buffer.from(header, "utf8");
  const expected = Buffer.from(`Bearer ${key}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function handlePauseCanaryRearmRequest(request, {
  env = process.env,
  rearmImpl = rearmRaydarPauseCanary,
} = {}) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST_only" }, 405);
  }
  if (!authorized(request.headers.get("authorization"), env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload_too_large" }, 413);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  if (
    !body
    || typeof body !== "object"
    || Array.isArray(body)
    || Object.keys(body).length !== 1
    || !SHA256.test(String(body.identitySha256 ?? ""))
  ) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  try {
    return json(await rearmImpl({
      identitySha256: body.identitySha256,
      env,
    }));
  } catch (error) {
    const code = String(error?.code || "PAUSE_CANARY_REARM_FAILED");
    const safe = /^PAUSE_CANARY_REARM_[A-Z_]+$/u.test(code)
      ? code
      : "PAUSE_CANARY_REARM_FAILED";
    return json({ ok: false, error: safe }, 409);
  }
}

export default {
  async fetch(request) {
    return handlePauseCanaryRearmRequest(request);
  },
};
