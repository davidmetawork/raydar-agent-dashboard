// A BARE DATE IS A CALENDAR DAY, NOT AN INSTANT.
//
// `new Date("2026-08-25")` is specified to parse as UTC midnight, but every
// reader in applicants.html asks for the day back with LOCAL getters
// (getMonth/getDate). West of UTC those disagree by exactly one day, so on
// 2026-08-25 David's review queue showed its newest applicants as
// "Aug 24 · 20h ago" and looked like it had received nothing all day — while
// 18 of its rows had in fact arrived that morning. Every date on the page was
// a day early, and the queue looked stale when it was current.
//
// These tests run the real helper out of the real file, in two timezones, in
// child processes — because the bug IS the timezone and asserting it in one
// zone proves nothing. A source-shape assertion alone would also be too weak:
// someone could "simplify" parseDate back to `new Date(v)` and every regex
// here would still pass if it only checked for the function's existence.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

/** The real helpers, lifted verbatim out of the page. */
function extractHelpers() {
  const dateOnly = /const DATE_ONLY = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/;/.exec(source);
  assert.ok(dateOnly, "DATE_ONLY guard missing — a bare date is being parsed as an instant again");
  const parse = /function parseDate\(v\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(parse, "parseDate not found");
  const short = /function shortDate\(v\) \{.*?\n/.exec(source);
  assert.ok(short, "shortDate not found");
  const months = /const MONTHS = \[[^\]]*\];/.exec(source);
  assert.ok(months, "MONTHS not found");
  return [months[0], dateOnly[0], parse[0], short[0]].join("\n");
}

/** Evaluate the page's own helpers under a given TZ, in a child process. */
function renderIn(timeZone, value) {
  const script = `${extractHelpers()}\nprocess.stdout.write(String(shortDate(${JSON.stringify(value)})));`;
  return execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, TZ: timeZone },
    encoding: "utf8",
  });
}

test("a date-only appliedAt renders as that calendar day, west of UTC and east of it", () => {
  // The regression: this returned "Aug 24" in Pacific before the fix.
  assert.equal(renderIn("America/Los_Angeles", "2026-08-25"), "Aug 25");
  assert.equal(renderIn("UTC", "2026-08-25"), "Aug 25");
  assert.equal(renderIn("Asia/Tokyo", "2026-08-25"), "Aug 25");
  // A day that also crosses a month boundary, where an off-by-one is loudest.
  assert.equal(renderIn("America/Los_Angeles", "2026-09-01"), "Sep 1");
});

test("a real timestamp is still an instant and is NOT shifted", () => {
  // 19:44Z on the 25th is still the 25th in Pacific (12:44pm) — unchanged
  // behaviour, and the reason the guard matches only bare dates.
  assert.equal(renderIn("America/Los_Angeles", "2026-08-25T19:44:02.400Z"), "Aug 25");
  // ...and an instant genuinely early enough to fall on the previous local day
  // MUST still render as that previous day. This is the case a blanket
  // "always parse as local" fix would have broken.
  assert.equal(renderIn("America/Los_Angeles", "2026-08-25T03:00:00.000Z"), "Aug 24");
});

test("the guard is in the file, so a simplification back to new Date(v) fails here", () => {
  assert.match(source, /const DATE_ONLY = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(source, /DATE_ONLY\.test\(s\) \? new Date\(s \+ "T00:00:00"\) : new Date\(s\)/);
});
