// api/prepdoc/_lib/runner-proxy.mjs — server-side proxy helpers for the Fly
// runner's authenticated read-only surface (candidate search + precheck).
// The browser never sees the runner key or talks to the runner directly; the
// dashboard session gate stays in front, the runner key rides only on this
// server-to-server hop. Nothing here touches the frozen dashboard data feed.

const DEFAULT_RUNNER_BASE = "https://raydar-prepdoc.fly.dev";
const PROXY_TIMEOUT_MS = 15_000;

export function runnerBase() {
  const configured = String(process.env.PREPDOC_RUNNER_URL || "").trim();
  return (configured || DEFAULT_RUNNER_BASE).replace(/\/+$/, "");
}

export function buildRunnerUrl(pathname, params = {}, base = runnerBase()) {
  const url = new URL(base + pathname);
  for (const [key, value] of Object.entries(params)) {
    const text = String(value ?? "").trim();
    if (text) url.searchParams.set(key, text.slice(0, 300));
  }
  return url.toString();
}

// Maps a runner response to the shape the Prep tab consumes. The runner not
// being deployed yet (404), being unreachable, or Paraform auth being down
// (503) all surface as a structured `runner_unavailable` so the UI can fall
// back to the legacy free-text path instead of breaking.
export async function proxyRunnerGet(res, pathname, params, {
  runnerKey = process.env.PREPDOC_RUNNER_KEY,
  fetchImpl = fetch,
  base = runnerBase(),
} = {}) {
  if (!runnerKey) {
    res.status(503).json({ ok: false, error: "runner_key_not_configured" });
    return;
  }
  let upstream;
  try {
    upstream = await fetchImpl(buildRunnerUrl(pathname, params, base), {
      headers: { authorization: `Bearer ${runnerKey}` },
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch {
    res.status(502).json({ ok: false, error: "runner_unavailable" });
    return;
  }
  if (upstream.status === 404 || upstream.status === 503) {
    res.status(502).json({ ok: false, error: "runner_unavailable" });
    return;
  }
  let payload = null;
  try { payload = await upstream.json(); } catch { payload = null; }
  if (!upstream.ok || payload == null) {
    res.status(upstream.status === 400 ? 400 : 502).json({
      ok: false,
      error: payload?.error || "runner_error",
    });
    return;
  }
  res.status(200).json({ ok: true, ...payload });
}
