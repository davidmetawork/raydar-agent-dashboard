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
// read David's requests alone. A row whose recruiter cannot be named is left
// out too, so an unexpected row shape fails closed to the old behaviour.
import { protectedRecruiterForPoster } from "../../seq/_lib/protected.mjs";

export const OUTREACH_TEAMMATES_DEFAULT = Object.freeze(["vanessa", "alzen", "noah"]);
const NEVER_COVERED = new Set(["kyra"]);

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const off = (value) => ["0", "false", "off", "no"].includes(text(value).toLowerCase());

export function outreachScopeConfig(env = process.env) {
  const configured = text(env.PARAAI_OUTREACH_TEAMMATES);
  const teammates = (configured ? configured.split(",") : OUTREACH_TEAMMATES_DEFAULT)
    .map((value) => text(value).toLowerCase())
    .filter((value) => /^[a-z]+$/.test(value) && !NEVER_COVERED.has(value));
  return {
    // PARAAI_OUTREACH_AGENCY_VIEW=off puts the lane back on David's requests only.
    agencyView: !off(env.PARAAI_OUTREACH_AGENCY_VIEW),
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
      directory.set(id, {
        name: personName(item),
        email: text(item?.email).toLowerCase(),
      });
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

// Who a request was sent to. sent_to_user_id and recruiter.id both equalled
// currentUserId on all 306 rows of the 2026-07-28 capture.
export function requestRecruiter(row, directory = new Map()) {
  const recruiter = row?.recruiter || row?.sent_to_user || row?.sentToUser || null;
  const userId = text(row?.sent_to_user_id || row?.sentToUserId || recruiter?.id || row?.recruiter_id);
  const listed = userId ? directory.get(userId) : null;
  const name = personName(recruiter) || text(row?.recruiter_name || row?.recruiterName) || listed?.name || "";
  const email = text(recruiter?.email || recruiter?.user?.email || row?.recruiter_email).toLowerCase()
    || listed?.email
    || "";
  return { userId, name, email };
}

// "vanessa" from "Vanessa Vallador" or vanessa@raydargroup.com.
export function recruiterKey({ name = "", email = "" } = {}) {
  const first = text(name).toLowerCase().split(" ")[0].replace(/[^a-z]/g, "");
  if (first) return first;
  const local = text(email).toLowerCase().split("@")[0].split(/[._+-]/)[0].replace(/[^a-z]/g, "");
  return local || "";
}

function protectedRecruiter({ name, email }, key) {
  if (NEVER_COVERED.has(key)) return true;
  return Boolean(protectedRecruiterForPoster(name) || protectedRecruiterForPoster(email));
}

// The lane's verdict on one raw row. With the agency view off every row is
// David's (the read is scoped to him), as before.
export function requestScope(row, {
  scope = outreachScopeConfig(),
  currentUserId = "",
  directory = new Map(),
} = {}) {
  const recruiter = requestRecruiter(row, directory);
  const key = recruiterKey(recruiter);
  if (!scope.agencyView) {
    return { ...recruiter, key, own: true, covered: true, excluded: null };
  }
  const me = text(currentUserId);
  const own = me && recruiter.userId ? recruiter.userId === me : key === "david";
  if (own) return { ...recruiter, key, own: true, covered: true, excluded: null };
  if (protectedRecruiter(recruiter, key)) {
    return { ...recruiter, key, own: false, covered: false, excluded: "protected_recruiter" };
  }
  if (!key) return { ...recruiter, key, own: false, covered: false, excluded: "recruiter_unknown" };
  if (!scope.teammates.includes(key)) {
    return { ...recruiter, key, own: false, covered: false, excluded: "recruiter_not_listed" };
  }
  return { ...recruiter, key, own: false, covered: true, excluded: null };
}

// Counts for the operator's inspect-pending read: staff first names only, no
// candidate data.
export function summarizeScope(entries) {
  const byRecruiter = {};
  for (const { scope, status } of entries) {
    const label = scope.own ? "david" : (scope.key || "unknown");
    const bucket = byRecruiter[label] ||= {
      rows: 0,
      pending: 0,
      covered: scope.covered,
      excluded: scope.excluded,
    };
    bucket.rows += 1;
    if (status === "pending") bucket.pending += 1;
  }
  return byRecruiter;
}

// True when nothing on the row says whose request it is. The reader then
// falls back to David's scoped read for that tick, so a shape surprise can
// never cost David's own requests.
export function unidentifiable(scope) {
  return !scope.userId && !scope.key;
}

// A sample of the recruiter fields' NAMES (never values) on a row we could not
// name, so a shape change can be fixed without another capture.
export function recruiterShapeHint(row) {
  const recruiter = row?.recruiter || row?.sent_to_user || row?.sentToUser || null;
  return {
    rowKeys: Object.keys(row || {}).filter((key) => /recruit|sent_to|user/i.test(key)).sort(),
    recruiterKeys: recruiter && typeof recruiter === "object" ? Object.keys(recruiter).sort() : [],
  };
}
