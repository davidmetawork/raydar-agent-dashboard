import {
  applyInboxTriage,
  assembleInboxSnapshotFeed,
  readInboxSnapshotState,
  readInboxTriage,
} from "../../inbox/_lib/core.mjs";
import { hashGetAllJson, K } from "../../applicants/_lib/kv.mjs";
import { listCuratedListCandidates } from "../../paraai/_lib/interest.mjs";
import {
  listInterestHandoffRecords,
  listInterestSnapshots,
  listPendingJobs,
} from "../../paraai/_lib/interest-store.mjs";
import { listReplyRecords } from "../../paraai/_lib/reply-store.mjs";
import { rowHash, readExternalSources } from "./store.mjs";

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export const SIGNAL_COPY = Object.freeze({
  hiring_manager_requested: "Hiring manager asked",
  good_fit_promised: "We promised to send their profile",
  curated_list_interested: "Clicked interested on their list",
  paraai_reply_yes: "Replied yes",
  sequence_reply_interested: "Replied interested",
  applicants_interview: "We chose to interview them",
  match_watch_replied: "Replied to a list of roles",
  not_interested: "Not interested",
});

const priority = (code) => ({
  hiring_manager_requested: 0,
  good_fit_promised: 1,
  curated_list_interested: 2,
  paraai_reply_yes: 2,
  sequence_reply_interested: 2,
  applicants_interview: 4,
  match_watch_replied: 5,
  not_interested: 9,
}[code] ?? 8);

function signal(code, at, detail = null) {
  return {
    code,
    label: SIGNAL_COPY[code] || code.replace(/_/g, " "),
    at: text(at) || null,
    detail: text(detail) || null,
    priority: priority(code),
  };
}

function candidateEmailRows(inboxFeed = {}) {
  return (inboxFeed.replies || []).filter((row) => (
    row?.reply_category === "INTERESTED"
    && !row?.is_archived
    && !row?.triage_status
  ));
}

export function buildSignalPairs({
  requests = [],
  curatedCandidates = [],
  interestSnapshots = new Map(),
  interestRecords = [],
  replyRecords = [],
  inboxFeed = null,
  applicantDecisions = {},
  external = null,
} = {}) {
  const pairs = new Map();
  const unresolved = [];
  const candidateById = new Map(curatedCandidates.map((candidate) => [candidate.candidateUserId, candidate]));
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const rolesByCandidate = new Map();

  const ensure = ({ candidateUserId, roleId, candidateName, roleName, companyName }) => {
    const candidate = text(candidateUserId);
    const role = text(roleId);
    if (!candidate || !role) return null;
    const key = rowHash(candidate, role);
    const current = pairs.get(key) || {
      key,
      candidateUserId: candidate,
      candidateName: text(candidateName) || candidateById.get(candidate)?.name || "Candidate",
      roleId: role,
      roleName: text(roleName) || "Role",
      companyName: text(companyName) || "Company",
      signals: [],
    };
    if (current.candidateName === "Candidate" && text(candidateName)) current.candidateName = text(candidateName);
    if (current.roleName === "Role" && text(roleName)) current.roleName = text(roleName);
    if (current.companyName === "Company" && text(companyName)) current.companyName = text(companyName);
    pairs.set(key, current);
    const roles = rolesByCandidate.get(candidate) || new Set();
    roles.add(role);
    rolesByCandidate.set(candidate, roles);
    return current;
  };
  const add = (row, nextSignal) => {
    if (!row || row.signals.some((item) => (
      item.code === nextSignal.code && item.at === nextSignal.at && item.detail === nextSignal.detail
    ))) return;
    row.signals.push(nextSignal);
  };

  for (const request of requests) {
    add(ensure(request), signal("hiring_manager_requested", request.createdAt));
  }

  for (const candidate of curatedCandidates) {
    const snapshot = interestSnapshots.get(candidate.candidateUserId);
    for (const [roleId, status] of Object.entries(snapshot?.statuses || {})) {
      const row = ensure({ ...candidate, roleId });
      if (status === "APPLIED_TO_ROLE") {
        add(row, signal("curated_list_interested", snapshot.updatedAt));
      } else if (status === "NOT_INTERESTED") {
        add(row, signal("not_interested", snapshot.updatedAt));
      }
    }
  }

  for (const record of interestRecords) {
    for (const roleId of record?.roles || []) {
      const row = ensure({
        candidateUserId: record.candidateUserId,
        candidateName: candidateById.get(record.candidateUserId)?.name,
        roleId,
      });
      add(row, signal("curated_list_interested", record.updatedAt || record.createdAt));
    }
  }

  for (const record of replyRecords) {
    if (record?.decision?.intent !== "yes") continue;
    const requestIds = [...new Set([
      ...(record?.decision?.targetRequestIds || []),
      ...(record?.plan?.requestIds || []),
    ])];
    let joined = 0;
    for (const requestId of requestIds) {
      const request = requestById.get(requestId);
      if (!request) continue;
      joined += 1;
      add(ensure(request), signal("paraai_reply_yes", record.createdAt || record.updatedAt));
    }
    if (!joined) unresolved.push({ source: "paraai_reply_yes", candidateUserId: record.candidateUserId || null });
  }

  for (const row of external?.interviewFollowups || []) {
    add(ensure(row), signal("good_fit_promised", row.promisedAt));
  }
  for (const row of external?.matchWatch || []) {
    for (const roleId of row.roleIds || []) {
      add(ensure({ candidateUserId: row.candidateUserId, roleId }), signal(
        "match_watch_replied",
        row.repliedAt,
        `Replied to a list of ${Number(row.listSize) || row.roleIds.length} roles`,
      ));
    }
  }

  for (const [key, decision] of Object.entries(applicantDecisions || {})) {
    if (decision?.action !== "interview") continue;
    const [candidateUserId, roleId] = key.split(":");
    add(ensure({
      candidateUserId,
      candidateName: decision.name,
      roleId,
      roleName: decision.roleTitle,
    }), signal("applicants_interview", decision.at));
  }

  for (const reply of candidateEmailRows(inboxFeed || {})) {
    const candidateUserId = text(reply.candidate_user_id);
    if (!candidateUserId) {
      unresolved.push({ source: "sequence_reply_interested", candidateUserId: null });
      continue;
    }
    const exactRoleId = text(reply.role_id || reply.roleId);
    const roles = exactRoleId
      ? [exactRoleId]
      : [...(rolesByCandidate.get(candidateUserId) || [])];
    if (!roles.length) {
      unresolved.push({ source: "sequence_reply_interested", candidateUserId });
      continue;
    }
    for (const roleId of roles) {
      add(ensure({
        candidateUserId,
        candidateName: reply.candidate_name,
        roleId,
      }), signal("sequence_reply_interested", reply.date));
    }
  }

  for (const row of pairs.values()) {
    row.signals.sort((left, right) => left.priority - right.priority
      || (Date.parse(left.at || "") || 0) - (Date.parse(right.at || "") || 0));
  }
  return { pairs: [...pairs.values()], unresolved };
}

async function cachedInboxFeed() {
  const [state, triage] = await Promise.all([readInboxSnapshotState(), readInboxTriage()]);
  if (state.status !== "ready") return null;
  const feed = assembleInboxSnapshotFeed(state.value);
  return triage.status === "ready" ? applyInboxTriage(feed, triage.value) : feed;
}

export async function readSignalSources({
  requests = [],
  listCandidatesImpl = listCuratedListCandidates,
  listSnapshotsImpl = listInterestSnapshots,
  listHandoffsImpl = listInterestHandoffRecords,
  listJobsImpl = listPendingJobs,
  listRepliesImpl = listReplyRecords,
  readInboxImpl = cachedInboxFeed,
  readDecisionsImpl = () => hashGetAllJson(K.decisions),
  readExternalImpl = readExternalSources,
} = {}) {
  const errors = [];
  const candidates = await listCandidatesImpl().catch((error) => {
    errors.push({ source: "curated_candidates", error });
    return [];
  });
  const settled = await Promise.allSettled([
    listSnapshotsImpl(candidates.map((candidate) => candidate.candidateUserId)),
    listHandoffsImpl(2_000),
    listJobsImpl(500),
    listRepliesImpl(500),
    readInboxImpl(),
    readDecisionsImpl(),
    readExternalImpl(),
  ]);
  const names = ["interest_snapshots", "interest_handoffs", "interest_jobs", "reply_records", "inbox", "applicants", "external"];
  const value = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    errors.push({ source: names[index], error: result.reason });
    return index === 0 ? new Map() : index === 5 ? {} : index === 6 ? null : [];
  });
  const interestRecords = [...(value[1] || []), ...(value[2] || [])];
  const built = buildSignalPairs({
    requests,
    curatedCandidates: candidates,
    interestSnapshots: value[0],
    interestRecords,
    replyRecords: value[3],
    inboxFeed: value[4],
    applicantDecisions: value[5],
    external: value[6],
  });
  return {
    ...built,
    errors: errors.map((entry) => ({
      source: entry.source,
      code: String(entry.error?.code || "read_failed"),
    })),
    coverage: {
      curatedCandidates: candidates.length,
      curatedSnapshots: [...value[0].values()].filter(Boolean).length,
      externalGeneratedAt: value[6]?.generatedAt || null,
      inboxGeneratedAt: value[4]?.generated_at || null,
    },
  };
}
