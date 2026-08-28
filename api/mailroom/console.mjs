import { cors } from "../seq/_lib/core.mjs";
import { requireOperator } from "../_lib/operator-access.mjs";

const TIMEOUT_MS = 12_000;
const TEMPLATE_ACTIONS = new Set(["save", "preview", "activate", "revert"]);
const CONTROL_ACTIONS = new Set(["retry", "cancel", "clear-brake"]);

function config() {
  return {
    base: String(process.env.MAILROOM_BASE || "https://raydar-mailroom.vercel.app").replace(/\/$/, ""),
    key: process.env.MAILROOM_API_KEY || "",
  };
}

function parseBody(req) {
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return req.body && typeof req.body === "object" ? req.body : {};
}

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

async function upstream(path, init = {}) {
  const { base, key } = config();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, accept: "application/json", "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function actorPayload(access) {
  return { email: access.email, role: access.role, capabilities: access.capabilities };
}

function answer(res, result, access) {
  return res.status(result.response.status).json({ ok: result.response.ok && result.body.ok !== false, configured: true, ...result.body, actor: actorPayload(access) });
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("cache-control", "no-store");
  // Preview is a read-only render even though the upstream contract uses POST;
  // every state-changing Mailroom action is gated again below.
  const access = await requireOperator(req, res, "mailroomRead");
  if (!access) return;
  if (!config().key) return res.status(503).json({ ok: false, configured: false, error: "mailroom_not_configured" });

  try {
    if (req.method === "GET") {
      const view = clean(req.query?.view || "overview", 40);
      if (view === "overview") {
        const [lanes, policy, stats, feed] = await Promise.all([
          upstream("/api/lanes"), upstream("/api/policy"), upstream("/api/stats"), upstream("/api/feed?limit=100"),
        ]);
        const failed = [lanes, policy, stats, feed].find((item) => !item.response.ok || item.body.ok === false);
        if (failed) return answer(res, failed, access);
        return res.status(200).json({ ok: true, configured: true, lanes: lanes.body.lanes || [], senders: lanes.body.senders || [], audit: lanes.body.audit || [], capabilities: lanes.body.capabilities || {}, dispatchPolicy: policy.body.dispatchPolicy || policy.body.policy || lanes.body.dispatchPolicy || null, stats: stats.body, rows: feed.body.rows || [], actor: actorPayload(access) });
      }
      if (view === "lanes") return answer(res, await upstream("/api/lanes"), access);
      if (view === "policy") return answer(res, await upstream("/api/policy"), access);
      if (view === "stats") return answer(res, await upstream("/api/stats"), access);
      if (view === "templates") {
        const lane = clean(req.query?.lane, 160);
        if (!lane) return res.status(400).json({ ok: false, error: "lane_required" });
        return answer(res, await upstream(`/api/templates?lane=${encodeURIComponent(lane)}`), access);
      }
      if (view === "message") {
        const id = Number(req.query?.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "message_id_required" });
        return answer(res, await upstream(`/api/message?id=${id}`), access);
      }
      if (view === "feed") {
        const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(200, Number(req.query?.limit) || 100))) });
        const lane = clean(req.query?.lane, 160);
        const state = clean(req.query?.state, 80);
        if (lane) query.set("lane", lane);
        if (state) query.set("state", state);
        return answer(res, await upstream(`/api/feed?${query}`), access);
      }
      return res.status(400).json({ ok: false, error: "mailroom_view_not_allowed" });
    }

    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
    const payload = parseBody(req);
    const action = clean(payload.action, 64);
    const lane = clean(payload.lane, 160);
    const actor = access.email;
    if (action !== "preview" && !access.capabilities.mailroomWrite) {
      return res.status(403).json({ ok: false, error: "operator_role_forbidden", role: access.role });
    }

    if (action === "update_lane") {
      if (!lane) return res.status(400).json({ ok: false, error: "lane_required" });
      const expectedRevision = Number(payload.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return res.status(400).json({ ok: false, error: "lane_revision_required" });
      const body = { schemaVersion: 2, lane, actor, expectedRevision };
      if (typeof payload.enabled === "boolean") body.enabled = payload.enabled;
      if (payload.sender != null) body.sender = clean(payload.sender, 160);
      return answer(res, await upstream("/api/lane", { method: "POST", body: JSON.stringify(body) }), access);
    }

    if (TEMPLATE_ACTIONS.has(action)) {
      if (!lane) return res.status(400).json({ ok: false, error: "lane_required" });
      const expectedLaneRevision = Number(payload.expectedLaneRevision);
      if (!Number.isInteger(expectedLaneRevision) || expectedLaneRevision < 0) return res.status(400).json({ ok: false, error: "lane_revision_required" });
      const body = { schemaVersion: 2, action, lane, actor, expectedLaneRevision };
      if (action === "save") {
        body.subject = String(payload.subject || "").slice(0, 998);
        body.bodyText = String(payload.bodyText || "").slice(0, 100_000);
        body.note = clean(payload.note, 1_000);
      } else if (action === "preview") {
        body.vars = payload.vars && typeof payload.vars === "object" && !Array.isArray(payload.vars) ? payload.vars : {};
        body.threadMode = payload.threadMode === "reply" ? "reply" : "new";
        if (payload.version != null) body.version = Number(payload.version);
        if (payload.subject != null) body.subject = String(payload.subject).slice(0, 998);
        if (payload.bodyText != null) body.bodyText = String(payload.bodyText).slice(0, 100_000);
      } else if (action === "activate") {
        body.version = Number(payload.version);
      } else if (action === "revert") {
        body.version = Number(payload.version);
      }
      return answer(res, await upstream("/api/template", { method: "POST", body: JSON.stringify(body) }), access);
    }

    if (CONTROL_ACTIONS.has(action)) {
      const body = { schemaVersion: 2, action, actor };
      if (action === "clear-brake") {
        body.mailbox = clean(payload.mailbox, 320);
        body.transport = clean(payload.transport || "gmail", 40);
      } else {
        body.id = Number(payload.id);
      }
      return answer(res, await upstream("/api/control", { method: "POST", body: JSON.stringify(body) }), access);
    }
    return res.status(400).json({ ok: false, error: "mailroom_action_not_allowed" });
  } catch (error) {
    return res.status(502).json({ ok: false, configured: true, error: "mailroom_proxy_failed", detail: String(error?.message || error).slice(0, 180) });
  }
}
