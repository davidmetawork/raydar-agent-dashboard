// Paraform sending-mailbox roster for the Health tab's email group.
//
// Paraform sends our sequence email from ~27 connected accounts (26
// cold-outreach aliases across ten raydar domains + david@raydar.xyz), and
// tracks a per-account gmail_status — some have already sat in ERROR while
// their sequences looked fine from our side. This endpoint is the ONLY thing
// that asks Paraform for that roster; the health tick pulls it like any other
// probe URL.
//
// Load discipline: one Paraform read per CACHE_FRESH_MS at most (the
// background-load-reduction concern is real). The KV cache key is owned by
// this endpoint alone, same single-writer pattern as beats and acks.
//
// Auth: HEALTH_BEAT_KEY bearer — the caller is the tick, not a browser, and
// the alias inventory should not be public (harvest bait).
import { timingSafeEqual } from "node:crypto";
import { hGet, hSet } from "./_lib/kv.mjs";
import { hasCookie, trpcGet } from "../seq/_lib/core.mjs";

const CACHE_KEY = "hlth:mailboxes:cache";
const CACHE_FRESH_MS = 25 * 60 * 1000;
const CACHE_TTL_SECONDS = 24 * 3600; // stale-but-present beats absent on a Paraform blip

function authed(req) {
  const secret = process.env.HEALTH_BEAT_KEY || "";
  if (!secret) return false;
  const provided = req.headers?.authorization || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function summarize(accounts, fetchedAt) {
  const gmailActive = accounts.filter((a) => a.gmailStatus === "ACTIVE").length;
  const gmailErrorRows = accounts.filter((a) => a.gmailStatus === "ERROR");
  const david = accounts.find((a) => a.email === "david@raydar.xyz");
  const errorDomains = [...new Set(
    gmailErrorRows.map((a) => String(a.email.split("@")[1] || "")).filter(Boolean),
  )];
  const ageMs = Date.now() - Date.parse(fetchedAt);
  return {
    ok: true,
    paraform: "live",
    fetchedAt,
    cacheAgeMin: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 60000)) : null,
    counts: {
      total: accounts.length,
      gmailActive,
      gmailError: gmailErrorRows.length,
      other: accounts.length - gmailActive - gmailErrorRows.length,
    },
    davidGmailStatus: david ? david.gmailStatus : "MISSING",
    errorDomains,
    // Full rows for the humans debugging a red tile; the evaluator only
    // lifts the counts. These are our own alias inboxes, not candidate data.
    mailboxes: accounts,
  };
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method" });
  if (!authed(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const cached = await hGet(CACHE_KEY);
  const cachedFresh = cached?.fetchedAt
    && Date.now() - Date.parse(cached.fetchedAt) < CACHE_FRESH_MS
    && Array.isArray(cached.accounts);
  if (cachedFresh) {
    return res.status(200).json(summarize(cached.accounts, cached.fetchedAt));
  }

  if (!hasCookie()) {
    return res.status(200).json({ ok: false, paraform: "no_cookie", error: "no Paraform session configured" });
  }

  let rows;
  try {
    rows = (await trpcGet("gmail.getActiveUserGmailAccounts", {})) || [];
  } catch (error) {
    // A dead cookie or throttle must not fabricate a roster verdict. Serve
    // the stale cache when one exists (age is visible to the evaluator);
    // otherwise say plainly that Paraform is unreadable.
    if (cached?.accounts) {
      return res.status(200).json(summarize(cached.accounts, cached.fetchedAt));
    }
    const code = String(error?.code || error?.message || "unavailable").slice(0, 120);
    return res.status(200).json({ ok: false, paraform: "unavailable", error: code });
  }

  const accounts = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      email: String(row?.email || "").trim().toLowerCase(),
      gmailStatus: String(row?.gmail_status || row?.gmailStatus || "UNKNOWN").toUpperCase(),
      outlookStatus: String(row?.outlook_status || row?.outlookStatus || "").toUpperCase() || null,
    }))
    .filter((row) => row.email);

  const fetchedAt = new Date().toISOString();
  try {
    await hSet(CACHE_KEY, { fetchedAt, accounts }, CACHE_TTL_SECONDS);
  } catch {
    // Cache write failure only costs the next caller a fresh read.
  }
  return res.status(200).json(summarize(accounts, fetchedAt));
}
