import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LANES, READERS, MAILBOXES, GROUPS, QUOTA_COSTS } from "../api/emails/_lib/lanes.mjs";
import { CATALOG } from "../api/health/_lib/catalog.mjs";

const SCHEDULE_KINDS = new Set(["every", "marks", "hourly", "daily", "event", "none"]);
const STATUSES = new Set(["live", "paused", "dark", "deprecated", "human-initiated"]);

test("every lane has a unique id and a known group", () => {
  const ids = new Set();
  for (const l of LANES) {
    assert.ok(l.id, `lane "${l.name}" needs an id`);
    assert.ok(!ids.has(l.id), `duplicate lane id: ${l.id}`);
    ids.add(l.id);
    assert.ok(GROUPS.some((g) => g.id === l.group), `${l.id} has unknown group ${l.group}`);
    assert.ok(STATUSES.has(l.status), `${l.id} has unknown status ${l.status}`);
  }
});

// The whole point of the page is that documented status and observed status are
// different things. A healthId that no longer exists would silently downgrade a
// watched lane to "not watched", which reads as a gap rather than as drift.
test("every healthId still exists on the Health board", () => {
  const known = new Set(CATALOG.map((c) => c.id));
  // Beat lanes are built from a template literal, so add the generated ids.
  for (const c of CATALOG) known.add(c.id);
  const missing = [];
  for (const x of [...LANES, ...READERS, ...MAILBOXES]) {
    if (x.healthId && !known.has(x.healthId)) missing.push(`${x.id || x.address} -> ${x.healthId}`);
  }
  assert.deepEqual(missing, [], `healthId no longer on the board:\n  ${missing.join("\n  ")}`);
});

test("schedules are well formed so the timing chart can draw them", () => {
  for (const x of [...LANES, ...READERS]) {
    const s = x.schedule;
    assert.ok(s && SCHEDULE_KINDS.has(s.kind), `${x.id} has an unusable schedule`);
    if (s.kind === "every") {
      assert.ok(s.n >= 1 && s.n <= 60, `${x.id} every.n out of range`);
      assert.ok((s.offset || 0) < s.n, `${x.id} offset ${s.offset} never fires with n=${s.n}`);
    }
    if (s.kind === "marks") {
      assert.ok(Array.isArray(s.minutes) && s.minutes.length, `${x.id} marks needs minutes`);
      for (const m of s.minutes) assert.ok(m >= 0 && m < 60, `${x.id} minute ${m} out of range`);
    }
    if (s.kind === "hourly") assert.ok(s.minute >= 0 && s.minute < 60, `${x.id} hourly minute out of range`);
    if (s.kind === "daily") {
      assert.ok(Array.isArray(s.times) && s.times.length, `${x.id} daily needs times`);
      for (const t of s.times) assert.match(t, /^\d{2}:\d{2}$/, `${x.id} time "${t}" must be HH:MM`);
    }
  }
});

test("every lane carries the detail the page renders", () => {
  for (const l of LANES) {
    for (const f of ["name", "system", "summary", "sender", "recipient", "trigger", "cadence", "runsOn", "volume", "rateLimit"]) {
      assert.ok(String(l[f] || "").trim(), `${l.id} is missing ${f}`);
    }
    assert.ok(Array.isArray(l.messages), `${l.id} needs a messages array`);
    for (const m of l.messages) {
      assert.ok(String(m.subject || "").trim(), `${l.id} has a message with no subject`);
      assert.ok(String(m.delay || "").trim(), `${l.id} has a message with no delay`);
    }
    assert.ok(l.flow.length >= 3, `${l.id} needs a readable flow`);
  }
});

// Copy that lives in the Paraform UI must say so. Inventing a subject line for
// a sequence we cannot read would put words in David's mouth.
test("unreadable sequence copy is declared, never guessed", () => {
  for (const l of LANES.filter((x) => x.group === "paraform")) {
    for (const m of l.messages) {
      const declared = /not in code|no subject/i.test(m.subject);
      assert.ok(declared || m.subject.length > 0, `${l.id}: ${m.subject}`);
    }
  }
});

test("the page and endpoint are wired into the app", async () => {
  const url = (p) => new URL(`../${p}`, import.meta.url);
  const vercel = JSON.parse(await readFile(url("vercel.json"), "utf8"));
  assert.ok(vercel.rewrites.some((r) => r.source === "/emails" && r.destination === "/emails.html"), "/emails rewrite missing");
  assert.ok(vercel.functions["api/emails/*.mjs"], "api/emails function config missing");
  const index = await readFile(url("index.html"), "utf8");
  for (const needle of ['id="tab-emails"', 'id="view-emails"', 'id="emails-frame"', 'emailsLoaded', '"emails"']) {
    assert.ok(index.includes(needle), `index.html missing ${needle}`);
  }
  const page = await readFile(url("emails.html"), "utf8");
  assert.ok(page.includes("/api/emails/state"), "emails.html must read its own endpoint");
});

test("quota costs keep the read-vs-send story intact", () => {
  const byCall = Object.fromEntries(QUOTA_COSTS.map((c) => [c.call, c.units]));
  assert.ok(byCall["Ask what changed"] < byCall["Open a thread, full"], "the cheap call must be cheaper");
  assert.equal(QUOTA_COSTS.filter((c) => c.good).length, 1, "exactly one call is the recommended one");
});
