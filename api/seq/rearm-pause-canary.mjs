import { timingSafeEqual } from "node:crypto";

import { rearmRaydarPauseCanary } from "./_lib/pause-canary-rearm.mjs";

const MAX_BODY_BYTES = 1_024;
const SHA256 = /^[a-f0-9]{64}$/u;
const KEY = /^\S{32,}$/u;

const json = (value, status = 200) => Response.json(value, {
  status,
  headers: { "cache-control": "no-store" },
});

function authorized(header, key) {
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
  const scheduled = request.method === "GET";
  const operator = request.method === "POST";
  if (!scheduled && !operator) {
    return json({ ok: false, error: "GET_or_POST_only" }, 405);
  }
  const key = scheduled
    ? env.CRON_SECRET
    : env.RAYDAR_PAUSE_CANARY_REARM_KEY;
  if (!authorized(request.headers.get("authorization"), key)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (scheduled) {
    try {
      return json(await rearmImpl({ identitySha256: null, env }));
    } catch (error) {
      const code = String(error?.code || "PAUSE_CANARY_REARM_FAILED");
      const safe = /^PAUSE_CANARY_REARM_[A-Z_]+$/u.test(code)
        ? code
        : "PAUSE_CANARY_REARM_FAILED";
      return json({ ok: false, error: safe }, 409);
    }
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
    || ![0, 1].includes(Object.keys(body).length)
    || (
      Object.keys(body).length === 1
      && (
        !Object.hasOwn(body, "identitySha256")
        || !SHA256.test(String(body.identitySha256 ?? ""))
      )
    )
  ) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  try {
    return json(await rearmImpl({
      identitySha256: body.identitySha256 ?? null,
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
