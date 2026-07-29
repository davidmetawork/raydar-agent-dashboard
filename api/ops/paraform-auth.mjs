// Paraform auth circuit — public flag reads (phase 1, observe-only).
//
// CONSUMER CONTRACT (binding, from the approved spec plus its verifier
// correction — future lane rollouts hold on this, one lane at a time, each
// behind its own gate; nothing consumes it yet):
// - Hold semantics apply ONLY while `down` is true, i.e. only on Paraform's
//   own confirmed 401s.
// - When this endpoint is unreachable, times out, or returns ok:false, a
//   lane MUST fail OPEN to its normal per-lane behavior. Failing closed on a
//   dashboard blip would halt local BRS/chase lanes on an unrelated outage.
//   This handler enforces its half of that contract by never answering with
//   a 5xx a naive consumer might mistake for "hold".
// - A consumer MUST treat down:true with lastProbe absent or older than 6
//   hours as unknown and fail open — a stalled probe must never strand a
//   stale flag into an indefinite hold.
//
// Public read by design: the response carries flag state only — no cookie
// material, no secrets, probe reasons mapped to a closed enum (never raw
// internal error strings). `alert` is the secrets-free delivery summary
// ({openedAt, delivered}): Para AI production has no Slack token, so the
// flag + this endpoint ARE the alert channel and delivery must be visible
// here, not assumed. The `auth:paraform:*` keys it reads are written solely
// by the probe on the */5 worker tick.
import {
  AUTH_FLAG_KEY,
  AUTH_LAST_PROBE_KEY,
  paraformAuthState,
  slackAlertingConfigured,
} from "../paraai/_lib/auth-probe.mjs";
import { kv, storeConfigured } from "../paraai/_lib/store.mjs";

export const config = { maxDuration: 15 };

const parse = (raw) => {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

export default async function handler(req, res, { kvImpl = kv } = {}) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "GET_only" });
  }
  if (!storeConfigured()) {
    // Fail open: without the store there is no flag to hold on.
    return res.status(200).json({
      ok: false,
      error: "state_store_not_configured",
      down: false,
      since: null,
      lastProbe: null,
      alert: null,
    });
  }
  try {
    const [flagRaw, lastProbeRaw] = await Promise.all([
      kvImpl(["GET", AUTH_FLAG_KEY]),
      kvImpl(["GET", AUTH_LAST_PROBE_KEY]),
    ]);
    const state = paraformAuthState({
      flag: parse(flagRaw),
      lastProbe: parse(lastProbeRaw),
    });
    return res.status(200).json({
      ok: true,
      ...state,
      // Surfaced because Para AI production has no Slack token today: when
      // false, the durable flag + this endpoint ARE the alert channel.
      alerting: { slackConfigured: slackAlertingConfigured() },
    });
  } catch {
    // Same fail-open shape on a store blip.
    return res.status(200).json({
      ok: false,
      error: "state_store_unreachable",
      down: false,
      since: null,
      lastProbe: null,
      alert: null,
    });
  }
}
