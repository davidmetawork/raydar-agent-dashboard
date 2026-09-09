import assert from "node:assert/strict";
import test from "node:test";

import { profileCacheSummary } from "../api/applicants/_lib/profile-readiness.mjs";

test("New today counts unique applications across every published section", () => {
  const samePerson = "candidate-shared";
  const today = "2026-09-08T18:00:00.000Z";
  const summary = profileCacheSummary({
    generatedAt: "2026-09-08T19:00:00.000Z",
    stream: [
      { profileKey: "core:app-stream", cuId: samePerson, addedAt: today },
      { profileKey: "core:app-prior", cuId: samePerson, addedAt: "2026-09-07T23:59:59.999Z" },
    ],
    queue: [
      { profileKey: "core:app-queue", cuId: samePerson, addedAt: today },
      { profileKey: "core:app-queue", cuId: samePerson, addedAt: today },
    ],
    profilePreparing: [
      { profileKey: "core:app-preparing", cuId: samePerson, addedAt: today },
    ],
  });

  assert.equal(summary.counts.newToday, 3);
});


test("Core's dated counts survive receipt partitioning without using arrival time as send time", () => {
  const published={generatedAt:"2026-09-09T01:00:00.000Z",
    counts:{dayTimeZone:"America/Los_Angeles",newToday:7,emailedToday:5},
    stream:[],queue:[],profilePreparing:[]};
  const summary=profileCacheSummary({...published,profilePreparing:12},{publishedSnapshot:published});
  assert.deepEqual({newToday:summary.counts.newToday,emailedToday:summary.counts.emailedToday,
    dayTimeZone:summary.counts.dayTimeZone},{newToday:7,emailedToday:5,dayTimeZone:"America/Los_Angeles"});
});
