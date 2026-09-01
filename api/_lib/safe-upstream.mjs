import { isIP } from "node:net";

const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^0\./,
];

function configuredOrigins(value) {
  return new Set(String(value || "").split(",").map((item) => {
    try { return new URL(item.trim()).origin; } catch { return ""; }
  }).filter(Boolean));
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  // These service bases are expected to be stable HTTPS origins, never literal
  // IP addresses. Rejecting every IP also closes alternate IPv4 spellings,
  // IPv4-mapped IPv6 and cloud metadata ranges without a brittle block list.
  if (isIP(host)) return true;
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd") ||
    PRIVATE_IPV4.some((pattern) => pattern.test(host));
}

export function safeUpstreamBase(raw, {
  fallback = "",
  allowedOrigins = "",
  service = "upstream",
} = {}) {
  const value = String(raw || fallback || "").trim();
  if (!value) throw new Error(`${service}_not_configured`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${service}_base_invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || isPrivateHost(url.hostname)) {
    throw new Error(`${service}_base_unsafe`);
  }
  if (url.pathname !== "/" && url.pathname !== "") throw new Error(`${service}_base_must_be_origin`);
  const allowlist = configuredOrigins(allowedOrigins);
  if (allowlist.size && !allowlist.has(url.origin)) throw new Error(`${service}_origin_not_allowed`);
  return url.origin;
}

export const safeUpstreamInternals = { configuredOrigins, isPrivateHost };
