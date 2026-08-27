// ON-DEMAND REFRESH — the Refresh button's other half.
//
// The tab renders a snapshot the DESKTOP publishes; nothing here can compute
// one. Before this endpoint existed, Refresh re-read that cached snapshot and
// nothing else, so the honest ceiling on the button was "whatever the desktop
// last pushed" — up to ten minutes stale, and stuck for hours whenever the
// number the viewer cared about only moves when the hourly plan re-runs. The
// button looked broken because it was doing something no one wanted.
//
// So the button now asks. The browser leaves a request here; the desktop's
// refresh listener (ops/interviews/refresh-listener.sh in the Raydar repo)
// polls this endpoint, and when it sees a request newer than the last one it
// served it re-runs the plan and republishes. The page watches the snapshot's
// generatedAt advance past the moment of the click and calls that success.
//
// A REQUEST, NOT A COMMAND, AND DELIBERATELY SO. There is no channel from
// Vercel to David's Mac — the desktop is behind NAT and asleep half the day.
// Everything here is therefore a durable note, not an RPC: nothing blocks,
// nothing is delivered, and a request nobody ever collects simply expires.
// The page's timeout is what turns silence into an honest message.
//
// WRITE OWNERSHIP: apphub:refresh is written ONLY here (both methods live in
// this one handler, so the key keeps its single writer). The desktop never
// writes it — it reads, decides, and keeps its own watermark on disk. That
// asymmetry is what makes the whole path idempotent: a listener that crashes
// mid-refresh re-reads the same request and redoes the same work.
//
//   POST  — the browser, Google-session auth. Leaves/refreshes the request.
//   GET   — the desktop listener, APPHUB_SYNC_KEY shared secret (same scheme
//           as sync.mjs; the caller is a launchd loop, not a browser).
//
// Two auth schemes in one file is unusual and load-bearing: the pair of
// methods IS the channel, and splitting them across two endpoints would split
// the key's ownership with it.

import { timingSafeEqual } from "node:crypto";
import { cors, requireAuth } from "./_lib/core.mjs";
import { getJson, K, kvConfigured, setJson } from "./_lib/kv.mjs";

export const config = { maxDuration: 15 };

// A pending request is worth serving for an hour and no longer. The listener's
// own watermark already stops it re-serving one it handled, so this TTL is
// about a DIFFERENT case: the Mac asleep at midnight should not wake up to a
// queued refresh from yesterday afternoon and burn a Paraform walk on it.
export const REQUEST_TTL_SECONDS = 3600;

// Re-clicking inside this window rides the request already in flight instead
// of writing a new one. A refresh takes ~40-90s end to end, so a second click
// at t+5s cannot make anything happen sooner — it would only push the
// listener's target forward and make the page wait for a LATER publish than
// the one already on its way.
export const COOLDOWN_MS = 20_000;

// THE CLOUD DISPATCH — inert until David adds GH_DISPATCH_TOKEN (2026-08-27).
//
// The desktop listener is the button's normal collector, and while the lane
// is PAUSED it already forwards a click to GitHub as a publish_only run of
// interview-invites.yml. But the listener only runs while the Mac is awake.
// This is the same forward taken from HERE, so a click works from a phone at
// midnight: fire a workflow_dispatch straight at the repo. publish_only=true
// gates every send/write step in that workflow — a Refresh stays a refresh.
//
// INERT BY DEFAULT, deliberately: without the token env this function does
// nothing and the endpoint behaves exactly as before. The token wants to be
// a fine-grained PAT with actions:write on davidmetawork/raydar only.
// Best-effort by contract — a GitHub hiccup must not fail the click, whose
// durable half (the KV note) is already written.
async function dispatchCloudRefresh() {
  const token = process.env.GH_DISPATCH_TOKEN || "";
  if (!token) return false;
  try {
    const r = await fetch(
      "https://api.github.com/repos/davidmetawork/raydar/actions/workflows/interview-invites.yml/dispatches",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "raydar-apphub-refresh",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs: { publish_only: "true" } }),
        signal: AbortSignal.timeout(4000),
      },
    );
    return r.status === 204;
  } catch {
    return false;
  }
}

function machineAuthed(req) {
  const secret = process.env.APPHUB_SYNC_KEY || "";
  if (!secret) return false;
  const a = Buffer.from(req.headers?.authorization || "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createRefreshHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  machineAuth = machineAuthed,
  kvReady = kvConfigured,
  readJson = getJson,
  writeJson = setJson,
  dispatchCloud = dispatchCloudRefresh,
  now = () => Date.now(),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "no-store");

    // ---- desktop listener ----
    if (req.method === "GET") {
      if (!machineAuth(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
      if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
      try {
        const request = await readJson(K.refresh);
        return res.status(200).json({ ok: true, request: request || null });
      } catch (error) {
        return res.status(502).json({
          ok: false,
          error: "refresh_unavailable",
          detail: String(error?.message || error).slice(0, 180),
        });
      }
    }

    // ---- the browser's Refresh button ----
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "GET or POST only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

    try {
      const at = now();
      const existing = await readJson(K.refresh);
      const priorMs = Date.parse(existing?.requestedAt || "");
      if (Number.isFinite(priorMs) && at - priorMs < COOLDOWN_MS) {
        // Not an error and not a rejection — the caller gets the in-flight
        // request's timestamp so its "has the snapshot passed this yet?" poll
        // targets the publish already coming rather than a new one.
        return res.status(200).json({
          ok: true,
          requestedAt: existing.requestedAt,
          deduped: true,
        });
      }
      const request = { requestedAt: new Date(at).toISOString(), by: req.authedEmail || "" };
      await writeJson(K.refresh, request, REQUEST_TTL_SECONDS);
      // After the durable note, not instead of it: the note is what the
      // desktop listener collects and what the page's watch verifies against;
      // the dispatch is the fast path when the token exists. The cooldown
      // above is also the dispatch's rate limit — a deduped click never
      // reaches this line.
      const dispatched = await dispatchCloud();
      return res.status(200).json({ ok: true, ...request, deduped: false, dispatched });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "refresh_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createRefreshHandler();
