import {
  fetchCall,
  isSuccessfulCall,
  linkedinHandle,
  normName,
  scoreIdentity,
} from "./core.mjs";

const CALLS_LOOKUP = String(
  process.env.RAYDAR_CALLS_LOOKUP_API || "https://raydar-calls.vercel.app/api/lookup",
).trim();
const MAX_CALLS_TO_VERIFY = Number(process.env.PARAAI_MAX_CALLS_TO_VERIFY || 8);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function linkedinUrl(value) {
  const handle = linkedinHandle(value);
  return handle ? `https://www.linkedin.com/in/${handle}` : null;
}

function candidateRole(item) {
  const direct = [item?.current_title, item?.job_title, item?.headline].map(text).find(Boolean);
  if (direct) return direct;
  for (const row of item?.roles || []) {
    const title = text(row?.title || row?.name || row?.role_title);
    if (title) return title;
  }
  for (const row of item?.furthest_statuses || []) {
    const title = text(row?.role?.title || row?.role?.name);
    if (title) return title;
  }
  return null;
}

export function candidateSummary(item) {
  return {
    id: String(item?.id || ""),
    name: text(item?.name) || "Unknown candidate",
    location: text(item?.location) || null,
    role: candidateRole(item),
    linkedinUrl: linkedinUrl(item?.linkedin_user || item?.linkedin_url || item?.linkedinUrl),
  };
}

export function searchCandidates(items, query, limit = 8) {
  const wanted = normName(query);
  if (wanted.length < 2) return [];
  const queryTokens = wanted.split(" ").filter(Boolean);
  return (items || [])
    .map((item, index) => {
      const name = normName(item?.name);
      const nameTokens = name.split(" ").filter(Boolean);
      if (!name || !queryTokens.every((token) => nameTokens.some((part) => part.startsWith(token)))) return null;
      const rank = name === wanted ? 0 : name.startsWith(wanted) ? 1 : nameTokens.some((part) => part.startsWith(wanted)) ? 2 : 3;
      return { item, rank, index, updatedAt: Date.parse(item?.updated_at || "") || 0 };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt || a.index - b.index)
    .slice(0, Math.max(1, limit))
    .map(({ item }) => candidateSummary(item));
}

function callCandidate(call) {
  const candidate = call?.candidate || {};
  return {
    fullName: candidate.fullName || candidate.name || "",
    linkedin: candidate.linkedin || "",
    phone: candidate.phone || "",
    scheduledStart: candidate.scheduledStart || null,
  };
}

export function selectedCallMatch(crmItem, call, sameNameCount = 1) {
  const candidate = callCandidate(call);
  const score = scoreIdentity(candidate, crmItem);
  if (score.ok) return { ok: true, confidence: "strong", signals: score.signals };
  const exactName = normName(candidate.fullName) && normName(candidate.fullName) === normName(crmItem?.name);
  if (exactName && sameNameCount === 1) {
    return { ok: true, confidence: "selected_unique_name", signals: ["human_selected_id", "unique_name"] };
  }
  return { ok: false, confidence: null, signals: score.signals };
}

function lookupHeaders() {
  const access = String(process.env.RAYDAR_CALLS_ACCESS_CODE || "").trim();
  return access ? { "x-raydar-access": access } : {};
}

export async function resolveCandidateCall(crmItem, allCrmItems, { fetchImpl = fetch, fetchCallImpl = fetchCall } = {}) {
  const name = text(crmItem?.name);
  if (!name) return { call: null, reason: "candidate_name_missing" };
  const url = `${CALLS_LOOKUP}${CALLS_LOOKUP.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}`;
  const response = await fetchImpl(url, {
    headers: lookupHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `call search failed: ${response.status}`);

  const exactName = normName(name);
  const sameNameCount = (allCrmItems || []).filter((item) => normName(item?.name) === exactName).length;
  const crmLinkedin = linkedinHandle(crmItem?.linkedin_user || crmItem?.linkedin_url || crmItem?.linkedinUrl);
  const rows = (body?.results || [])
    .filter((row) => normName(row?.name) === exactName)
    .map((row) => ({
      row,
      linkedinMatch: Boolean(crmLinkedin && crmLinkedin === linkedinHandle(row?.linkedin)),
      at: Date.parse(row?.joinAt || row?.scheduledStart || "") || 0,
    }))
    .sort((a, b) => Number(b.linkedinMatch) - Number(a.linkedinMatch) || b.at - a.at)
    .slice(0, Math.max(1, MAX_CALLS_TO_VERIFY));

  let nameFallback = null;
  for (const { row } of rows) {
    const call = await fetchCallImpl(row.botId).catch(() => null);
    if (!call || !isSuccessfulCall(call)) continue;
    const match = selectedCallMatch(crmItem, call, sameNameCount);
    if (!match.ok) continue;
    const resolved = {
      botId: call.botId,
      link: `${String(process.env.MONITOR_URL || "https://monitor.raydar.xyz").replace(/\/+$/, "")}/c/${call.botId}`,
      joinAt: call.joinAt || row.joinAt || null,
      label: call?.verdict?.label || "Screening completed",
      confidence: match.confidence,
      signals: match.signals,
    };
    if (match.confidence === "strong") return { call: resolved, reason: null };
    if (!nameFallback) nameFallback = resolved;
  }
  return nameFallback ? { call: nameFallback, reason: null } : { call: null, reason: "no_successful_screen" };
}
