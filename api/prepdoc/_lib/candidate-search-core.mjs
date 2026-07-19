// api/prepdoc/_lib/candidate-search-core.mjs — CRM candidate search for the
// Prep tab picker, served directly from the dashboard with its own Paraform
// session (the same credential the roles dropdown already uses). This is the
// hard identity gate: a prep job may only be enqueued for a candidate that
// was found here (candidate_user_id) or referenced by a paraform.com URL —
// free-text names can no longer reach the runner.
//
// Paraform has no server-side CRM search, so this is the documented paginated
// updated_at-desc scan with a client-side substring match. Bounds: <=3 pages
// of 50 per query, 120s per-term cache, single-flight per term. Cards carry
// only what the picker renders: no emails, no notes, no raw CRM payloads.

const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 50;
const PAGE_LIMIT = 50;
const MAX_PAGES = 3;
const PAGE_GAP_MS = 300;
const MAX_RESULTS = 8;

const cacheEntries = new Map();
const inFlight = new Map();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheGet(key, now) {
  const hit = cacheEntries.get(key);
  if (!hit || now - hit.at > CACHE_TTL_MS) return null;
  return hit.value;
}
function cacheSet(key, value, now) {
  cacheEntries.set(key, { at: now, value });
  while (cacheEntries.size > CACHE_MAX_ENTRIES) {
    cacheEntries.delete(cacheEntries.keys().next().value);
  }
}

const text = (value, max = 200) => {
  const out = String(value ?? "").replace(/\s+/g, " ").trim();
  return out ? out.slice(0, max) : null;
};

function crmCandidateOf(item) {
  return item?.candidate && typeof item.candidate === "object" ? item.candidate : item || {};
}

function crmNameOf(item) {
  const candidate = crmCandidateOf(item);
  return text(
    candidate.name || candidate.full_name ||
    [candidate.first_name, candidate.last_name].filter(Boolean).join(" ") ||
    item?.name || item?.candidate_name,
    120,
  );
}

function crmIdOf(item) {
  return item?.candidate_user_id || item?.cu_id || item?.candidateUserId || item?.id || null;
}

function headlineOf(item) {
  const candidate = crmCandidateOf(item);
  const explicit = text(candidate.one_liner || item?.one_liner, 160);
  if (explicit) return explicit;
  const experience = Array.isArray(candidate.experiences) ? candidate.experiences[0] : null;
  const title = text(experience?.role_title || experience?.title, 80);
  const company = text(experience?.company?.name || experience?.company_name, 80);
  if (title && company) return `${title} @ ${company}`;
  return title || null;
}

function emailPresent(item) {
  const candidate = crmCandidateOf(item);
  return [
    ...(Array.isArray(item?.emails) ? item.emails : []),
    ...(Array.isArray(candidate.emails) ? candidate.emails : []),
    candidate.email, item?.email,
  ].some((value) => typeof value === "string" && value.includes("@"));
}

export function identityCard(item) {
  const candidate = crmCandidateOf(item);
  const id = crmIdOf(item);
  if (!id) return null;
  return {
    candidate_user_id: id,
    name: crmNameOf(item),
    headline: headlineOf(item),
    location: text(candidate.location || item?.location, 120),
    avatar_url: text(candidate.image_src || candidate.img_src || item?.image_src, 500),
    linkedin_present: !!(candidate.linkedin_user || candidate.linkedin_url || item?.linkedin_user),
    email_present: emailPresent(item),
    updated_at: text(item?.updated_at || candidate.updated_at, 40),
  };
}

async function scanCrm(term, trpcGet) {
  const needle = term.toLowerCase();
  const cards = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES && cards.length < MAX_RESULTS * 2; page++) {
    const response = await trpcGet("candidateUser.getCRMExternalCandidates", {
      limit: PAGE_LIMIT,
      ...(cursor != null ? { cursor } : {}),
      filters: {
        sort: { field: "updated_at", direction: "desc" },
        ...(term ? { general_search: term } : {}),
      },
    });
    const items = response?.items || [];
    for (const item of items) {
      const name = crmNameOf(item);
      if (name && name.toLowerCase().includes(needle)) {
        const card = identityCard(item);
        if (card) cards.push(card);
      }
    }
    cursor = response?.next_cursor ?? null;
    if (cursor == null || !items.length) break;
    await wait(PAGE_GAP_MS);
  }
  return cards;
}

async function applicationsFor(candidateUserId, trpcGet) {
  const rows = await trpcGet("candidateUser.getCandidateUserApplications", {
    candidate_user_id: candidateUserId,
  }).catch(() => null);
  return (Array.isArray(rows) ? rows : []).slice(0, 8).map((row) => ({
    application_id: row?.id || null,
    role_id: row?.role_id || null,
    role_title: text(row?.role?.name, 120),
    client: text(row?.role?.company?.name || row?.role?.company_name, 120),
  })).filter((row) => row.role_id);
}

export async function searchCandidates(query, { trpcGet, limit = MAX_RESULTS, now = Date.now() }) {
  const term = String(query || "").replace(/\s+/g, " ").trim();
  if (term.length < 2) return { query: term, results: [] };
  const boundedLimit = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || MAX_RESULTS));
  const key = `${term.toLowerCase()} ${boundedLimit}`;
  const cached = cacheGet(key, now);
  if (cached) return cached;
  if (inFlight.has(key)) return inFlight.get(key);

  const pending = (async () => {
    const cards = (await scanCrm(term, trpcGet)).slice(0, boundedLimit);
    const results = [];
    for (const card of cards) {
      results.push({ ...card, applications: await applicationsFor(card.candidate_user_id, trpcGet) });
    }
    const value = { query: term, results };
    cacheSet(key, value, Date.now());
    return value;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}
