// GET /api/seq/sequences — the Sequences page's campaign dropdown.
//
// READ MODEL (2026-09-26 Paraform read-cut pass): an ordinary request (no
// `refresh` param) never touches Paraform. It serves the last computed list
// from the shared seq:v1:sequences-snapshot KV store
// (api/seq/_lib/sequences-snapshot.mjs) and labels its age. Only
// `?refresh=1` — the page's explicit "Refresh list" action — may run a live
// listSequences() read, and even that is paced by a shared lock so a
// double-click or two open tabs cannot fan out into two live reads.
//
// Before this, every page load called listSequences() live with no cache at
// all — see docs/research/paraform-quota-plan-2026-09-25.md, "Put a brake or
// cache on the unbraked readers" -> "Sequences list: serve it from the
// stored snapshot".
import { cors, requireAuth, hasCookie, listSequences, ensureParaformSession } from "./_lib/core.mjs";
import {
  claimSequencesRefreshWindow,
  readSequencesSnapshot,
  sequencesSnapshotAgeMs,
  writeSequencesSnapshot,
} from "./_lib/sequences-snapshot.mjs";

const queryOf = (req) => {
  if (req?.query && typeof req.query === "object") return req.query;
  try {
    return Object.fromEntries(new URL(req?.url || "", "http://localhost").searchParams.entries());
  } catch {
    return {};
  }
};

export function createSequencesHandler({
  corsImpl = cors,
  requireAuthImpl = requireAuth,
  hasCookieImpl = hasCookie,
  ensureSessionImpl = ensureParaformSession,
  fetchSequences = listSequences,
  readSnapshot = readSequencesSnapshot,
  writeSnapshot = writeSequencesSnapshot,
  claimRefresh = claimSequencesRefreshWindow,
  ageOf = sequencesSnapshotAgeMs,
  now = Date.now,
} = {}) {
  return async function handler(req, res) {
    if (corsImpl(req, res)) return;
    if (!(await requireAuthImpl(req, res))) return;

    const refresh = String(queryOf(req).refresh || "") === "1";

    if (!refresh) {
      const cached = await readSnapshot();
      if (cached) {
        return res.status(200).json({
          ok: true,
          sequences: cached.sequences,
          source: "snapshot",
          fetchedAt: cached.fetchedAt,
          snapshotAgeMs: ageOf(cached, Number(now())),
        });
      }
      // No snapshot yet (first deploy, or the KV store was cleared). One
      // caller must do the bootstrap read; a burst of simultaneous cold
      // viewers gets an empty-but-honest answer instead of each doing their
      // own live read.
      await ensureSessionImpl();
      if (!hasCookieImpl()) return res.status(200).json({ ok: false, error: "no_cookie", sequences: [] });
      const won = await claimRefresh();
      if (!won) {
        return res.status(200).json({ ok: true, sequences: [], source: "warming", warming: true });
      }
      try {
        const sequences = await fetchSequences();
        const record = await writeSnapshot(sequences);
        return res.status(200).json({ ok: true, sequences, source: "live", fetchedAt: record.fetchedAt, snapshotAgeMs: 0 });
      } catch (e) {
        const expired = e.code === "AUTH_EXPIRED";
        return res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 160), sequences: [] });
      }
    }

    // Explicit operator "Refresh list" — still paced.
    await ensureSessionImpl();
    if (!hasCookieImpl()) return res.status(200).json({ ok: false, error: "no_cookie", sequences: [] });
    const won = await claimRefresh();
    if (!won) {
      const cached = await readSnapshot();
      return res.status(200).json({
        ok: true,
        sequences: cached?.sequences || [],
        source: cached ? "snapshot" : "warming",
        refreshSkipped: "too_soon",
        fetchedAt: cached?.fetchedAt || null,
        snapshotAgeMs: cached ? ageOf(cached, Number(now())) : null,
      });
    }
    try {
      const sequences = await fetchSequences();
      const record = await writeSnapshot(sequences);
      return res.status(200).json({ ok: true, sequences, source: "live", refreshed: true, fetchedAt: record.fetchedAt, snapshotAgeMs: 0 });
    } catch (e) {
      // A failed refresh must not blank a page that had a good list.
      const cached = await readSnapshot();
      if (cached) {
        return res.status(200).json({
          ok: true,
          sequences: cached.sequences,
          source: "snapshot",
          refreshError: String(e.code || e.message || e).slice(0, 160),
          fetchedAt: cached.fetchedAt,
          snapshotAgeMs: ageOf(cached, Number(now())),
        });
      }
      const expired = e.code === "AUTH_EXPIRED";
      return res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 160), sequences: [] });
    }
  };
}

const handler = createSequencesHandler();
export default handler;
export { handler };
