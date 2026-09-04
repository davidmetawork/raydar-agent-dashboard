import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const applicants = readFileSync(resolve("applicants.html"), "utf8");

test("Applicants explains that uncached candidates are held off the page until ready", () => {
  assert.match(applicants, /STATE\.profileCache = body\.profileCache \|\| null/);
  assert.match(applicants, /still missing a readable source profile; they remain in Profile preparing until that source history is available/);
});

// THE PREPARING NUMBER HAS TWO HALVES (2026-09-04 review).
//
// feed.mjs now partitions rather than 503s, so "N profiles are preparing" is
// Core's own immutable partition PLUS whatever THIS read withheld because a
// Hub re-observation moved a row's observation id under a live generation.
// feed reports the second half as `profileReceiptWithheld` explicitly so the
// tab can name it — and for one review round the tab ignored the field, which
// is how 1,808 preparing rows on 2026-09-04 cost a day of guessing whether
// upstream was still working or the generation had aged out from under it.
test("the tab reads the read-time withheld count the feed reports", () => {
  assert.match(applicants, /STATE\.profileReceiptWithheld = Number\(body\.profileReceiptWithheld\) \|\| 0;/);
  assert.match(applicants, /profileReceiptWithheld: 0,/);
  // Cleared with the rest of the feed state, so a stale number cannot outlive
  // the publication it described.
  assert.match(applicants, /STATE\.profileReceiptWithheld = 0;/);
});

test("the preparing banner says which half this read withheld, and why it clears", () => {
  assert.match(applicants, /const withheldNow = Number\(STATE\.profileReceiptWithheld\) \|\| 0;/);
  assert.match(applicants, /withheld by this read, not by the publisher/);
  assert.match(applicants, /they return when Core publishes the next one/);
  // Silent when there is nothing to split — a plain Core preparing partition
  // must not grow a sentence about a read that withheld nothing.
  assert.match(applicants, /withheldNow > 0\s*\?/);
});
