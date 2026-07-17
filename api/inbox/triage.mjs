import {
  cors,
  requireInboxAuth,
  storeConfigured,
  validInboxGmailId,
  writeInboxTriage,
} from "./_lib/core.mjs";

const REQUEST_STATUSES = new Set(["archived", "complete", "inbox"]);

function requestBody(req) {
  if (typeof req?.body === "string") return JSON.parse(req.body || "{}");
  return req?.body && typeof req.body === "object" ? req.body : {};
}

export function createInboxTriageHandler({
  corsHandler = cors,
  authHandler = requireInboxAuth,
  storeReady = storeConfigured,
  writeTriage = writeInboxTriage,
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({
        ok: false,
        error: "method_not_allowed",
      });
    }
    const contentType = String(
      req.headers?.["content-type"] || "",
    ).split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return res.status(415).json({
        ok: false,
        error: "unsupported_media_type",
      });
    }
    if (!(await authHandler(req, res))) return;
    if (!storeReady()) {
      return res.status(503).json({
        ok: false,
        error: "triage_store_not_configured",
      });
    }

    let body;
    try {
      body = requestBody(req);
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_json" });
    }

    const gmailId = String(body.gmail_id || "").trim();
    const requestedStatus = typeof body.status === "string"
      ? body.status.trim().toLowerCase()
      : "";
    if (!validInboxGmailId(gmailId)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_gmail_id",
      });
    }
    if (!REQUEST_STATUSES.has(requestedStatus)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_triage_status",
      });
    }

    try {
      const triage = await writeTriage(
        gmailId,
        requestedStatus === "inbox" ? null : requestedStatus,
      );
      return res.status(200).json({ ok: true, ...triage });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "triage_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createInboxTriageHandler();
