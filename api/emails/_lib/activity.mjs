// "When did this lane last do something?" — derived from the health tile's
// evaluator metrics, with the KIND made explicit so the page never dresses a
// heartbeat up as a delivery.
//
// The honest vocabulary, in order of strength:
//   sentToday   — real sends, counted by the lane's own per-day counters
//   sentLastRun — real sends, reported by the lane's last heartbeat metrics
//   ran         — the lane completed a pass; says nothing about deliveries
//   null        — no timestamp exists anywhere for this lane
export function activityFrom(metrics) {
  const m = metrics && typeof metrics === "object" ? metrics : {};
  if (m.lastOkAt) {
    return {
      at: m.lastOkAt,
      kind: "run",
      sentToday: Number.isFinite(Number(m.sentLatestDay)) ? Number(m.sentLatestDay) : null,
    };
  }
  if (m.lastBeat) {
    return {
      at: m.lastBeat,
      kind: "run",
      sentLastRun: Number.isFinite(Number(m.sent)) ? Number(m.sent) : null,
    };
  }
  return null;
}
