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
      return res.status(200).json({ ok: true, ...request, deduped: false });
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
