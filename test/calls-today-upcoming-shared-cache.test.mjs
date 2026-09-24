import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// C6 (2026-09-24 Paraform reduction pass): calls-today.html's Upcoming panel
// used to fetch webview-lake.vercel.app/api/status directly from every open
// tab every 30s. It now reads this dashboard's own cached copy through the
// same same-origin api() helper loadCalls() already uses.

const callsToday = await readFile(new URL("../calls-today.html", import.meta.url), "utf8");

test("loadUpcoming reads the shared dashboard cache, not webview directly", () => {
  assert.match(callsToday, /await api\("\/api\/health\/upcoming"\)/);
  assert.doesNotMatch(callsToday, /fetch\("https:\/\/webview-lake\.vercel\.app\/api\/status"/);
});

test("the Upcoming panel still sorts, caps at 100, and renders through upcomingRow", () => {
  const fn = callsToday.slice(
    callsToday.indexOf("async function loadUpcoming("),
    callsToday.indexOf("async function load("),
  );
  assert.match(fn, /sort\(\(a,b\)=>Date\.parse\(a\.join_at\|\|0\)-Date\.parse\(b\.join_at\|\|0\)\)/);
  assert.match(fn, /\.slice\(0,100\)/);
  assert.match(fn, /rows\.map\(upcomingRow\)/);
});
