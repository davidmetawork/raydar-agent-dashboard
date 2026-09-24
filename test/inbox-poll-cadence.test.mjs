import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// C5 (2026-09-24 Paraform reduction pass): steady-state poll 3min -> 15min
// (David-approved number, Inbox stays tighter than the Monitor-wide "up to
// an hour old" default since it's a reply-triage action surface), cold-start
// reseed burst spacing 1s -> 12s (each pass can fan out to
// INBOX_SYNC_BATCH_SIZE Paraform calls at INBOX_FANOUT_CONCURRENCY; six
// passes at 1s could burst ~120 calls in under 10s).
const inboxHtml = await readFile(new URL("../inbox.html", import.meta.url), "utf8");

test("the steady-state Inbox poll fires every 15 minutes, not 3", () => {
  assert.match(inboxHtml, /setInterval\(\(\)=>queueInboxSync\(\),900000\)/);
  assert.doesNotMatch(inboxHtml, /setInterval\(\(\)=>queueInboxSync\(\),180000\)/);
});

test("the cold-start reseed burst paces at 12s, still capped at 6 passes", () => {
  assert.match(inboxHtml, /STATE\.snapshotState==="seeding"&&STATE\.seedPasses<6\)queueInboxSync\(12000\)/);
  assert.doesNotMatch(inboxHtml, /STATE\.seedPasses<6\)queueInboxSync\(1000\)/);
});
