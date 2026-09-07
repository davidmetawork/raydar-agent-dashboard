// Read-only "Calls Today" feed for monitor.raydar.xyz.
//
// This reuses review.mjs's exported `config`/`upstream` helpers rather than
// duplicating the signed-fetch logic (the same reuse Status v2 already does
// for ?metrics/?funnel — see api/status-v2/state.mjs). No new operator
// capability is introduced: any authenticated dashboard viewer already gets
// `reviewRead` from reviewAccess(), and this route is display-only (GET-only,
// no actions, no writes).
//
// UPSTREAM CONTRACT: GET {POST_CALL_BASE}/api/v1/monitor-calls (see
// post-call/api/v1/monitor-calls.mjs in the post-call service repo — the
// canonical path; docs/RAYDAR-CONTEXT-MAP.md's post-call entry should point
// here, not at any other name) accepting `from`, `to` (ISO timestamps),
// `limit` (1-2000), bearer POST_CALL_MONITOR_API_KEY exactly (requireMonitorActor
// in post-call/lib/admin.mjs does a strict safeEqual against that one key —
// it does NOT accept the review-feed key as a fallback, unlike review.mjs's
// own upstream). Expected 200 body:
//   { ok:true, calls: [{ callId, obligationId, meetingId, callMode,
//       callPurpose, roleTitle, company, scheduledStartAt, startedAt,
//       endedAt, normalizedOutcome, candidate:{displayName,linkedinUrl},
//       ranBy, outcome:{bucket,label,detail}, reviewId, paraformCallUrl }],
//       nextCursor?, generatedAt? }
// A 404/501 (route not deployed yet) is treated as "not_published", not an
// error, exactly like review.mjs's existing ?funnel branch — so the page can
// render a calm "not available yet" state instead of failing outright.
//
// Defense in depth: even though the upstream is our own service, every call
// row is re-whitelisted to a small set of display fields before it leaves
// this proxy, so an upstream response carrying more than expected (a resume
// pointer, a raw evidence blob, a cookie-bearing URL) never reaches the
// browser through this route.

import { cors } from "../seq/_lib/core.mjs";
import { requireReviewOperator, requireSameOrigin } from "../_lib/operator-access.mjs";
import { upstream, config } from "./review.mjs";

const READ_TIMEOUT_MS = 12_000;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

function safeString(value, max = 400) {
  return String(value ?? "").trim().slice(0, max);
}

function safeIsoOrEmpty(value) {
  const text = safeString(value, 64);
  if (!text) return "";
  return Number.isNaN(Date.parse(text)) ? "" : text;
}

function safeText(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

// Only these result tones are ever rendered with color; anything else falls
// back to neutral so an unexpected upstream value can't be used to spoof a
// "delivered" look.
const RESULT_TONES = new Set(["good", "warn", "bad", "muted"]);

// classifyCallOutcome's bucket (post-call/lib/monitor-calls-presentation.mjs)
// -> this page's pill tone.
const BUCKET_TONES = {
  sent: "good",
  in_review: "warn",
  no_show: "bad",
  no_send: "warn",
  still_working: "muted",
  other: "muted",
};

// Terminal reasons are internal enums (post-call/lib/workflow.mjs writes
// `call_${normalizedOutcome}`, the Review board writes review_abandoned).
// The board says them in plain words; an unknown one is humanized, never
// shown raw.
const REASON_WORDS = {
  call_no_show: "Candidate did not join",
  call_cancelled_or_rescheduled: "Call was cancelled or rescheduled",
  call_failed: "The call failed",
  call_incomplete: "The call did not complete",
  call_ambiguous: "Call outcome unclear",
  review_abandoned: "Stopped from the Review board",
  abandoned: "Stopped from the Review board",
};
function reasonSentence(reason) {
  const key = safeText(reason, 120);
  if (!key) return null;
  if (REASON_WORDS[key]) return REASON_WORDS[key];
  const words = key.replace(/^call_/, "").replace(/[_:]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

// outcome.detail is an object shaped differently per bucket (rolesInEmail/
// routeKey for sent, why/nextStep/category/priority for in_review, step for
// still_working, reason for no_show/other) — never a plain string. Flatten
// it into one display sentence so it never renders as "[object Object]".
function detailSentenceFor(bucket, detail) {
  if (!detail || typeof detail !== "object") return null;
  if (bucket === "sent") {
    const count = Number.isFinite(detail.rolesInEmail) ? detail.rolesInEmail : null;
    return count != null ? `${count} role${count === 1 ? "" : "s"} in email` : null;
  }
  if (bucket === "in_review") {
    return safeText(detail.why, 300);
  }
  if (bucket === "still_working") {
    return safeText(detail.step, 120);
  }
  return reasonSentence(detail.reason);
}

function sanitizeResult(outcome) {
  if (!outcome || typeof outcome !== "object") return null;
  const label = safeText(outcome.label, 120);
  if (!label) return null;
  const bucket = String(outcome.bucket || "").toLowerCase();
  const tone = RESULT_TONES.has(BUCKET_TONES[bucket]) ? BUCKET_TONES[bucket] : "muted";
  return {
    label,
    detail: detailSentenceFor(bucket, outcome.detail),
    tone,
  };
}

// The full field whitelist for a single call row, mapped from the real
// presentCallRow() shape (post-call/lib/monitor-calls-presentation.mjs).
// Anything else the upstream might include (raw evidence, resume URLs,
// cookies, free-form transcripts) is dropped here before it ever reaches
// the browser.
function sanitizeCall(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = safeText(raw.callId, 160);
  if (!id) return null;
  const candidate = raw.candidate && typeof raw.candidate === "object" ? raw.candidate : {};
  return {
    id,
    meetingId: safeText(raw.meetingId, 160),
    reviewId: safeText(raw.reviewId, 160),
    candidateName: safeText(candidate.displayName, 200),
    callTimeIso: safeIsoOrEmpty(raw.endedAt) || safeIsoOrEmpty(raw.startedAt) || safeIsoOrEmpty(raw.scheduledStartAt) || null,
    callMode: safeText(raw.callMode, 40),
    callPurpose: safeText(raw.callPurpose, 40),
    assignedRecruiter: safeText(raw.ranBy, 160),
    result: sanitizeResult(raw.outcome),
  };
}

function withActor(body, access) {
  return { ...body, actor: { email: access.email, role: access.role, capabilities: access.capabilities } };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  // Every method this route serves is a read (GET/HEAD/OPTIONS), so this is a
  // no-op today; kept for parity with review.mjs and so a future mutating verb
  // here fails closed by default instead of by omission.
  if (!requireSameOrigin(req, res)) return;
  res.setHeader("cache-control", "no-store");

  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  const access = await requireReviewOperator(req, res, "reviewRead");
  if (!access) return;

  const { base, error: configError } = config();
  // This route calls post-call's monitor-scoped route (requireMonitorActor),
  // which does a strict check against POST_CALL_MONITOR_API_KEY only — it
  // does not accept the review-feed key as a fallback the way review.mjs's
  // own upstream does. Read it directly rather than trusting config()'s
  // feedKey (POST_CALL_REVIEW_FEED_API_KEY || POST_CALL_MONITOR_API_KEY) to
  // happen to coincide.
  const monitorKey = process.env.POST_CALL_MONITOR_API_KEY || "";
  if (!base || !monitorKey) {
    return res.status(503).json({ ok: false, configured: false, error: "post_call_monitor_not_configured", detail: configError || undefined });
  }

  try {
    const from = safeIsoOrEmpty(req.query?.from);
    const to = safeIsoOrEmpty(req.query?.to);
    const cursor = safeString(req.query?.cursor, 400);
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number(req.query?.limit) || DEFAULT_LIMIT));
    const query = new URLSearchParams({ limit: String(limit) });
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (cursor) query.set("cursor", cursor);

    const path = `/api/v1/monitor-calls?${query}`;
    const { response, body } = await upstream(path, access, {}, {}, { serviceKey: monitorKey, timeoutMs: READ_TIMEOUT_MS });

    // Mirrors review.mjs's ?funnel handling: the route may not exist upstream
    // yet, and that reads as "no publisher yet", not an error.
    if (response.status === 404 || response.status === 501) {
      return res.status(200).json(withActor({ ok: false, configured: true, reason: "not_published", calls: [] }, access));
    }
    if (response.status === 401 || response.status === 403) {
      return res.status(502).json(withActor({
        ok: false,
        configured: true,
        error: "post_call_service_authorization_failed",
        detail: "The Calls feed could not authorize this request.",
      }, access));
    }
    if (!response.ok || body?.ok === false) {
      return res.status(response.status || 502).json(withActor({
        ok: false,
        configured: true,
        error: "post_call_calls_summary_failed",
        detail: "The Calls feed returned an error.",
      }, access));
    }

    const rawCalls = Array.isArray(body?.calls) ? body.calls : [];
    const calls = rawCalls.map(sanitizeCall).filter(Boolean).slice(0, MAX_LIMIT);
    // A non-empty upstream response where every row sanitizes away means the
    // upstream shape changed out from under this mapping (or is not the
    // shape we expect at all) — that must fail loudly, not render as a calm
    // "no calls yet" that quietly lies to a non-technical reader.
    if (rawCalls.length > 0 && calls.length === 0) {
      return res.status(502).json(withActor({
        ok: false,
        configured: true,
        error: "post_call_calls_summary_unrecognized_shape",
        detail: "The Calls feed returned rows this dashboard doesn't recognize.",
      }, access));
    }
    const generatedAt = safeIsoOrEmpty(body?.generatedAt) || new Date().toISOString();
    const nextCursor = safeText(body?.nextCursor, 400);
    return res.status(200).json(withActor({ ok: true, configured: true, calls, generatedAt, nextCursor }, access));
  } catch (error) {
    // Never echo the raw error message: it could carry a URL, a stack frame,
    // or (if the upstream ever misbehaves) a fragment of a request body.
    return res.status(502).json({ ok: false, configured: true, error: "post_call_calls_summary_proxy_failed" });
  }
}
