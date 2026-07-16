import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "__Host-raydar_session";
export const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;

const GOOGLE_CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID || "";
const SESSION_SECRET = () => process.env.AUTH_SESSION_SECRET || "";
const allowedDomains = () => (process.env.ALLOWED_DOMAINS || "raydar.xyz,raydargroup.com")
  .split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean);

function authError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

const sign = (value, secret) => createHmac("sha256", secret).update(value).digest("base64url");

function equal(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionConfig() {
  return {
    googleClientId: GOOGLE_CLIENT_ID(),
    allowedDomains: allowedDomains(),
    authRequired: Boolean(GOOGLE_CLIENT_ID()),
    durableSessionEnabled: SESSION_SECRET().length >= 32,
    sessionDays: SESSION_TTL_SECONDS / 86400,
  };
}

export function createSessionToken(identity, options = {}) {
  const secret = options.secret ?? SESSION_SECRET();
  if (secret.length < 32) throw authError("auth_session_not_configured");
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const email = String(identity?.email || "").trim().toLowerCase();
  const domain = String(identity?.domain || email.split("@")[1] || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !domain) throw authError("invalid_identity");
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    email,
    domain,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token, options = {}) {
  const secret = options.secret ?? SESSION_SECRET();
  if (secret.length < 32 || !token) return null;
  const [payload, signature, extra] = String(token).split(".");
  if (!payload || !signature || extra || !equal(signature, sign(payload, secret))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
    const domains = options.allowedDomains ?? allowedDomains();
    const email = String(value.email || "").trim().toLowerCase();
    const domain = String(value.domain || email.split("@")[1] || "").trim().toLowerCase();
    const valid = value.v === 1 && email && domain && Number.isInteger(value.iat) && Number.isInteger(value.exp) &&
      value.iat <= now + 300 && value.exp > now && value.exp - value.iat === SESSION_TTL_SECONDS &&
      domains.includes(domain) && /^[^@\s]+@[^@\s]+$/.test(email);
    return valid ? { email, domain, issuedAt: value.iat, expiresAt: value.exp } : null;
  } catch {
    return null;
  }
}

function cookieValue(req, name) {
  const header = String(req?.headers?.cookie || "");
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(rest.join("=")); }
      catch { return ""; }
    }
  }
  return "";
}

export function sessionFromRequest(req) {
  return verifySessionToken(cookieValue(req, SESSION_COOKIE));
}

export function sessionCookie(token, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const expires = new Date(nowMs + SESSION_TTL_SECONDS * 1000).toUTCString();
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Expires=${expires}; Priority=High`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Priority=High`;
}

export function issueSession(identity, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const token = createSessionToken(identity, { ...options, nowMs });
  return {
    token,
    cookie: sessionCookie(token, { nowMs }),
    expiresAt: new Date(nowMs + SESSION_TTL_SECONDS * 1000).toISOString(),
  };
}

export async function verifyGoogleCredential(credential) {
  const clientId = GOOGLE_CLIENT_ID();
  if (!clientId) throw authError("google_auth_not_configured");
  if (!credential) throw authError("auth_required");
  let response;
  try {
    response = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential), {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw authError("auth_check_failed");
  }
  const token = await response.json().catch(() => ({}));
  const email = String(token.email || "").trim().toLowerCase();
  const hostedDomain = String(token.hd || "").trim().toLowerCase();
  const emailDomain = String(email.split("@")[1] || "").trim().toLowerCase();
  const domain = allowedDomains().includes(hostedDomain) ? hostedDomain : emailDomain;
  const valid = response.ok && token.aud === clientId && token.email_verified === "true" &&
    Number(token.exp) * 1000 > Date.now() && allowedDomains().includes(domain) && /^[^@\s]+@[^@\s]+$/.test(email);
  if (!valid) throw authError("forbidden", "Use an approved Raydar Google account.");
  return { email, domain };
}
