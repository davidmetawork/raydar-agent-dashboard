// This route takes Paraform's recruiter-owned candidate user ID, not its
// separate underlying candidate ID; callers must already have resolved identity.
export function paraformCandidateProfileUrl(candidateUserId) {
  if (typeof candidateUserId !== "string" || !/^[a-z0-9_-]{1,200}$/iu.test(candidateUserId)) return null;
  return `https://www.paraform.com/candidates?candidate_profile_id=${encodeURIComponent(candidateUserId)}`;
}

export function paraformCuratedListUrl(listId) {
  if (typeof listId !== "string" || !/^[a-z0-9_-]{1,200}$/iu.test(listId)) return null;
  return `https://www.paraform.com/lists/${encodeURIComponent(listId)}`;
}

export function isParaformCuratedListUrl(value) {
  if (typeof value !== "string") return false;
  const match = /^https:\/\/www\.paraform\.com\/lists\/([a-z0-9_-]{1,200})$/iu.exec(value);
  return Boolean(match && paraformCuratedListUrl(match[1]) === value);
}
