// Private machine import for licensed funded-employer membership snapshots.
// Uses the existing Applicant Hub publisher secret. Responses contain only
// snapshot metadata; licensed organization rows are never returned.

import { timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

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
  updateFundedEmployerCatalog,
} from "./_lib/funded-employers.mjs";
import { readPublishedArtifacts, validPublication } from "./_lib/generation.mjs";
import { getJson, K, kv, kvConfigured, setJsonIfAbsent } from "./_lib/kv.mjs";
import { sourceObservationIdFor } from "./_lib/profile-readiness.mjs";
import { sourceProfileDigest } from "./_lib/source-profile-digest.mjs";

export const config = { maxDuration: 60 };

export const MAX_FUNDED_EMPLOYER_IMPORT_COMPRESSED_BYTES = 2_500_000;
export const MAX_FUNDED_EMPLOYER_IMPORT_DECODED_BYTES = 8_000_000;
const IMPORT_TRANSPORT_VERSION = "funded-employer-import-gzip-v1";
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

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

function parseBody(value) {
  if (typeof value !== "string") return { ok: true, body: value || {} };
  if (Buffer.byteLength(value, "utf8") > MAX_FUNDED_EMPLOYER_IMPORT_DECODED_BYTES) {
    return { ok: false, error: "funded_employer_import_too_large" };
  }
  try { return { ok: true, body: JSON.parse(value || "{}") }; }
  catch { return { ok: false, error: "invalid_json" }; }
}

/** Decode the authenticated, bounded import envelope used above Vercel's JSON-body ceiling. */
export function decodeFundedEmployerImport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["operation", "transport"])
    || input.operation !== "import_snapshot") {
    return { ok: false, error: "invalid_import_envelope" };
  }
  const transport = input.transport;
  const keys = ["codec", "data", "decodedBytes", "decodedSha256", "version"];
  if (!transport || typeof transport !== "object" || Array.isArray(transport)
    || JSON.stringify(Object.keys(transport).sort()) !== JSON.stringify(keys)
    || transport.version !== IMPORT_TRANSPORT_VERSION
    || transport.codec !== "gzip-base64"
    || !Number.isSafeInteger(transport.decodedBytes)
    || transport.decodedBytes < 2 || transport.decodedBytes > MAX_FUNDED_EMPLOYER_IMPORT_DECODED_BYTES
    || !/^[a-f0-9]{64}$/iu.test(String(transport.decodedSha256 || ""))
    || typeof transport.data !== "string" || !transport.data.length
    || transport.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(transport.data)
    || transport.data.length > Math.ceil(MAX_FUNDED_EMPLOYER_IMPORT_COMPRESSED_BYTES / 3) * 4 + 4) {
    return { ok: false, error: "invalid_import_envelope" };
  }
  try {
    const compressed = Buffer.from(transport.data, "base64");
    if (compressed.length > MAX_FUNDED_EMPLOYER_IMPORT_COMPRESSED_BYTES
      || compressed.toString("base64") !== transport.data) {
      return { ok: false, error: "invalid_import_envelope" };
    }
    const decoded = gunzipSync(compressed, { maxOutputLength: MAX_FUNDED_EMPLOYER_IMPORT_DECODED_BYTES + 1 });
    if (decoded.length !== transport.decodedBytes || decoded.length > MAX_FUNDED_EMPLOYER_IMPORT_DECODED_BYTES
      || createHash("sha256").update(decoded).digest("hex") !== transport.decodedSha256) {
      return { ok: false, error: "invalid_import_payload" };
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    if (!body || typeof body !== "object" || Array.isArray(body) || own(body, "transport") || own(body, "operation")) {
      return { ok: false, error: "invalid_import_payload" };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, error: "invalid_import_payload" };
  }
}

export function createFundedEmployersHandler({
  corsHandler = cors,
  authHandler = publisherAuthorized,
  kvReady = kvConfigured,
  readJson = getJson,
  writeIfAbsent = setJsonIfAbsent,
  command = kv,
  updateCatalog = updateFundedEmployerCatalog,
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
      const parsed = parseBody(req.body);
      if (!parsed.ok) return res.status(parsed.error === "funded_employer_import_too_large" ? 413 : 400)
        .json({ ok: false, error: parsed.error });
      let body = parsed.body;
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
      if (body?.operation === "import_snapshot") {
        const decoded = decodeFundedEmployerImport(body);
        if (!decoded.ok) return res.status(400).json({ ok: false, error: decoded.error });
        body = decoded.body;
      }
      const result = await importFundedEmployerSnapshot(body, {
        readJson,
        writeIfAbsent,
        updateCatalog: (metadata) => updateCatalog(metadata, { kvImpl: command }),
      });
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
      const conflict = detail === "funded_employer_snapshot_id_conflict"
        || detail === "funded_employer_catalog_conflict";
      const tooLarge = detail === "funded_employer_snapshot_too_large";
      return res.status(conflict ? 409 : tooLarge ? 413 : 400).json({
        ok: false,
        error: conflict || tooLarge ? detail : "funded_employer_snapshot_invalid",
        detail,
      });
    }
  };
}

export default createFundedEmployersHandler();
