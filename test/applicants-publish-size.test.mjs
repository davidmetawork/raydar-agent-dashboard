// The publish size fences, and the order they must fire in.
//
// 2026-09-04: Core's cycles were failing HTTP 413 queue_too_large against a
// 5,500,000-byte queue cap while the live review queue was 4,345 rows and
// growing daily. Raising a cap is only safe if the whole chain is raised
// coherently — a cap the payload can never reach is not a fence, it is a trap
// that fails later, at a lower layer, with a worse error.
//
// The chain a full publish passes through, in order:
//   1. decodeTransportBody  — MAX_TRANSPORT_COMPRESSED_BYTES (wire, base64)
//                             MAX_TRANSPORT_DECODED_BYTES (the whole body)
//   2. the queue check      — MAX_QUEUE_BYTES        -> clean 413
//   3. the body check       — MAX_PUBLISH_BYTES      -> clean 413
//   4. publishGeneration    — MAX_GENERATION_ARTIFACT_BYTES, which THROWS
//                             (502 store_unavailable), so it must be last.

import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import {
  MAX_PUBLISH_BYTES,
  MAX_QUEUE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_TRANSPORT_COMPRESSED_BYTES,
  MAX_TRANSPORT_DECODED_BYTES,
} from "../api/applicants/sync.mjs";
import { MAX_GENERATION_ARTIFACT_BYTES, buildGeneration } from "../api/applicants/_lib/generation.mjs";

/** A row shaped like a published one: the fields the tab actually renders,
 *  plus the revision triple and the source observation id. Measured at about
 *  818 bytes serialized, which is the live average. */
const syntheticRow = (i) => ({
  key: `cu${i}abcdefghij:role-${i % 40}`,
  cuId: `cu${i}abcdefghij`,
  profileKey: `cu${i}abcdefghij`,
  roleId: `role-${i % 40}`,
  roleTitle: "Senior Software Engineer, Platform Infrastructure",
  name: `Person Number ${i}`,
  company: "Some Company Name Incorporated",
  location: "San Francisco Bay Area, California, United States",
  linkedin: `https://www.linkedin.com/in/person-number-${i}`,
  appliedAt: "2026-09-01T12:34:56.000Z",
  addedAt: "2026-09-01T12:44:56.000Z",
  tier: i % 3 ? "unrated" : "C",
  status: "pending",
  interviewAllowed: true,
  inputRevision: `rev-input-${i}-0000-0000-0000`,
  readinessRevision: `rev-ready-${i}-0000-0000`,
  decisionRevision: 0,
  sourceObservationId: `obs-${i}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
  readinessState: "ready",
  deliveryState: null,
  headline: "Building distributed systems at scale for a large marketplace company",
});

/** Rows enough to serialize past `targetBytes`. Sized from one row and then
 *  topped up, rather than re-serializing the whole array every iteration —
 *  the naive loop is O(n^2) and takes minutes at these sizes. */
function queueOfBytes(targetBytes) {
  const doc = (rows) => JSON.stringify({ generatedAt: "2026-09-04T12:00:00.000Z", rows });
  const perRow = Buffer.byteLength(JSON.stringify(syntheticRow(1_000_000))) + 1;
  const rows = Array.from({ length: Math.ceil(targetBytes / perRow) }, (_, i) => syntheticRow(i));
  while (Buffer.byteLength(doc(rows)) < targetBytes) {
    for (let i = 0; i < 64; i += 1) rows.push(syntheticRow(rows.length));
  }
  return rows;
}

test("the caps fire in order, so an oversized publish always gets a clean 413", () => {
  // Anything that throws must sit ABOVE everything that returns a status code.
  assert.ok(MAX_QUEUE_BYTES <= MAX_PUBLISH_BYTES,
    "a queue can never be larger than the body carrying it");
  assert.ok(MAX_PUBLISH_BYTES <= MAX_TRANSPORT_DECODED_BYTES,
    "the transport must be able to deliver a body the publish cap would accept");
  assert.ok(MAX_GENERATION_ARTIFACT_BYTES > MAX_PUBLISH_BYTES,
    "the artifact cap throws, so it must never be the first cap a payload meets");
  assert.ok(MAX_SNAPSHOT_BYTES < MAX_PUBLISH_BYTES);
});

test("a 9 MB queue is nowhere near the compressed transport cap", () => {
  const rows = queueOfBytes(9_000_000);
  const body = JSON.stringify({
    snapshot: { generatedAt: "2026-09-04T12:00:00.000Z", stream: [], profilePreparing: 0 },
    queue: rows,
    generation: { id: "g", digest: "0".repeat(64), sourceCutoff: null, sourceWatermark: null },
    counts: { total: rows.length, queue: rows.length, stream: 0, profilePreparing: 0 },
  });
  const bodyBytes = Buffer.byteLength(body);
  assert.ok(bodyBytes >= 9_000_000, `body is ${bodyBytes}`);

  const compressed = gzipSync(Buffer.from(body), { level: 9 });
  const base64 = compressed.toString("base64");
  // MEASURED 2026-09-04: 9,000,486 bytes -> 320,862 gzipped (28.1x), 427,816
  // base64 chars. Queue rows are extremely repetitive, so the wire envelope is
  // an order of magnitude below its own cap and is NOT the binding fence at
  // these sizes — which is why widening the logical caps did not require
  // touching it.
  assert.ok(compressed.length < MAX_TRANSPORT_COMPRESSED_BYTES / 4,
    `gzip is ${compressed.length} of ${MAX_TRANSPORT_COMPRESSED_BYTES}`);
  assert.ok(base64.length <= Math.ceil(MAX_TRANSPORT_COMPRESSED_BYTES / 3) * 4 + 4);
  // The decoded body, on the other hand, is within a megabyte of its cap, so
  // that is the fence to watch as the queue keeps growing.
  assert.ok(bodyBytes <= MAX_TRANSPORT_DECODED_BYTES,
    `a body at the publish cap must still decode: ${bodyBytes} vs ${MAX_TRANSPORT_DECODED_BYTES}`);
});

test("the generation stamp's per-row cost still fits under the artifact cap", () => {
  // MEASURED: a 9,000,188-byte raw queue becomes a 10,649,972-byte stamped
  // artifact, +18.3%, because every row gains a generation id, a 64-char
  // digest and the source tuple. This is the check that would have thrown a
  // 502 store_unavailable if the artifact cap had been left at 8,000,000.
  const rows = queueOfBytes(MAX_QUEUE_BYTES);
  const generation = buildGeneration({
    snapshot: { generatedAt: "2026-09-04T12:00:00.000Z", stream: [], profilePreparing: 0 },
    queue: rows,
    counts: { total: rows.length, queue: rows.length, stream: 0, profilePreparing: 0 },
    generationId: "gen-size-fixture",
    publishedAt: "2026-09-04T12:00:00.000Z",
  });
  const stamped = Buffer.byteLength(JSON.stringify(generation.queue));
  const raw = Buffer.byteLength(JSON.stringify({ generatedAt: "2026-09-04T12:00:00.000Z", rows }));
  assert.ok(stamped > raw, "stamping only ever adds bytes");
  assert.ok(stamped <= MAX_GENERATION_ARTIFACT_BYTES,
    `a queue at the publish cap stamps to ${stamped}, cap ${MAX_GENERATION_ARTIFACT_BYTES}`);
});
