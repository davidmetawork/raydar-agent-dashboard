// The honest "Interview requested" pill (2026-09-05).
//
// The pill counted every queue row with an `interview` decision in
// apphub:decisions, whether or not the invitation had already been sent. On
// 2026-09-05, against the live published queue (4,766 rows) and the live KV
// hashes, that read 319 while 248 of those rows carried an `invited` ack: four
// out of five people the tab presented as "still to email" had already been
// emailed, and 71 were genuinely outstanding. On a tab whose one unforgivable
// mistake is a second interview email for the same role, that is not a
// cosmetic miscount.
//
// These tests pin both halves: the shape of the wiring (like the other
// applicants.html suites, which no server test can see), and the BEHAVIOUR of
// the split predicates, lifted whole out of the shipped file so the harness
// cannot drift from what the browser runs.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

/* ---- the shipped predicates, lifted whole ---- */

function between(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = text.indexOf(end, from);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return text.slice(from, to + end.length);
}

const block = between(applicants, "const SENT_ACK_STATUSES", "/* ---- end already-emailed block ---- */");

function harness({ rows = [], decisions = {}, acks = {}, local = {} } = {}) {
  const context = vm.createContext({ String, Object, Array, Boolean, Set, JSON, console });
  context.__rows = rows;
  context.__decisions = decisions;
  context.__acks = acks;
  context.__local = local;
  // The three collaborators, transcribed from applicants.html (queueRows :506,
  // effectiveDecision :494-501, ackFor :965-969) — including ackFor's
  // requestId guard, which is what keeps a stale ack from masking a fresh click.
  vm.runInContext(
    `const STATE = { snapshot: { queue: __rows }, decisions: __decisions, acks: __acks, local: __local };
     function queueRows() { return STATE.snapshot?.queue || []; }
     function effectiveDecision(key) {
       const decision = STATE.local[key] || STATE.decisions[key] || null;
       if (decision?.action === 'undo') return null;
       return decision;
     }
     function ackFor(key) {
       const decision = STATE.local[key] || STATE.decisions[key];
       const ack = STATE.acks[key];
       return decision?.requestId && ack?.requestId !== decision.requestId ? null : ack || null;
     }
     ` + block,
    context,
  );
  return {
    requested: () => vm.runInContext("requestedRows().map((r) => r.key)", context),
    emailed: () => vm.runInContext("emailedRows().map((r) => r.key)", context),
  };
}

const row = (key, extra = {}) => ({ key, ...extra });

test("an interview decision whose ack says invited leaves Interview requested and lands in Already emailed", () => {
  const h = harness({
    rows: [row("a"), row("b")],
    decisions: { a: { action: "interview" }, b: { action: "interview" } },
    acks: { a: { status: "invited" } },
  });
  assert.deepEqual(h.requested(), ["b"]);
  assert.deepEqual(h.emailed(), ["a"]);
});

test("sendgrid_delivered counts as sent, blocked does not", () => {
  const h = harness({
    rows: [row("a"), row("b")],
    decisions: { a: { action: "interview" }, b: { action: "interview" } },
    acks: { a: { status: "sendgrid_delivered" }, b: { status: "blocked" } },
  });
  assert.deepEqual(h.requested(), ["b"], "a hard-held row still owes an email, so it stays outstanding");
  assert.deepEqual(h.emailed(), ["a"]);
});

test("a fresh click is NOT hidden by a stale ack from an earlier request", () => {
  // The exact regression this must never introduce: a row emailed last month,
  // re-decided today, would silently vanish from the pill if the old ack
  // counted. ackFor's requestId guard is why it does not.
  const h = harness({
    rows: [row("a")],
    decisions: { a: { action: "interview", requestId: "req-new" } },
    acks: { a: { status: "invited", requestId: "req-old" } },
  });
  assert.deepEqual(h.requested(), ["a"]);
  assert.deepEqual(h.emailed(), []);
});

test("the local optimistic overlay keeps a just-clicked row outstanding until its own ack arrives", () => {
  const h = harness({
    rows: [row("a")],
    local: { a: { action: "interview", requestId: "req-1" } },
    acks: {},
  });
  assert.deepEqual(h.requested(), ["a"]);
  assert.deepEqual(h.emailed(), []);
});

test("an undo tombstone removes the row from Interview requested", () => {
  const h = harness({
    rows: [row("a")],
    decisions: { a: { action: "interview" } },
    local: { a: { action: "undo" } },
  });
  assert.deepEqual(h.requested(), []);
});

test("Already emailed also catches a send Core made without ever writing a decision", () => {
  // 528 live queue rows on 2026-09-05 carry an `invited` ack and no decision
  // in apphub:decisions at all. They are the rows a reviewer most needs
  // warning about, so the send pill is not gated on the decision hash.
  const h = harness({ rows: [row("a")], acks: { a: { status: "invited" } } });
  assert.deepEqual(h.emailed(), ["a"]);
  assert.deepEqual(h.requested(), []);
});

test("a stream-shaped row status and an external prior send both count as sent", () => {
  const h = harness({
    rows: [row("a", { status: "emailed" }), row("b", { externalPriorSendAt: "2026-08-26T23:36:18.612Z" }),
      row("c", { status: "pending" })],
  });
  assert.deepEqual(h.emailed(), ["a", "b"]);
});

test("a legacy send Core does not publish is NOT counted, and the source says so", () => {
  // The ~904 armed rows as they exist today: undecided (so no ack is ever
  // minted for them), no stream status (Review rows carry none), and no
  // published externalPriorSendAt (Core's queue row map omitted it until
  // be4ec712). They are invisible to this tab, and the comment must keep
  // saying that rather than describing the clause as a hole already closed.
  const h = harness({ rows: [row("a")] });
  assert.deepEqual(h.emailed(), []);
  assert.deepEqual(h.requested(), []);
  assert.match(applicants, /`externalPriorSendAt` IS DORMANT TODAY/);
  assert.doesNotMatch(applicants, /when Core starts publishing it, a legacy send/);
});

test("a pass decision never appears on either interview pill", () => {
  const h = harness({ rows: [row("a")], decisions: { a: { action: "pass" } } });
  assert.deepEqual(h.requested(), []);
  assert.deepEqual(h.emailed(), []);
});

/* ---- wiring ---- */

test("Already emailed is its own view pill, between Interview requested and Delivery review", () => {
  assert.match(
    applicants,
    /id="pillRequested"[\s\S]*?id="pillEmailed"[\s\S]*?id="pillDelivery"/,
  );
  assert.match(applicants, /<button class="view-pill" id="pillEmailed" onclick="setView\('emailed'\)">Already emailed <span class="n" id="emailedCount"><\/span><\/button>/);
});

test("both counts are live, from the same render pass as the others", () => {
  assert.match(applicants, /\$\("requestedCount"\)\.textContent = STATE\.snapshot \? String\(requestedRows\(\)\.length\) : "";/);
  assert.match(applicants, /\$\("emailedCount"\)\.textContent = STATE\.snapshot \? String\(emailedRows\(\)\.length\) : "";/);
});

test("the new view is reachable, deep-linkable and rendered by the review list", () => {
  assert.match(applicants, /\$\("pillEmailed"\)\.classList\.toggle\("active", view === "emailed"\);/);
  assert.match(applicants, /\['review','requested','emailed','delivery'\]\.includes\(view\)/);
  assert.match(applicants, /\} else if \(STATE\.view === "emailed"\) \{\s*rows = emailedRows\(\);/);
  assert.match(applicants, /const DEEP_LINK_VIEWS = \["review", "requested", "emailed", "delivery", "stream", "rules"\];/);
  assert.match(applicants, /No queue row carries published send evidence\./);
});

test("'emailed' has ONE definition, shared by the pill and the Decided outcome filter", () => {
  // decisionStatus() had its own inline list of sent ack statuses. Two copies
  // of the same fact is how the Decided > Emailed filter and the pill would
  // drift apart.
  assert.match(applicants, /const SENT_ACK_STATUSES = new Set\(\["invited", "sendgrid_delivered"\]\);/);
  assert.match(applicants, /if \(decision\?\.action === "interview" && SENT_ACK_STATUSES\.has\(String\(ack\?\.status \|\| ""\)\)\) return "emailed";/);
  assert.doesNotMatch(applicants, /\["invited", "sendgrid_delivered"\]\.includes/);
});

/* ---- the Delivery review pill's predicate is untouched; only its words are new ---- */

test("Delivery review still uses exactly the predicate it had", () => {
  assert.match(
    applicants,
    /function deliveryRows\(\) \{\s*return queueRows\(\)\.filter\(\(row\) => \{\s*const decision = effectiveDecision\(row\.key\);\s*const ack = ackFor\(row\.key\);\s*return Boolean\(interviewHold\(row\)\)\s*\|\| \(decision\?\.action === "interview" && \["identity_review", "recipient_review", "delivery_review", "cannot_contact"\]\.includes\(String\(ack\?\.status \|\| decision\.deliveryState \|\| ""\)\)\);/,
  );
});

test("Delivery review names the hold codes it aggregates, on hover and to a screen reader", () => {
  assert.match(applicants, /Hard holds aggregated here right now: /);
  assert.match(applicants, /"\. Hold codes watched: " \+ \[\.\.\.HARD_HOLD_CODES\]\.join\(", "\)/);
  assert.match(applicants, /"\. Hold states watched: " \+ \[\.\.\.HARD_HOLD_STATES\]\.join\(", "\)/);
  assert.match(applicants, /pill\.setAttribute\("aria-label", label \+ "\. " \+ text\);/);
});

test("Interview requested says how many rows it stopped counting, and why", () => {
  assert.match(applicants, /Interview decisions with NO published send yet/);
  assert.match(applicants, /an ack says the invitation already went out; they are under Already emailed/);
  // Honesty about the limit: an ack-less legacy send cannot be seen from here.
  assert.match(applicants, /A pre-cutover send by a retired lane that never wrote an ack cannot be seen from this tab\./);
});

test("the descriptions are refreshed on every render, not written once at load", () => {
  const body = applicants.slice(applicants.indexOf("function renderPills()"));
  const call = body.indexOf("describeInterviewPills();");
  assert.ok(call > 0 && call < body.indexOf("function describeInterviewPills"), "renderPills calls it");
});
