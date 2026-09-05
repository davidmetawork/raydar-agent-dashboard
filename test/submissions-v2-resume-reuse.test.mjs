import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateOriginalExtractionRecord,
  reuseCandidateOriginalExtraction,
} from "../api/submissions-v2/_lib/resume/candidate-original-reuse.mjs";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const bytes = Buffer.from("%PDF-1.7 original candidate facts");
const cache = new Map();
const cachePort = {
  load: async (identity) => cache.get(`${identity.candidate_id}:${identity.source_id}:${identity.content_digest}`) || null,
  save: async (record) => cache.set(`${record.candidate_id}:${record.source_id}:${record.content_digest}`, record),
  now: () => NOW,
};

test("two roles reuse only the same candidate-original extraction", async () => {
  let calls = 0;
  const first = await reuseCandidateOriginalExtraction({ candidateUserId: "candidate-1", resumeId: "resume-1", locator: "paraform:candidate:candidate-1:resume", bytes, extract: async () => { calls += 1; return { text: "Candidate original employment history", pageCount: 2 }; } }, cachePort);
  const second = await reuseCandidateOriginalExtraction({ candidateUserId: "candidate-1", resumeId: "resume-1", locator: "paraform:candidate:candidate-1:resume", bytes, extract: async () => { calls += 1; return { text: "must not run", pageCount: 1 }; } }, cachePort);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.text, "Candidate original employment history");
  assert.equal(calls, 1);
  assert.equal(Object.hasOwn(second.record, "role_id"), false);
  assert.equal(Object.hasOwn(second.record, "supplement"), false);
});

test("changed candidate source digest and stale evidence never reuse extraction", async () => {
  let calls = 0;
  await reuseCandidateOriginalExtraction({ candidateUserId: "candidate-2", resumeId: "resume-2", locator: "paraform:candidate:candidate-2:resume", bytes, extract: async () => { calls += 1; return { text: "Original facts", pageCount: 1 }; } }, cachePort);
  const changed = await reuseCandidateOriginalExtraction({ candidateUserId: "candidate-2", resumeId: "resume-2", locator: "paraform:candidate:candidate-2:resume", bytes: Buffer.concat([bytes, Buffer.from(" updated")]), extract: async () => { calls += 1; return { text: "Updated original facts", pageCount: 1 }; } }, cachePort);
  assert.equal(changed.reused, false);
  const identity = { candidate_id: "candidate-3", source_id: "resume-3", source_locator: "paraform:candidate:candidate-3:resume", content_digest: "a".repeat(64) };
  const stale = candidateOriginalExtractionRecord(identity, { text: "Old original facts", pageCount: 1 }, { capturedAt: "2026-07-01T00:00:00.000Z" });
  const fresh = await reuseCandidateOriginalExtraction({ candidateUserId: "candidate-3", resumeId: "resume-3", locator: identity.source_locator, bytes: identity.content_digest, extract: async () => { calls += 1; return { text: "Fresh original facts", pageCount: 1 }; } }, { ...cachePort, load: async () => stale });
  assert.equal(fresh.reused, false);
  assert.equal(fresh.text, "Fresh original facts");
  assert.equal(calls, 3);
});
