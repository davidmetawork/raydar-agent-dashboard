// Machine channel between the desktop interview loop and the Applicants tab.
//
// POST: the loop publishes the stream/queue snapshot, reports send outcomes
// (acks), and prewarms complete applicant profile JSONs (profiles → the
// apphub:profile:* cache keys plus the apphub:photos and apphub:cards
// hashes — cards are the compact list-row projection of the same profiles).
// GET: Applicant Core pulls every unacknowledged human decision while legacy
// callers retain their narrower interview-only approvals field; shared-secret
// auth (APPHUB_SYNC_KEY), never requireAuth — the
// caller is a launchd cron, not a browser (pattern: api/health/beat.mjs).
// 401 carries no detail on purpose.

import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { directoryFromFacts, factsFromProfile } from "./_lib/facts.mjs";
import {
  buildGeneration,
  coreGenerationDigest,
  publishGeneration,
  readActivePublication,
  readPublishedArtifacts,
  validDigest,
  validGenerationId,
} from "./_lib/generation.mjs";
import {
  activeSourceProfileReceiptMismatches,
  profileCacheSummary,
  profilePreparingCount,
} from "./_lib/profile-readiness.mjs";
import {
  getJson,
  hashDelMany,
  hashGetAllJson,
  hashGetMany,
  hashKeys,
  hashSetJson,
  K,
  compareAndSetJson,
  kvConfigured,
  PROFILE_TTL_SECONDS,
  setJsonIfAbsent,
  setJson,
  validKey,
} from "./_lib/kv.mjs";

export const config = { maxDuration: 30 };

// The loop caps the snapshot on its side (drops per-step detail); this guard
// keeps a buggy publisher from parking a multi-megabyte blob in KV.
export const MAX_SNAPSHOT_BYTES = 1_800_000;
// The authenticated publisher uses a bounded gzip+base64 transport envelope
// once the exact JSON body would exceed Vercel's request ceiling. These are
// decoded logical limits; the wire envelope has its own smaller cap below.
const MAX_QUEUE_BYTES = 5_500_000;
const MAX_PUBLISH_BYTES = 6_500_000;
const MAX_TRANSPORT_COMPRESSED_BYTES = 2_500_000;
const MAX_TRANSPORT_DECODED_BYTES = 7_000_000;
const MONITOR_TRANSPORT_VERSION = "applicant-core-monitor-gzip-v1";
// Delivery is a separate state machine. `blocked` and `invited` are retained
// for the existing loop; the preparation states make a saved Interview intent
// visible without pretending that delivery has already happened.
const ACK_STATUSES = new Set([
  "requested",
  "preparing_identity",
  "preparing_role_agent",
  "ready_to_schedule",
  "scheduler_verified",
  "ready_to_email",
  "mailroom_accepted",
  "sendgrid_delivered",
  "waiting_for_provider",
  "identity_review",
  "recipient_review",
  "delivery_review",
  "cannot_contact",
  "invited",
  "blocked",
]);
import {saveApplicantAck} from './_lib/request-safety.mjs';

function authed(req) {
  const secret = process.env.APPHUB_SYNC_KEY || "";
  if (!secret) return false;
  const provided = req.headers?.authorization || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stableHash(value) {
  const canonical = JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// Accepts acks as `{key: record}` or `[{key, ...record}]`. All-or-nothing:
// one malformed entry rejects the batch before anything is written, so the
// loop's stderr shows exactly which key it produced wrong.
export function normalizeAcks(input, now = () => new Date().toISOString()) {
  const entries = Array.isArray(input)
    ? input.map((entry) => [entry?.key, entry])
    : input && typeof input === "object" ? Object.entries(input) : null;
  if (!entries) return { ok: false, badKey: null };
  const acks = {};
  for (const [rawKey, record] of entries) {
    const key = String(rawKey || "").trim();
    const status = String(record?.status || "");
    if (!validKey(key) || !ACK_STATUSES.has(status)) {
      return { ok: false, badKey: key || null };
    }
    acks[key] = {
      status,
      at: String(record?.at || "") || now(),
      ...(record?.requestId ? {requestId:String(record.requestId).slice(0,80)} : {}),
      ...(record?.reason ? { reason: String(record.reason).slice(0, 200) } : {}),
      ...(record?.inviteId ? { inviteId: String(record.inviteId).slice(0, 100) } : {}),
      ...(record?.deliveryState ? { deliveryState: String(record.deliveryState).slice(0, 60) } : {}),
      ...(record?.generationId ? { generationId: String(record.generationId).slice(0, 128) } : {}),
      ...(record?.generationDigest ? { generationDigest: String(record.generationDigest).slice(0, 64) } : {}),
    };
  }
  return { ok: true, acks };
}

// Prewarmed profiles ride sync as `{<cuId>: profileJson}` — the desktop loop
// bulk-writes the same apphub:profile:* cache keys api/applicants/profile.mjs
// fills on a cache miss (identical shape; see the kv.mjs header contract).
// All-or-nothing like acks: one bad entry rejects the whole batch before
// anything is written. Per-profile byte cap because the body-level cap alone
// would let one bloated profile ride in with the rest of the batch.
// Photos: only imageSrc values on the stable public Paraform bucket are
// collected into the apphub:photos hash — anything else (foreign hosts,
// expiring signed URLs) is silently dropped, not an error.
//
// CU_RE is exported so the read side (api/applicants/cards.mjs) validates
// cuIds against the exact contract the writer enforces, not a drifting copy.
export const CU_RE = /^[a-z0-9]{10,40}$/i;
export const PROFILE_KEY_RE = /^(?:[a-z0-9]{10,40}|core:[a-z0-9]{10,64})$/i;
export const MAX_PROFILE_BYTES = 30_000;
export const MAX_SOURCE_PROFILE_RECEIPT_QUERY_KEYS = 2_000;
const PHOTO_URL_PREFIX = "https://storage.googleapis.com/paraform-images/";

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function decodeTransportBody(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 1 || !own(input, "transport")) {
    return { ok: false, error: "invalid_transport_envelope" };
  }
  const transport = input.transport;
  const expectedKeys = ["codec", "data", "decodedBytes", "decodedSha256", "version"];
  if (!transport || typeof transport !== "object" || Array.isArray(transport)
    || JSON.stringify(Object.keys(transport).sort()) !== JSON.stringify(expectedKeys)
    || transport.version !== MONITOR_TRANSPORT_VERSION
    || transport.codec !== "gzip-base64"
    || !Number.isSafeInteger(transport.decodedBytes)
    || transport.decodedBytes < 2
    || transport.decodedBytes > MAX_TRANSPORT_DECODED_BYTES
    || !/^[a-f0-9]{64}$/iu.test(String(transport.decodedSha256 || ""))
    || typeof transport.data !== "string"
    || transport.data.length === 0
    || transport.data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(transport.data)
    || transport.data.length > Math.ceil(MAX_TRANSPORT_COMPRESSED_BYTES / 3) * 4 + 4) {
    return { ok: false, error: "invalid_transport_envelope" };
  }
  try {
    const compressed = Buffer.from(transport.data, "base64");
    if (compressed.length > MAX_TRANSPORT_COMPRESSED_BYTES
      || compressed.toString("base64") !== transport.data) {
      return { ok: false, error: "invalid_transport_envelope" };
    }
    const decoded = gunzipSync(compressed, { maxOutputLength: MAX_TRANSPORT_DECODED_BYTES + 1 });
    if (decoded.length !== transport.decodedBytes
      || decoded.length > MAX_TRANSPORT_DECODED_BYTES
      || createHash("sha256").update(decoded).digest("hex") !== transport.decodedSha256) {
      return { ok: false, error: "invalid_transport_payload" };
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) || own(body, "transport")) {
      return { ok: false, error: "invalid_transport_payload" };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, error: "invalid_transport_payload" };
  }
}

/**
 * Core is the source of the publication identity.  Do not accept the former
 * top-level or artifact-local fallbacks: they let Monitor mint a generation
 * that Core cannot fence.  Null high-water marks are explicit values; absent
 * fields are a malformed generation contract.
 */
export function normalizeCoreGeneration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "generation_required" };
  }
  const id = input.id;
  const digest = input.digest;
  if (!validGenerationId(id) || !validDigest(digest)) {
    return { ok: false, error: "generation_invalid" };
  }
  if (!own(input, "sourceCutoff") || !own(input, "sourceWatermark")) {
    return { ok: false, error: "generation_high_watermark_required" };
  }
  return {
    ok: true,
    id,
    digest,
    sourceCutoff: input.sourceCutoff ?? null,
    sourceWatermark: input.sourceWatermark ?? null,
  };
}

const CONSERVED_COUNT_ALIASES = {
  total: ["total", "rowCount", "totalRows", "rows"],
  stream: ["stream", "streamCount"],
  queue: ["queue", "queueCount"],
  profilePreparing: ["profilePreparing", "profilePreparingCount", "preparing", "preparingCount"],
};

function countValue(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstCount(sources, aliases) {
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const alias of aliases) {
      if (own(source, alias)) return countValue(source[alias]);
    }
  }
  return null;
}

/**
 * Core's conserved population is a publication input, not a count Monitor
 * derives from whichever arrays survived serialization.  Require the four
 * declared dimensions, then prove they describe the exact payload received.
 * The aliases keep the boundary readable while Core moves from rowCount/
 * queueCount naming to the public total/queue/stream contract.
 */
export function normalizeConservedCounts(snapshot, queue, explicitCounts = null) {
  const snapshotCounts = snapshot?.counts;
  const sources = [
    explicitCounts,
    snapshot?.conservedCounts,
    snapshotCounts?.conserved,
    snapshotCounts,
    snapshot,
  ];
  const declared = Object.fromEntries(Object.entries(CONSERVED_COUNT_ALIASES)
    .map(([key, aliases]) => [key, firstCount(sources, aliases)]));
  const hasPreparing = sources.some((source) => source && typeof source === "object"
    && !Array.isArray(source)
    && CONSERVED_COUNT_ALIASES.profilePreparing.some((alias) => own(source, alias)))
    || own(snapshot || {}, "profilePreparing");
  if (declared.profilePreparing == null && own(snapshot || {}, "profilePreparing")) {
    // Core may publish the immutable preparing partition as rows rather than
    // repeating its length in the count object.  Count that partition once;
    // it remains part of the exact snapshot and is never dynamically filtered.
    declared.profilePreparing = profilePreparingCount(snapshot);
  }
  if (!hasPreparing) declared.profilePreparing = null;

  const missing = Object.keys(declared).filter((key) => declared[key] == null);
  if (missing.length) return { ok: false, error: "conserved_counts_required", missing };

  const actual = {
    stream: Array.isArray(snapshot?.stream) ? snapshot.stream.length : 0,
    queue: Array.isArray(queue) ? queue.length : 0,
    profilePreparing: profilePreparingCount(snapshot),
  };
  actual.total = actual.stream + actual.queue + actual.profilePreparing;
  const mismatches = Object.keys(actual).filter((key) => declared[key] !== actual[key]);
  if (mismatches.length) {
    return { ok: false, error: "conserved_counts_mismatch", expected: actual, declared };
  }
  return { ok: true, ...declared };
}

export function normalizeProfiles(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, badCu: null };
  }
  const profiles = {};
  const photos = {};
  for (const [rawCu, profile] of Object.entries(input)) {
    const cu = String(rawCu || "").trim();
    if (!CU_RE.test(cu)
      || !profile || typeof profile !== "object" || Array.isArray(profile)
      || Buffer.byteLength(JSON.stringify(profile)) > MAX_PROFILE_BYTES) {
      return { ok: false, badCu: cu || null };
    }
    profiles[cu] = profile;
    if (typeof profile.imageSrc === "string" && profile.imageSrc.startsWith(PHOTO_URL_PREFIX)) {
      photos[cu] = profile.imageSrc;
    }
  }
  return { ok: true, profiles, photos };
}

export function normalizeSourceProfiles(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, badKey: null };
  }
  const profiles = {};
  const sourceHistoryStates = new Set(["data", "verified_empty"]);
  for (const [rawKey, profile] of Object.entries(input)) {
    const key = String(rawKey || "").trim();
    const sourceObservationId = String(
      profile?.sourceObservationId
      ?? profile?.source_observation_id
      ?? profile?.sourceObservation?.id
      ?? "",
    ).trim();
    const historyState = String(
      profile?.historyState
      ?? profile?.profileHistoryState
      ?? profile?.history_state
      ?? "",
    ).trim().toLowerCase();
    const hasHistory = (Array.isArray(profile?.experiences) && profile.experiences.length > 0)
      || (Array.isArray(profile?.education) && profile.education.length > 0);
    const normalizedProfile = profile && typeof profile === "object" && !Array.isArray(profile)
      ? { ...profile, profileSource: "applicant_hub", historyState, sourceObservationId }
      : profile;
    if (!PROFILE_KEY_RE.test(key)
      || !profile || typeof profile !== "object" || Array.isArray(profile)
      || profile.profileSource !== "applicant_hub"
      || !sourceObservationId || sourceObservationId.length > 256
      || /[\u0000-\u001f\u007f]/.test(sourceObservationId)
      || !sourceHistoryStates.has(historyState)
      || (historyState === "verified_empty" && hasHistory)
      || Buffer.byteLength(JSON.stringify(normalizedProfile)) > MAX_PROFILE_BYTES) {
      return { ok: false, badKey: key || null };
    }
    profiles[key] = normalizedProfile;
  }
  return { ok: true, profiles, photos: {} };
}

// Compact list-row card, derived from the same prewarmed profile that fills
// apphub:profile:<cuId>. It exists so the Applicants list can render
// LinkedIn-Recruiter-style rows (headline, location, top-3 experience, top-3
// education) from ONE hash read instead of a profile fetch per row.
//
// Shape is fixed and total: every key is always present, so the UI never has
// to branch on absence — a card with nothing known is all nulls, empty arrays
// and zero counts. Descriptions/about/aiTags/talentRank are deliberately left
// out (that is what opening the profile modal is for), and every string is
// capped at CARD_FIELD_MAX purely defensively — a bloated card store would
// re-create the per-row cost this exists to remove.
export const CARD_FIELD_MAX = 300;
export const CARD_LIST_MAX = 3;

const cardStr = (value) => {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, CARD_FIELD_MAX) : null;
};

const asList = (value) => (Array.isArray(value) ? value : []);

export function cardFromProfile(profile) {
  const source = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
  const experiences = asList(source.experiences);
  const education = asList(source.education);
  const historyState = String(
    source.historyState ?? source.profileHistoryState ?? source.history_state ?? "",
  ).trim().toLowerCase();
  return {
    // Same bucket-prefix rule as the photos hash: foreign hosts and expiring
    // signed URLs are dropped rather than baked into a long-lived card.
    photo: typeof source.imageSrc === "string" && source.imageSrc.startsWith(PHOTO_URL_PREFIX)
      ? cardStr(source.imageSrc)
      : null,
    title: cardStr(source.title),
    location: cardStr(source.location),
    updatedAt: cardStr(source.updatedAt),
    exp: experiences.slice(0, CARD_LIST_MAX).map((row) => ({
      role: cardStr(row?.roleTitle),
      company: cardStr(row?.companyName),
      start: cardStr(row?.start),
      end: cardStr(row?.end),
      current: Boolean(row?.current),
      logo: cardStr(row?.logo),
    })),
    // Counts are of the FULL list, not the truncated one — the row shows
    // "+N more" from these.
    expCount: experiences.length,
    edu: education.slice(0, CARD_LIST_MAX).map((row) => ({
      school: cardStr(row?.school),
      degree: cardStr(row?.degree),
      start: cardStr(row?.start),
      end: cardStr(row?.end),
      logo: cardStr(row?.logo),
    })),
    eduCount: education.length,
    // Source-backed profiles carry an explicit terminal history result. Rich
    // provider cards keep null here and continue using their count-based TTL
    // behavior; verified_empty is a real, publishable outcome, not a miss.
    historyState: ["data", "verified_empty"].includes(historyState) ? historyState : null,
  };
}

// Count-drop tripwire. On 2026-08-10 a poisoned upstream CRM index collapsed
// the review queue 2,244 → 22 overnight and the tab rendered it silently —
// the only warnings were age-based. Sync is the one place that sees
// consecutive publishes, so it keeps a tiny apphub:counts doc: the queue and
// stream sizes of the last publish, plus a latched alert when either falls
// below COUNT_DROP_RATIO of its baseline. The alert LATCHES on the pre-drop
// baseline because a broken publisher republishes the same collapsed number
// every cycle — compared only against the previous publish, the alert would
// self-clear one cycle after tripping. It clears when the count recovers past
// the ratio of that baseline. The floor keeps small queues quiet (4 → 1 is a
// 75% drop and pure noise). Display-only by contract: a tripped alert never
// rejects or blocks the sync — feed hands it to the tab, which shows a
// banner while still rendering the data.
export const COUNT_DROP_RATIO = 0.5;
export const COUNT_DROP_FLOOR = 50;
const COUNT_DIMENSIONS = ["queue", "stream"];

export function nextCountsDoc(prev, incoming, at) {
  const doc = { updatedAt: at, alert: null };
  const alerts = {};
  for (const dim of COUNT_DIMENSIONS) {
    const next = incoming[dim];
    const prior = typeof prev?.[dim] === "number" ? prev[dim] : null;
    const latched = prev?.alert?.[dim];
    if (typeof next !== "number") {
      // This publish did not carry the dimension — carry it forward untouched.
      if (prior != null) doc[dim] = prior;
      if (latched) alerts[dim] = latched;
      continue;
    }
    doc[dim] = next;
    const baseline = latched ? latched.baseline : prior;
    if (typeof baseline === "number" && baseline >= COUNT_DROP_FLOOR
      && next < baseline * COUNT_DROP_RATIO) {
      alerts[dim] = { baseline, seen: next, at: latched?.at || at };
    }
  }
  if (Object.keys(alerts).length) doc.alert = alerts;
  return doc;
}

/**
 * Re-baseline a latched count-drop alert against what is published TODAY.
 *
 * The latch is deliberately one-way: it holds against the PRE-DROP baseline so
 * a broken publisher cannot clear it by republishing its own collapsed number.
 * That is right for a break, and wrong for the other thing with the same shape
 * — a real, verified, permanent change in what the queue contains.
 *
 * 2026-08-24 was the second kind. The invite lane moved to GitHub Actions
 * without its CRM index, published a truncated queue for two days, and latched
 * a 2,479 baseline. Once the index was restored the queue came back at ~1,183,
 * which is CORRECT (independently rebuilt from plan.mjs and reconciled against
 * the tab row for row) but still under half of 2,479 — so the alert could not
 * clear, and `rules-tick` stayed parked on `snapshot_counts_alert`, meaning no
 * applicant rule acted at all. Waiting for a stale high-water mark to be
 * re-reached is not a decision anyone made; it is just what the code did.
 *
 * So: an explicit, authenticated, RECORDED acknowledgement. It never suppresses
 * a future alert — it only moves the baseline to the current published counts,
 * so the very next genuine collapse trips again from there. `acknowledged`
 * stays on the doc as the audit trail of who re-baselined and what they
 * accepted.
 */
export function acknowledgeCountsDoc(prev, { by, at, note = null }) {
  const doc = { ...(prev || {}), updatedAt: at, alert: null };
  const cleared = prev?.alert || null;
  if (!cleared) return { doc, cleared: null };
  doc.acknowledged = {
    at, by, note,
    cleared,
    // The counts this acknowledgement accepts as the new normal. Stored
    // explicitly so a later reader can see what was re-baselined TO, not just
    // what was dismissed.
    accepted: { queue: prev?.queue ?? null, stream: prev?.stream ?? null },
  };
  return { doc, cleared };
}

// Applicant Pipeline Core's funnel snapshot, riding sync as an optional
// `pipeline` object (Status v2 build plan step 3). Backward compatible by
// construction: Core does not send this field today, and every other sync
// caller's payload is untouched by its absence. All-or-nothing like acks
// and profiles — a malformed pipeline object rejects the batch before any
// key is written, never a half-stored funnel.
//
// SHARED CONTRACT with the Status v2 page aggregator (dash-plumbing +
// dash-page builders): counts are integer or null (null = "not computed
// yet", never a fake 0); `holdsByReason` is the source's own {code,label}
// list, never a page-side label; `laneEnabled`/`stopReason` are what let the
// page distinguish "paused on purpose" from "cannot tell why it stopped".
export const PIPELINE_COUNT_FIELDS = [
  "captured", "identified", "readyToDecide", "holdsTotal",
  "passed", "invited", "postDecisionHolds", "unaccounted",
];
const MAX_HOLDS_BY_REASON = 32;

const isIntegerOrNull = (value) => value === null || value === undefined || Number.isInteger(value);
const isIsoString = (value) => typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value));

export function normalizePipeline(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "invalid_pipeline" };
  if (!isIsoString(input.generatedAt)) return { ok: false, reason: "invalid_generatedAt" };
  const window = input.window;
  if (!window || typeof window !== "object" || Array.isArray(window) || !Number.isInteger(window.days)) {
    return { ok: false, reason: "invalid_window" };
  }
  if (window.since != null && !isIsoString(window.since)) return { ok: false, reason: "invalid_window_since" };
  for (const field of PIPELINE_COUNT_FIELDS) {
    if (!isIntegerOrNull(input[field])) return { ok: false, reason: `invalid_${field}` };
  }
  if (!Array.isArray(input.holdsByReason) || input.holdsByReason.length > MAX_HOLDS_BY_REASON) {
    return { ok: false, reason: "invalid_holdsByReason" };
  }
  const holdsByReason = [];
  for (const row of input.holdsByReason) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, reason: "invalid_holdsByReason_row" };
    const code = String(row.code || "").trim();
    const label = String(row.label || "").trim();
    if (!code || code.length > 80 || !label || label.length > 200) return { ok: false, reason: "invalid_holdsByReason_row" };
    if (!isIntegerOrNull(row.count)) return { ok: false, reason: "invalid_holdsByReason_count" };
    holdsByReason.push({ code, label, count: row.count ?? null });
  }
  if (typeof input.laneEnabled !== "boolean") return { ok: false, reason: "invalid_laneEnabled" };
  if (input.stopReason != null && typeof input.stopReason !== "string") return { ok: false, reason: "invalid_stopReason" };

  const pipeline = {
    generatedAt: input.generatedAt,
    window: { days: window.days, since: window.since ?? null },
    holdsByReason,
    laneEnabled: input.laneEnabled,
    stopReason: input.stopReason ? String(input.stopReason).slice(0, 500) : null,
  };
  for (const field of PIPELINE_COUNT_FIELDS) pipeline[field] = input[field] ?? null;
  return { ok: true, pipeline };
}

export function createSyncHandler({
  kvReady = kvConfigured,
  readHash = hashGetAllJson,
  writeHash = hashSetJson,
  writeJson = setJson,
  readJson = getJson,
  readHashKeys = hashKeys,
  readHashMany = hashGetMany,
  deleteHashFields = hashDelMany,
  writeImmutableJson = setJsonIfAbsent,
  activateGeneration = compareAndSetJson,
  now = () => new Date().toISOString(),
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (!authed(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

    try {
      if (req.method === "GET") {
        if (String(req.query?.profileCache || "") === "1") {
          const [publication, sourceProfileReceipts] = await Promise.all([
            readActivePublication({ readJson }),
            readHash(K.sourceProfileReady),
          ]);
          const artifacts = publication ? await readPublishedArtifacts(publication, { readJson }) : null;
          const joined = artifacts ? {
            ...artifacts.snapshot,
            ...(Array.isArray(artifacts.queue?.rows) ? { queue: artifacts.queue.rows } : {}),
          } : null;
          const receiptMismatches = joined
            ? activeSourceProfileReceiptMismatches(joined, sourceProfileReceipts, { now: Date.parse(now()) })
            : [];
          if (publication && receiptMismatches.length) {
            return res.status(503).json({
              ok: false,
              error: "generation_unavailable",
              reason: "profile_receipt_mismatch",
              generationId: publication.generationId,
              profilePreparing: profilePreparingCount(joined),
            });
          }
          return res.status(200).json({
            ok: true,
            profileCache: profileCacheSummary(joined),
            ...(publication ? {
              generationId: publication.generationId,
              generationDigest: publication.digest,
              profilePreparing: profilePreparingCount(joined),
            } : {}),
          });
        }
        const [decisions, acks] = await Promise.all([
          readHash(K.decisions),
          readHash(K.acks),
        ]);
        if (String(req.query?.history || "") === "1") {
          const publication = await readActivePublication({ readJson });
          const artifacts = publication ? await readPublishedArtifacts(publication, { readJson }) : null;
          const snapshot = artifacts?.snapshot || null;
          const queueDoc = artifacts?.queue || null;
          const countsDoc = artifacts?.counts || null;
          const queueRows = Array.isArray(queueDoc?.rows) ? queueDoc.rows : [];
          const streamRows = Array.isArray(snapshot?.stream) ? snapshot.stream : [];
          const queueKeys = queueRows.map((row) => row?.key).filter(Boolean).sort();
          const streamKeys = streamRows.map((row) => row?.key).filter(Boolean).sort();
          const orderedDecisions = Object.fromEntries(Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b)));
          const orderedAcks = Object.fromEntries(Object.entries(acks).sort(([a], [b]) => a.localeCompare(b)));
          return res.status(200).json({
            ok: true,
            generatedAt: now(),
            history: {
              decisions: orderedDecisions,
              acks: orderedAcks,
              counts: {
                decisions: Object.keys(orderedDecisions).length,
                acks: Object.keys(orderedAcks).length,
              },
              digest: stableHash({ decisions: orderedDecisions, acks: orderedAcks }),
            },
            publish: {
              generatedAt: snapshot?.generatedAt || queueDoc?.generatedAt || null,
              source: snapshot?.source || null,
              generationId: publication?.generationId || null,
              generationDigest: publication?.digest || null,
              sourceCutoff: publication?.sourceCutoff || null,
              sourceWatermark: publication?.sourceWatermark || null,
              counts: {
                total: countsDoc?.total ?? (
                  queueRows.length + streamRows.length + profilePreparingCount(snapshot)
                ),
                queue: queueRows.length,
                uniqueQueueKeys: new Set(queueKeys).size,
                stream: streamRows.length,
                uniqueStreamKeys: new Set(streamKeys).size,
                profilePreparing: countsDoc?.profilePreparing ?? profilePreparingCount(snapshot),
              },
              storedCounts: countsDoc == null ? null : {
                total: countsDoc.total ?? null,
                queue: countsDoc.queue ?? null,
                stream: countsDoc.stream ?? null,
                profilePreparing: countsDoc.profilePreparing ?? null,
                updatedAt: countsDoc.updatedAt ?? null,
                alert: Boolean(countsDoc.alert),
              },
              digest: stableHash({
                generationId: publication?.generationId || null,
                generationDigest: publication?.digest || null,
                queueKeys,
                streamKeys,
              }),
            },
          });
        }
        const decisionRecords = Object.entries(decisions)
          .filter(([key, decision]) =>
            ["interview", "pass"].includes(decision?.action)
            && (!acks[key] || (decision.requestId && acks[key].requestId!==decision.requestId)))
          .map(([key, decision]) => ({ key, ...decision }));
        const approvals = decisionRecords.filter(({ action }) => action === "interview");
        // `decisions` is deliberately narrow — un-acked interviews, the only
        // thing the loop's next plan has to ACT on. `decidedKeys` is the wider
        // question the loop also needs answered: which rows has a human (or an
        // armed rule) already handled at all?
        //
        // It exists for the publisher's queue trim. When the review queue
        // outgrows the KV budget the loop has to drop rows from the tab, and
        // until 2026-08-24 it dropped the oldest-applied ones blindly — safe
        // only by luck, because the oldest happened to be decided. With this it
        // can spend the DECIDED rows first and leave every pending applicant
        // visible, which is the only version of that trim that cannot silently
        // hide someone nobody has reviewed. Passes are the important half here:
        // an interviewed applicant leaves the queue on the next plan, a passed
        // one never does, so passes are what the backlog silts up with.
        //
        // Keys only, no records — the publisher needs set membership, and the
        // full hash is the browser's business (feed.mjs), not the loop's.
        return res.status(200).json({
          ok: true,
          generatedAt: now(),
          decisions: approvals,
          decisionRecords,
          decidedKeys: Object.keys(decisions),
        });
      }
      if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

      let body;
      try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
      catch { return res.status(400).json({ ok: false, error: "invalid_json" }); }
      if (own(body, "transport")) {
        const decoded = decodeTransportBody(body);
        if (!decoded.ok) return res.status(400).json({ ok: false, error: decoded.error });
        body = decoded.body;
      }

      // Core can verify the durable Hub history receipts for the exact keys it
      // is about to place in a generation. This is deliberately a read-only
      // POST because the desktop publisher already uses POST for its shared-
      // secret channel; returning null explicitly makes missing coverage
      // distinguishable from a failed/omitted lookup without exposing other
      // applicants' receipts.
      if (own(body, "sourceProfileReceiptKeys")) {
        const rawKeys = body.sourceProfileReceiptKeys;
        if (!Array.isArray(rawKeys) || rawKeys.length > MAX_SOURCE_PROFILE_RECEIPT_QUERY_KEYS) {
          return res.status(400).json({ ok: false, error: "invalid_source_profile_receipt_keys" });
        }
        const keys = [...new Set(rawKeys.map((rawKey) => String(rawKey ?? "").trim()))];
        if (keys.some((key) => !PROFILE_KEY_RE.test(key))) {
          return res.status(400).json({ ok: false, error: "invalid_source_profile_receipt_key" });
        }
        const storedReceipts = keys.length
          ? await readHashMany(K.sourceProfileReady, keys)
          : {};
        const sourceProfileReceipts = Object.fromEntries(
          keys.map((key) => [key, storedReceipts?.[key] ?? null]),
        );
        return res.status(200).json({ ok: true, sourceProfileReceipts });
      }

      // ACKNOWLEDGE A LATCHED COUNT-DROP ALERT. Its own branch, and it returns
      // immediately: re-baselining must never ride along with a data publish,
      // because the whole point is that someone VERIFIED the new counts are
      // real. `by` is required for the same reason — this write is an audit
      // record, not a reset button.
      if (body.acknowledgeCountsAlert) {
        const by = String(body.acknowledgeCountsAlert.by || "").trim();
        if (!by) return res.status(400).json({ ok: false, error: "acknowledge_requires_by" });
        const note = body.acknowledgeCountsAlert.note
          ? String(body.acknowledgeCountsAlert.note).slice(0, 500) : null;
        const prev = await readJson(K.counts);
        if (!prev?.alert) {
          return res.status(200).json({ ok: true, at: now(), cleared: null, detail: "no latched alert" });
        }
        const { doc, cleared } = acknowledgeCountsDoc(prev, { by, at: now(), note });
        await writeJson(K.counts, doc);
        return res.status(200).json({ ok: true, at: doc.updatedAt, cleared, counts: doc });
      }

      // Validate a snapshot+queue publication as one unit BEFORE either
      // persistent key changes. The split keys isolate their stored sizes, not
      // the incoming HTTP request. In particular, rejecting an oversized queue
      // after writing its snapshot would publish a fresh stream beside a stale
      // review queue.
      const hasSnapshot = body.snapshot != null;
      const hasQueue = body.queue != null;
      let snapshotBytes = null;
      let queueDoc = null;
      let queueBytes = null;
      if (hasSnapshot) {
        if (typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) {
          return res.status(400).json({ ok: false, error: "invalid_snapshot" });
        }
        snapshotBytes = Buffer.byteLength(JSON.stringify(body.snapshot));
        if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
          return res.status(413).json({ ok: false, error: "snapshot_too_large", bytes: snapshotBytes, max: MAX_SNAPSHOT_BYTES });
        }
      }
      if (hasQueue) {
        if (!Array.isArray(body.queue)) {
          return res.status(400).json({ ok: false, error: "invalid_queue" });
        }
        queueDoc = { generatedAt: String(body.snapshot?.generatedAt || now()), rows: body.queue };
        queueBytes = Buffer.byteLength(JSON.stringify(queueDoc));
        if (queueBytes > MAX_QUEUE_BYTES) {
          return res.status(413).json({ ok: false, error: "queue_too_large", bytes: queueBytes, max: MAX_QUEUE_BYTES });
        }
      }
      if (hasSnapshot && hasQueue) {
        const bytes = Buffer.byteLength(JSON.stringify(body));
        if (bytes > MAX_PUBLISH_BYTES) {
          return res.status(413).json({ ok: false, error: "publish_too_large", bytes, max: MAX_PUBLISH_BYTES });
        }
      }

      const stored = { snapshot: false, queue: false, acks: 0 };
      let generation = null;
      let generationCounts = null;
      if (hasSnapshot && hasQueue) {
        // A complete pair is the only input allowed to advance the browser's
        // active view.  The legacy keys remain diagnostic compatibility for
        // older callers, but no Applicants reader uses them after a pointer
        // exists; this prevents a partial POST from creating a mixed feed.
        const sourceGeneration = normalizeCoreGeneration(body.generation);
        if (!sourceGeneration.ok) {
          return res.status(400).json({ ok: false, error: sourceGeneration.error });
        }
        const logicalDigest = coreGenerationDigest({
          generationId: sourceGeneration.id,
          sourceCutoff: sourceGeneration.sourceCutoff,
          sourceWatermark: sourceGeneration.sourceWatermark,
          snapshot: body.snapshot,
          queue: body.queue,
        });
        if (sourceGeneration.digest.toLowerCase() !== logicalDigest) {
          return res.status(400).json({
            ok: false,
            error: "generation_digest_mismatch",
            generation: {
              id: sourceGeneration.id,
              digest: sourceGeneration.digest,
              sourceCutoff: sourceGeneration.sourceCutoff,
              sourceWatermark: sourceGeneration.sourceWatermark,
            },
            logicalDigest,
          });
        }
        const sourceReceipts=await readHash(K.sourceProfileReady);
        const receiptMismatches=activeSourceProfileReceiptMismatches({
          ...body.snapshot,
          queue:body.queue,
        },sourceReceipts,{now:Date.parse(now())});
        if (receiptMismatches.length) {
          return res.status(409).json({
            ok:false,
            error:"source_profile_prepublication_incomplete",
            missing:receiptMismatches.length,
          });
        }
        const conservedCounts = normalizeConservedCounts(body.snapshot, body.queue, body.counts);
        if (!conservedCounts.ok) {
          return res.status(400).json({
            ok: false,
            error: conservedCounts.error,
            ...(conservedCounts.missing ? { missing: conservedCounts.missing } : {}),
            ...(conservedCounts.expected ? {
              expected: conservedCounts.expected,
              declared: conservedCounts.declared,
            } : {}),
          });
        }
        const incomingCounts = {
          queue: conservedCounts.queue,
          stream: conservedCounts.stream,
        };
        generationCounts = {
          ...nextCountsDoc(await readJson(K.counts), incomingCounts, now()),
          total: conservedCounts.total,
          profilePreparing: conservedCounts.profilePreparing,
        };
        generation = buildGeneration({
          snapshot: body.snapshot,
          queue: body.queue,
          counts: generationCounts,
          generationId: sourceGeneration.id,
          generationDigest: sourceGeneration.digest,
          sourceCutoff: sourceGeneration.sourceCutoff,
          sourceWatermark: sourceGeneration.sourceWatermark,
          displayDigest: body.profileDisplayDigest || body.snapshot.profileDisplayDigest || null,
          publishedAt: now(),
        });
        const published = await publishGeneration({
          generation,
          expectedCounts: conservedCounts,
          readJson,
          writeImmutableJson,
          activate: activateGeneration,
        });
        if (!published.ok) {
          return res.status(409).json({
            ok: false,
            error: "generation_changed_retry_publish",
            generationId: published.current?.generationId || null,
          });
        }
        stored.snapshot = true;
        stored.queue = true;
        stored.generation = {
          id: generation.pointer.generationId,
          digest: generation.pointer.digest,
          sourceCutoff: generation.pointer.sourceCutoff,
          sourceWatermark: generation.pointer.sourceWatermark,
          artifactIntegrityDigest: generation.pointer.artifactIntegrityDigest,
          counts: published.readback.counts,
        };
        // Keep the old count tripwire's baseline available to diagnostics and
        // the next publisher, but never use it as the browser's feed artifact.
        await writeJson(K.counts, generation.counts).catch(() => {});
      } else {
        // Partial legacy writes are intentionally not active publication. They
        // are retained only for the sync/history compatibility surface while a
        // publisher rolls forward to the paired generation contract.
        if (body.snapshot != null) {
          await writeJson(K.snapshot, body.snapshot);
          stored.snapshot = true;
        }
        if (body.queue != null) {
          await writeJson(K.queue, queueDoc);
          stored.queue = true;
        }
      }
      // Photos/cards hygiene: neither hash has a TTL, so without pruning they
      // grow for every applicant ever seen while feed HGETALLs photos on every
      // poll. When a full publish arrives (snapshot AND queue together), rows
      // for people no longer on the tab are dropped. Best-effort — a prune
      // failure must never fail the push that carried real data.
      if (stored.snapshot && stored.queue) {
        try {
          const keep = new Set(
            [...(Array.isArray(body.snapshot?.stream) ? body.snapshot.stream : []), ...body.queue]
              .map((row) => row?.profileKey || row?.cuId).filter(Boolean),
          );
          const drop = (await readHashKeys(K.photos)).filter((cu) => !keep.has(cu));
          if (drop.length) await deleteHashFields(K.photos, drop);
          // Same keep-set, but cards needs its own key list: a card is written
          // for EVERY prewarmed profile while a photo only lands for bucket-
          // hosted images, so the photos drop list would strand cards forever.
          // Sequenced after the photos prune on purpose — the photos path keeps
          // exactly the failure semantics it had before cards existed.
          const dropCards = (await readHashKeys(K.cards)).filter((cu) => !keep.has(cu));
          if (dropCards.length) await deleteHashFields(K.cards, dropCards);
          const readyRecords = await readHash(K.profileReady);
          const dropProfileReady = Object.keys(readyRecords || {})
            .filter((cu) => !keep.has(cu) && readyRecords[cu]?.source !== "applicant_hub");
          if (dropProfileReady.length) await deleteHashFields(K.profileReady, dropProfileReady);
          // Facts follow cards exactly: same keep-set, same lifecycle, its own
          // key list. The picker directories are deliberately NOT pruned —
          // a school stays a valid rule target after the last applicant who
          // attended it leaves the tab, and re-adding it later would silently
          // break every rule that referenced it.
          const dropFacts = (await readHashKeys(K.facts)).filter((cu) => !keep.has(cu));
          if (dropFacts.length) await deleteHashFields(K.facts, dropFacts);
        } catch { /* hygiene only */ }
      }
      // Count tripwire (see nextCountsDoc above). Best-effort like the prune:
      // a counts failure must never fail the push that carried real data. The
      // queue count prefers the split key; a queue embedded in the snapshot
      // (older publisher) counts only when no split doc rode this POST —
      // mirroring feed's merge precedence. A stored snapshot with no stream
      // array counts as stream 0, because that is what the tab will render.
      if (stored.snapshot || stored.queue) {
        try {
          if (generationCounts) {
            await writeJson(K.counts, generationCounts);
          } else {
            const incoming = {
              ...(stored.queue
                ? { queue: body.queue.length }
                : Array.isArray(body.snapshot?.queue)
                  ? { queue: body.snapshot.queue.length }
                  : {}),
              ...(stored.snapshot
                ? { stream: Array.isArray(body.snapshot.stream) ? body.snapshot.stream.length : 0 }
                : {}),
            };
            await writeJson(K.counts, nextCountsDoc(await readJson(K.counts), incoming, now()));
          }
        } catch { /* display-only tripwire */ }
      }
      if (body.acks != null) {
        const normalized = normalizeAcks(body.acks, now);
        if (!normalized.ok) {
          return res.status(400).json({ ok: false, error: "invalid_ack", key: normalized.badKey });
        }
        if (Object.keys(normalized.acks).length) {
          stored.acks=0;
          const entries=Object.entries(normalized.acks);
          for(let offset=0;offset<entries.length;offset+=25) {
            const saved=await Promise.all(entries.slice(offset,offset+25).map(([key,ack])=>saveApplicantAck(key,ack)));
            stored.acks+=saved.filter(Boolean).length;
          }
        }
      }
      // `stored.profiles` only appears when the field was sent, so responses
      // to profile-less POSTs (the existing loop payloads) stay unchanged.
      if (body.profiles != null) {
        const normalized = normalizeProfiles(body.profiles);
        if (!normalized.ok) {
          return res.status(400).json({ ok: false, error: "invalid_profile", cu: normalized.badCu });
        }
        const entries = Object.entries(normalized.profiles);
        // A rich-provider refresh is optional enrichment. It must not replace
        // the source-owned durable projection or receipt when both channels
        // happen to use the same profile key.
        const sourceReceipts = await readHash(K.sourceProfileReady).catch(() => ({}));
        const sourceOwnedKeys = new Set(Object.entries(sourceReceipts || {})
          .filter(([, receipt]) => receipt?.source === "applicant_hub")
          .map(([key]) => key));
        const richEntries = entries.filter(([key]) => !sourceOwnedKeys.has(key));
        const profileReady = {};
        for (const [cu, profile] of richEntries) {
          // Stamp immediately before the TTL write, never after the batch:
          // the receipt may expire a little early, but can never claim the
          // underlying profile still exists after its real cache key expired.
          const cachedAt = now();
          const expiresAt = new Date(Date.parse(cachedAt) + PROFILE_TTL_SECONDS * 1000).toISOString();
          await writeJson(K.profile(cu), profile, PROFILE_TTL_SECONDS);
          profileReady[cu] = { cachedAt, expiresAt };
        }
        if (Object.keys(normalized.photos).length) {
          await writeHash(K.photos, normalized.photos);
        }
        // One card per prewarmed profile, one HSET for the whole batch — the
        // list rows read these instead of fetching a profile each.
        const cards = Object.fromEntries(richEntries.map(([cu, profile]) => [cu, cardFromProfile(profile)]));
        if (Object.keys(cards).length) {
          await writeHash(K.cards, cards);
        }
        if (Object.keys(profileReady).length) {
          await writeHash(K.profileReady, profileReady);
        }
        // Evaluation facts ride the same batch (see _lib/facts.mjs). Distinct
        // from cards on purpose: facts keep EVERY school and job plus their
        // stable ids, which is what a rule needs and a render projection does
        // not. Best-effort — a facts failure must never fail the push that
        // carried the profiles, because the profiles are the durable thing and
        // facts rebuild from them on the next prewarm.
        // Reported in the response rather than only swallowed: a facts
        // derivation that failed every cycle would otherwise be invisible,
        // and the rules engine would quietly skip everybody with
        // "no_facts_yet" forever while looking healthy.
        try {
          const facts = Object.fromEntries(richEntries.map(([cu, profile]) => [cu, factsFromProfile(profile)]));
          await writeHash(K.facts, facts);
          stored.facts = richEntries.length;
          // Picker directories, harvested from the same facts. Paraform
          // exposes no school or company search we can call, so the only
          // directory we can offer is the one our own applicants describe.
          const schools = {};
          const companies = {};
          for (const record of Object.values(facts)) {
            const found = directoryFromFacts(record);
            Object.assign(schools, found.schools);
            Object.assign(companies, found.companies);
          }
          if (Object.keys(schools).length) await writeHash(K.schools, schools);
          if (Object.keys(companies).length) await writeHash(K.companies, companies);
        } catch (error) {
          // Derived state; the next prewarm rebuilds it. Name the failure so a
          // publisher log shows it instead of a silent zero.
          stored.factsError = String(error?.message || error).slice(0, 120);
        }
        stored.profiles = richEntries.length;
      }
      if (body.sourceProfiles != null) {
        const normalized = normalizeSourceProfiles(body.sourceProfiles);
        if (!normalized.ok) {
          return res.status(400).json({ ok: false, error: "invalid_source_profile", key: normalized.badKey });
        }
        const entries = Object.entries(normalized.profiles);
        const profileReady = {};
        for (const [key, profile] of entries) {
          const cachedAt = now();
          // Hub history is an immutable source projection, not a rich-provider
          // cache. Keep the payload and its receipt durable; the exact source
          // observation is the freshness fence for the current queue row.
          await writeJson(K.sourceProfile(key), profile);
          profileReady[key] = {
            cachedAt,
            source: "applicant_hub",
            durable: true,
            historyState: profile.historyState,
            sourceObservationId: profile.sourceObservationId,
          };
        }
        const cards = Object.fromEntries(entries.map(([key, profile]) => [key, cardFromProfile(profile)]));
        if (Object.keys(cards).length) await writeHash(K.cards, cards);
        if (Object.keys(profileReady).length) await writeHash(K.sourceProfileReady, profileReady);
        try {
          const facts = Object.fromEntries(entries.map(([key, profile]) => [key, factsFromProfile(profile)]));
          await writeHash(K.facts, facts);
          stored.sourceFacts = entries.length;
        } catch (error) {
          stored.sourceFactsError = String(error?.message || error).slice(0, 120);
        }
        stored.sourceProfiles = entries.length;
      }
      if (body.pipeline != null) {
        const normalized = normalizePipeline(body.pipeline);
        if (!normalized.ok) {
          return res.status(400).json({ ok: false, error: "invalid_pipeline", reason: normalized.reason });
        }
        await writeJson(K.pipeline, normalized.pipeline);
        stored.pipeline = true;
      }
      return res.status(200).json({
        ok: true,
        stored,
        ...(generation ? {
          // Echo Core's tuple exactly. artifactIntegrityDigest remains an internal
          // Monitor integrity value under `stored.generation`.
          generation: {
            id: generation.pointer.generationId,
            digest: generation.pointer.digest,
            sourceCutoff: generation.pointer.sourceCutoff,
            sourceWatermark: generation.pointer.sourceWatermark,
            counts: stored.generation.counts,
          },
        } : {}),
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "store_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createSyncHandler();
