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

// 2026-09-28: the page no longer polls Paraform at all. The scheduled
// refresh (vercel.json, three times a day) and Refresh now are the only
// Paraform-reading paths; an open page only re-reads the stored snapshot.
test("an open Inbox page re-reads the stored snapshot and never polls Paraform", () => {
  assert.match(inboxHtml, /setInterval\(\(\)=>loadFeed\(\),600000\)/);
  assert.doesNotMatch(inboxHtml, /setInterval\(\(\)=>(?:queueInboxSync|syncFeed)/);
  assert.doesNotMatch(inboxHtml, /queueInboxSync/);
});

test("opening the page starts no cold-start reseed burst", () => {
  assert.doesNotMatch(inboxHtml, /seedPasses/);
  assert.match(inboxHtml, /function startApp\(\)\{\n  loadHealth\(\);\n  loadFeed\(\);\n/);
});
