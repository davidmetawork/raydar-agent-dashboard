// Shared exact LinkedIn profile URL interpretation. Kept separate from person
// matching so Core and Monitor can use the same identity boundary without a
// second identity owner or provider dependency.
const compact = (value) => typeof value === "string" ? value.trim() : "";

const LINKEDIN_PATH_DECODE_LIMIT = 16;
const LINKEDIN_EMAIL_ENTITY_TOKEN =
  /^AEMAAA[A-Za-z0-9_-]{16,512}$/u;

function rawUrlPath(value) {
  const authorityStart = value.indexOf("://") + 3;
  const pathStart = value.indexOf("/", authorityStart);
  if (pathStart < 0) return "";
  const queryStart = value.indexOf("?", authorityStart);
  const fragmentStart = value.indexOf("#", authorityStart);
  const endings = [queryStart, fragmentStart].filter((index) => index >= 0);
  const pathEnd = endings.length > 0 ? Math.min(...endings) : value.length;
  // A slash inside a query or fragment is not an authority-bound pathname.
  // Inspect the raw source before WHATWG URL normalization so it can never be
  // promoted into a LinkedIn profile path.
  if (pathStart >= pathEnd) return "";
  return value.slice(pathStart, pathEnd);
}

function encodedLinkedinPathSegment(value) {
  let current = value;
  let decoded = false;
  for (let iteration = 0; iteration < LINKEDIN_PATH_DECODE_LIMIT; iteration += 1) {
    const hasEscape = /%[0-9a-f]{2}/iu.test(current);
    if (!hasEscape) {
      // A raw malformed escape is ambiguous. A literal percent produced by
      // decoding %25 is unambiguous and is re-encoded below.
      if (!decoded && current.includes("%")) return null;
      break;
    }
    if (/%(?![0-9a-f]{2})/iu.test(current)) return null;
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    decoded = true;
    current = next;
    if (/[/\\?#\u0000-\u001f\u007f]/u.test(current)) return null;
    if (
      iteration === LINKEDIN_PATH_DECODE_LIMIT - 1
      && /%[0-9a-f]{2}/iu.test(current)
    ) {
      return null;
    }
  }
  if (
    !current
    || current === "."
    || current === ".."
    || LINKEDIN_EMAIL_ENTITY_TOKEN.test(current)
    || !/^[A-Za-z0-9._-]+$/u.test(current)
    || /[/\\?#\u0000-\u001f\u007f]/u.test(current)
  ) {
    return null;
  }
  let encoded;
  try {
    encoded = encodeURIComponent(current)
      // encodeURIComponent leaves these path punctuation characters raw.
      // Encoding them keeps a canonical URL immune to the source miner's
      // surrounding-prose punctuation trim on replay.
      .replace(/[!'()*]/gu, (character) =>
        `%${character.codePointAt(0).toString(16).toUpperCase()}`)
      .replace(/\.$/u, "%2E");
  } catch {
    return null;
  }
  return encoded.length <= 200 ? encoded : null;
}

function normalizeLinkedinProfileUrlOnce(value) {
  const raw = compact(value);
  if (
    !raw
    || raw.length > 2_048
    || /[\\\u0000-\u001f\u007f]/u.test(raw)
  ) {
    return null;
  }
  const absolute = /^https?:\/\//iu.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(absolute);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const linkedinHost = hostname === "linkedin.com"
    || hostname === "www.linkedin.com"
    || /^[a-z]{2,3}\.linkedin\.com$/u.test(hostname);
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || !linkedinHost
    || parsed.username
    || parsed.password
    || parsed.port
  ) {
    return null;
  }

  let path = rawUrlPath(absolute);
  if (!path.startsWith("/") || path === "/") return null;
  if (path.endsWith("/")) path = path.slice(0, -1);
  const parts = path.split("/");
  const route = parts[1];
  const rawSegments = parts.slice(2);
  if (
    parts[0] !== ""
    || !["in", "pub"].includes(route)
    || rawSegments.some((segment) => !segment)
    || (route === "in" && rawSegments.length !== 1)
    || (
      route === "pub"
      && (rawSegments.length < 1 || rawSegments.length > 5)
    )
  ) {
    return null;
  }
  const segments = rawSegments.map(encodedLinkedinPathSegment);
  if (
    segments.some((segment) => segment == null)
    || segments[0].length < 2
  ) {
    return null;
  }
  parsed.protocol = "https:";
  parsed.hostname = "www.linkedin.com";
  parsed.pathname = `/${route}/${segments.join("/")}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.replace(/\/$/u, "");
}

export function normalizeLinkedinProfileUrl(value) {
  const canonical = normalizeLinkedinProfileUrlOnce(value);
  if (!canonical) return null;
  // This postcondition makes the hard-key boundary fail closed if a future
  // URL-runtime or encoder change would emit a non-idempotent identity.
  return normalizeLinkedinProfileUrlOnce(canonical) === canonical
    ? canonical
    : null;
}


function candidateText(value) {
  return String(value ?? "").trim();
}

function trimmedUrlCandidate(value) {
  return candidateText(value)
    .replace(/^[<([{"']+/u, "")
    .replace(/[>\])},"';:.!?]+$/u, "");
}

export function canonicalLinkedinProfileUrl(value) {
  const candidate = trimmedUrlCandidate(value);
  const canonical = normalizeLinkedinProfileUrl(candidate);
  return canonical != null
    && normalizeLinkedinProfileUrl(canonical) === canonical
      ? canonical
      : null;
}
