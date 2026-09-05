// Private machine import for licensed funded-employer membership snapshots.
// Uses the existing Applicant Hub publisher secret. Responses contain only
// snapshot metadata; licensed organization rows are never returned.

import { timingSafeEqual } from "node:crypto";

import { cors } from "./_lib/core.mjs";
import {
  importFundedEmployerSnapshot,
  readFundedEmployerCatalog,
} from "./_lib/funded-employers.mjs";
import { getJson, kvConfigured, setJson, setJsonIfAbsent } from "./_lib/kv.mjs";

export const config = { maxDuration: 60 };

function publisherAuthorized(req) {
  const secret = process.env.APPHUB_SYNC_KEY || "";
  const provided = req.headers?.authorization || "";
  if (!secret) return false;
  const actual = Buffer.from(provided);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createFundedEmployersHandler({
  corsHandler = cors,
  authHandler = publisherAuthorized,
  kvReady = kvConfigured,
  readJson = getJson,
  writeJson = setJson,
  writeIfAbsent = setJsonIfAbsent,
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "GET or POST only" });
    }
    if (!authHandler(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
    try {
      if (req.method === "GET") {
        return res.status(200).json({ ok: true, ...(await readFundedEmployerCatalog({ readJson })) });
      }
      let body;
      try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
      catch { return res.status(400).json({ ok: false, error: "invalid_json" }); }
      const result = await importFundedEmployerSnapshot(body, { readJson, writeJson, writeIfAbsent });
      return res.status(result.created ? 201 : 200).json({
        ok: true,
        created: result.created,
        activeSnapshotId: result.catalog.activeSnapshotId,
        snapshot: result.metadata,
      });
    } catch (error) {
      const detail = String(error?.message || error).slice(0, 180);
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
