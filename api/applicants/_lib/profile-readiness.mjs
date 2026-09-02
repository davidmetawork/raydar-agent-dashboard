const rows = (value) => Array.isArray(value) ? value : [];

export function profileCacheGate(snapshot, cards) {
  const available = cards && typeof cards === "object" && !Array.isArray(cards) ? cards : {};
  const rawStream = rows(snapshot?.stream);
  const rawQueue = rows(snapshot?.queue);
  const ready = (row) => Boolean(row?.cuId && available[row.cuId]);
  const stream = rawStream.filter(ready);
  const queue = rawQueue.filter(ready);
  // Missing ids are returned in this order to the cache warmer: review work
  // first, then the stream, while preserving each publisher's newest-first order.
  const all = [...rawQueue, ...rawStream];
  const candidateIds = new Set(all.map((row) => row?.cuId).filter(Boolean));
  const readyCandidateIds = new Set(all.filter(ready).map((row) => row.cuId));
  const missingCuIds = [...candidateIds].filter((cuId) => !available[cuId]);
  const generatedDay = String(snapshot?.generatedAt || "").slice(0, 10);
  const next = snapshot ? {
    ...snapshot,
    counts: {
      ...(snapshot.counts || {}),
      stream: stream.length,
      queue: queue.length,
      unrated: queue.filter((row) => row?.tier === "unrated").length,
      emailedToday: stream.filter((row) =>
        row?.status === "emailed" && String(row?.addedAt || "").slice(0, 10) === generatedDay).length,
      newToday: stream.filter((row) =>
        String(row?.addedAt || "").slice(0, 10) === generatedDay).length,
    },
    stream,
    queue,
  } : null;
  return {
    snapshot: next,
    profileCache: {
      required: true,
      totalRows: all.length,
      readyRows: stream.length + queue.length,
      withheldRows: all.length - stream.length - queue.length,
      totalCandidates: candidateIds.size,
      readyCandidates: readyCandidateIds.size,
      withheldCandidates: missingCuIds.length,
      missingCuIds,
      queue: { total: rawQueue.length, ready: queue.length, withheld: rawQueue.length - queue.length },
      stream: { total: rawStream.length, ready: stream.length, withheld: rawStream.length - stream.length },
    },
  };
}
