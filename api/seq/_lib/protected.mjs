// PROTECTED RECRUITERS — the durable guardrail behind the standing rule that
// Raydar leaves certain recruiters' job postings COMPLETELY alone: never close
// their jobs, and NEVER enroll or email their candidates.
//
// Background (2026-07-20 incident): the 2026-07-12 LinkedIn-cohort run enrolled
// all 534 applicants to Kyra Wyman's "Corporate Counsel" job into a sent-as-David
// screening sequence. Nothing in code stopped it — the exclusion depended on a
// human remembering during a supervised run, and the human approved it. This
// module makes the exclusion a code invariant enforced at every enrollment and
// send path, backed by a guardian that continuously pauses any protected
// sequence that slips through.
//
// To protect another recruiter, add an entry. Any ONE positive signal (poster,
// LinkedIn job id, or role-title pattern) marks a role as protected — the checks
// are intentionally broad because a false positive only pauses one of OUR
// sequences (reversible), while a false negative emails a protected candidate.

export const PROTECTED_RECRUITERS = [
  {
    key: "kyra-wyman",
    displayName: "Kyra Phillips (Wyman)",
    // Exact LinkedIn "Job poster" strings (case-insensitive, substring-tolerant).
    // The cohort reads the poster on each job row; this is the authoritative
    // source-of-truth signal.
    posterAliases: ["kyra phillips (wyman)", "kyra phillips", "kyra wyman"],
    // Known LinkedIn job IDs owned by this recruiter (from the cohort run logs:
    // Corporate Counsel + its archived Commercial Counsel sibling).
    linkedinJobIds: ["4436912132", "4400419853"],
    // Role-title patterns — the downstream signal once the poster is no longer
    // attached (the Sequences launcher buckets applicants by parsed role title).
    roleTitlePatterns: ["corporate counsel", "commercial counsel"],
  },
];

const norm = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function protectedRecruiterForPoster(poster) {
  const p = norm(poster);
  if (!p) return null;
  return PROTECTED_RECRUITERS.find((r) =>
    r.posterAliases.some((a) => { const n = norm(a); return n && (p === n || p.includes(n)); })
  ) || null;
}

export function protectedRecruiterForRoleTitle(title) {
  const t = norm(title);
  if (!t) return null;
  return PROTECTED_RECRUITERS.find((r) =>
    r.roleTitlePatterns.some((pat) => { const n = norm(pat); return n && t.includes(n); })
  ) || null;
}

export function protectedRecruiterForLinkedinJobId(jobId) {
  const id = String(jobId ?? "").trim();
  if (!id) return null;
  return PROTECTED_RECRUITERS.find((r) => r.linkedinJobIds.includes(id)) || null;
}

// Combined check used by enroll/release/outreach/guardian. Returns the matching
// protected-recruiter entry (truthy) or null. Any positive signal protects.
export function protectedRecruiterForRole({ roleTitle, poster, linkedinJobId } = {}) {
  return protectedRecruiterForPoster(poster)
    || protectedRecruiterForLinkedinJobId(linkedinJobId)
    || protectedRecruiterForRoleTitle(roleTitle)
    || null;
}

export function isProtectedRole(args) {
  return protectedRecruiterForRole(args) != null;
}

// True if a sequence (from campaigns.getListOfCampaignsOptimized) belongs to a
// protected recruiter. Matches on the sequence's own role_name and on the role
// title embedded in the launcher's "... - <Title>" naming convention.
export function protectedRecruiterForSequence(seq) {
  const name = String(seq?.name || "");
  const embeddedTitle = name.includes(" - ") ? name.slice(name.lastIndexOf(" - ") + 3) : name;
  return protectedRecruiterForRoleTitle(seq?.role_name)
    || protectedRecruiterForRoleTitle(embeddedTitle)
    || protectedRecruiterForRoleTitle(name)
    || null;
}
