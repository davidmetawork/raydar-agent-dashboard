// The applicant photo allowlist: the one rule every path that can put a
// candidate photo into the Applicants tab's <img src> goes through.
//
// Its own module so the lean read paths (_lib/paged.mjs, profile.mjs) can
// share it without importing the whole sync handler. applicants.html carries
// a browser copy (allowedPhotoUrl, used by avatarImg); the drift test in
// test/applicants-photo-allowlist-paths.test.mjs runs both on the same inputs.
//
// The paths that call it (all found by 2026-09-24; each has a test there):
//   - sync.mjs: the apphub:photos hash, cards, and the apphub:profile store.
//   - profile.mjs: every branch that returns imageSrc (paged read, source
//     profile, cached apphub:profile, live Paraform read) and what it caches.
//   - _lib/paged.mjs: the paged store's profile.photo, which Core keeps as
//     Paraform's raw image_src.
//
// THE PHOTO ALLOWLIST. Positive, exact-prefix, and deliberately short.
//
//   [0] Paraform's own public bucket. Paraform's copy of the picture, obtained
//       by its enrichment vendor, served unsigned to the recruiter who is
//       already permitted to see that candidate.
//   [1] The Workable CloudFront uploads path. The candidate uploaded this to
//       the employer's ATS as part of their own application to a job we
//       operate; it is already in Raydar's Hub. MEASURED 2026-09-05 over all
//       1,244 distinct URLs in that corpus: one host, no query strings, no
//       fragments, anonymous HTTP 200.
//
// DO NOT WIDEN THIS LIST. About 17% of Paraform's image_src values are
// media.licdn.com signed URLs (every one sampled had already expired) and ~6%
// are a 42-byte 1x1 transparent GIF; adding either "to fix the missing photos"
// puts a direct LinkedIn CDN request in the reviewer's browser, or renders an
// invisible avatar instead of falling back to initials. A photo that is not on
// this list is not a bug — it is a card that shows initials, which is correct.
export const PHOTO_URL_PREFIXES = [
  "https://storage.googleapis.com/paraform-images/",
  "https://dvz3vrza543jw.cloudfront.net/uploads/",
];
// startsWith on the FULL prefix including the trailing slash, so a look-alike
// host ("https://storage.googleapis.com/paraform-images.example.com/x") can
// never satisfy it. Query strings and fragments are refused outright: every
// signed, expiring URL we have measured carries one.
//
// The link must also already be in the canonical form the browser will
// request. startsWith reads the raw string, but <img src> resolves the path
// first, so ".../paraform-images/../another-bucket/x.jpg" (or %2e%2e, or a
// backslash) loads from a different public bucket on the same host. The same
// rule as applicant-core/lib/candidate-photos.mjs in the Raydar repo. MEASURED
// 2026-09-24 over the links the Raydar CRM uses: all 1,141 Workable links and
// the 719 Paraform photos in Core's cache are canonical.
export function allowedPhotoUrl(value) {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url || url.length > 512 || !url.startsWith("https://")) return null;
  if (url.includes("?") || url.includes("#")) return null;
  if (!PHOTO_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) return null;
  try {
    return new URL(url).href === url ? url : null;
  } catch {
    return null;
  }
}
