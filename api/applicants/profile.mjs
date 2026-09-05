// Paraform-referral-style applicant profile, served cache-first (6h TTL).
//
// The live path is three read families on the recruiter session cookie:
//   candidateUser.getLinkedInCandidate  { candidateUserId }    <- camelCase!
//   candidateUser.getMostRecentResume   { candidate_user_id }  <- snake_case!
//   company.getCompanyTalentDensity     { company_id } -> { talentRank }
// (input-shape gotchas verified live: docs/PARAAI-REENABLE-CAPTURE-2026-07-31.md
// in the main repo). The LinkedIn record is a CACHE Paraform does not refresh
// on read — observed snapshot ages ran 1-42 days — so updatedAt rides along and
// the UI shows "LinkedIn data as of <updatedAt>". `is_current` is null on every
// experience row; end_date == null is what marks the current role.
//
// Rank reads are serialized 250ms apart through the 30-day apphub:rank: cache
// because a burst of parallel Paraform reads trips its 401 throttle.
//
// On a dead cookie this endpoint answers 200 with {degraded:"paraform_auth"}
// and whatever it has — never a blank 500 (the modal must always open).

import { cors, requireAuth } from "./_lib/core.mjs";
import {
  getJson,
  K,
  kvConfigured,
  PROFILE_TTL_SECONDS,
  RANK_TTL_SECONDS,
  setJson,
} from "./_lib/kv.mjs";
import { hasCookie, isParaformAuthError, sleep, trpcGet } from "./_lib/paraform.mjs";
import { CU_RE, PROFILE_KEY_RE } from "./sync.mjs";
import { readActivePublication, readPublishedArtifacts } from "./_lib/generation.mjs";
import { richBindingsForSnapshot, richProfileMatches } from "./_lib/rich-profile.mjs";

export const config = { maxDuration: 60 };

const RANK_DELAY_MS = 250;
const MAX_RANK_LOOKUPS = 25; // bounds the serialized walk well under the 60s budget

const str = (value) => {
  const s = value == null ? "" : String(value).trim();
  return s || null;
};

// One rank per unique company/school id, cache-first, live reads paced 250ms
// apart. A confirmed auth failure stops the live walk (every remaining lookup
// would ride the same dead ladder) but keeps the ranks already gathered.
async function talentRanks(companyIds) {
  const ranks = new Map();
  let degraded = false;
  let paced = false;
  for (const companyId of companyIds) {
    const cached = await getJson(K.rank(companyId)).catch(() => null);
    if (cached && typeof cached === "object" && "rank" in cached) {
      ranks.set(companyId, cached.rank ?? null);
      continue;
    }
    if (degraded) continue;
    if (paced) await sleep(RANK_DELAY_MS);
    paced = true;
    try {
      const density = await trpcGet("company.getCompanyTalentDensity", { company_id: companyId });
      const rank = density?.talentRank ?? null;
      ranks.set(companyId, rank);
      await setJson(K.rank(companyId), { rank, at: new Date().toISOString() }, RANK_TTL_SECONDS).catch(() => {});
    } catch (error) {
      if (isParaformAuthError(error)) { degraded = true; continue; }
      // Transport blip: no rank this time, and no 30-day cache poisoning.
      ranks.set(companyId, null);
    }
  }
  return { ranks, degraded };
}

function mapExperience(row, ranks) {
  const companyId = row?.company_id ?? row?.company?.id ?? null;
  return {
    // The stable Paraform id. Added 2026-08-20 for Applicant Decision Rules:
    // rules match companies and schools by id, never by typed text, because
    // name matching cannot tell Harvard College from Harvard Business School.
    // MIRROR THIS IN src/interviews/publish.mjs — that file is the other
    // writer of apphub:profile:* and any drift is a bug in both.
    companyId: companyId == null ? null : String(companyId),
    roleTitle: str(row?.role_title ?? row?.title),
    companyName: str(row?.company_name ?? row?.company?.name),
    start: row?.start_date ?? null,
    end: row?.end_date ?? null,
    current: row?.end_date == null, // is_current is always null — never branch on it
    description: str(row?.description),
    location: str(row?.location),
    // Verified against a captured payload (2026-08-09): industry/ai_tags/logo
    // live on the nested company object, not the experience row.
    industry: str(row?.company?.industry ?? row?.industry ?? row?.company_industry),
    aiTags: (Array.isArray(row?.company?.ai_tags) ? row.company.ai_tags
      : Array.isArray(row?.ai_tags) ? row.ai_tags : Array.isArray(row?.aiTags) ? row.aiTags : [])
      .map((tag) => str(tag?.name ?? tag)).filter(Boolean).slice(0, 2),
    logo: str(row?.company?.logo_src),
    talentRank: companyId != null ? ranks.get(String(companyId)) ?? null : null,
  };
}

function mapEducation(row, ranks) {
  const schoolId = row?.school?.id ?? row?.school_id ?? null;
  return {
    schoolId: schoolId == null ? null : String(schoolId),   // see mapExperience
    school: str(row?.school?.name ?? row?.school_name ?? (typeof row?.school === "string" ? row.school : null)),
    degree: str(row?.degree ?? row?.degree_name),
    start: row?.start_date ?? null,
    end: row?.end_date ?? null,
    logo: str(row?.school?.logo_src),
    // Where the school is, and its site. Added 2026-08-25 so a rule can ask
    // whether a degree is American — the applicant's own location answers a
    // different question (see _lib/school-us.mjs). Both ride the nested
    // school object; MIRRORS src/interviews/publish.mjs in the Raydar repo.
    schoolLocation: str(row?.school?.primary_location),
    schoolWebsite: str(row?.school?.website),
    talentRank: schoolId != null ? ranks.get(String(schoolId)) ?? null : null,
  };
}

export function createProfileHandler({
  corsHandler = cors, authHandler = requireAuth, kvReady = kvConfigured,
  readJson = getJson, now = Date.now,
} = {}) {
return async function handler(req, res) {
  if (corsHandler(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!(await authHandler(req, res))) return;
  if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

  const cu = String(req.query?.cu || "").trim();
  if (!PROFILE_KEY_RE.test(cu)) return res.status(400).json({ ok: false, error: "invalid_cu" });

  res.setHeader("Cache-Control", "no-store");
  try {
    // Applicant Hub history is the durable source projection. Read it before
    // the expiring rich-provider cache so a provider refresh cannot hide the
    // source-backed profile used by the active generation.
    const sourceCached = await readJson(K.sourceProfile(cu)).catch(() => null);
    if (sourceCached) {
      const { paraformProfile: _unboundProviderProfile, ...sourceProfile } = sourceCached;
      let paraformProfile = null;
      try {
        const publication = await readActivePublication({ readJson });
        const artifacts = publication ? await readPublishedArtifacts(publication, { readJson }) : null;
        const binding = artifacts ? richBindingsForSnapshot({ ...artifacts.snapshot, queue: artifacts.queue.rows }).get(cu) : null;
        if (binding && binding.sourceObservationId === sourceCached.sourceObservationId) {
          const rich = await readJson(K.richProfile(cu));
          const current = await readActivePublication({ readJson });
          if (current?.generationId === publication.generationId && current?.digest === publication.digest
            && richProfileMatches(binding, rich, { now: now() })) paraformProfile = rich;
        }
      } catch { /* Optional provider state cannot prevent opening the source profile. */ }
      return res.status(200).json({ ok: true, ...sourceProfile, ...(paraformProfile ? { paraformProfile } : {}) });
    }
    const cached = await readJson(K.profile(cu)).catch(() => null);
    if (cached) return res.status(200).json({ ok: true, ...cached });

    if (!CU_RE.test(cu)) return res.status(404).json({ ok: false, error: "profile_cache_miss" });

    if (!hasCookie()) return res.status(200).json({ ok: true, degraded: "paraform_auth" });

    let record;
    try {
      record = await trpcGet("candidateUser.getLinkedInCandidate", { candidateUserId: cu });
    } catch (error) {
      if (isParaformAuthError(error)) {
        return res.status(200).json({ ok: true, degraded: "paraform_auth" });
      }
      throw error;
    }
    if (!record || typeof record !== "object") {
      return res.status(404).json({ ok: false, error: "linkedin_record_not_found" });
    }

    // Resume absence is normal (many applicants never attach one) — best-effort.
    const resume = await trpcGet("candidateUser.getMostRecentResume", { candidate_user_id: cu })
      .catch(() => null);

    const experienceRows = Array.isArray(record.experiences) ? record.experiences : [];
    const educationRows = Array.isArray(record.education) ? record.education
      : Array.isArray(record.educations) ? record.educations
        : Array.isArray(record.schools) ? record.schools : [];
    const companyIds = [...new Set([
      ...experienceRows.map((row) => row?.company_id ?? row?.company?.id),
      ...educationRows.map((row) => row?.school?.id ?? row?.school_id),
    ].filter((id) => id != null).map(String))].slice(0, MAX_RANK_LOOKUPS);
    const { ranks, degraded } = await talentRanks(companyIds);

    const profile = {
      name: str(record.name ?? record.full_name),
      // title is null on real payloads; one_liner carries the headline.
      title: str(record.title ?? record.one_liner ?? record.headline),
      location: str(record.location),
      about: str(record.about ?? record.summary),
      imageSrc: str(record.image_src ?? record.imageSrc ?? record.profile_pic_url ?? record.profile_picture_url),
      linkedin: str(record.linkedin_user ?? record.public_identifier),
      updatedAt: record.updated_at ?? null,
      // The number behind the S/A/B/C letter, and Paraform's own fake-profile
      // flag. Both are cheap scalars already on the record and both are rule
      // criteria; same mirroring rule as the ids above.
      densityScore: typeof record.candidate_talent_density_score === "number"
        ? record.candidate_talent_density_score
        : null,
      possibleFake: Boolean(record.possible_fake_candidate),
      resumeUrl: str(resume?.signed_url ?? resume?.signedUrl ?? resume?.url ?? resume?.resume_uri ?? resume?.uri),
      experiences: experienceRows.map((row) => mapExperience(row, ranks)),
      education: educationRows.map((row) => mapEducation(row, ranks)),
    };

    // A degraded walk is served but not cached: caching it would pin missing
    // ranks for six hours after the cookie comes back.
    if (!degraded) await setJson(K.profile(cu), profile, PROFILE_TTL_SECONDS).catch(() => {});
    return res.status(200).json({
      ok: true,
      ...(degraded ? { degraded: "paraform_auth" } : {}),
      ...profile,
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: "profile_unavailable",
      detail: String(error?.message || error).slice(0, 180),
    });
  }
};
}

export default createProfileHandler();
