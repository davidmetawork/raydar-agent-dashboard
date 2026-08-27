// Machine-owned source bridge for facts that live in the Raydar repo/runtime,
// not in the dashboard deployment: interview follow-up promises and the
// match-watch reply ladder. APPHUB_SYNC_KEY already authenticates the hourly
// interview runner; no browser session or Paraform write is involved.
import { timingSafeEqual } from "node:crypto";

import { readExternalSources, storeConfigured, writeExternalSources } from "./_lib/store.mjs";

export const config = { maxDuration: 30 };
export const MAX_SOURCE_BYTES = 1_500_000;

const text = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const id = (value) => {
  const result = text(value, 160);
  return /^[a-z0-9:_-]+$/i.test(result) ? result : "";
};

export function sourceBridgeAuthorized(req, env = process.env) {
  const secret = env.APPHUB_SYNC_KEY || "";
  const provided = String(req?.headers?.authorization || "");
  if (!secret || !provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(`Bearer ${secret}`);
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeInterview(row) {
  const candidateUserId = id(row?.candidateUserId);
  const roleId = id(row?.roleId);
  if (!candidateUserId || !roleId) return null;
  return {
    candidateUserId,
    candidateName: text(row?.candidateName, 120) || null,
    roleId,
    roleName: text(row?.roleName, 160) || null,
    companyName: text(row?.companyName, 160) || null,
    promisedAt: text(row?.promisedAt, 40) || null,
    callId: id(row?.callId) || null,
  };
}

function normalizeMatchWatch(row) {
  const candidateUserId = id(row?.candidateUserId);
  const roleIds = [...new Set((Array.isArray(row?.roleIds) ? row.roleIds : [])
    .map(id).filter(Boolean))].slice(0, 50);
  if (!candidateUserId || !roleIds.length) return null;
  return {
    candidateUserId,
    roleIds,
    repliedAt: text(row?.repliedAt, 40) || null,
    listSize: Math.max(roleIds.length, Number(row?.listSize) || 0),
  };
}

export function normalizeExternalSources(body = {}) {
  return {
    generatedAt: text(body.generatedAt, 40) || new Date().toISOString(),
    interviewFollowups: (Array.isArray(body.interviewFollowups) ? body.interviewFollowups : [])
      .map(normalizeInterview).filter(Boolean),
    matchWatch: (Array.isArray(body.matchWatch) ? body.matchWatch : [])
      .map(normalizeMatchWatch).filter(Boolean),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!sourceBridgeAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (req.method === "GET") {
    const source = await readExternalSources().catch(() => null);
    return res.status(200).json({
      ok: true,
      generatedAt: source?.generatedAt || null,
      counts: {
        interviewFollowups: source?.interviewFollowups?.length || 0,
        matchWatch: source?.matchWatch?.length || 0,
      },
    });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  if (Buffer.byteLength(raw) > MAX_SOURCE_BYTES) {
    return res.status(413).json({ ok: false, error: "source_payload_too_large" });
  }
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: "invalid_json" }); }
  }
  const source = await writeExternalSources(normalizeExternalSources(body));
  return res.status(200).json({
    ok: true,
    generatedAt: source.generatedAt,
    counts: {
      interviewFollowups: source.interviewFollowups.length,
      matchWatch: source.matchWatch.length,
    },
  });
}
