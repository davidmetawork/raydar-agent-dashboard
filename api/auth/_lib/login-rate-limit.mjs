import { createHmac } from "node:crypto";
import { isIP } from "node:net";

// Google login write ownership:
//   auth:login:v1:<HMAC(client address)> — POST /api/auth/google only. The
//   shared KV value is a counter with a five-minute expiry; neither the key nor
//   the value contains a raw client address. If KV is absent or unavailable,
//   the same window is enforced best-effort in a bounded per-instance map.
//   Fallback attempts are not merged into Redis after recovery, so an outage
//   and recovery do not form one distributed budget; preserving valid login
//   access during a store outage is the deliberate tradeoff.
export const LOGIN_RATE_WINDOW_SECONDS = 5 * 60;
export const LOGIN_RATE_LIMIT = 20;
const MEMORY_ENTRY_CAP = 2_048;
const memoryWindows = new Map();

function trustedClientAddress(req, env = process.env) {
  // Vercel supplies x-vercel-forwarded-for at the platform edge. Do not use
  // ordinary x-forwarded-for here: direct clients can spoof it and rotate the
  // limiter key. Local development falls back to the socket address.
  const platform = env.VERCEL === "1"
    ? String(req?.headers?.["x-vercel-forwarded-for"] || "").split(",", 1)[0].trim()
    : "";
  const socket = String(req?.socket?.remoteAddress || "").trim();
  const value = platform || socket;
  return isIP(value) ? value.toLowerCase() : "unknown";
}

function limiterKey(req, secret, env) {
  const address = trustedClientAddress(req, env);
  const digest = createHmac("sha256", secret).update(`raydar-login\0${address}`).digest("hex").slice(0, 32);
  return `auth:login:v1:${digest}`;
}

function memoryLimit(key, nowMs) {
  for (const [candidate, window] of memoryWindows) {
    if (window.expiresAt <= nowMs) memoryWindows.delete(candidate);
  }
  if (!memoryWindows.has(key) && memoryWindows.size >= MEMORY_ENTRY_CAP) {
    memoryWindows.delete(memoryWindows.keys().next().value);
  }
  const current = memoryWindows.get(key);
  const window = current?.expiresAt > nowMs
    ? current
    : { count: 0, expiresAt: nowMs + LOGIN_RATE_WINDOW_SECONDS * 1000 };
  window.count += 1;
  memoryWindows.delete(key);
  memoryWindows.set(key, window);
  return {
    allowed: window.count <= LOGIN_RATE_LIMIT,
    count: window.count,
    retryAfterSeconds: Math.max(1, Math.ceil((window.expiresAt - nowMs) / 1000)),
    distributed: false,
  };
}

async function distributedLimit(key, { env, fetchImpl }) {
  const base = String(env.KV_REST_API_URL || "").replace(/\/+$/u, "");
  const token = String(env.KV_REST_API_TOKEN || "");
  if (!base || !token) return null;
  const script = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "local ttl = redis.call('TTL', KEYS[1])",
    "if ttl == -1 then",
    "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
    "  ttl = redis.call('TTL', KEYS[1])",
    "end",
    "return { count, ttl }",
  ].join("\n");
  const response = await fetchImpl(base, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(["EVAL", script, 1, key, String(LOGIN_RATE_WINDOW_SECONDS)]),
    signal: AbortSignal.timeout(1_500),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error || !Array.isArray(body?.result)) throw new Error("login_rate_store_unavailable");
  const count = body.result[0];
  const ttl = body.result[1];
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(ttl) || ttl < 0) {
    throw new Error("login_rate_store_invalid");
  }
  return {
    allowed: count <= LOGIN_RATE_LIMIT,
    count,
    retryAfterSeconds: Math.max(1, ttl),
    distributed: true,
  };
}

export async function checkLoginRateLimit(req, {
  nowMs = Date.now(),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const secret = String(env.AUTH_SESSION_SECRET || "");
  if (secret.length < 32) return { allowed: false, count: 0, retryAfterSeconds: 0, distributed: false };
  const key = limiterKey(req, secret, env);
  try {
    const result = await distributedLimit(key, { env, fetchImpl });
    if (result) return result;
  } catch {
    // A KV outage must not take Google login down. The bounded per-instance
    // window still absorbs bursts until the shared limiter becomes available.
  }
  return memoryLimit(key, nowMs);
}

export const loginRateLimitInternals = {
  limiterKey,
  memoryLimit,
  trustedClientAddress,
  resetMemory() { memoryWindows.clear(); },
  memorySize() { return memoryWindows.size; },
};
