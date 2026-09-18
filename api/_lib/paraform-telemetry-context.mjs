import { AsyncLocalStorage } from "node:async_hooks";
import { createTelemetryFetch } from "./paraform-telemetry.mjs";

export const PARAFORM_TELEMETRY_SOURCE_IDS = Object.freeze([
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

function source(value, fallback) {
  const selected = String(value || fallback || "");
  if (!SOURCES.has(selected)) throw new Error("PARAFORM_TELEMETRY_SOURCE_INVALID");
  return selected;
}

/**
 * Scope an existing request or worker job to a fixed, non-PII caller label.
 * The context changes telemetry metadata only; it cannot change the wrapped
 * provider request or a caller's pause/control behavior.
 */
export function withParaformTelemetrySource(sourceId, operation) {
  if (typeof operation !== "function") throw new Error("PARAFORM_TELEMETRY_OPERATION_REQUIRED");
  return sourceContext.run(source(sourceId), operation);
}

export function paraformTelemetrySource(fallbackSource) {
  return source(sourceContext.getStore(), fallbackSource);
}

/**
 * Wrap exactly one provider transport. The shared client filters non-Paraform
 * hosts, so signed blob downloads and telemetry delivery remain unobserved.
 */
export function telemetryFetch(fetchImpl = globalThis.fetch, fallbackSource, options = {}) {
  if (typeof fetchImpl !== "function") throw new Error("PARAFORM_TELEMETRY_FETCH_REQUIRED");
  return createTelemetryFetch({
    fetchImpl,
    sourceId: paraformTelemetrySource(fallbackSource),
    env: options.env || process.env,
    ...(options.telemetryFetchImpl ? { telemetryFetchImpl: options.telemetryFetchImpl } : {}),
  });
}
