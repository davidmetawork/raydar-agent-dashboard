// GET /api/activity/feed — both queues, cache-first with a build lock
// (pattern: api/inbox/feed.mjs), triage overlay applied AFTER the (possibly
// slow) build so mid-build clicks are never clobbered by stale state.

import { cors, requireAuth, cronAuth } from "../seq/_lib/core.mjs";
import { getJson, setJson, hgetallJson, acquireLock, releaseLock } from "./_lib/kv.mjs";
import { buildFeed, FEED_KEY, FEED_TTL_SECONDS, FEED_LOCK_KEY } from "./_lib/feed.mjs";
import { hasCookie, sessionState, transportStats } from "./_lib/paraform.mjs";

export const TRIAGE_KEY = "activity:v1:triage";

export function applyTriage(feed, triage) {
  const now = Date.now();
  const overlay = (row) => {
    const t = triage[row.key];
    if (!t) return { ...row, triage: null };
    // A NEW inbound after a done/dismiss re-surfaces the row: triage is
    // per-ask (keyed to the inbound item id at click time), never a mute.
    if (row.inbound?.id && t.inboundId && t.inboundId !== row.inbound.id) return { ...row, triage: null };
    if (t.status === "snoozed" && t.until && Date.parse(t.until) < now) return { ...row, triage: null };
    return { ...row, triage: { status: t.status, until: t.until || null, by: t.by || null, at: t.at || null } };
  };
  const needs = feed.queues.needs_reply.map(overlay);
  const quiet = feed.queues.gone_quiet.map(overlay);
  const open = (rows) => rows.filter((r) => !r.triage).length;
  return {
    ...feed,
    queues: { needs_reply: needs, gone_quiet: quiet },
    counts: { ...feed.counts, open_needs_reply: open(needs), open_gone_quiet: open(quiet) },
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  const isCron = cronAuth(req).ok;
  if (!isCron && !(await requireAuth(req, res))) return;
  if (!hasCookie()) { res.status(200).json({ ok: false, degraded: "no_cookie" }); return; }

  const force = String(req.query?.refresh || "") === "1";
  try {
    if (!force) {
      const cached = await getJson(FEED_KEY);
      if (cached) {
        const triage = await hgetallJson(TRIAGE_KEY).catch(() => ({}));
        res.status(200).json({ ok: true, cached: true, ...applyTriage(cached, triage) });
        return;
      }
    }

    if (!(await acquireLock(FEED_LOCK_KEY, 110))) {
      res.setHeader("Retry-After", "4");
      res.status(503).json({ ok: false, error: "feed_refresh_in_progress" });
      return;
    }
    let feed;
    try {
      feed = await buildFeed();
      // Cache only when the read pass was materially complete — a feed with
      // large unreadable counts must not become the truth for two minutes.
      if (feed.counts.unreadable <= Math.max(3, Math.floor(feed.pairsScanned * 0.1))) {
        await setJson(FEED_KEY, feed, { ttlSeconds: FEED_TTL_SECONDS });
      }
    } finally {
      await releaseLock(FEED_LOCK_KEY);
    }
    const triage = await hgetallJson(TRIAGE_KEY).catch(() => ({}));
    res.status(200).json({ ok: true, cached: false, ...applyTriage(feed, triage) });
  } catch (e) {
    const auth = e?.name === "AuthExpired" || /AUTH_EXPIRED/.test(String(e?.message));
    const state = auth ? await sessionState().catch(() => "error") : null;
    res.status(200).json({
      ok: false,
      degraded: auth ? (state === "live" ? "paraform_burst" : "paraform_auth") : "error",
      error: String(e?.message || e).slice(0, 200),
      transport: transportStats(),
    });
  }
}
