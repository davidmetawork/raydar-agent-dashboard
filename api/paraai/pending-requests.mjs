// GET /api/paraai/pending-requests
//
// The ParaAI interview requests still pending, from the copy the outreach tick
// saves after its own Paraform read (_lib/pending-snapshot.mjs). This route
// never calls Paraform and needs no Paraform session: it reads one stored copy.
// Built 2026-11-19 for the CRM Call List (app.raydar.xyz/call-list).
//
// AUTH. `Authorization: Bearer <PARAAI_PENDING_READ_KEY>`, a secret used for
// this read alone, held by this project and by the reader (the CRM holds the
// same value as CRM_CALL_LIST_PARAAI_READ_KEY). It opens nothing else here, and
// no other key opens this route. With the env unset the route answers 503: it
// is shut until David sets the secret.
//
// 200 -> {
//   ok: true,
//   as_of,            ISO time of the tick read David's own requests came from;
//                     null when there is no copy (the list is then NOT "nobody
//                     is pending": the reader must show nothing and say so)
//   teammates_as_of,  the same for the named teammates' requests, or null
//   expiry_days,      Paraform's expiry window (7)
//   count,
//   requests: [{
//     request_id,         Paraform's id of the request
//     candidate_name,
//     candidate_user_id,  Paraform's candidate user id (the CRM's identity key
//                         paraform_candidate_user_id), or null
//     role_id, role_title, company_name,
//     created_at,         ISO
//     expires_at,         ISO, created_at + expiry_days: a forecast, not proof
//     recruiter,          "david" or the teammate's key
//     reached_out,        Paraform's own reached-out mark at the last read
//   }]                    soonest to expire first; forecast-expired rows left out
// }
// 401 unauthorized | 405 GET_only | 503 pending_read_not_configured
import { timingSafeEqual } from "node:crypto";

import { readPendingSnapshot } from "./_lib/pending-snapshot.mjs";

export const config = { maxDuration: 15 };

export const PENDING_READ_KEY_VAR = "PARAAI_PENDING_READ_KEY";

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function createPendingRequestsHandler({
  env = process.env,
  readImpl = readPendingSnapshot,
  clock = Date.now,
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET_only" });
    const key = String(env[PENDING_READ_KEY_VAR] || "").trim();
    // A short secret is a misconfiguration, not a lock.
    if (key.length < 24) return res.status(503).json({ ok: false, error: "pending_read_not_configured" });
    const header = String(req.headers?.authorization || "");
    const bearer = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
    if (!equalSecret(bearer, key)) return res.status(401).json({ ok: false, error: "unauthorized" });
    return res.status(200).json({ ok: true, ...(await readImpl({ now: clock() })) });
  };
}

export default createPendingRequestsHandler();
