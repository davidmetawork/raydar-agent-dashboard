// Which interview requests the outreach lane covers (David, 2026-10-12:
// "cover the whole agency"). Paraform sends a Para AI request to the recruiter
// whose Talent Network holds the candidate, so requests on Vanessa's, Alzen's
// and Noah's seats never reached this lane while it read David's own history
// (agencyView:false). Two expired that way the same day with no candidate
// email at all; Alzen left on 2026-09-30, so nobody watches his seat.
//
// The lane now reads the agency view and keeps:
//   - David's own requests, exactly as before;
//   - requests on the named teammates' seats (an allow-list, not "everyone but
//     X": a seat added later stays out until it is named here or in
//     PARAAI_OUTREACH_TEAMMATES).
// Kyra's seat is never covered, whatever the configuration says: the standing
// protected-recruiter rule (api/seq/_lib/protected.mjs) bars any lane from
// emailing her candidates, and this lane was only safe for them because it
// read David's requests alone. A teammate's request for a candidate who also
// has a request on Kyra's seat is left out too.
//
// Anything ambiguous fails closed to the old behaviour: the reader goes back
// to David's own scoped read for that read (see readSubmissionRequestHistory
// WithScope in outreach.mjs).
import { protectedRecruiterForPoster } from "../../seq/_lib/protected.mjs";

export const OUTREACH_TEAMMATES_DEFAULT = Object.freeze(["vanessa", "alzen", "noah"]);
const NEVER_COVERED = new Set(["kyra"]);

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const off = (value) => ["0", "false", "off", "no"].includes(text(value).toLowerCase());

export function outreachScopeConfig(env = process.env) {
  // Set but empty means nobody: only David's own requests.
  const listed = Object.prototype.hasOwnProperty.call(env || {}, "PARAAI_OUTREACH_TEAMMATES")
    ? text(env.PARAAI_OUTREACH_TEAMMATES).split(",")
    : OUTREACH_TEAMMATES_DEFAULT;
  const teammates = listed
    .map((value) => text(value).toLowerCase())
    .filter((value) => /^[a-z]+$/.test(value) && !NEVER_COVERED.has(value));
  return {
    // PARAAI_OUTREACH_AGENCY_VIEW=off puts the lane back on David's requests only.
    agencyView: !off(env?.PARAAI_OUTREACH_AGENCY_VIEW),
    teammates: Object.freeze([...new Set(teammates)]),
  };
}

// The response may carry a recruiter directory next to the rows (the agency
// filter's options). Read it when present; never require it.
export function recruiterDirectory(result) {
  const directory = new Map();
  for (const key of ["recruiters", "agencyRecruiters", "agencyMembers", "members", "users"]) {
    const list = result?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = text(item?.id || item?.user_id || item?.userId);
      if (!id) continue;
      directory.set(id, { name: personName(item), email: text(item?.email).toLowerCase() });
    }
  }
  return directory;
}

function personName(person) {
  if (!person || typeof person !== "object") return "";
  return text(
    person.name ||
    person.full_name ||
    person.fullName ||
    [person.first_name ?? person.firstName, person.last_name ?? person.lastName]
      .filter(Boolean)
      .join(" ") ||
    person.user?.name ||
    "",
  );
}

// "vanessa" from "Vanessa Vallador" or vanessa@raydargroup.com.
export function recruiterKey({ name = "", email = "" } = {}) {
  const first = text(name).toLowerCase().split(" ")[0].replace(/[^a-z]/g, "");
  if (first) return first;
  const local = text(email).toLowerCase().split("@")[0].split(/[._+-]/)[0].replace(/[^a-z]/g, "");
  return local || "";
}

// Who a request was sent to, from every source on the row. sent_to_user_id
// and recruiter.id both equalled currentUserId on all 306 rows of the
// 2026-07-28 capture. Two different ids, or two different names, are a
// conflict: the row cannot be trusted either way.
export function requestRecruiter(row, directory = new Map()) {
  const recruiter = row?.recruiter || row?.sent_to_user || row?.sentToUser || null;
  const ids = [...new Set(
    [row?.sent_to_user_id, row?.sentToUserId, recruiter?.id, row?.recruiter_id].map(text).filter(Boolean),
  )];
  const userId = ids.length === 1 ? ids[0] : "";
  const listed = userId ? directory.get(userId) : null;
  const people = [
    { name: personName(recruiter), email: text(recruiter?.email || recruiter?.user?.email).toLowerCase() },
    { name: text(row?.recruiter_name || row?.recruiterName), email: text(row?.recruiter_email).toLowerCase() },
    listed || { name: "", email: "" },
  ];
  // Names decide; an email is used only when no source has a name, because
  // an address need not start with the first name (vvallador@...).
  const unique = (values) => [...new Set(values.filter(Boolean))];
  const nameKeys = unique(people.map((person) => recruiterKey({ name: person.name })));
  const emailKeys = unique(people.map((person) => recruiterKey({ email: person.email })));
  const keys = nameKeys.length ? nameKeys : emailKeys;
  const isProtected = [...nameKeys, ...emailKeys].some((key) => NEVER_COVERED.has(key)) || people.some((person) => (
    protectedRecruiterForPoster(person.name) || protectedRecruiterForPoster(person.email)
  ));
  return {
    userId,
    key: keys.length === 1 ? keys[0] : "",
    isProtected,
    conflict: ids.length > 1 ? "recruiter_ids_disagree" : (keys.length > 1 ? "recruiter_names_disagree" : null),
  };
}

// The lane's verdict on one raw row. With the agency view off every row is
// David's (the read is scoped to him), as before. `unidentifiable` makes the
// caller fall back to the scoped read: without a single trustworthy id, David's
// own rows cannot be told apart from anyone else's.
export function requestScope(row, {
  scope = outreachScopeConfig(),
  currentUserId = "",
  directory = new Map(),
} = {}) {
  const recruiter = requestRecruiter(row, directory);
  const base = { userId: recruiter.userId, key: recruiter.key, own: false, covered: false, excluded: null, unidentifiable: false };
  if (!scope.agencyView) return { ...base, own: true, covered: true };
  const me = text(currentUserId);
  if (!me || !recruiter.userId || recruiter.conflict) {
    return { ...base, unidentifiable: true, excluded: recruiter.conflict || "recruiter_unidentifiable" };
  }
  if (recruiter.userId === me) return { ...base, key: "david", own: true, covered: true };
  if (recruiter.isProtected) return { ...base, excluded: "protected_recruiter" };
  if (!recruiter.key) return { ...base, excluded: "recruiter_unknown" };
  if (!scope.teammates.includes(recruiter.key)) return { ...base, excluded: "recruiter_not_listed" };
  return { ...base, covered: true };
}

// Counts for health and the operator's inspect-pending read: staff first
// names only, no candidate data.
export function summarizeScope(entries) {
  const byRecruiter = {};
  for (const { scope, status } of entries) {
    const label = scope.own ? "david" : (scope.key || "unknown");
    const bucket = byRecruiter[label] ||= { rows: 0, pending: 0, coveredPending: 0, excluded: {} };
    bucket.rows += 1;
    if (status === "pending") {
      bucket.pending += 1;
      if (scope.covered) bucket.coveredPending += 1;
      else bucket.excluded[scope.excluded || "excluded"] = (bucket.excluded[scope.excluded || "excluded"] || 0) + 1;
    }
  }
  return byRecruiter;
}

// The NAMES (never values) of the recruiter fields on a row we could not
// read, so a shape change can be fixed without another capture.
export function recruiterShapeHint(row) {
  const recruiter = row?.recruiter || row?.sent_to_user || row?.sentToUser || null;
  return {
    rowKeys: Object.keys(row || {}).filter((key) => /recruit|sent_to|user/i.test(key)).sort(),
    recruiterKeys: recruiter && typeof recruiter === "object" ? Object.keys(recruiter).sort() : [],
  };
}
