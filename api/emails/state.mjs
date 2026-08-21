// Everything the Emails page renders: the documented lane inventory, plus the
// live status of the lanes that have a Health tile.
//
// Two kinds of status live on this page and they must never be confused:
//   documented — what the code says the lane is (live / paused / dark)
//   observed   — what the Health board saw in the last 2 minutes
// A lane with no `healthId` has no observed status. It reports `watched:false`
// rather than borrowing a neighbour's green, because "documented as live" is
// not evidence that mail moved.
import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { hGet, K } from "../health/_lib/kv.mjs";
import { LANES, READERS, MAILBOXES, GROUPS, QUOTA_COSTS } from "./_lib/lanes.mjs";
import { lockoutFromSamples, numberOrNull, pacificDay, summarize as summarizeQuota } from "../health/gmail-quota.mjs";
import { activityFrom } from "./_lib/activity.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  res.setHeader("cache-control", "no-store");

  // A missing or unreadable board is not an outage of this page: the inventory
  // is static and still worth rendering. Every lane just reports unwatched.
  let tiles = {};
  let checkedAt = null;
  try {
    const state = await hGet(K.state);
    if (state) {
      tiles = state.tiles || {};
      checkedAt = state.checkedAt || null;
    }
  } catch {
    tiles = {};
  }

  const observe = (healthId) => {
    if (!healthId) return { watched: false };
    const t = tiles[healthId];
    if (!t) return { watched: false };
    return {
      watched: true,
      state: t.state || "UNKNOWN",
      reason: t.reason || "",
      acked: Boolean(t.ackUntil),
      healthId,
    };
  };
  // Last-activity is derived from the tile's evaluator metrics with the kind
  // kept explicit — real send counts where a lane counts them, run timestamps
  // where only a heartbeat exists, and null rather than a guess otherwise.
  const activity = (healthId) => activityFrom(tiles[healthId]?.metrics);

  // The daily allowance, read from the records /api/health/gmail-quota owns.
  // Reading is all this endpoint does — it never counts, never calls Gmail,
  // and a missing record renders as "not counted yet", never as zero.
  let quota = null;
  try {
    const today = pacificDay();
    const days = [];
    for (let back = 0; back < 7; back += 1) {
      const d = pacificDay(Date.now() - back * 24 * 3600 * 1000);
      days.push(d);
    }
    const [samples, ...records] = await Promise.all([
      hGet("hlth:samples:email-inbox-david"),
      ...days.map((d) => hGet(`hlth:gmailquota:${d}`)),
    ]);
    const todayRecord = records[0];
    quota = {
      ...summarizeQuota(todayRecord || { day: today, sends: null, four29: 0 },
        lockoutFromSamples(samples)),
      history: days.map((d, i) => ({
        day: d,
        sends: numberOrNull(records[i]?.sends),
      })).reverse(),
    };
  } catch {
    quota = null; // the page renders the rest of itself regardless
  }

  return res.status(200).json({
    ok: true,
    checkedAt,
    quota,
    boardReadable: Object.keys(tiles).length > 0,
    groups: GROUPS,
    mailboxes: MAILBOXES.map((m) => ({ ...m, observed: observe(m.healthId) })),
    quotaCosts: QUOTA_COSTS,
    lanes: LANES.map((l) => ({ ...l, observed: observe(l.healthId), activity: activity(l.healthId) })),
    readers: READERS.map((r) => ({ ...r, observed: observe(r.healthId), activity: activity(r.healthId) })),
  });
}
