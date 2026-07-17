import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createParaAIStatusHandler } from "../api/roster/paraai-status.mjs";

const dashboard = await readFile(new URL("../index.html", import.meta.url), "utf8");

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("Candidates replaces Needs Action with the fail-closed Match Queue", () => {
  assert.doesNotMatch(dashboard, /Needs action/i);
  assert.match(dashboard, />Match Queue \(…\)<\/button>/);
  assert.match(dashboard, /cdStatusKey\(r\.status\)==="success"/);
  assert.match(dashboard, /cdParaAIKey\(r\)==="added"/);
  assert.match(dashboard, /!r\.outcomeComplete/);
  assert.match(dashboard, /!cdEffectiveOutcome\(r\)/);
  assert.match(dashboard, /latest\.get\(identity\)===r/);
  assert.match(dashboard, /if\(!rosterOutcomeVerified\) return false/);
});

test("sequence-derived outcomes act as a virtual backfill while manual outcomes win", () => {
  assert.match(
    dashboard,
    /String\(row\?\.outcome\|\|row\?\.verifiedOutcome\|\|""\)\.trim\(\)/,
  );
  assert.match(dashboard, /row\.verifiedOutcome=hit\?\.verifiedOutcome\|\|null/);
  assert.match(dashboard, /cdSelect\(i,"outcome",CD_OUTCOMES,displayOutcome\)/);
});

test("Para AI status endpoint joins exact-ID outcome membership onto CRM status", async () => {
  const handler = createParaAIStatusHandler({
    corsImpl: () => false,
    requireAuthImpl: async () => true,
    loadSnapshot: async () => ({
      rows: [{ id: "candidate-a", name: "Candidate A" }],
      complete: true,
      generatedAt: "2026-07-17T00:00:00.000Z",
      cached: false,
    }),
    loadJobs: async () => [],
    loadOutcomeSnapshot: async () => ({
      complete: true,
      generatedAt: "2026-07-17T00:00:00.000Z",
      cached: false,
      ruleCount: 5,
      entries: [{
        id: "vw168sypaoagu5j5g209cps3",
        outcome: "Sent List",
        leads: [{ cu_id: "candidate-a" }],
      }],
    }),
    now: () => Date.parse("2026-07-17T01:00:00.000Z"),
  });
  const res = responseRecorder();
  await handler({ method: "GET", query: {}, headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcomeVerification.complete, true);
  assert.equal(res.body.outcomeVerification.candidateCount, 1);
  assert.deepEqual(res.body.statuses[0], {
    name: "Candidate A",
    normalizedName: "candidate a",
    candidateUserId: "candidate-a",
    candidateUserIds: undefined,
    status: "added",
    label: "Added",
    added: true,
    ambiguous: false,
    source: "outcome_sequence",
    outcomeComplete: true,
    verifiedOutcome: "Sent List",
    outcomeConflict: false,
    outcomeSequenceIds: ["vw168sypaoagu5j5g209cps3"],
  });
});

test("incomplete outcome verification returns status data but cannot populate the queue", async () => {
  const handler = createParaAIStatusHandler({
    corsImpl: () => false,
    requireAuthImpl: async () => true,
    loadSnapshot: async () => ({
      rows: [{ id: "candidate-a", name: "Candidate A", talent_network_submitted_at: "2026-07-17" }],
      complete: true,
      generatedAt: "2026-07-17T00:00:00.000Z",
      cached: false,
    }),
    loadJobs: async () => [],
    loadOutcomeSnapshot: async () => { throw new Error("incomplete campaign membership read"); },
  });
  const res = responseRecorder();
  await handler({ method: "GET", query: {}, headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.statuses[0].status, "added");
  assert.equal(res.body.statuses[0].outcomeComplete, false);
  assert.equal(res.body.outcomeVerification.complete, false);
});
