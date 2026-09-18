import { AsyncLocalStorage } from "node:async_hooks";
import { waitUntil } from "@vercel/functions";

import { createTelemetryFetch } from "./paraform-telemetry.mjs";

export const PARAFORM_TELEMETRY_SOURCE_IDS = Object.freeze([
  "paraai",
  "dashboard-sequences",
  "dashboard-booking",
  "dashboard-health",
  "dashboard-inbox",
  "dashboard-activity",
  "submissions-v1",
  "submissions-v2",
  "dashboard-applicants",
  "dashboard-manual",
]);

const SOURCES = new Set(PARAFORM_TELEMETRY_SOURCE_IDS);
const sourceContext = new AsyncLocalStorage();
// Retain the bounded reporter across warm-runtime calls so a failed delivery's
// dropped count is included in the next successful heartbeat for this source.
const reportersByFetch = new WeakMap();

function source(value, fallback) {
  const selected = String(value || fallback || "");
  if (!SOURCES.has(selected)) throw new Error("PARAFORM_TELEMETRY_SOURCE_INVALID");
  return selected;
}

// Context carries a fixed collector identity only. It cannot alter a provider
// request, its pause/control state, or its caller-visible response/error.
export function withParaformTelemetrySource(sourceId, operation) {
  if (typeof operation !== "function") throw new Error("PARAFORM_TELEMETRY_OPERATION_REQUIRED");
  return sourceContext.run(source(sourceId), operation);
}

export function paraformTelemetrySource(fallbackSource) {
  return source(sourceContext.getStore(), fallbackSource);
}

// The shared client filters non-Paraform hosts. On Vercel, schedule terminal
// delivery in the supported lifecycle hook; normal provider completion is not
// delayed for collector delivery.
export function telemetryFetch(fetchImpl = globalThis.fetch, fallbackSource, options = {}) {
  if (typeof fetchImpl !== "function") throw new Error("PARAFORM_TELEMETRY_FETCH_REQUIRED");
  const sourceId = paraformTelemetrySource(fallbackSource);
  const optionKeys = Object.keys(options);
  const cacheable = !options.telemetryFetchImpl
    && (!options.env || options.env === process.env)
    && optionKeys.every((key) => key === "env");
  const cacheKey = cacheable ? JSON.stringify([sourceId, ...[
    "PARAFORM_TELEMETRY_SOURCE", "PARAFORM_TELEMETRY_URL",
    "PARAFORM_TELEMETRY_TOKEN", "PARAFORM_TELEMETRY_DISPATCH_TOKEN",
  ].map(key => process.env[key] || "")]) : null;
  let cache = cacheable ? reportersByFetch.get(fetchImpl) : null;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  const wrapped = createTelemetryFetch({
    fetchImpl,
    sourceId,
    env: options.env || process.env,
    ...(options.telemetryFetchImpl ? { telemetryFetchImpl: options.telemetryFetchImpl } : {}),
  });
  const observed = (...args) => {
    const attempt = wrapped(...args);
    if (process.env.VERCEL === "1") {
      try { waitUntil(Promise.resolve(attempt).then(() => wrapped.flush(), () => wrapped.flush()).catch(() => {})); } catch { /* auto-flush remains */ }
    }
    return attempt;
  };
  Object.defineProperties(observed, {
    flush: { value: wrapped.flush, enumerable: false },
    heartbeat: { value: wrapped.heartbeat, enumerable: false },
    snapshot: { value: wrapped.snapshot, enumerable: false },
  });
  if (cacheable) {
    if (!cache) { cache = new Map(); reportersByFetch.set(fetchImpl, cache); }
    // Credentials can change only at deployment in normal operation; keep a
    // bounded fallback for unusual in-process environment replacement.
    if (cache.size >= 32) cache.clear();
    cache.set(cacheKey, observed);
  }
  return observed;
}
