import { createHash, randomUUID } from "node:crypto";
import {
  nativeSaveCandidate,
  nativeSearchApply,
  nativeSearchCreateSession,
  nativeSearchPaginate,
  nativeSearchSubmit,
} from "./core.mjs";
import { evaluateCandidates } from "./ranking.mjs";
import { dedupeResults } from "../../../sourcing-domain.mjs";
import { bookedSet, enrolledElsewhereSet, projectMembers } from "../../seq/_lib/core.mjs";

const text = (value) => String(value ?? "").trim();
const rows = (value) => Array.isArray(value) ? value : [];
const first = (...values) => values.map(text).find(Boolean) || "";
const identity = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const DEFAULT_ADAPTERS = Object.freeze({
  createSession: nativeSearchCreateSession,
  applyFilters: nativeSearchApply,
  submitSearch: nativeSearchSubmit,
  paginateSearch: nativeSearchPaginate,
  saveCandidate: nativeSaveCandidate,
  projectMembers,
  bookedSet,
  enrolledElsewhereSet: () => enrolledElsewhereSet({ strict: true }),
  wait,
  evaluateCandidates,
});

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
  const laneLabel = `${lane?.id || ""} ${lane?.name || ""}`.toLowerCase();
  const targetTitles = [...new Set([first(role.title), ...rows(positive.titles)].filter(Boolean))].slice(0, 5);
  const locations = rows(positive.locations).length ? rows(positive.locations) : [first(role.location)].filter(Boolean);
  const experience = must.slice(0, laneLabel.includes("company") ? 2 : 3);
  const parts = [
    `Find ${targetTitles.join(" or ") || first(role.title, "relevant")} candidates${locations.length ? ` in ${locations.slice(0, 2).join(" or ")}` : ""}.`,
    laneLabel.includes("adjacent") ? `Include adjacent titles with transferable experience for a ${first(role.title, "similar")} role.` : "",
    laneLabel.includes("company") ? "Prioritize strong company backgrounds and relevant operating environments." : "",
    lane?.rationale && !/^closest interpretation|transferable profiles|target-company/i.test(lane.rationale) ? `Search angle: ${lane.rationale}` : "",
    experience.length ? `Relevant experience: ${experience.join("; ")}.` : "",
    rows(positive.skills).length ? `Skills to boost: ${positive.skills.slice(0, 8).join(", ")}.` : "",
    rows(positive.companies).length ? `Ideal company backgrounds: ${positive.companies.slice(0, 10).join(", ")}.` : "",
    positive.experience ? `Experience range: ${positive.experience}.` : "",
    pref.length ? `Prefer: ${pref.slice(0, 3).join("; ")}.` : "",
    rows(negative.titles).length ? `Exclude titles: ${negative.titles.join(", ")}.` : "",
    rows(negative.skills).length ? `Exclude profiles missing or centered on: ${negative.skills.join(", ")}.` : "",
    rows(negative.companies).length ? `Avoid companies: ${negative.companies.join(", ")}.` : "",
    adjustments.length ? `Reviewer-approved calibration: ${adjustments.map((item) => item.action || item).join(" ")}` : "",
  ];
  // Paraform's current submitNlSearch schema rejects queries over 1,000
  // characters. Keep the query to native, searchable attributes. Subjective
  // review-only exclusions stay in the persisted rubric: feeding phrases such
  // as "frequent job hopper" to NL Search has been observed to turn them into
  // positive keyword filters instead of exclusions.
  let query = "";
  for (const part of parts.filter(Boolean)) {
    const room = 1000 - query.length - (query ? 1 : 0);
    if (room <= 0) break;
    query += `${query ? " " : ""}${part.slice(0, room)}`;
  }
  return query;
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

async function searchLane(lane, rubric, adjustments, cap, adapters) {
  const created = await adapters.createSession();
  const sessionId = text(created?.id || created?.session?.id);
  if (!sessionId) throw new Error("Paraform Search did not return a session id");
  const query = buildLaneQuery(rubric, lane, adjustments);
  const firstPage = await adapters.submitSearch(sessionId, query);
  const results = firstPage?.results || {};
  const collected = [...rows(results.hits)];
  const total = Number(results.total || collected.length);
  const pageSize = Math.min(50, Math.max(1, Number(firstPage?.session?.currentPageSize || collected.length || 50)));
  let page = Number(firstPage?.session?.currentPage || 1);
  while (collected.length < Math.min(total, cap)) {
    page += 1;
    const response = await adapters.paginateSearch(sessionId, page, pageSize);
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

async function verifyProjectMembership(adapters, projectId, candidateUserIds) {
  const expected = new Set(candidateUserIds.map(text).filter(Boolean));
  const delays = [250, 750, 1500, 2500];
  let members = new Set();
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length && expected.size; attempt++) {
    try {
      members = new Set(rows(await adapters.projectMembers(projectId)).map((item) => text(item?.id)).filter(Boolean));
      lastError = null;
      if ([...expected].every((id) => members.has(id))) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < delays.length) await adapters.wait(delays[attempt]);
  }
  return { members, error: lastError };
}

async function fileCandidates({ accepted, adapters, reviewProject, fileToProject, enrolledCandidateUserIds, bookedCandidateUserIds }) {
  if (!fileToProject) {
    return accepted.map((candidate) => ({ ...candidate, state: "in_review", projectStatus: "not_authorized" }));
  }
  let filed = await pool(accepted, 3, async (candidate) => {
    if (!candidate.linkedinSlug) return { ...candidate, state: "dedup_blocked", dedupReason: "missing_linkedin_identity", projectStatus: "failed" };
    try {
      const saved = await adapters.saveCandidate(candidate.linkedinSlug, reviewProject.id, reviewProject.name);
      const candidateUserId = text(saved?.savedRecordId) || candidate.candidateUserId;
      if (!candidateUserId) {
        return { ...candidate, state: "discovered", projectStatus: "failed", projectError: "Paraform save returned no candidate identity" };
      }
      return {
        ...candidate,
        candidateUserId,
        candidateDbId: text(saved?.candidateDbId) || null,
        state: "discovered",
        projectStatus: "verification_pending",
      };
    } catch (error) {
      return { ...candidate, state: "discovered", projectStatus: "failed", projectError: text(error?.message).slice(0, 160) };
    }
  });
  const pendingIds = filed.filter((candidate) => candidate.projectStatus === "verification_pending").map((candidate) => candidate.candidateUserId);
  const readback = await verifyProjectMembership(adapters, reviewProject.id, pendingIds);
  filed = filed.map((candidate) => {
    if (candidate.projectStatus !== "verification_pending") return candidate;
    if (readback.members.has(candidate.candidateUserId)) {
      return { ...candidate, state: "in_review", projectStatus: "filed", projectVerifiedAt: new Date().toISOString() };
    }
    return {
      ...candidate,
      state: "discovered",
      projectStatus: "readback_failed",
      projectError: text(readback.error?.message || "candidate not found in Project readback").slice(0, 160),
    };
  });

  const filedIds = filed.filter((candidate) => candidate.projectStatus === "filed").map((candidate) => candidate.candidateUserId);
  const enrolled = new Set(enrolledCandidateUserIds === null
    ? await adapters.enrolledElsewhereSet()
    : enrolledCandidateUserIds);
  const booked = new Set(bookedCandidateUserIds === null
    ? await adapters.bookedSet(filedIds)
    : bookedCandidateUserIds);
  return filed.map((candidate) => {
    if (candidate.projectStatus !== "filed") return candidate;
    const reason = booked.has(candidate.candidateUserId)
      ? "booked_or_later"
      : enrolled.has(candidate.candidateUserId) ? "already_in_sequence" : null;
    return reason
      ? { ...candidate, state: "dedup_blocked", dedupReason: reason, dedupStage: "post_project_readback" }
      : candidate;
  });
}

async function structuredSearch(filters, cap, name, adapters) {
  const created = await adapters.createSession();
  const sessionId = text(created?.id || created?.session?.id);
  if (!sessionId) throw new Error("Paraform Search did not return a session id");
  const firstPage = await adapters.applyFilters(sessionId, filters, name);
  const results = firstPage?.results || {};
  const collected = [...rows(results.hits)];
  const total = Number(results.total || collected.length);
  const pageSize = Math.min(100, Math.max(1, Number(firstPage?.session?.currentPageSize || collected.length || 25)));
  let page = Number(firstPage?.session?.currentPage || 1);
  while (collected.length < Math.min(total, cap)) {
    page += 1;
    const response = await adapters.paginateSearch(sessionId, page, pageSize);
    const hits = rows(response?.results?.hits);
    if (!hits.length) break;
    collected.push(...hits);
  }
  return {
    id: "native-filters",
    name: name || "Native filters",
    sessionId,
    searchId: text(results.searchId || firstPage?.session?.latestSearchId) || null,
    reportedTotal: total,
    hits: collected.slice(0, cap),
  };
}

export async function executeHybridSearch({
  rubric,
  nativeFilters,
  agentCriteria = "",
  adjustments = [],
  rankingConfig,
  reviewProject,
  seenCandidateIds = [],
  enrolledCandidateUserIds = null,
  bookedCandidateUserIds = null,
  fileToProject = false,
  searchName = "Raydar hybrid search",
  adapters: adapterOverrides = {},
}) {
  const poolSize = Number(rankingConfig?.poolSize);
  const saveLimit = Number(rankingConfig?.saveLimit);
  const minimumScore = Number(rankingConfig?.minimumScore);
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 100) throw new Error("poolSize must be 1-100");
  if (!Number.isInteger(saveLimit) || saveLimit < 1 || saveLimit > poolSize) throw new Error("saveLimit must be 1-poolSize");
  if (!Number.isInteger(minimumScore) || minimumScore < 0 || minimumScore > 100) throw new Error("minimumScore must be 0-100");
  const adapters = { ...DEFAULT_ADAPTERS, ...adapterOverrides };
  const searched = await structuredSearch(nativeFilters, poolSize, searchName, adapters);
  const pairs = searched.hits.map((raw) => ({ raw, candidate: normalizeNativeHit(raw, searched) })).filter((item) => item.candidate);
  const enrolled = new Set(enrolledCandidateUserIds === null ? await adapters.enrolledElsewhereSet() : enrolledCandidateUserIds);
  const booked = new Set(bookedCandidateUserIds === null
    ? await adapters.bookedSet(pairs.map((item) => item.candidate.candidateUserId).filter(Boolean))
    : bookedCandidateUserIds);
  const deduped = dedupeResults(pairs.map((item) => item.candidate), {
    seenCandidateIds,
    enrolledCandidateUserIds: [...enrolled],
    bookedCandidateUserIds: [...booked],
  });
  const pairById = new Map(pairs.map((item) => [item.candidate.candidateId, item]));
  const evaluable = deduped.accepted.map((candidate) => ({ candidate, raw: pairById.get(candidate.candidateId)?.raw || {} }));
  const ranked = await adapters.evaluateCandidates(evaluable, { rubric, agentCriteria, adjustments });
  const evaluationById = new Map(rows(ranked.evaluations).map((item) => [item.candidateId, item]));
  const evaluated = deduped.accepted.map((candidate) => ({
    ...candidate,
    agentEvaluation: evaluationById.get(candidate.candidateId) || {
      score: 0, hardRequirementsMet: false, confidence: "low", strengths: [], concerns: ["Missing evaluation"], reason: "No evaluator result.",
    },
  })).sort((a, b) => b.agentEvaluation.score - a.agentEvaluation.score || a.id.localeCompare(b.id));
  const selected = evaluated
    .filter((candidate) => candidate.agentEvaluation.hardRequirementsMet && candidate.agentEvaluation.score >= minimumScore)
    .slice(0, saveLimit);
  const filed = await fileCandidates({
    accepted: selected,
    adapters,
    reviewProject,
    fileToProject,
    enrolledCandidateUserIds: [...enrolled],
    bookedCandidateUserIds: bookedCandidateUserIds === null ? null : [...booked],
  });
  return {
    search: { ...searched, hits: undefined, resultCount: searched.hits.length },
    candidates: [...filed, ...deduped.blocked],
    seenCandidateIds: pairs.map((item) => item.candidate.candidateId),
    discoveredCount: pairs.length,
    evaluatedCount: evaluated.length,
    qualifiedCount: evaluated.filter((candidate) => candidate.agentEvaluation.hardRequirementsMet && candidate.agentEvaluation.score >= minimumScore).length,
    selectedCount: selected.length,
    rejectedCount: evaluated.length - selected.length,
    reviewCount: filed.filter((candidate) => candidate.state === "in_review").length,
    dedupedCount: deduped.blocked.length + filed.filter((candidate) => candidate.state === "dedup_blocked").length,
    projectFiledCount: filed.filter((candidate) => candidate.projectStatus === "filed").length,
    ranking: { model: ranked.model, batches: ranked.batches, minimumScore, saveLimit },
  };
}

export async function executeNativeSearch({
  rubric,
  lanes,
  adjustments = [],
  candidateCap,
  reviewProject,
  seenCandidateIds = [],
  enrolledCandidateUserIds = null,
  bookedCandidateUserIds = null,
  fileToProject = false,
  adapters: adapterOverrides = {},
}) {
  const cap = Number(candidateCap);
  if (!Number.isInteger(cap) || cap < 1 || cap > 100) throw new Error("candidateCap must be 1-100");
  const searchLanes = rows(lanes).slice(0, Math.max(1, cap));
  if (!searchLanes.length) throw new Error("at least one Search lane is required");
  const adapters = { ...DEFAULT_ADAPTERS, ...adapterOverrides };
  const base = Math.floor(cap / searchLanes.length);
  let remainder = cap % searchLanes.length;
  const searched = [];
  // Sequential lanes keep Paraform load predictable and make partial failures auditable.
  for (const lane of searchLanes) {
    const laneCap = Math.max(1, base + (remainder-- > 0 ? 1 : 0));
    searched.push(await searchLane(lane, rubric, adjustments, laneCap, adapters));
  }
  const normalized = searched.flatMap((lane) => lane.hits.map((hit) => normalizeNativeHit(hit, lane)).filter(Boolean));
  const existingIds = normalized.map((candidate) => candidate.candidateUserId).filter(Boolean);
  const enrolled = new Set(enrolledCandidateUserIds === null
    ? await adapters.enrolledElsewhereSet()
    : enrolledCandidateUserIds);
  const booked = new Set(bookedCandidateUserIds === null
    ? await adapters.bookedSet(existingIds)
    : bookedCandidateUserIds);
  const deduped = dedupeResults(normalized, {
    seenCandidateIds,
    enrolledCandidateUserIds: [...enrolled],
    bookedCandidateUserIds: [...booked],
  });
  const accepted = deduped.accepted.slice(0, cap);
  const blocked = deduped.blocked;
  let filed = accepted;
  if (fileToProject) {
    filed = await pool(accepted, 3, async (candidate) => {
      if (!candidate.linkedinSlug) return { ...candidate, state: "dedup_blocked", dedupReason: "missing_linkedin_identity", projectStatus: "failed" };
      try {
        const saved = await adapters.saveCandidate(candidate.linkedinSlug, reviewProject.id, reviewProject.name);
        const candidateUserId = text(saved?.savedRecordId) || candidate.candidateUserId;
        if (!candidateUserId) {
          return { ...candidate, state: "discovered", projectStatus: "failed", projectError: "Paraform save returned no candidate identity" };
        }
        return {
          ...candidate,
          candidateUserId,
          candidateDbId: text(saved?.candidateDbId) || null,
          state: "discovered",
          projectStatus: "verification_pending",
        };
      } catch (error) {
        return { ...candidate, state: "discovered", projectStatus: "failed", projectError: text(error?.message).slice(0, 160) };
      }
    });
    const pendingIds = filed
      .filter((candidate) => candidate.projectStatus === "verification_pending")
      .map((candidate) => candidate.candidateUserId);
    const readback = await verifyProjectMembership(adapters, reviewProject.id, pendingIds);
    filed = filed.map((candidate) => {
      if (candidate.projectStatus !== "verification_pending") return candidate;
      if (readback.members.has(candidate.candidateUserId)) {
        return { ...candidate, state: "in_review", projectStatus: "filed", projectVerifiedAt: new Date().toISOString() };
      }
      return {
        ...candidate,
        state: "discovered",
        projectStatus: "readback_failed",
        projectError: text(readback.error?.message || "candidate not found in Project readback").slice(0, 160),
      };
    });

    // saveCandidate resolves the stable candidate-user id for previously unseen
    // profiles. Re-run the safety checks with those resolved ids before review.
    const filedIds = filed.filter((candidate) => candidate.projectStatus === "filed").map((candidate) => candidate.candidateUserId);
    const bookedAfterSave = new Set(bookedCandidateUserIds === null
      ? await adapters.bookedSet(filedIds)
      : bookedCandidateUserIds);
    filed = filed.map((candidate) => {
      if (candidate.projectStatus !== "filed") return candidate;
      const reason = bookedAfterSave.has(candidate.candidateUserId)
        ? "booked_or_later"
        : enrolled.has(candidate.candidateUserId)
          ? "already_in_sequence"
          : null;
      return reason
        ? { ...candidate, state: "dedup_blocked", dedupReason: reason, dedupStage: "post_project_readback" }
        : candidate;
    });
  } else {
    filed = accepted.map((candidate) => ({ ...candidate, state: "in_review", projectStatus: "not_authorized" }));
  }
  const candidates = [...filed, ...blocked];
  return {
    lanes: searched.map(({ hits, ...lane }) => ({ ...lane, resultCount: hits.length })),
    candidates,
    discoveredCount: normalized.length,
    reviewCount: candidates.filter((candidate) => candidate.state === "in_review").length,
    dedupedCount: candidates.filter((candidate) => candidate.state === "dedup_blocked").length,
    projectFiledCount: filed.filter((candidate) => candidate.projectStatus === "filed").length,
  };
}

export function newRunId() {
  return `run-${randomUUID()}`;
}
