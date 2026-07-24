const SOFT_REVIEW_CODES = new Set([
  "human_intro_without_transcript",
  "human_intro_preferences_confirmed_manually",
]);
const REQUIRED_ROUTING_FIELDS = [
  "locations",
  "workplaceTypes",
  "idealFundingRounds",
  "salaryMin",
  "requiresSponsorship",
];
const POST_CALL_GRACE_MS = 60 * 60_000;

export function normalizeReviewReason(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const message = value.replace(/\s+/g, " ").trim().slice(0, 300);
    const code = message.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 100);
    return message ? {
      code,
      message,
      soft: SOFT_REVIEW_CODES.has(code),
    } : null;
  }
  if (typeof value !== "object") return null;
  const code = String(value.code || value.reason || "review_required")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    .slice(0, 100);
  const message = String(value.message || value.detail || value.reason || code)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  if (!message) return null;
  return {
    code,
    message,
    soft: value.soft === true || SOFT_REVIEW_CODES.has(code),
  };
}

export function jobReviewReasons(job) {
  const structured = Array.isArray(job?.reviewReasons)
    ? job.reviewReasons.filter(Boolean)
    : [];
  const values = structured.length
    ? structured
    : [
        job?.reviewReason,
        ...(Array.isArray(job?.automation?.reasons) ? job.automation.reasons : []),
      ];
  const rows = values.map(normalizeReviewReason).filter(Boolean);
  const unique = new Map();
  for (const row of rows) unique.set(row.code, row);
  return [...unique.values()];
}

export function reviewActionFor(job, reasons = jobReviewReasons(job)) {
  const endedAt = Date.parse(String(job?.callEndedAt || ""));
  const routing = job?.reviewPolicy?.preferenceRouting;
  const routingComplete = Boolean(
    routing &&
    REQUIRED_ROUTING_FIELDS.every((field) => (
      routing[field] &&
      Object.hasOwn(routing[field], "stated") &&
      Object.hasOwn(routing[field], "routed") &&
      String(routing[field].rule || "").trim()
    )),
  );
  const graceComplete = Number.isFinite(endedAt) && Date.now() >= endedAt + POST_CALL_GRACE_MS;
  const allowed = Boolean(
    job?.state === "needs_review" &&
    reasons.length &&
    reasons.every((reason) => reason.soft === true) &&
    routingComplete &&
    graceComplete,
  );
  return {
    allowed,
    reasons: reasons.map((reason) => reason.code),
  };
}
