// Private machine import for licensed funded-employer membership snapshots.
// Uses the existing Applicant Hub publisher secret. Responses contain only
// snapshot metadata; licensed organization rows are never returned.

import { timingSafeEqual } from "node:crypto";

import { cors } from "./_lib/core.mjs";
import {
  companyCatalogFromFactPage,
  loadActiveSourceFactPage,
  rebuildActiveFacts,
} from "./_lib/facts-rebuild.mjs";
import { factsFromProfile } from "./_lib/facts.mjs";
import {
  importFundedEmployerSnapshot,
  readFundedEmployerCatalog,
} from "./_lib/funded-employers.mjs";
import { readPublishedArtifacts, validPublication } from "./_lib/generation.mjs";
import { getJson, K, kv, kvConfigured, setJson, setJsonIfAbsent } from "./_lib/kv.mjs";
import { sourceObservationIdFor } from "./_lib/profile-readiness.mjs";
import { sourceProfileDigest } from "./_lib/source-profile-digest.mjs";

export const config = { maxDuration: 60 };

function publisherAuthorized(req) {
  const secret = process.env.APPHUB_SYNC_KEY || "";
  const provided = req.headers?.authorization || "";
  if (!secret) return false;
  const actual = Buffer.from(provided);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function pageValue(value, fallback) {
  if (value == null || value === "") return fallback;
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function pageOptions(input) {
  const offset = pageValue(input?.offset, 0);
  const limit = pageValue(input?.limit, 100);
  return Number.isSafeInteger(offset) && offset >= 0
    && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
    ? { offset, limit }
    : null;
}

function expectedGeneration(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return false;
  const result = value.trim();
  return result && result.length <= 128 ? result : false;
}

export function createFundedEmployersHandler({
  corsHandler = cors,
  authHandler = publisherAuthorized,
  kvReady = kvConfigured,
  readJson = getJson,
  writeJson = setJson,
  writeIfAbsent = setJsonIfAbsent,
  command = kv,
  loadSourceFactPage = loadActiveSourceFactPage,
  rebuildFacts = rebuildActiveFacts,
} = {}) {
  const sourceFactDependencies = {
    kvImpl: command,
    K,
    validPublication,
    readPublishedArtifacts,
    factsFromProfile,
    sourceProfileDigest,
    sourceObservationIdFor,
  };
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "GET or POST only" });
    }
    if (!authHandler(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
    let operationalRequest = req.method === "GET" && req.query?.companyCatalog === "1";
    try {
      if (req.method === "GET") {
        if (req.query?.companyCatalog === "1") {
          const page = pageOptions(req.query);
          const expectedGenerationId = expectedGeneration(req.query?.expectedGenerationId);
          if (!page || expectedGenerationId === false) {
            return res.status(400).json({ ok: false, error: "invalid_page" });
          }
          const loaded = await loadSourceFactPage({
            ...page,
            includeStream: false,
            expectedGenerationId,
            ...sourceFactDependencies,
          });
          return res.status(200).json({ ok: true, ...companyCatalogFromFactPage(loaded) });
        }
        return res.status(200).json({ ok: true, ...(await readFundedEmployerCatalog({ readJson })) });
      }
      let body;
      try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
      catch { return res.status(400).json({ ok: false, error: "invalid_json" }); }
      if (body?.operation === "rebuild_facts") {
        operationalRequest = true;
        const page = pageOptions(body);
        const expectedGenerationId = expectedGeneration(body.expectedGenerationId);
        if (!page || expectedGenerationId === false) {
          return res.status(400).json({ ok: false, error: "invalid_rebuild_request" });
        }
        const dryRun = body.dryRun !== false;
        const report = await rebuildFacts({
          apply: !dryRun,
          ...page,
          includeStream: false,
          expectedGenerationId,
          ...sourceFactDependencies,
        });
        return res.status(200).json({ ok: true, dryRun, ...report });
      }
      const result = await importFundedEmployerSnapshot(body, { readJson, writeJson, writeIfAbsent });
      return res.status(result.created ? 201 : 200).json({
        ok: true,
        created: result.created,
        activeSnapshotId: result.catalog.activeSnapshotId,
        snapshot: result.metadata,
      });
    } catch (error) {
      const detail = String(error?.message || error).slice(0, 180);
      if (["active_generation_unavailable", "active_generation_invalid"].includes(detail)) {
        return res.status(503).json({ ok: false, error: detail });
      }
      if (["expected_generation_mismatch", "active_generation_changed_during_staging"].includes(detail)) {
        return res.status(409).json({ ok: false, error: detail });
      }
      if (detail === "facts_rebuild_page_invalid") {
        return res.status(400).json({ ok: false, error: "invalid_page" });
      }
      if (operationalRequest) {
        return res.status(502).json({ ok: false, error: "funded_employer_operation_unavailable" });
      }
      const conflict = detail === "funded_employer_snapshot_id_conflict";
      return res.status(conflict ? 409 : 400).json({
        ok: false,
        error: conflict ? detail : "funded_employer_snapshot_invalid",
        detail,
      });
    }
  };
}

export default createFundedEmployersHandler();
