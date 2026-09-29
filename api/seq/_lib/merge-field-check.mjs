// SEQUENCE MERGE-FIELD CHECK: finds sequence steps whose copy still holds a
// typed placeholder, such as `{Candidate First Name}`, that Paraform will send
// to candidates word for word.
//
// WHY (2026-09-29): 27 sequences made by the LinkedIn Job Poster run on
// 2026-09-22/23 held the TYPED text `{Candidate First Name}` instead of
// Paraform's merge field. One of them, "N - Henry Labs - Founding Engineer
// v1", was switched on and sent it literally about 458 times before a
// Paraform employee noticed. Rendered text reads the same for a real merge
// field and a typed one, so only the stored HTML tells them apart: a real
// field is `<span data-value="Candidate First Name" data-type="token" ...>`.
// Main-repo records: task sequence-first-name-variable-fix, and the
// campaigns.updateSequenceSteps row of the Paraform API reference.
//
// This file is pure (no network, no KV) so it can be tested offline. The
// cron in api/seq/merge-field-check.mjs does the Paraform reads, keeps the
// state and posts the alert. Nothing here ever edits a sequence: fixing
// candidate-facing copy stays a human decision.

import { createHash } from "node:crypto";

// Every variable Paraform's sequence editor can insert, read from its public
// JS bundle (the TOKEN map) on 2026-09-29. A token span whose data-value is
// not one of these is flagged, because Paraform has nothing to fill it with.
// If Paraform adds a variable, add it here.
export const PARAFORM_MERGE_VARIABLES = Object.freeze([
  "Candidate First Name",
  "Candidate Full Name",
  "Candidate Linkedin",
  "Role Title",
  "Company Name",
  "Most Recent Company Name",
  "Linkedin One Liner",
  "Hiring Manager First Name",
  "Hiring Manager Full Name",
  "Hiring Manager Title",
  "Schedule Link",
  "Recruiter First Name",
  "Recruiter Full Name",
  "Paraform Owner First Name",
  "Curated List Link",
  "Referral Link",
  "AI Role Match Two Liner",
  "AI Role Match Responsibilities",
  "AI Role Match Company Name",
  "AI Role Match Role Name",
  "Market Feedback Form",
]);
const KNOWN_VARIABLES = new Set(PARAFORM_MERGE_VARIABLES);

// What a leftover placeholder looks like once real merge fields and markup
// are gone. Each was checked against all 352 sequences on 2026-09-29: before
// the fix they flagged exactly the 27 broken sequences, after it only the
// launcher template's `*INSERT ROLE*` (exempted by the caller).
const PATTERNS = [
  // `{Candidate First Name}` and `{{first_name}}`.
  ["typed_braces", /\{\{[^{}]{0,80}\}\}|\{[^{}]{0,80}\}/g],
  // `[First Name]`, `[Company]`, `[XX]`. Only brackets naming a fill-in
  // word, so ordinary copy such as `[Hybrid]` is left alone.
  ["typed_brackets", /\[[^[\]]{0,40}\b(?:names?|first|last|company|role|title|position|job|link|candidate|recruiter|manager|insert|x+|tbd|todo)\b[^[\]]{0,40}\]/gi],
  // `<<First Name>>` (stored as &lt;&lt;...&gt;&gt;).
  ["typed_angles", /<<[^<>]{1,60}>>/g],
  // `*INSERT ROLE*`: the launcher template's fill-in marker, left unfilled.
  ["insert_marker", /\*\s*INSERT\b[^*\n]{0,60}\*?/gi],
];

const MAX_HIT_CHARS = 80;
const MAX_FINDINGS_PER_SEQUENCE = 40;

// Tag attributes are read with quoted values whole, so a ">" inside a style
// value cannot end the tag early.
const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;
const ANY_TAG = new RegExp(`<${ATTRS}>`, "g");
// A token span, allowing one level of spans inside it (the editor can leave
// an empty <span></span> before the name).
const TOKEN_SPAN = new RegExp(
  `<span\\b(?=${ATTRS}\\bdata-type\\s*=\\s*["']token["'])${ATTRS}>(?:<span\\b${ATTRS}>[\\s\\S]*?<\\/span>|[\\s\\S])*?<\\/span>`,
  "gi",
);
const OPEN_TAG = new RegExp(`^<span\\b${ATTRS}>`, "i");
const DATA_VALUE = /\bdata-value\s*=\s*(["'])([\s\S]*?)\1/i;

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X"
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const value = NAMED_ENTITIES[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

/** Stored step HTML -> the text a candidate reads, with real merge fields removed. */
export function visibleTextWithoutMergeFields(html) {
  const withoutFields = String(html ?? "")
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(TOKEN_SPAN, " ")
    .replace(ANY_TAG, " ");
  return decodeEntities(withoutFields).replace(/\s+/g, " ").trim();
}

function unknownVariables(html) {
  const found = [];
  for (const span of String(html ?? "").match(TOKEN_SPAN) || []) {
    const openTag = span.match(OPEN_TAG)?.[0] ?? "";
    const value = decodeEntities(openTag.match(DATA_VALUE)?.[2] ?? "").trim();
    if (!KNOWN_VARIABLES.has(value)) found.push(value || "(empty)");
  }
  return found;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Names that read as ordinary words in copy ("our Referral Link") are left
// out; the rest never belong in an email as plain text. Longest first, so
// "Most Recent Company Name" is one finding.
const PLAIN_WORD_VARIABLES = new Set(["Company Name", "Role Title", "Schedule Link", "Referral Link"]);
const BARE_VARIABLE = new RegExp(
  `\\b(?:${PARAFORM_MERGE_VARIABLES.filter((name) => !PLAIN_WORD_VARIABLES.has(name))
    .sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})\\b`,
  "g",
);

/** -> [{ kind, text }] for one subject or body. */
export function lintStepField(html) {
  const findings = [];
  let text = visibleTextWithoutMergeFields(html);
  for (const [kind, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ kind, text: match[0].trim().slice(0, MAX_HIT_CHARS) });
    }
    text = text.replace(pattern, " ");
  }
  // A variable's name as plain text: a merge field that lost its span, which
  // Paraform also sends as written. None appeared in any sequence on
  // 2026-09-29, so a hit here is worth a look.
  for (const match of text.matchAll(BARE_VARIABLE)) {
    findings.push({ kind: "bare_variable", text: match[0] });
  }
  for (const value of unknownVariables(html)) {
    findings.push({ kind: "unknown_variable", text: value.slice(0, MAX_HIT_CHARS) });
  }
  return findings;
}

/**
 * One campaign (campaigns.getCampaign) -> its problems, in step order.
 * `exemptInsertIds`: sequences whose `*INSERT ...*` marker is intended (the
 * disabled launcher template ensureRoleSequence copies from). Any other
 * problem in them still counts.
 */
export function lintCampaign(campaign, { exemptInsertIds = [] } = {}) {
  const exemptInsert = new Set(exemptInsertIds).has(campaign?.id);
  const problems = [];
  const steps = Array.isArray(campaign?.steps) ? campaign.steps : [];
  for (const step of steps) {
    // A TASK step is a to-do for the recruiter; nothing in it is sent.
    if (!step || step.step_kind === "TASK") continue;
    for (const field of ["subject", "body"]) {
      for (const finding of lintStepField(step[field])) {
        if (exemptInsert && finding.kind === "insert_marker") continue;
        problems.push({
          step: Number.isInteger(step.step_number) ? step.step_number : null,
          stepId: typeof step.id === "string" ? step.id : null,
          field,
          ...finding,
        });
      }
    }
  }
  problems.sort((a, b) => (a.step ?? 0) - (b.step ?? 0)
    || (a.field === b.field ? 0 : a.field === "subject" ? -1 : 1));
  return problems.slice(0, MAX_FINDINGS_PER_SEQUENCE);
}

/** Stable id for one set of problems, so the same breakage alerts once. */
export function problemDigest(problems) {
  if (!problems?.length) return null;
  const canonical = problems
    .map((p) => [p.stepId ?? p.step, p.field, p.kind, p.text].join("\u0001"))
    .sort()
    .join("\u0002");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ---------- which sequences to read this pass ----------
//
// The catalog read (campaigns.getListOfCampaignsOptimized) carries id, name,
// enabled and is_archived but NO updated_at, so a step edit cannot be seen
// from it. The plan therefore reads, in this order:
//   1. enabled sequences never checked (new, or the first baseline)
//   2. sequences switched on since their last check (the moment they start
//      sending)
//   3. switched-off sequences never checked (e.g. a Job Poster run's new
//      sequences, caught before anyone switches them on)
//   4. renamed sequences
//   5. flagged sequences, so a fix clears the alert state
//   6. enabled sequences whose last check is older than the recheck window,
//      because a step edit on a live sequence is invisible in the catalog
// A switched-off, clean sequence is not re-read until it changes or is
// switched on: it cannot send while it is off. Inside a bucket, a sequence
// whose last read failed goes to the back, so one bad read cannot hold up
// every pass.

const DEFAULT_PLAN = Object.freeze({
  maxReads: 30,
  recheckEnabledMs: 6 * 3600 * 1000,
  recheckFlaggedMs: 2 * 3600 * 1000,
});

const isLive = (sequence) => sequence?.enabled === true;
const nameOf = (value) => String(value ?? "");

export function planReads(catalog, records = {}, {
  now = Date.now(),
  maxReads = DEFAULT_PLAN.maxReads,
  recheckEnabledMs = DEFAULT_PLAN.recheckEnabledMs,
  recheckFlaggedMs = DEFAULT_PLAN.recheckFlaggedMs,
  failures = {},
} = {}) {
  const buckets = [[], [], [], [], [], []];
  for (const sequence of catalog) {
    const record = records[sequence.id];
    const checkedAt = Date.parse(record?.checkedAt ?? "");
    const age = Number.isFinite(checkedAt) ? now - checkedAt : Infinity;
    const failedAt = Date.parse(failures[sequence.id] ?? "");
    const live = isLive(sequence);
    let bucket = null;
    let reason = null;
    if (!record && live) { bucket = 0; reason = "new_live"; }
    else if (record && live && record.enabled !== true) { bucket = 1; reason = "switched_on"; }
    else if (!record) { bucket = 2; reason = "new"; }
    else if (nameOf(record.name) !== nameOf(sequence.name)) { bucket = 3; reason = "renamed"; }
    else if (record.problems?.length && age >= recheckFlaggedMs) { bucket = 4; reason = "flagged_recheck"; }
    else if (live && age >= recheckEnabledMs) { bucket = 5; reason = "live_recheck"; }
    if (bucket !== null) {
      buckets[bucket].push({ id: sequence.id, reason, age, failedAt: Number.isFinite(failedAt) ? failedAt : -Infinity });
    }
  }
  // Never-failed first, then oldest check first; ties keep catalog order.
  for (const bucket of buckets) {
    bucket.sort((a, b) => (a.failedAt === b.failedAt ? 0 : a.failedAt - b.failedAt)
      || (b.age === a.age ? 0 : b.age - a.age));
  }
  const all = buckets.flat();
  const cap = Math.max(0, Math.floor(Number(maxReads) || 0));
  return {
    reads: all.slice(0, cap).map(({ id, reason }) => ({ id, reason })),
    deferred: Math.max(0, all.length - cap),
  };
}

// ---------- alerting ----------

/**
 * One alert per incident. An incident is one set of problems in one
 * sequence; it posts once while the sequence is off, and once more if it is
 * then switched on (the moment it starts reaching candidates). A sequence
 * that reads clean again closes its incident (no recovery post).
 */
export function needsAlert(record, live) {
  if (!record?.problems?.length || !record.digest) return false;
  const alerted = record.alerted;
  if (!alerted || alerted.digest !== record.digest) return true;
  return live && alerted.live !== true;
}

const PARAFORM_SEQUENCE_URL = "https://www.paraform.com/sequences?detail=";
export const MAX_ALERT_SEQUENCES = 30;
const MAX_HITS_PER_LINE = 3;

// Slack mrkdwn treats &, < and > as control characters, even inside code.
const slackEscape = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function describeProblem(problem) {
  const where = problem.step == null ? "a step" : `Step ${problem.step}`;
  const text = slackEscape(problem.text).replace(/`/g, "'");
  const what = problem.kind === "unknown_variable"
    ? `unknown merge field \`${text}\``
    : problem.kind === "bare_variable"
      ? `variable name typed as text \`${text}\``
      : `\`${text}\``;
  return `${where} ${problem.field} ${what}`;
}

/** Live ones first, then by name: the order the alert names them in. */
export function orderAlertItems(items) {
  return [...items].sort((a, b) => Number(b.live) - Number(a.live)
    || String(a.name).localeCompare(String(b.name)));
}

/**
 * Slack text naming each sequence and step. Carries no candidate data (the
 * hits are template text). `remaining`: due sequences left for the next
 * post, because one post names at most MAX_ALERT_SEQUENCES.
 */
export function alertText(items, { remaining = 0 } = {}) {
  const ordered = orderAlertItems(items);
  const liveCount = ordered.filter((item) => item.live).length;
  const head = liveCount
    ? `:rotating_light: ${liveCount} LIVE sequence${liveCount === 1 ? "" : "s"} will email candidates a typed placeholder word for word.`
    : ":warning: Switched-off sequences hold a typed placeholder that Paraform would send word for word if switched on.";
  const lines = ordered.map((item) => {
    const hits = item.problems.slice(0, MAX_HITS_PER_LINE).map(describeProblem);
    const more = item.problems.length > MAX_HITS_PER_LINE
      ? ` (+${item.problems.length - MAX_HITS_PER_LINE} more)`
      : "";
    const name = slackEscape(item.name || item.id).replace(/\|/g, "/");
    return `• ${item.live ? "*LIVE*" : "off"}: <${PARAFORM_SEQUENCE_URL}${encodeURIComponent(item.id)}|${name}>: ${hits.join("; ")}${more}`;
  });
  if (remaining > 0) {
    lines.push(`• +${remaining} more, named in the next post (all of them: signed-in https://monitor.raydar.xyz/api/seq/merge-field-check?detail=1)`);
  }
  return [
    head,
    ...lines,
    "Fix: in Paraform's sequence editor, replace each one with the variable from the editor's variable menu. Nothing was changed automatically.",
  ].join("\n");
}

// ---------- one pass ----------

export const STATE_SCHEMA = "raydar-seq-merge-field-check-v1";

function freshState() {
  return { schema: STATE_SCHEMA, records: {}, readFailures: {}, lastPass: null, lastOkAt: null };
}

function usableState(state) {
  if (!state
    || typeof state !== "object"
    || state.schema !== STATE_SCHEMA
    || !state.records
    || typeof state.records !== "object"
    || Array.isArray(state.records)) return freshState();
  if (!state.readFailures || typeof state.readFailures !== "object") state.readFailures = {};
  return state;
}

// Read failures that end the pass at once; the rest wait for the next one.
const STOP_CODES = {
  AUTH_EXPIRED: "paraform_expired",
  PARAFORM_THROTTLED: "paraform_throttled",
  PARAFORM_HTTP_429: "paraform_throttled",
};
const MAX_CONSECUTIVE_READ_ERRORS = 3;

function stopCode(error) {
  if (STOP_CODES[error?.code]) return STOP_CODES[error.code];
  // A 403 arrives as a tRPC error body, not a status code.
  if (/\b(?:FORBIDDEN|UNAUTHORIZED)\b/.test(String(error?.message ?? ""))) return "paraform_forbidden";
  return null;
}

function flaggedCounts(catalog, records) {
  let flaggedLive = 0;
  let flaggedOff = 0;
  let neverChecked = 0;
  for (const sequence of catalog) {
    const record = records[sequence.id];
    if (!record) { neverChecked++; continue; }
    if (!record.problems?.length) continue;
    if (isLive(sequence)) flaggedLive++;
    else flaggedOff++;
  }
  return { flaggedLive, flaggedOff, neverChecked };
}

/** Flagged sequences with names, for the signed-in detail view. */
export function flaggedDetail(state) {
  return Object.entries(usableState(state).records)
    .filter(([, record]) => record?.problems?.length)
    .map(([id, record]) => ({
      id,
      name: record.name,
      enabled: record.enabled === true,
      checkedAt: record.checkedAt,
      alertedAt: record.alerted?.at ?? null,
      problems: record.problems,
    }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled)
      || String(a.name).localeCompare(String(b.name)));
}

/**
 * One pass. Every dependency is injected; api/seq/merge-field-check.mjs
 * supplies the real ones. Reads are serial and spaced, and stop at the
 * soft deadline, at maxReads, at the first throttle, 403 or dead session,
 * or after 3 failed reads in a row (the rest wait for the next pass). Only
 * the state and the Slack post are written; Paraform is only read.
 *
 * The state is saved before the post, and nothing is posted if that save
 * fails, so a broken store cannot re-post the same alert every pass.
 * `alert: false` (a manual dry run) posts nothing and records no alert, so
 * the next real pass still posts.
 */
export async function runMergeFieldCheck({
  loadState,
  saveState,
  pauseState = async () => ({ paused: false }),
  sessionReady = async () => true,
  listCatalog,
  readCampaign,
  send,
  exemptInsertIds = [],
  plan = {},
  alert = true,
  spacingMs = 2000,
  deadlineMs = 75_000,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const startedAt = clock();
  const at = new Date(startedAt).toISOString();
  let state;
  try {
    state = usableState(await loadState());
  } catch {
    // Without the state every pass would re-read and re-alert everything,
    // so no state means no Paraform traffic at all.
    return { ok: false, status: "error", error: "state_unavailable", at };
  }

  const finish = async (pass) => {
    // A pass that read nothing (paused, no session, bad catalog) keeps the
    // last known counts, so a live problem stays visible on the tile.
    const known = state.lastPass || {};
    const carried = {
      flaggedLive: known.flaggedLive ?? null,
      flaggedOff: known.flaggedOff ?? null,
      neverChecked: known.neverChecked ?? null,
    };
    const lastPass = { ...carried, ...pass, at, durationMs: clock() - startedAt };
    state.lastPass = lastPass;
    if (pass.status === "complete" || pass.status === "partial") state.lastOkAt = at;
    let saved = true;
    try { await saveState(state); } catch { saved = false; }
    return { ok: pass.status !== "error" && saved, ...lastPass, lastOkAt: state.lastOkAt, saved };
  };

  const pause = await pauseState().catch(() => ({ paused: true, state: "unreadable" }));
  if (pause?.paused) {
    return finish({ status: "paused", error: null, pauseControlState: pause.state || "configured" });
  }
  if (!(await sessionReady().catch(() => false))) {
    return finish({ status: "error", error: "no_session" });
  }

  let raw;
  try {
    raw = await listCatalog();
  } catch (error) {
    return finish({ status: "error", error: stopCode(error) || "catalog_error" });
  }
  if (!Array.isArray(raw)
    || raw.some((row) => !row || typeof row !== "object" || typeof row.id !== "string" || !row.id)) {
    return finish({ status: "error", error: "catalog_invalid" });
  }
  const seen = new Set();
  const catalog = raw.filter((row) => !seen.has(row.id) && seen.add(row.id));
  // A catalog half the size we track is more likely a bad read than a mass
  // delete: keep the state. The same size twice in a row is believed; an
  // empty one never is.
  const tracked = Object.keys(state.records).length;
  if (tracked > 0 && catalog.length < tracked / 2
    && (catalog.length === 0
      || !(state.lastPass?.error === "catalog_shrank" && state.lastPass.catalogSequences === catalog.length))) {
    return finish({ status: "error", error: "catalog_shrank", catalogSequences: catalog.length, trackedSequences: tracked });
  }

  const byId = new Map(catalog.map((row) => [row.id, row]));
  for (const [id, record] of Object.entries(state.records)) {
    const row = byId.get(id);
    if (!row) { delete state.records[id]; continue; }
    // Switching off needs no read, but must be remembered: switching the
    // sequence back on is then a "switched_on" read.
    if (!isLive(row) && record.enabled === true) record.enabled = false;
  }
  for (const id of Object.keys(state.readFailures)) {
    if (!byId.has(id)) delete state.readFailures[id];
  }

  const { reads, deferred } = planReads(catalog, state.records, {
    now: startedAt,
    failures: state.readFailures,
    ...plan,
  });
  const readReasons = {};
  let done = 0;
  let readErrors = 0;
  let consecutiveErrors = 0;
  let stopped = null;
  const failed = (id) => {
    readErrors++;
    consecutiveErrors++;
    state.readFailures[id] = new Date(clock()).toISOString();
  };
  for (const { id, reason } of reads) {
    if (clock() - startedAt >= deadlineMs) { stopped = "deadline"; break; }
    if (consecutiveErrors >= MAX_CONSECUTIVE_READ_ERRORS) { stopped = "read_errors"; break; }
    await sleep(spacingMs);
    let campaign;
    try {
      campaign = await readCampaign(id);
    } catch (error) {
      failed(id);
      const code = stopCode(error);
      if (code) { stopped = code; break; }
      continue;
    }
    if (!campaign || typeof campaign !== "object" || !Array.isArray(campaign.steps)
      || (campaign.id !== undefined && campaign.id !== id)) {
      failed(id);
      continue;
    }
    done++;
    consecutiveErrors = 0;
    delete state.readFailures[id];
    readReasons[reason] = (readReasons[reason] || 0) + 1;
    const row = byId.get(id);
    // The template's marker is only intended while the template is off.
    const problems = lintCampaign({ ...campaign, id }, { exemptInsertIds: isLive(row) ? [] : exemptInsertIds });
    const previous = state.records[id];
    state.records[id] = {
      // The catalog's name, exactly: the plan compares against it.
      name: nameOf(row.name),
      enabled: isLive(row),
      checkedAt: new Date(clock()).toISOString(),
      problems,
      digest: problemDigest(problems),
      // A clean read closes the incident; a changed problem set opens a new one.
      alerted: problems.length ? previous?.alerted ?? null : null,
    };
  }

  const leftover = deferred + (reads.length - done - readErrors);
  const fatal = Boolean(stopped && stopped !== "deadline") || (done === 0 && readErrors > 0);
  const pass = {
    status: fatal ? "error" : leftover > 0 || readErrors > 0 ? "partial" : "complete",
    error: fatal ? (stopped && stopped !== "deadline" ? stopped : "read_errors") : null,
    stoppedAt: stopped,
    catalogSequences: catalog.length,
    liveSequences: catalog.filter(isLive).length,
    trackedSequences: Object.keys(state.records).length,
    reads: done,
    readReasons,
    readErrors,
    deferred: leftover,
    ...flaggedCounts(catalog, state.records),
    dryRun: !alert,
  };

  const due = orderAlertItems(catalog
    .filter((row) => needsAlert(state.records[row.id], isLive(row)))
    .map((row) => ({ id: row.id, name: state.records[row.id].name, live: isLive(row), problems: state.records[row.id].problems })));
  const named = due.slice(0, MAX_ALERT_SEQUENCES);
  let posted = 0;
  let alertFailed = false;
  if (alert && named.length) {
    try {
      await saveState(state);
    } catch {
      return finish({ ...pass, status: "error", error: "state_save_failed", alertsDue: due.length, alertsPosted: 0, alertFailed: true });
    }
    const delivered = await Promise.resolve()
      .then(() => send(alertText(named, { remaining: due.length - named.length })))
      .then((value) => value === true)
      .catch(() => false);
    if (delivered) {
      const alertedAt = new Date(clock()).toISOString();
      // Only the sequences the post named; the rest post next pass.
      for (const item of named) {
        const record = state.records[item.id];
        record.alerted = { digest: record.digest, live: item.live, at: alertedAt };
      }
      posted = named.length;
    } else {
      alertFailed = true; // not marked, so the next pass tries again
    }
  }
  return finish({ ...pass, alertsDue: due.length, alertsPosted: posted, alertFailed });
}
