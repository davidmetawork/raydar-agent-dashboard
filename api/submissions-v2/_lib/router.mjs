import { sessionConfig } from "../../auth/_lib/session.mjs";
import { effectiveControls, serviceConfig } from "./config.mjs";
import { readRuntimeControls } from "./db.mjs";
import {
  csrfToken, readRawBody, requireAdmin, requireCron, requireHuman,
  requireIdempotency, sendError, verifyInboxMachine,
} from "./http.mjs";
import { createService } from "./service.mjs";
import { authorizeBlobBroker, issueWorkerBlobCapability } from "./blob-capabilities.mjs";
import { authorizeNotificationBroker, postSafeNotification } from "./notifications.mjs";
import { readSequenceInboxBrokerBatch } from "./sequence-inbox-broker.mjs";

function routeSegments(req) {
  const captured = req.query?.route;
  if (Array.isArray(captured)) return captured.map(String).filter(Boolean);
  if (captured) return String(captured).split("/").filter(Boolean);
  const pathname = new URL(String(req.url || "/"), "https://monitor.raydar.xyz").pathname;
  return pathname.replace(/^\/api\/submissions-v2\/?/u, "").split("/").filter(Boolean).map(decodeURIComponent);
}

function queryWithoutRoute(req) {
  const query = { ...(req.query || {}) };
  delete query.route;
  return query;
}

function method(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  res.setHeader("allow", allowed.join(", "));
  res.status(405).json({ ok: false, error: "method_not_allowed" });
  return false;
}

async function parsedBody(req, limit = 1_000_000) {
  const raw = await readRawBody(req, limit);
  try { return { raw, body: raw ? JSON.parse(raw) : {} }; }
  catch { throw Object.assign(new Error("The request body is not valid JSON."), { code: "invalid_json", status: 400 }); }
}

function eventIdentity(body) {
  return String(body?.event_id || body?.id || "").trim();
}

async function sessionRoute(req, res) {
  if (!method(req, res, ["GET"])) return;
  const identity = requireHuman(req, res);
  if (!identity) return;
  const auth = sessionConfig();
  const config = serviceConfig();
  let durable;
  try { durable = await readRuntimeControls(); }
  catch { return res.status(503).json({ ok: false, error: "submissions_v2_controls_unavailable" }); }
  const controls = effectiveControls(config.controls, durable);
  if (!controls.ui) return res.status(503).json({ ok: false, error: "submissions_v2_ui_disabled" });
  return res.status(200).json({
    ok: true,
    authenticated: true,
    identity: { email: identity.email },
    csrf_token: csrfToken(identity),
    google_client_id: auth.googleClientId || null,
    controls,
    readiness: {
      database: config.databaseConfigured,
      blob: config.blobConfigured,
      worker: config.workerConfigured,
      master_inbox: config.inboxConfigured,
      classifier: config.openaiConfigured,
      strategist: config.anthropicConfigured,
    },
  });
}

async function intakeRoute(req, res) {
  if (!method(req, res, ["POST"])) return;
  const { raw, body } = await parsedBody(req);
  const machine = verifyInboxMachine(req, res, raw);
  if (!machine) return;
  if (!eventIdentity(body) || eventIdentity(body) !== machine.eventId) {
    return res.status(401).json({ ok: false, error: "machine_event_identity_mismatch" });
  }
  return res.status(202).json({ ok: true, ...(await createService().intakeMasterInbox(body)) });
}

export async function routeSubmissionsV2(req, res) {
  const route = routeSegments(req);
  const key = route.join("/");
  try {
    if (key === "session") return sessionRoute(req, res);
    if (key === "intake/master-inbox") return intakeRoute(req, res);
    if (key === "internal/blob-capability") {
      if (!method(req, res, ["POST"])) return;
      authorizeBlobBroker(req);
      const { body } = await parsedBody(req, 10_000);
      return res.status(200).json({ ok: true, ...(await issueWorkerBlobCapability(body)) });
    }
    if (key === "internal/sequence-inbox-batch") {
      if (!method(req, res, ["POST"])) return;
      authorizeBlobBroker(req);
      const { body } = await parsedBody(req, 10_000);
      res.setHeader("cache-control", "private, no-store, max-age=0");
      return res.status(200).json({ ok: true, result: await readSequenceInboxBrokerBatch(body) });
    }
    if (key === "internal/notification") {
      if (!method(req, res, ["POST"])) return;
      authorizeNotificationBroker(req);
      const { body } = await parsedBody(req, 10_000);
      const result = await postSafeNotification(body.text, { destinationId: body.destination_id });
      return res.status(200).json({ ok: true, receipt: result.receipt, channel: result.channel });
    }
    if (key === "tick") {
      if (!method(req, res, ["POST"]) || !requireCron(req, res)) return;
      return res.status(202).json({ ok: true, ...(await createService().tick()) });
    }

    const adminCase = key.match(/^admin\/cases\/([^/]+)\/(delete|restore)$/u);
    if (adminCase) {
      if (!method(req, res, ["POST"])) return;
      const identity = requireAdmin(req, res, { mutation: true });
      const idempotencyKey = identity && requireIdempotency(req, res);
      if (!identity || !idempotencyKey) return;
      const { body } = await parsedBody(req);
      const input = { actorEmail: identity.email, idempotencyKey, pairId: adminCase[1], body };
      const result = adminCase[2] === "delete"
        ? await createService().softDeleteCase(input)
        : await createService().restoreCase(input);
      return res.status(200).json({ ok: true, ...result });
    }

    if (key === "admin/controls") {
      if (!method(req, res, ["GET", "POST"])) return;
      const identity = requireAdmin(req, res, { mutation: req.method === "POST" });
      if (!identity) return;
      if (req.method === "GET") return res.status(200).json({ ok: true, ...(await createService().controls()) });
      const idempotencyKey = requireIdempotency(req, res);
      if (!idempotencyKey) return;
      const { body } = await parsedBody(req);
      return res.status(200).json({ ok: true, ...(await createService().setControls({ actorEmail: identity.email, idempotencyKey, body })) });
    }

    if (key === "archive") {
      if (!method(req, res, ["GET"])) return;
      const identity = requireAdmin(req, res);
      if (!identity) return;
      return res.status(200).json({ ok: true, ...(await createService().archive({ actorEmail: identity.email, input: queryWithoutRoute(req) })) });
    }

    if (key === "download") {
      if (!method(req, res, ["GET"])) return;
      const identity = requireHuman(req, res);
      if (!identity) return;
      const result = await createService().download({ actorEmail: identity.email, ticket: req.query?.ticket });
      res.setHeader("content-type", result.content_type);
      const disposition = req.query?.display === "inline" ? "inline" : "attachment";
      res.setHeader("content-disposition", `${disposition}; filename="${result.filename.replace(/["\\]/gu, "_")}"`);
      res.setHeader("content-length", String(result.bytes.length));
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("x-content-type-options", "nosniff");
      return res.status(200).end(result.bytes);
    }

    if (["list", "counts", "health"].includes(key)) {
      if (!method(req, res, ["GET"]) || !requireHuman(req, res)) return;
      const result = key === "list"
        ? await createService().list(queryWithoutRoute(req))
        : key === "counts" ? await createService().counts() : await createService().health();
      return res.status(200).json({ ok: true, ...result });
    }

    const search = key.match(/^search\/(candidates|roles)$/u);
    if (search) {
      if (!method(req, res, ["GET"]) || !requireHuman(req, res)) return;
      return res.status(200).json({ ok: true, ...(await createService().search(search[1], queryWithoutRoute(req))) });
    }

    const pairRoute = key.match(/^pairs\/([^/]+)(?:\/(jobs|resume\/download-ticket|submit-open))?$/u);
    if (pairRoute) {
      const pairId = pairRoute[1];
      const action = pairRoute[2] || "pair";
      if (["pair", "jobs"].includes(action)) {
        if (!method(req, res, ["GET"]) || !requireHuman(req, res)) return;
        const result = action === "pair"
          ? await createService().pair(pairId)
          : await createService().jobs({ ...queryWithoutRoute(req), pair_id: pairId });
        return res.status(200).json({ ok: true, ...result });
      }
      if (!method(req, res, ["POST"])) return;
      const identity = requireHuman(req, res, { mutation: true });
      const idempotencyKey = identity && requireIdempotency(req, res);
      if (!identity || !idempotencyKey) return;
      const { body } = await parsedBody(req);
      const result = action === "resume/download-ticket"
        ? await createService().issueDownload({ actorEmail: identity.email, idempotencyKey, pairId, body })
        : await createService().openSubmit({ actorEmail: identity.email, idempotencyKey, pairId, body });
      return res.status(200).json({ ok: true, ...result });
    }

    if (key === "command") {
      if (!method(req, res, ["POST"])) return;
      const identity = requireHuman(req, res, { mutation: true });
      const idempotencyKey = identity && requireIdempotency(req, res);
      if (!identity || !idempotencyKey) return;
      const { body } = await parsedBody(req);
      return res.status(200).json({ ok: true, ...(await createService().command({ actorEmail: identity.email, idempotencyKey, body })) });
    }

    return res.status(404).json({ ok: false, error: "not_found" });
  } catch (error) {
    return sendError(res, error);
  }
}

export const routerInternals = Object.freeze({ routeSegments, queryWithoutRoute, eventIdentity });
