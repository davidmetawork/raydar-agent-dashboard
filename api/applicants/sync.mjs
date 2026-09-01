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

import { timingSafeEqual } from "node:crypto";
import { directoryFromFacts, factsFromProfile } from "./_lib/facts.mjs";
import {
  getJson,
  hashDelMany,
  hashGetAllJson,
  hashKeys,
  hashSetJson,
  K,
  kvConfigured,
  PROFILE_TTL_SECONDS,
  setJson,
  validKey,
} from "./_lib/kv.mjs";

export const config = { maxDuration: 30 };

// The loop caps the snapshot on its side (drops per-step detail); this guard
// keeps a buggy publisher from parking a multi-megabyte blob in KV.
export const MAX_SNAPSHOT_BYTES = 900_000;
const ACK_STATUSES = new Set(["invited", "blocked"]);

function authed(req) {
  const secret = process.env.APPHUB_SYNC_KEY || "";
  if (!secret) return false;
  const provided = req.headers?.authorization || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
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
      ...(record?.reason ? { reason: String(record.reason).slice(0, 200) } : {}),
      ...(record?.inviteId ? { inviteId: String(record.inviteId).slice(0, 100) } : {}),
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
export const MAX_PROFILE_BYTES = 30_000;
const PHOTO_URL_PREFIX = "https://storage.googleapis.com/paraform-images/";

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

export function createSyncHandler({
  kvReady = kvConfigured,
  readHash = hashGetAllJson,
  writeHash = hashSetJson,
  writeJson = setJson,
  readJson = getJson,
  readHashKeys = hashKeys,
  deleteHashFields = hashDelMany,
  now = () => new Date().toISOString(),
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (!authed(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

    try {
      if (req.method === "GET") {
        const [decisions, acks] = await Promise.all([
          readHash(K.decisions),
          readHash(K.acks),
        ]);
        const decisionRecords = Object.entries(decisions)
          .filter(([key, decision]) =>
            ["interview", "pass"].includes(decision?.action) && !acks[key])
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

      const stored = { snapshot: false, queue: false, acks: 0 };
      if (body.snapshot != null) {
        if (typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) {
          return res.status(400).json({ ok: false, error: "invalid_snapshot" });
        }
        const bytes = Buffer.byteLength(JSON.stringify(body.snapshot));
        if (bytes > MAX_SNAPSHOT_BYTES) {
          return res.status(413).json({ ok: false, error: "snapshot_too_large", bytes, max: MAX_SNAPSHOT_BYTES });
        }
        await writeJson(K.snapshot, body.snapshot);
        stored.snapshot = true;
      }
      // The queue rides its own key so a large review backlog can never
      // squeeze the stream out of the snapshot cap (each part gets the full
      // budget; the 2026-08-09 seed hit exactly this with 2,151 queue rows).
      if (body.queue != null) {
        if (!Array.isArray(body.queue)) {
          return res.status(400).json({ ok: false, error: "invalid_queue" });
        }
        const doc = { generatedAt: String(body.snapshot?.generatedAt || now()), rows: body.queue };
        const bytes = Buffer.byteLength(JSON.stringify(doc));
        if (bytes > MAX_SNAPSHOT_BYTES) {
          return res.status(413).json({ ok: false, error: "queue_too_large", bytes, max: MAX_SNAPSHOT_BYTES });
        }
        await writeJson(K.queue, doc);
        stored.queue = true;
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
              .map((row) => row?.cuId).filter(Boolean),
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
        } catch { /* display-only tripwire */ }
      }
      if (body.acks != null) {
        const normalized = normalizeAcks(body.acks, now);
        if (!normalized.ok) {
          return res.status(400).json({ ok: false, error: "invalid_ack", key: normalized.badKey });
        }
        if (Object.keys(normalized.acks).length) {
          await writeHash(K.acks, normalized.acks);
          stored.acks = Object.keys(normalized.acks).length;
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
        for (const [cu, profile] of entries) {
          await writeJson(K.profile(cu), profile, PROFILE_TTL_SECONDS);
        }
        if (Object.keys(normalized.photos).length) {
          await writeHash(K.photos, normalized.photos);
        }
        // One card per prewarmed profile, one HSET for the whole batch — the
        // list rows read these instead of fetching a profile each.
        const cards = Object.fromEntries(entries.map(([cu, profile]) => [cu, cardFromProfile(profile)]));
        if (Object.keys(cards).length) {
          await writeHash(K.cards, cards);
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
          const facts = Object.fromEntries(entries.map(([cu, profile]) => [cu, factsFromProfile(profile)]));
          await writeHash(K.facts, facts);
          stored.facts = entries.length;
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
        stored.profiles = entries.length;
      }
      return res.status(200).json({ ok: true, stored });
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
