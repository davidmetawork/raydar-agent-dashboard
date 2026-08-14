// Pure revenue-ledger model: validation, period math, aggregation, pacing.
//
// No I/O, no env reads, no clock of its own — every entry point takes an
// explicit `now`. That keeps the whole thing testable and keeps the ONE rule
// that matters here honest: this ledger is compensation-bearing, so nothing
// in it may be approximate by accident.
//
// MONEY IS INTEGER CENTS, everywhere, always. One real row in David's sheet is
// $8,312.50; float arithmetic on a number people are paid against is not
// acceptable. Parsing happens once, at the edge (`parseMoneyToCents`), and the
// rest of the system only ever sees integers.
//
// RECOGNITION: revenue is booked on `offerSignedAt`. This is what the existing
// Google Sheet already does — verified to the dollar for Feb-Jul 2026 — and it
// is the only basis Paraform cannot supply for us (it pays on hire, not on
// offer signature), which is exactly why this ledger exists.

export const CATEGORIES = ["placement", "platform", "bonus"];
export const STATUSES = ["booked", "collected", "fell_through"];
export const SOURCES = ["paraform", "offplatform"];

// Display roster. Free-text is still accepted (people join), this just drives
// the picker order and keeps casing consistent.
export const TEAM_MEMBERS = ["David", "Kyra", "Noah", "Alzen", "Vanessa", "Raydar"];

export const DEFAULT_TARGET_CENTS = 150_000_000; // $1,500,000
export const TIMEZONE = "America/Los_Angeles";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── primitives ──────────────────────────────────────────────────────────────

/** Today in the Raydar timezone as YYYY-MM-DD. Never uses the server's TZ. */
export function today(now = new Date(), timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export const isDate = (value) => typeof value === "string" && DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/**
 * "$47,500.00" | "47500" | 47500.5 -> integer cents.
 * Returns null on anything it cannot read exactly — never a silent 0, because
 * a silent 0 in a revenue ledger is a deleted deal.
 */
export function parseMoneyToCents(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!cleaned || !/^-?\d*(\.\d+)?$/.test(cleaned) || cleaned === "-" || cleaned === ".") return null;
  return Math.round(Number(cleaned) * 100);
}

export const formatCents = (cents) =>
  `$${(Math.round(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

// ─── period math ─────────────────────────────────────────────────────────────
// All ledger dates are plain YYYY-MM-DD with no time component, so bucketing is
// string math and carries no timezone hazard at all. Only "today" needs a zone.

export const monthOf = (date) => String(date).slice(0, 7);              // 2026-08
export const yearOf = (date) => String(date).slice(0, 4);               // 2026
export const quarterOf = (date) => {
  const month = Number(String(date).slice(5, 7));
  return `${yearOf(date)}-Q${Math.floor((month - 1) / 3) + 1}`;
};

/** The period key a date belongs to, for the page's month/quarter/year toggle. */
export function periodKey(date, granularity) {
  if (granularity === "month") return monthOf(date);
  if (granularity === "quarter") return quarterOf(date);
  return yearOf(date);
}

/** Inclusive [start, end] YYYY-MM-DD bounds of the period containing `date`. */
export function periodBounds(date, granularity) {
  const year = Number(yearOf(date));
  if (granularity === "year") return { start: `${year}-01-01`, end: `${year}-12-31` };
  const month = Number(String(date).slice(5, 7));
  const firstMonth = granularity === "quarter" ? Math.floor((month - 1) / 3) * 3 + 1 : month;
  const lastMonth = granularity === "quarter" ? firstMonth + 2 : month;
  const pad = (n) => String(n).padStart(2, "0");
  return {
    start: `${year}-${pad(firstMonth)}-01`,
    end: `${year}-${pad(lastMonth)}-${pad(daysInMonth(year, lastMonth))}`,
  };
}

export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Every YYYY-MM in a calendar year, in order. */
export const monthsOfYear = (year) =>
  Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

/**
 * How far through the year `date` is, as a fraction in (0, 1].
 * Day-granular and inclusive of today, so the pace line moves every day rather
 * than jumping at month boundaries.
 */
export function yearProgress(date) {
  const year = Number(yearOf(date));
  const startMs = Date.UTC(year, 0, 1);
  const dayIndex = Math.round((Date.parse(`${date}T00:00:00Z`) - startMs) / 86_400_000) + 1;
  const totalDays = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  return Math.min(1, Math.max(0, dayIndex / totalDays));
}

/** Months left in the year including the current one as a fraction. */
export function monthsRemaining(date) {
  const month = Number(String(date).slice(5, 7));
  const day = Number(String(date).slice(8, 10));
  const year = Number(yearOf(date));
  const fractionOfThisMonthLeft = 1 - (day - 1) / daysInMonth(year, month);
  return (12 - month) + fractionOfThisMonthLeft;
}

// ─── weeks (for "calls booked this week") ────────────────────────────────────
// Sunday-start, matching how David's Google Calendar is laid out. A week is
// identified by its Sunday as YYYY-MM-DD.

export function weekStart(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const dayOfWeek = new Date(ms).getUTCDay(); // 0 = Sunday
  return new Date(ms - dayOfWeek * 86_400_000).toISOString().slice(0, 10);
}

/** The last `count` week-start dates ending with the week containing `date`, oldest first. */
export function trailingWeeks(date, count) {
  const current = weekStart(date);
  const currentMs = Date.parse(`${current}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(currentMs - (count - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10));
}

/**
 * Bucket bookings into trailing weeks by the date they were BOOKED (not the
 * date the call happens) — David's explicit definition. The final bucket is
 * the current, still-filling week and is flagged `partial` so nobody reads a
 * Monday number as a finished week.
 */
export function bookingsByWeek(bookings, { asOf, weeks = 12, timeZone = TIMEZONE } = {}) {
  const buckets = new Map(trailingWeeks(asOf, weeks).map((week) => [week, { week, agent: 0, human: 0, total: 0 }]));
  const dayOf = (ms) => new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));

  for (const booking of bookings || []) {
    // A cancelled call was still set. A rescheduled row is the superseded
    // history record and its replacement is counted separately, so counting it
    // here would double-count one call.
    if (booking?.status === "rescheduled") continue;
    const ms = Number(booking?.bookedAtMs);
    if (!Number.isFinite(ms)) continue;
    const bucket = buckets.get(weekStart(dayOf(ms)));
    if (!bucket) continue;
    if (booking.callType === "agent") bucket.agent += 1;
    else if (booking.callType === "human") bucket.human += 1;
    bucket.total += 1;
  }

  const series = [...buckets.values()];
  if (series.length) series[series.length - 1].partial = true;
  return series;
}

// ─── deal validation ─────────────────────────────────────────────────────────

const str = (value, max) => String(value ?? "").trim().slice(0, max);

/**
 * Validate and normalize an inbound deal. Returns {deal} or {errors:[...]}.
 * Deliberately strict on money and dates and forgiving on free text.
 */
export function normalizeDeal(input, { id, now, actor, existing = null } = {}) {
  const errors = [];
  const raw = input || {};

  const category = existing && raw.category === undefined ? existing.category : str(raw.category, 20) || "placement";
  if (!CATEGORIES.includes(category)) errors.push("category must be one of " + CATEGORIES.join(", "));

  const source = existing && raw.source === undefined ? existing.source : str(raw.source, 20) || "offplatform";
  if (!SOURCES.includes(source)) errors.push("source must be one of " + SOURCES.join(", "));

  const status = existing && raw.status === undefined ? existing.status : str(raw.status, 20) || "booked";
  if (!STATUSES.includes(status)) errors.push("status must be one of " + STATUSES.join(", "));

  const offerSignedAt = existing && raw.offerSignedAt === undefined ? existing.offerSignedAt : str(raw.offerSignedAt, 10);
  if (!isDate(offerSignedAt)) errors.push("offerSignedAt must be a YYYY-MM-DD date");

  const optionalDate = (key) => {
    const value = existing && raw[key] === undefined ? existing[key] : (raw[key] == null || raw[key] === "" ? null : str(raw[key], 10));
    if (value !== null && !isDate(value)) errors.push(`${key} must be a YYYY-MM-DD date or empty`);
    return value;
  };
  const startAt = optionalDate("startAt");
  const paidAt = optionalDate("paidAt");

  const dealSizeCents = existing && raw.dealSize === undefined && raw.dealSizeCents === undefined
    ? existing.dealSizeCents
    : (raw.dealSizeCents != null ? (Number.isInteger(raw.dealSizeCents) ? raw.dealSizeCents : null) : parseMoneyToCents(raw.dealSize));
  if (dealSizeCents == null) errors.push("dealSize must be a number");
  else if (dealSizeCents < 0) errors.push("dealSize cannot be negative");

  // A/R defaults to the whole fee: a deal is outstanding until someone says
  // otherwise. Defaulting to 0 would silently claim every new deal was paid.
  let arCents;
  if (existing && raw.ar === undefined && raw.arCents === undefined) arCents = existing.arCents;
  else if (raw.arCents != null) arCents = Number.isInteger(raw.arCents) ? raw.arCents : null;
  else if (raw.ar == null || raw.ar === "") arCents = dealSizeCents ?? 0;
  else arCents = parseMoneyToCents(raw.ar);
  if (arCents == null) errors.push("ar must be a number or empty");
  else if (arCents < 0) errors.push("ar cannot be negative");
  else if (dealSizeCents != null && arCents > dealSizeCents) errors.push("ar cannot exceed dealSize");

  if (errors.length) return { errors };

  const stamp = now || new Date().toISOString();
  const by = str(actor, 120) || "unknown";
  return {
    deal: {
      id: id || existing?.id,
      category,
      source,
      status,
      teamMember: str(raw.teamMember ?? existing?.teamMember, 60) || "Raydar",
      client: str(raw.client ?? existing?.client, 120),
      jobTitle: str(raw.jobTitle ?? existing?.jobTitle, 160),
      candidateRef: str(raw.candidateRef ?? existing?.candidateRef, 120),
      offerSignedAt,
      startAt,
      paidAt,
      dealSizeCents,
      arCents,
      notes: str(raw.notes ?? existing?.notes, 600),
      createdBy: existing?.createdBy || by,
      createdAt: existing?.createdAt || stamp,
      updatedBy: by,
      updatedAt: stamp,
    },
  };
}

// ─── aggregation ─────────────────────────────────────────────────────────────

const live = (deal) => deal.status !== "fell_through";
export const collectedCentsOf = (deal) => Math.max(0, deal.dealSizeCents - deal.arCents);

/**
 * The whole page payload's numbers, derived from the ledger in one pass.
 * `paraformHiresByMonth` is optional: {"2026-08": 3} drives reconciliation.
 */
export function summarize(deals, {
  now = new Date(),
  targetCents = DEFAULT_TARGET_CENTS,
  paraformHiresByMonth = null,
  timeZone = TIMEZONE,
} = {}) {
  const asOf = today(now, timeZone);
  const year = yearOf(asOf);
  const rows = (Array.isArray(deals) ? deals : []).filter((d) => d && isDate(d.offerSignedAt));
  const thisYear = rows.filter((d) => yearOf(d.offerSignedAt) === year);
  const counted = thisYear.filter(live);

  const sum = (list, pick) => list.reduce((total, deal) => total + pick(deal), 0);
  const bookedCents = sum(counted, (d) => d.dealSizeCents);
  const collectedCents = sum(counted, collectedCentsOf);
  const arCents = sum(counted, (d) => d.arCents);

  // Monthly series across the full calendar year, so the chart always shows
  // twelve slots and an empty month reads as zero rather than as missing.
  const byMonth = monthsOfYear(year).map((month) => {
    const monthDeals = counted.filter((d) => monthOf(d.offerSignedAt) === month);
    return {
      month,
      bookedCents: sum(monthDeals, (d) => d.dealSizeCents),
      collectedCents: sum(monthDeals, collectedCentsOf),
      deals: monthDeals.length,
      targetCents: Math.round(targetCents / 12),
    };
  });

  const byQuarter = ["Q1", "Q2", "Q3", "Q4"].map((label) => {
    const key = `${year}-${label}`;
    const quarterDeals = counted.filter((d) => quarterOf(d.offerSignedAt) === key);
    return {
      quarter: key,
      bookedCents: sum(quarterDeals, (d) => d.dealSizeCents),
      collectedCents: sum(quarterDeals, collectedCentsOf),
      deals: quarterDeals.length,
      targetCents: Math.round(targetCents / 4),
    };
  });

  const group = (keyOf) => {
    const map = new Map();
    for (const deal of counted) {
      const key = keyOf(deal) || "Unattributed";
      const entry = map.get(key) || { key, bookedCents: 0, collectedCents: 0, arCents: 0, deals: 0 };
      entry.bookedCents += deal.dealSizeCents;
      entry.collectedCents += collectedCentsOf(deal);
      entry.arCents += deal.arCents;
      entry.deals += 1;
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.bookedCents - a.bookedCents);
  };

  const progress = yearProgress(asOf);
  const paceTargetCents = Math.round(targetCents * progress);
  const remainingMonths = monthsRemaining(asOf);
  const elapsedMonths = Math.max(1 / 30, 12 - remainingMonths);

  return {
    asOf,
    year,
    targetCents,
    bookedCents,
    collectedCents,
    arCents,
    dealCount: counted.length,
    fellThroughCount: thisYear.length - counted.length,
    pace: {
      progress,
      paceTargetCents,
      // Positive = ahead of an even-split pace, negative = behind.
      varianceCents: bookedCents - paceTargetCents,
      remainingCents: Math.max(0, targetCents - bookedCents),
      monthsRemaining: remainingMonths,
      // The sentence that makes this page worth opening: what per-month rate
      // closes the year, versus the rate actually being run.
      requiredPerMonthCents: remainingMonths > 0
        ? Math.round(Math.max(0, targetCents - bookedCents) / remainingMonths)
        : 0,
      trailingPerMonthCents: Math.round(bookedCents / elapsedMonths),
      onTrack: bookedCents >= paceTargetCents,
    },
    byMonth,
    byQuarter,
    byMember: group((d) => d.teamMember),
    byCategory: group((d) => d.category),
    ar: arAging(counted, asOf),
    reconciliation: reconcile(counted, paraformHiresByMonth, year),
  };
}

/**
 * A/R aged from `startAt` when we have it, else `offerSignedAt`. Invoicing
 * follows the start date in practice; the fallback keeps a deal with no start
 * date visible rather than silently un-aged.
 */
export function arAging(deals, asOf) {
  const buckets = [
    { label: "0-30", min: 0, max: 30, cents: 0, deals: 0 },
    { label: "31-60", min: 31, max: 60, cents: 0, deals: 0 },
    { label: "61-90", min: 61, max: 90, cents: 0, deals: 0 },
    { label: "90+", min: 91, max: Infinity, cents: 0, deals: 0 },
  ];
  let totalCents = 0;
  for (const deal of deals) {
    if (deal.arCents <= 0) continue;
    const from = deal.startAt || deal.offerSignedAt;
    const days = Math.max(0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
    const bucket = buckets.find((b) => days >= b.min && days <= b.max);
    if (!bucket) continue;
    bucket.cents += deal.arCents;
    bucket.deals += 1;
    totalCents += deal.arCents;
  }
  return { totalCents, buckets };
}

/**
 * Paraform's hired column is David's stated source of truth for "an offer was
 * signed", but it lags and he enters deals by hand. So we never auto-create
 * revenue from it — we only compare counts per month and surface a gap. A
 * month where Paraform reports more hires than the ledger has placement rows
 * is a prompt, not a number.
 */
export function reconcile(deals, paraformHiresByMonth, year) {
  if (!paraformHiresByMonth || typeof paraformHiresByMonth !== "object") {
    return { available: false, months: [], missingTotal: 0 };
  }
  const months = [];
  let missingTotal = 0;
  for (const month of monthsOfYear(year)) {
    const hires = Number(paraformHiresByMonth[month]);
    if (!Number.isFinite(hires)) continue;
    const ledger = deals.filter((d) => d.category === "placement" && monthOf(d.offerSignedAt) === month).length;
    const missing = Math.max(0, hires - ledger);
    if (missing > 0) missingTotal += missing;
    months.push({ month, paraformHires: hires, ledgerDeals: ledger, missing });
  }
  return { available: true, months, missingTotal };
}

// ─── bulk import ─────────────────────────────────────────────────────────────

const IMPORT_HEADERS = {
  "team member": "teamMember", team: "teamMember", member: "teamMember",
  client: "client", company: "client",
  "job title": "jobTitle", role: "jobTitle", title: "jobTitle",
  "candidate name": "candidateRef", candidate: "candidateRef",
  "offer signed": "offerSignedAt", signed: "offerSignedAt",
  "start date": "startAt", start: "startAt",
  paid: "paidAt",
  "deal size": "dealSize", amount: "dealSize", value: "dealSize",
  ar: "ar", "a/r": "ar", outstanding: "ar",
  category: "category", notes: "notes",
};

/**
 * Parse pasted TSV/CSV from the revenue sheet into candidate deals.
 *
 * Deliberately tolerant of the real sheet: bare month-day dates ("Nov 15",
 * "August 1st"), "Pending"/"-" in the paid column, blank rows, and a trailing
 * totals block. Every row that cannot be read exactly is reported as a skip
 * with its reason rather than being dropped silently.
 */
export function parseImport(text, { defaultYear, now = new Date(), timeZone = TIMEZONE } = {}) {
  const year = defaultYear || yearOf(today(now, timeZone));
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { rows: [], skipped: [], headers: [] };

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const cells = (line) => line.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, "$1"));

  // Real sheet headers carry an as-of date: the live A/R column is literally
  // "A/R: 8/14/26". Everything from the first colon on is an annotation, not
  // part of the column name. Without this the A/R column silently fails to
  // map and every imported deal defaults to zero outstanding — i.e. it reads
  // as fully collected, which is the worst possible silent error here.
  const headerCells = cells(lines[0])
    .map((cell) => cell.toLowerCase().split(":")[0].replace(/\s+/g, " ").trim());
  const mapped = headerCells.map((cell) => IMPORT_HEADERS[cell] || null);
  if (!mapped.includes("dealSize") || !mapped.includes("offerSignedAt")) {
    return { rows: [], skipped: [], headers: headerCells, error: "need at least a deal-size column and an offer-signed column" };
  }

  const rows = [];
  const skipped = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = cells(lines[i]);
    if (!values.some((value) => value && value !== "-")) continue;
    const row = {};
    mapped.forEach((field, index) => { if (field) row[field] = values[index] ?? ""; });

    // The sheet's trailing totals block has money but no client and no date.
    if (!row.client && !row.candidateRef) { skipped.push({ line: i + 1, reason: "no client or candidate — looks like a totals row" }); continue; }

    const signed = coerceSheetDate(row.offerSignedAt, year);
    if (!signed) { skipped.push({ line: i + 1, reason: `could not read offer-signed date "${row.offerSignedAt}"` }); continue; }
    const cents = parseMoneyToCents(row.dealSize);
    if (cents == null) { skipped.push({ line: i + 1, reason: `could not read deal size "${row.dealSize}"` }); continue; }

    rows.push({
      teamMember: row.teamMember || "Raydar",
      client: row.client,
      jobTitle: row.jobTitle || "",
      candidateRef: row.candidateRef || "",
      offerSignedAt: signed,
      startAt: coerceSheetDate(row.startAt, year),
      paidAt: coerceSheetDate(row.paidAt, year),
      dealSizeCents: cents,
      arCents: parseMoneyToCents(row.ar) ?? 0,
      category: CATEGORIES.includes(String(row.category || "").toLowerCase())
        ? String(row.category).toLowerCase()
        : (/platform/i.test(row.jobTitle || "") ? "platform" : /bonus/i.test(row.candidateRef || "") ? "bonus" : "placement"),
      source: "offplatform",
      status: "booked",
      notes: row.notes || "",
    });
  }
  return { rows, skipped, headers: headerCells };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * "Nov 15" | "August 1st" | "Mar 7, 2026" | "2026-03-07" -> YYYY-MM-DD.
 * "Pending", "-", "" and anything unreadable -> null (an honest unknown).
 */
export function coerceSheetDate(input, defaultYear) {
  const value = String(input ?? "").trim();
  if (!value || value === "-" || /^(pending|tbd|n\/a)$/i.test(value)) return null;
  if (DATE_RE.test(value)) return isDate(value) ? value : null;

  const match = value.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$/i);
  if (!match) {
    // A bare year ("2025") carries no day — not a date we can bucket.
    return null;
  }
  const monthIndex = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase());
  if (monthIndex < 0) return null;
  const day = Number(match[2]);
  const year = Number(match[3] || defaultYear);
  if (day < 1 || day > daysInMonth(year, monthIndex + 1)) return null;
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ─── CSV export ──────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  ["id", (d) => d.id],
  ["category", (d) => d.category],
  ["source", (d) => d.source],
  ["status", (d) => d.status],
  ["teamMember", (d) => d.teamMember],
  ["client", (d) => d.client],
  ["jobTitle", (d) => d.jobTitle],
  ["candidate", (d) => d.candidateRef],
  ["offerSignedAt", (d) => d.offerSignedAt],
  ["startAt", (d) => d.startAt || ""],
  ["paidAt", (d) => d.paidAt || ""],
  ["dealSize", (d) => (d.dealSizeCents / 100).toFixed(2)],
  ["ar", (d) => (d.arCents / 100).toFixed(2)],
  ["collected", (d) => (collectedCentsOf(d) / 100).toFixed(2)],
  ["notes", (d) => d.notes || ""],
  ["createdBy", (d) => d.createdBy || ""],
  ["updatedAt", (d) => d.updatedAt || ""],
];

const csvCell = (value) => {
  const text = String(value ?? "");
  // Guard against spreadsheet formula injection on re-import elsewhere.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(deals) {
  const header = CSV_COLUMNS.map(([name]) => name).join(",");
  const body = (deals || []).map((deal) => CSV_COLUMNS.map(([, pick]) => csvCell(pick(deal))).join(",")).join("\n");
  return `${header}\n${body}\n`;
}
