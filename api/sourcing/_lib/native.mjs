import { createHash, randomUUID } from "node:crypto";
import {
  nativeSaveCandidate,
  nativeSearchCreateSession,
  nativeSearchPaginate,
  nativeSearchSubmit,
} from "./core.mjs";
import { dedupeResults } from "../../../sourcing-domain.mjs";
import { bookedSet, enrolledElsewhereSet } from "../../seq/_lib/core.mjs";

const text = (value) => String(value ?? "").trim();
const rows = (value) => Array.isArray(value) ? value : [];
const first = (...values) => values.map(text).find(Boolean) || "";
const identity = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 24);

export function normalizeNativeHit(hit = {}, lane = {}) {
  const current = hit.currentPosition || hit.current_position || hit.currentRole || hit.current_role || {};
  const linkedinSlug = first(hit.linkedinSlug, hit.linkedin_slug, hit.linkedin_url, hit.linkedin);
  const sourceId = first(hit.candidateDbId, hit.candidate_db_id, hit.candidateId, hit.candidate_id, hit.id, linkedinSlug);
  if (!sourceId) return null;
  return {
    id: `cand-${identity(sourceId)}`,
    candidateId: sourceId,
    candidateUserId: first(hit.savedRecordId, hit.saved_record_id, hit.candidate_user_id) || null,
    linkedinSlug: linkedinSlug || null,
    name: first(hit.name, hit.full_name) || "Unknown candidate",
    title: first(hit.title, hit.oneLiner, hit.one_liner, current.title, current.role_title),
    company: first(hit.company, hit.companyName, hit.company_name, current.company, current.company_name, current.name),
    location: first(hit.location, hit.location_name, hit.city),
    laneId: lane.id,
    laneName: lane.name,
    state: "discovered",
    projectStatus: "pending",
    feedback: null,
  };
}

export function buildLaneQuery(rubric, lane, adjustments = []) {
  const role = rubric?.role || {};
  const must = rows(rubric?.mustHaves);
  const pref = rows(rubric?.preferences);
  const positive = rubric?.searchSignals || {};
  const negative = rubric?.exclusions || {};
  const parts = [
    `Find strong candidates for ${first(role.title, "this role")}${role.company ? ` at ${role.company}` : ""}.`,
    lane?.rationale ? `Search angle: ${lane.rationale}` : "",
    must.length ? `Must have: ${must.join("; ")}.` : "",
    pref.length ? `Prefer: ${pref.join("; ")}.` : "",
    rows(positive.titles).length ? `Target titles: ${positive.titles.join(", ")}.` : "",
    rows(positive.skills).length ? `Skills: ${positive.skills.join(", ")}.` : "",
    rows(positive.companies).length ? `Ideal company backgrounds: ${positive.companies.join(", ")}.` : "",
    rows(positive.locations).length ? `Locations: ${positive.locations.join(", ")}.` : "",
    positive.experience ? `Experience: ${positive.experience}.` : "",
    rows(negative.titles).length ? `Exclude titles: ${negative.titles.join(", ")}.` : "",
    rows(negative.skills).length ? `Exclude profiles missing or centered on: ${negative.skills.join(", ")}.` : "",
    rows(negative.companies).length ? `Avoid companies: ${negative.companies.join(", ")}.` : "",
    rows(negative.criteria).length ? `Reject profiles matching these dealbreakers or traits to avoid: ${negative.criteria.join("; ")}.` : "",
    adjustments.length ? `Reviewer-approved calibration: ${adjustments.map((item) => item.action || item).join(" ")}` : "",
  ];
  return parts.filter(Boolean).join(" ").slice(0, 5000);
}

async function pool(items, concurrency, fn) {
  const output = new Array(items.length);
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const current = index++;
      output[current] = await fn(items[current], current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return output;
}

async function searchLane(lane, rubric, adjustments, cap) {
  const created = await nativeSearchCreateSession();
  const sessionId = text(created?.id || created?.session?.id);
  if (!sessionId) throw new Error("Paraform Search did not return a session id");
  const query = buildLaneQuery(rubric, lane, adjustments);
  const firstPage = await nativeSearchSubmit(sessionId, query);
  const results = firstPage?.results || {};
  const collected = [...rows(results.hits)];
  const total = Number(results.total || collected.length);
  const pageSize = Math.min(50, Math.max(1, Number(firstPage?.session?.currentPageSize || collected.length || 50)));
  let page = Number(firstPage?.session?.currentPage || 1);
  while (collected.length < Math.min(total, cap)) {
    page += 1;
    const response = await nativeSearchPaginate(sessionId, page, pageSize);
    const hits = rows(response?.results?.hits);
    if (!hits.length) break;
    collected.push(...hits);
  }
  return {
    id: lane.id,
    name: lane.name,
    rationale: lane.rationale,
    sessionId,
    searchId: text(results.searchId || firstPage?.session?.latestSearchId) || null,
    query,
    reportedTotal: total,
    hits: collected.slice(0, cap),
  };
}

export async function executeNativeSearch({ rubric, lanes, adjustments = [], candidateCap, reviewProject, seenCandidateIds = [], enrolledCandidateUserIds = null, bookedCandidateUserIds = null, fileToProject = false }) {
  lanes = lanes.slice(0, Math.max(1, candidateCap));
  const base = Math.floor(candidateCap / lanes.length);
  let remainder = candidateCap % lanes.length;
  const searched = [];
  // Sequential lanes keep Paraform load predictable and make partial failures auditable.
  for (const lane of lanes) {
    const laneCap = Math.max(1, base + (remainder-- > 0 ? 1 : 0));
    searched.push(await searchLane(lane, rubric, adjustments, laneCap));
  }
  const normalized = searched.flatMap((lane) => lane.hits.map((hit) => normalizeNativeHit(hit, lane)).filter(Boolean));
  const existingIds = normalized.map((candidate) => candidate.candidateUserId).filter(Boolean);
  if (!enrolledCandidateUserIds) enrolledCandidateUserIds = [...(await enrolledElsewhereSet())];
  if (!bookedCandidateUserIds) bookedCandidateUserIds = [...(await bookedSet(existingIds))];
  const deduped = dedupeResults(normalized, { seenCandidateIds, enrolledCandidateUserIds, bookedCandidateUserIds });
  const accepted = deduped.accepted.slice(0, candidateCap);
  const blocked = deduped.blocked;
  let filed = accepted;
  if (fileToProject) {
    filed = await pool(accepted, 3, async (candidate) => {
      if (!candidate.linkedinSlug) return { ...candidate, state: "dedup_blocked", dedupReason: "missing_linkedin_identity", projectStatus: "failed" };
      try {
        const saved = await nativeSaveCandidate(candidate.linkedinSlug, reviewProject.id, reviewProject.name);
        return {
          ...candidate,
          candidateUserId: text(saved?.savedRecordId) || candidate.candidateUserId,
          candidateDbId: text(saved?.candidateDbId) || null,
          state: "in_review",
          projectStatus: "filed",
        };
      } catch (error) {
        return { ...candidate, state: "discovered", projectStatus: "failed", projectError: text(error?.message).slice(0, 160) };
      }
    });
  } else {
    filed = accepted.map((candidate) => ({ ...candidate, state: "in_review", projectStatus: "not_authorized" }));
  }
  return {
    lanes: searched.map(({ hits, ...lane }) => ({ ...lane, resultCount: hits.length })),
    candidates: [...filed, ...blocked],
    discoveredCount: normalized.length,
    reviewCount: filed.filter((candidate) => candidate.state === "in_review").length,
    dedupedCount: blocked.length,
    projectFiledCount: filed.filter((candidate) => candidate.projectStatus === "filed").length,
  };
}

export function newRunId() {
  return `run-${randomUUID()}`;
}
