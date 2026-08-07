// Full board for the Health page. Google-session gated like every browser API.
import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { hGet, K } from "./_lib/kv.mjs";
import { CATALOG, GROUPS } from "./_lib/catalog.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  res.setHeader("cache-control", "no-store");
  const state = await hGet(K.state);
  if (!state) {
    return res.status(200).json({
      ok: true, empty: true, groups: GROUPS,
      catalog: CATALOG.map(({ id, name, group, tier, registry, note, paused }) =>
        ({ id, name, group, tier, registry, note, paused: Boolean(paused) })),
    });
  }
  return res.status(200).json({
    ok: true,
    ...state,
    groups: GROUPS,
    catalog: CATALOG.map(({ id, name, group, tier, registry, note, paused }) =>
      ({ id, name, group, tier, registry, note, paused: Boolean(paused) })),
  });
}
