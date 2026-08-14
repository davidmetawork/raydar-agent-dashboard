// The revenue model is compensation-bearing. These tests pin the behaviours
// that would quietly produce a WRONG number rather than an obvious crash:
// money parsing, recognition bucketing, A/R defaulting, pace arithmetic, the
// sheet's real date formats, and the reconciliation prompt.

import assert from "node:assert/strict";
import test from "node:test";

import {
  arAging, bookingsByWeek, coerceSheetDate, collectedCentsOf, formatCents,
  monthsRemaining, normalizeDeal, parseImport, parseMoneyToCents, periodBounds,
  quarterOf, reconcile, summarize, toCsv, today, trailingWeeks, weekStart, yearProgress,
} from "../api/revenue/_lib/model.mjs";

const AUG = new Date("2026-08-14T18:00:00Z"); // 11:00 in America/Los_Angeles

// ─── money ───────────────────────────────────────────────────────────────────

test("money parses the sheet's real formats to exact cents", () => {
  assert.equal(parseMoneyToCents("$47,500.00"), 4750000);
  assert.equal(parseMoneyToCents("8312.50"), 831250);   // the row that forbids floats
  assert.equal(parseMoneyToCents("$8,312.50"), 831250);
  assert.equal(parseMoneyToCents(20000), 2000000);
  assert.equal(parseMoneyToCents("0"), 0);
});

test("unreadable money is null, never a silent zero", () => {
  for (const bad of ["", "  ", "Pending", "-", "abc", "1.2.3", null, undefined, {}, NaN]) {
    assert.equal(parseMoneyToCents(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("cent arithmetic does not drift on a half-dollar row", () => {
  // 8312.50 + 23625.00 + 32000.00 = 63937.50 exactly, which float dollars fumble.
  const total = parseMoneyToCents("8312.50") + parseMoneyToCents("23625") + parseMoneyToCents("32000");
  assert.equal(total, 6393750);
  assert.equal(formatCents(total), "$63,938");
});

// ─── periods ─────────────────────────────────────────────────────────────────

test("quarters and period bounds are calendar-exact", () => {
  assert.equal(quarterOf("2026-01-01"), "2026-Q1");
  assert.equal(quarterOf("2026-08-14"), "2026-Q3");
  assert.equal(quarterOf("2026-12-31"), "2026-Q4");
  assert.deepEqual(periodBounds("2026-08-14", "quarter"), { start: "2026-07-01", end: "2026-09-30" });
  assert.deepEqual(periodBounds("2026-02-10", "month"), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(periodBounds("2024-02-10", "month"), { start: "2024-02-01", end: "2024-02-29" });
});

test("today uses the Raydar timezone, not the server's", () => {
  // 02:00 UTC on the 15th is still the 14th in Los Angeles.
  assert.equal(today(new Date("2026-08-15T02:00:00Z")), "2026-08-14");
});

test("year progress and months remaining move day by day", () => {
  assert.ok(Math.abs(yearProgress("2026-08-14") - 226 / 365) < 1e-9);
  assert.equal(yearProgress("2026-12-31"), 1);
  // Mid-August: four whole months plus most of August.
  const remaining = monthsRemaining("2026-08-14");
  assert.ok(remaining > 4.5 && remaining < 4.7, `got ${remaining}`);
});

// ─── validation ──────────────────────────────────────────────────────────────

const base = { client: "Alcove", offerSignedAt: "2026-08-01", dealSize: "10000", teamMember: "David" };

test("a valid deal normalizes and defaults A/R to the whole fee", () => {
  const { deal, errors } = normalizeDeal(base, { id: "x", now: "2026-08-14T00:00:00Z", actor: "david@raydar.xyz" });
  assert.equal(errors, undefined);
  assert.equal(deal.dealSizeCents, 1000000);
  // Unpaid until someone says otherwise — defaulting to 0 would claim it was collected.
  assert.equal(deal.arCents, 1000000);
  assert.equal(collectedCentsOf(deal), 0);
  assert.equal(deal.createdBy, "david@raydar.xyz");
});

test("bad money, bad dates and impossible A/R are rejected", () => {
  assert.ok(normalizeDeal({ ...base, dealSize: "abc" }, {}).errors);
  assert.ok(normalizeDeal({ ...base, offerSignedAt: "14/08/2026" }, {}).errors);
  assert.ok(normalizeDeal({ ...base, offerSignedAt: "" }, {}).errors);
  assert.ok(normalizeDeal({ ...base, dealSize: "-5" }, {}).errors);
  assert.ok(normalizeDeal({ ...base, ar: "20000" }, {}).errors, "A/R above the fee must fail");
  assert.ok(normalizeDeal({ ...base, category: "nonsense" }, {}).errors);
});

test("a patch keeps untouched fields and preserves original authorship", () => {
  const { deal } = normalizeDeal(base, { id: "x", now: "2026-08-01T00:00:00Z", actor: "kyra@raydar.xyz" });
  const { deal: patched } = normalizeDeal({ status: "fell_through" }, {
    id: "x", now: "2026-08-14T00:00:00Z", actor: "david@raydar.xyz", existing: deal,
  });
  assert.equal(patched.status, "fell_through");
  assert.equal(patched.client, "Alcove");
  assert.equal(patched.dealSizeCents, 1000000);
  assert.equal(patched.createdBy, "kyra@raydar.xyz");
  assert.equal(patched.updatedBy, "david@raydar.xyz");
});

// ─── aggregation ─────────────────────────────────────────────────────────────

const mk = (over) => normalizeDeal({ ...base, ...over }, { id: Math.random().toString(36).slice(2), now: "2026-08-14T00:00:00Z", actor: "t" }).deal;

test("revenue is recognized on the offer-signed date", () => {
  const summary = summarize([
    mk({ offerSignedAt: "2026-02-20", dealSize: "41500", paidAt: "2026-06-01" }),
    mk({ offerSignedAt: "2026-08-01", dealSize: "32000" }),
  ], { now: AUG });
  const february = summary.byMonth.find((m) => m.month === "2026-02");
  // Booked in February despite being paid in June.
  assert.equal(february.bookedCents, 4150000);
  assert.equal(summary.bookedCents, 4150000 + 3200000);
});

test("fell-through deals stop counting but stay reported", () => {
  const summary = summarize([
    mk({ dealSize: "10000" }),
    mk({ dealSize: "99000", status: "fell_through" }),
  ], { now: AUG });
  assert.equal(summary.bookedCents, 1000000);
  assert.equal(summary.dealCount, 1);
  assert.equal(summary.fellThroughCount, 1);
});

test("a prior-year deal never leaks into this year's total", () => {
  const summary = summarize([mk({ offerSignedAt: "2025-11-15", dealSize: "47500" })], { now: AUG });
  assert.equal(summary.bookedCents, 0);
});

test("collected is the fee minus outstanding A/R, matching the sheet's Received line", () => {
  const summary = summarize([
    mk({ dealSize: "25000", ar: "5000" }),
    mk({ dealSize: "20000", ar: "0" }),
  ], { now: AUG });
  assert.equal(summary.bookedCents, 4500000);
  assert.equal(summary.arCents, 500000);
  assert.equal(summary.collectedCents, 4000000);
  assert.equal(summary.bookedCents, summary.collectedCents + summary.arCents);
});

test("pace states the gap and the rate needed to close it", () => {
  // $600k booked against $1.5m, 62% through the year.
  const summary = summarize([mk({ dealSize: "600000" })], { now: AUG, targetCents: 150000000 });
  assert.equal(summary.bookedCents, 60000000);
  assert.equal(summary.pace.remainingCents, 90000000);
  assert.equal(summary.pace.onTrack, false);
  assert.ok(summary.pace.varianceCents < 0);
  // ~$90m cents over ~4.6 months.
  assert.ok(summary.pace.requiredPerMonthCents > 19000000 && summary.pace.requiredPerMonthCents < 20000000,
    `got ${summary.pace.requiredPerMonthCents}`);
});

test("the monthly series always has twelve slots so an empty month reads as zero", () => {
  const summary = summarize([mk({ dealSize: "1000" })], { now: AUG });
  assert.equal(summary.byMonth.length, 12);
  assert.equal(summary.byQuarter.length, 4);
  assert.equal(summary.byMonth.filter((m) => m.bookedCents === 0).length, 11);
});

test("A/R ages from the start date when present, else from the signing date", () => {
  const aging = arAging([
    { offerSignedAt: "2026-08-10", startAt: null, arCents: 100 },   // 4 days
    { offerSignedAt: "2026-01-01", startAt: "2026-05-01", arCents: 200 }, // 105 days
    { offerSignedAt: "2026-08-01", startAt: null, arCents: 0 },     // nothing outstanding
  ], "2026-08-14");
  assert.equal(aging.totalCents, 300);
  assert.equal(aging.buckets[0].cents, 100);
  assert.equal(aging.buckets[3].cents, 200);
});

test("reconciliation prompts when Paraform reports more hires than the ledger holds", () => {
  const deals = [mk({ offerSignedAt: "2026-08-01" })];
  const result = reconcile(deals, { "2026-08": 3, "2026-07": 0 }, "2026");
  assert.equal(result.available, true);
  assert.equal(result.missingTotal, 2);
  assert.equal(result.months.find((m) => m.month === "2026-08").missing, 2);
});

test("reconciliation is absent, not zero, when Paraform data is missing", () => {
  assert.equal(reconcile([], null, "2026").available, false);
  assert.equal(summarize([], { now: AUG }).reconciliation.available, false);
});

// ─── weeks ───────────────────────────────────────────────────────────────────

test("weeks start on Sunday and trail in order", () => {
  assert.equal(weekStart("2026-08-14"), "2026-08-09"); // Friday -> preceding Sunday
  assert.equal(weekStart("2026-08-09"), "2026-08-09"); // a Sunday is its own start
  const weeks = trailingWeeks("2026-08-14", 3);
  assert.deepEqual(weeks, ["2026-07-26", "2026-08-02", "2026-08-09"]);
});

test("calls are bucketed by when they were booked, and the current week is flagged partial", () => {
  const series = bookingsByWeek([
    { bookedAtMs: Date.parse("2026-08-12T17:00:00Z"), callType: "agent", status: "confirmed" },
    { bookedAtMs: Date.parse("2026-08-12T18:00:00Z"), callType: "human", status: "cancelled" },
    { bookedAtMs: Date.parse("2026-08-05T17:00:00Z"), callType: "agent", status: "confirmed" },
    { bookedAtMs: Date.parse("2026-08-12T19:00:00Z"), callType: "agent", status: "rescheduled" },
  ], { asOf: "2026-08-14", weeks: 3 });

  const current = series[series.length - 1];
  assert.equal(current.week, "2026-08-09");
  assert.equal(current.partial, true);
  // A cancelled call was still set; the superseded "rescheduled" row is not
  // counted, because its replacement is counted separately.
  assert.equal(current.agent, 1);
  assert.equal(current.human, 1);
  assert.equal(current.total, 2);
  assert.equal(series[1].agent, 1);
});

// ─── import ──────────────────────────────────────────────────────────────────

test("the sheet's date shapes parse, and unknown ones stay null", () => {
  assert.equal(coerceSheetDate("Nov 15", 2026), "2026-11-15");
  assert.equal(coerceSheetDate("August 1st", 2026), "2026-08-01");
  assert.equal(coerceSheetDate("Mar 7, 2026", 2026), "2026-03-07");
  assert.equal(coerceSheetDate("2026-03-07", 2026), "2026-03-07");
  for (const unknown of ["Pending", "-", "", "2025", "Feb 30", "Smarch 4"]) {
    assert.equal(coerceSheetDate(unknown, 2026), null, `expected null for ${unknown}`);
  }
});

test("a pasted sheet imports real rows and reports every skip with a reason", () => {
  const pasted = [
    "Team Member\tClient\tJob Title\tCandidate Name\tOffer Signed\tStart Date\tPaid\tDeal Size\tA/R",
    "Kyra\tCrosby Legal\tCounsel\tPerson A\tNov 15\tDec 15\tJan 15\t$47,500.00\t",
    "Raydar\tStrala\tMarketing Analyst\tPerson B\tAug 12\tAug 24\t\t$8,312.50\t$8,312.50",
    "\t\t\t\t\t\tTOTAL\t689,202\t",
    "David\tBroken\tRole\tPerson C\tnot a date\t\t\t$1,000\t",
  ].join("\n");

  const { rows, skipped } = parseImport(pasted, { defaultYear: "2026", now: AUG });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dealSizeCents, 4750000);
  assert.equal(rows[1].dealSizeCents, 831250);
  assert.equal(rows[1].arCents, 831250);
  assert.equal(rows[0].offerSignedAt, "2026-11-15");
  // The totals row and the unreadable date are both reported, never coerced.
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /totals row/);
  assert.match(skipped[1].reason, /offer-signed date/);
});

test("the live sheet's dated A/R header still maps, so A/R is never silently zeroed", () => {
  // The real column is literally "A/R: 8/14/26". If the as-of date defeats the
  // header match, every imported deal gets A/R 0 and reads as fully collected.
  const pasted = [
    "Team Member\tClient\tJob Title\tCandidate Name\tOffer Signed\tStart Date\tPaid\tDeal Size\tA/R: 8/14/26",
    "Kyra\tSunlight\tGeneral Counsel\tPerson A\tAugust 1st\tAugust 24th\t\t$32,000.00\t$12,500.00",
    "Noah\tLoancrate\tSenior SWE\tPerson B\tJune 1\tJun 15\t-\t$25,000.00\t$10,000.00",
  ].join("\n");

  const { rows, skipped } = parseImport(pasted, { defaultYear: "2026", now: AUG });
  assert.equal(skipped.length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].arCents, 1250000, "A/R must survive the dated header");
  assert.equal(rows[1].arCents, 1000000);
  assert.equal(rows[0].offerSignedAt, "2026-08-01");
  assert.equal(rows[1].startAt, "2026-06-15");
  assert.equal(rows[1].paidAt, null, '"-" is an honest unknown, not a date');
});

test("a bonus row dated only by year is skipped with a reason, never guessed", () => {
  // Two real rows carry "2025" in the Offer Signed column. A bare year has no
  // day, so it cannot be bucketed; reporting it beats inventing a date.
  const pasted = [
    "Team Member\tClient\tJob Title\tCandidate Name\tOffer Signed\tDeal Size",
    "EXTRA\tPomelo Care\tCounsel\tBONUS\t2025\t$2,256.00",
  ].join("\n");
  const { rows, skipped } = parseImport(pasted, { defaultYear: "2026", now: AUG });
  assert.equal(rows.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /offer-signed date "2025"/);
});

test("import refuses a paste whose columns it cannot identify", () => {
  const result = parseImport("Foo\tBar\nbaz\tqux", { defaultYear: "2026", now: AUG });
  assert.ok(result.error);
  assert.equal(result.rows.length, 0);
});

test("platform revenue is categorized from the sheet's own wording", () => {
  const pasted = [
    "Team Member\tClient\tJob Title\tCandidate Name\tOffer Signed\tDeal Size",
    "Raydar\tParaform\tPlatform Revenue\t-\tJan 5\t$53,450.00",
  ].join("\n");
  const { rows } = parseImport(pasted, { defaultYear: "2026", now: AUG });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "platform");
});

// ─── export ──────────────────────────────────────────────────────────────────

test("CSV round-trips money as dollars and neutralizes formula injection", () => {
  const deal = mk({ client: "=cmd|calc", dealSize: "8312.50", ar: "0" });
  const csv = toCsv([deal]);
  assert.match(csv, /^id,category,source,status,teamMember,client/);
  assert.match(csv, /8312\.50/);
  assert.match(csv, /'=cmd\|calc/, "a leading = must be escaped so a reopened CSV cannot execute it");
});

test("CSV quotes any field containing a comma", () => {
  const deal = mk({ client: "Acme, Inc." });
  assert.match(toCsv([deal]), /"Acme, Inc\."/);
});
