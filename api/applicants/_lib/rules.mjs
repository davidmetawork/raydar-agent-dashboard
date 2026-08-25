// The rule model: what a rule is, what it may say, and whether it matches.
//
// Pure and dependency-free on purpose — no KV, no fetch, no clock except one
// injected `now`. The tick, the match preview, and the tests all evaluate
// through this one function, so what the editor previews is exactly what the
// tick will do.
//
// ── THE ONE SEMANTIC THAT MATTERS MOST ─────────────────────────────────────
// Education conditions are scoped to a SINGLE school row, and experience
// conditions to a SINGLE job row.
//
// "School is Harvard" AND "degree level is bachelors" must mean *one* Harvard
// bachelor's degree. Evaluated independently they would also match somebody
// with a Harvard MBA and an unrelated bachelor's from elsewhere — the exact
// person David's flagship rule is meant to exclude. Row scoping is what makes
// "Harvard undergraduate" mean Harvard undergraduate.
//
// The UI states this in words next to the education and experience groups.
//
// ── FAIL CLOSED, ALWAYS ────────────────────────────────────────────────────
// A missing fact never satisfies a condition, and never satisfies a negated
// one either. 44% of the queue has no history at all; if absence could match,
// one careless rule would action half the queue on the strength of knowing
// nothing about them. `evaluateRule` reports `skipped` for those, and the tick
// counts them separately so the page can show honest coverage.

import { DEGREE_LEVELS, levelMatches } from "./degree.mjs";
import { FACTS_VERSION } from "./facts.mjs";

export const RULE_ACTIONS = ["interview", "pass"];
export const RULE_STATES = ["off", "watching", "live"];

export const NAME_MAX = 80;
export const NOTE_MAX = 400;
export const MAX_CONDITIONS = 12;
export const MAX_VALUES = 60;      // ids in one any_of list
export const MAX_RULES = 200;
/** Ids a rule may carry a display label for (see `labels` on the rule). */
export const MAX_LABELS = 120;

const lower = (value) => String(value ?? "").trim().toLowerCase();
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * THE FIELD CATALOG — the single source of truth for what a rule may say.
 * The editor renders its pickers from this, the validator accepts nothing
 * outside it, and the evaluator switches on `read`. Adding a criterion is one
 * entry here plus one line of facts.
 *
 *   group   which row-scope it belongs to (see the header note)
 *   ops     the comparisons the editor may offer
 *   kind    what `value` must look like
 *   read    (subject, row) => the value to compare
 *   label   plain English for the rule card
 */
export const FIELDS = {
  // ── education, scoped to one school row ─────────────────────────────────
  "school.id": {
    group: "school", ops: ["any_of"], kind: "ids", label: "Attended",
    picker: "schools", read: (_s, row) => row?.id,
    display: (_s, row) => row?.name ?? row?.id,
  },
  "school.level": {
    group: "school", ops: ["any_of"], kind: "levels", label: "Degree level is",
    read: (_s, row) => row?.level, display: (_s, row) => row?.degree ?? row?.level,
  },
  "school.degreeText": {
    group: "school", ops: ["contains"], kind: "text", label: "Degree text",
    approximate: true, read: (_s, row) => row?.degree,
  },
  "school.endYear": {
    group: "school", ops: ["after", "before", "between"], kind: "year",
    label: "Graduated", read: (_s, row) => row?.endYear,
  },
  "school.inUS": {
    group: "school", ops: ["is"], kind: "bool", label: "School is in the US",
    read: (_s, row) => row?.inUS,
    display: (_s, row) => row?.location ?? row?.name ?? null,
  },
  "school.location": {
    group: "school", ops: ["contains"], kind: "text", label: "School location",
    approximate: true, read: (_s, row) => row?.location,
  },
  "school.rank": {
    group: "school", ops: ["any_of"], kind: "ranks", label: "School talent rank is",
    read: (_s, row) => row?.rank,
  },

  // ── experience, scoped to one job row ───────────────────────────────────
  "job.companyId": {
    group: "job", ops: ["any_of"], kind: "ids", label: "Worked at",
    picker: "companies", read: (_s, row) => row?.id,
    display: (_s, row) => row?.name ?? row?.id,
  },
  "job.title": {
    group: "job", ops: ["contains"], kind: "text", label: "Job title",
    read: (_s, row) => row?.title,
  },
  "job.industry": {
    group: "job", ops: ["contains"], kind: "text", label: "Company industry",
    read: (_s, row) => row?.industry,
  },
  "job.rank": {
    group: "job", ops: ["any_of"], kind: "ranks", label: "Company talent rank is",
    read: (_s, row) => row?.rank,
  },
  "job.current": {
    group: "job", ops: ["is"], kind: "bool", label: "Their current role",
    read: (_s, row) => row?.current,
  },

  // ── whole-applicant facts, no row scope ─────────────────────────────────
  "applicant.currentCompanyId": {
    group: "applicant", ops: ["any_of"], kind: "ids", label: "Currently works at",
    picker: "companies", read: (s) => s.facts?.currentCompanyId,
    display: (s) => s.facts?.currentCompanyName,
  },
  "applicant.currentTitle": {
    group: "applicant", ops: ["contains"], kind: "text", label: "Current title",
    read: (s) => s.facts?.currentTitle,
  },
  "applicant.years": {
    group: "applicant", ops: ["at_least", "at_most"], kind: "number",
    label: "Years of experience is", approximate: true,
    read: (s) => (s.facts?.months == null ? null : Math.round((s.facts.months / 12) * 10) / 10),
  },
  "applicant.jobCount": {
    group: "applicant", ops: ["at_least", "at_most"], kind: "number",
    label: "Number of roles is", read: (s) => s.facts?.jobCount,
  },
  "applicant.schoolCount": {
    group: "applicant", ops: ["at_least", "at_most"], kind: "number",
    label: "Number of schools is", read: (s) => s.facts?.schoolCount,
  },
  "applicant.location": {
    group: "applicant", ops: ["contains"], kind: "text", label: "Location",
    read: (s) => s.facts?.location,
  },
  "applicant.headline": {
    group: "applicant", ops: ["contains"], kind: "text", label: "Headline",
    read: (s) => s.facts?.title,
  },
  "applicant.hasResume": {
    group: "applicant", ops: ["is"], kind: "bool", label: "Has a resume",
    read: (s) => s.facts?.hasResume,
  },
  "applicant.hasLinkedin": {
    group: "applicant", ops: ["is"], kind: "bool", label: "Has a LinkedIn profile",
    read: (s) => s.facts?.hasLinkedin,
  },
  "applicant.densityScore": {
    group: "applicant", ops: ["at_least", "at_most"], kind: "number",
    label: "Talent density score is", read: (s) => s.facts?.densityScore,
  },

  // ── the application itself; these read the QUEUE ROW, not the facts, so
  //    they work even for the 44% with no profile history ─────────────────
  "application.tier": {
    group: "application", ops: ["any_of"], kind: "tiers", label: "Tier is",
    // The publisher writes tier "C" or "unrated" on every queue row. An absent
    // tier is unknown, not unrated — inventing one would let a tier rule fire
    // on a row we never actually graded.
    read: (s) => {
      const tier = s.row?.tier;
      if (tier === "C") return "C";
      return tier ? "unrated" : null;
    },
  },
  "application.roleId": {
    group: "application", ops: ["any_of"], kind: "ids", label: "Applied to role",
    picker: "roles", read: (s) => s.row?.roleId,
    display: (s) => s.row?.roleTitle,
  },
  "application.roleTitle": {
    group: "application", ops: ["contains"], kind: "text",
    label: "Role applied to", read: (s) => s.row?.roleTitle,
  },
  "application.client": {
    group: "application", ops: ["contains"], kind: "text",
    label: "Client company", read: (s) => s.row?.company,
  },
  "application.ageDays": {
    group: "application", ops: ["at_least", "at_most"], kind: "number",
    label: "Days since applied is",
    read: (s, _row, now) => {
      const applied = Date.parse(s.row?.appliedAt ?? "");
      if (!Number.isFinite(applied)) return null;
      return Math.floor((now - applied) / 86_400_000);
    },
  },
};

/**
 * The catalog as the browser needs it: no functions, just what the editor
 * renders from. Served by GET /api/applicants/rules so the pickers can never
 * drift from what the validator accepts — a hand-mirrored copy in the page
 * would be wrong the first time anyone adds a field.
 */
export function fieldCatalog() {
  return Object.entries(FIELDS).map(([name, field]) => ({
    name,
    group: field.group,
    ops: field.ops,
    kind: field.kind,
    label: field.label,
    picker: field.picker ?? null,
    approximate: Boolean(field.approximate),
  }));
}

/** Group headings, in the order the editor shows them. */
export const FIELD_GROUPS = [
  { id: "school", label: "Education", note: "All education conditions must be true of the SAME school." },
  { id: "job", label: "Experience", note: "All experience conditions must be true of the SAME role." },
  { id: "applicant", label: "The person", note: "" },
  { id: "application", label: "The application", note: "Works even for applicants with no profile history." },
];

export const RANKS = ["S", "A", "B", "C"];
export const TIERS = ["C", "unrated"];

/** Fields whose group needs a matching row to exist at all. */
const ROW_GROUPS = { school: "schools", job: "jobs" };

// ── comparison ─────────────────────────────────────────────────────────────

function compare(op, actual, expected, kind) {
  // The fail-closed gate. Nothing absent satisfies anything.
  if (actual == null || actual === "") return false;
  switch (op) {
    case "any_of": {
      const wanted = Array.isArray(expected) ? expected : [expected];
      // Degree levels route through levelMatches so `unknown` can never
      // satisfy a condition, not even one that explicitly asks for unknown.
      // Keyed on the FIELD's kind rather than on the value's shape: sniffing
      // the value would silently change behaviour the day a rank, tier or
      // school name happened to collide with a level word.
      if (kind === "levels") return levelMatches(actual, wanted);
      return wanted.some((value) => String(value) === String(actual));
    }
    case "contains": {
      const needle = lower(expected);
      return needle ? lower(actual).includes(needle) : false;
    }
    case "is":
      return Boolean(actual) === Boolean(expected);
    case "at_least":
      return num(actual) != null && num(expected) != null && num(actual) >= num(expected);
    case "at_most":
      return num(actual) != null && num(expected) != null && num(actual) <= num(expected);
    case "after":
      return num(actual) != null && num(expected) != null && num(actual) > num(expected);
    case "before":
      return num(actual) != null && num(expected) != null && num(actual) < num(expected);
    case "between": {
      const [lo, hi] = Array.isArray(expected) ? expected : [];
      return num(actual) != null && num(lo) != null && num(hi) != null
        && num(actual) >= num(lo) && num(actual) <= num(hi);
    }
    default:
      return false;
  }
}

/**
 * Does one row (or the applicant as a whole) satisfy every condition in a
 * group? Returns the audit evidence when it does, null when it does not.
 */
function groupMatches(conditions, subject, row, now) {
  const evidence = [];
  for (const condition of conditions) {
    const field = FIELDS[condition.field];
    if (!field) return null;
    const actual = field.read(subject, row, now);
    if (!compare(condition.op, actual, condition.value, field.kind)) return null;
    evidence.push({
      field: condition.field,
      op: condition.op,
      // The literal value the decision rested on, in human terms — this is
      // what "why did this fire" renders from.
      matched: String(field.display ? (field.display(subject, row) ?? actual) : actual).slice(0, 160),
    });
  }
  return evidence;
}

/**
 * Evaluate one rule against one applicant.
 *
 * Returns `{ matched, skipped, reason, evidence }`:
 *   matched  the rule's conditions are all satisfied
 *   skipped  we could not tell, because the facts needed are absent or stale
 *   reason   why it was skipped, for the coverage counters
 *
 * `skipped` is never `matched`. A rule acts only on a positive answer.
 */
export function evaluateRule(rule, subject, { now = Date.now() } = {}) {
  const conditions = rule?.conditions ?? [];
  if (!conditions.length) {
    return { matched: false, skipped: true, reason: "rule_has_no_conditions", evidence: [] };
  }

  const byGroup = new Map();
  for (const condition of conditions) {
    const field = FIELDS[condition.field];
    if (!field) return { matched: false, skipped: true, reason: "unknown_field", evidence: [] };
    if (!byGroup.has(field.group)) byGroup.set(field.group, []);
    byGroup.get(field.group).push(condition);
  }

  // Any condition that reads the profile needs facts of a shape we understand.
  const needsFacts = [...byGroup.keys()].some((group) => group !== "application");
  if (needsFacts) {
    const facts = subject.facts;
    if (!facts) return { matched: false, skipped: true, reason: "no_facts_yet", evidence: [] };
    if (facts.v !== FACTS_VERSION) {
      return { matched: false, skipped: true, reason: "facts_version_stale", evidence: [] };
    }
    const needsHistory = byGroup.has("school") || byGroup.has("job");
    if (needsHistory && !facts.hasHistory) {
      // The 44%. Not a failure — there is genuinely nothing to judge.
      return { matched: false, skipped: true, reason: "no_profile_history", evidence: [] };
    }
  }

  const evidence = [];
  for (const [group, groupConditions] of byGroup) {
    const rowsKey = ROW_GROUPS[group];
    if (!rowsKey) {
      // Whole-applicant group: one evaluation, no row scoping.
      const found = groupMatches(groupConditions, subject, null, now);
      if (!found) return { matched: false, skipped: false, reason: null, evidence: [] };
      evidence.push(...found);
      continue;
    }
    // Row-scoped group: ALL of its conditions must hold on the SAME row.
    const rows = subject.facts?.[rowsKey] ?? [];
    let found = null;
    for (const row of rows) {
      found = groupMatches(groupConditions, subject, row, now);
      if (found) break;
    }
    if (!found) return { matched: false, skipped: false, reason: null, evidence: [] };
    evidence.push(...found);
  }

  return { matched: true, skipped: false, reason: null, evidence };
}

// ── validation ─────────────────────────────────────────────────────────────

const VALUE_CHECK = {
  ids: (value) => Array.isArray(value) && value.length > 0 && value.length <= MAX_VALUES
    && value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 80),
  levels: (value) => Array.isArray(value) && value.length > 0
    && value.every((level) => DEGREE_LEVELS.includes(level)),
  ranks: (value) => Array.isArray(value) && value.length > 0
    && value.every((rank) => RANKS.includes(rank)),
  tiers: (value) => Array.isArray(value) && value.length > 0
    && value.every((tier) => TIERS.includes(tier)),
  text: (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 120,
  bool: (value) => typeof value === "boolean",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  year: (value, op) => (op === "between"
    ? Array.isArray(value) && value.length === 2 && value.every((y) => Number.isInteger(y))
      && value[0] <= value[1]
    : Number.isInteger(value)),
};

export function validateCondition(condition) {
  const field = FIELDS[condition?.field];
  if (!field) return `unknown field: ${String(condition?.field).slice(0, 40)}`;
  if (!field.ops.includes(condition?.op)) {
    return `${condition.field} does not support ${String(condition?.op).slice(0, 20)}`;
  }
  const check = VALUE_CHECK[field.kind];
  if (!check(condition.value, condition.op)) return `${condition.field} has an invalid value`;
  return null;
}

/**
 * Validate and normalise a rule submitted by the browser. Returns
 * `{ ok, rule, error }`. Rejects rather than repairs anything that would
 * change what the rule means.
 */
export function normalizeRule(input, { now = () => new Date().toISOString(), by = "unknown" } = {}) {
  const name = String(input?.name ?? "").trim();
  if (!name) return { ok: false, error: "a rule needs a name" };
  if (name.length > NAME_MAX) return { ok: false, error: `name is longer than ${NAME_MAX} characters` };

  const action = String(input?.action ?? "");
  if (!RULE_ACTIONS.includes(action)) return { ok: false, error: "action must be interview or pass" };

  const state = String(input?.state ?? "off");
  if (!RULE_STATES.includes(state)) return { ok: false, error: "state must be off, watching or live" };

  const conditions = Array.isArray(input?.conditions) ? input.conditions : [];
  if (!conditions.length) return { ok: false, error: "a rule needs at least one condition" };
  if (conditions.length > MAX_CONDITIONS) {
    return { ok: false, error: `a rule may hold at most ${MAX_CONDITIONS} conditions` };
  }
  for (const condition of conditions) {
    const problem = validateCondition(condition);
    if (problem) return { ok: false, error: problem };
  }

  // LABELS. A rule stores ids, but a person has to be able to read it. The
  // picker directory is built from prewarmed profiles and lags behind — a
  // school nobody has been warmed for yet is simply not in it — so a rule that
  // relied on the directory alone would render "Attended clfq6t2ju000tl60g..."
  // to the whole team. The rule therefore carries the names it was written
  // with. The directory still wins when it has the id, so a school Paraform
  // later renames reads correctly rather than freezing at its old name.
  const labels = {};
  if (input?.labels && typeof input.labels === "object" && !Array.isArray(input.labels)) {
    for (const [id, label] of Object.entries(input.labels).slice(0, MAX_LABELS)) {
      if (typeof id === "string" && typeof label === "string" && id && label) {
        labels[id.slice(0, 80)] = label.slice(0, 120);
      }
    }
  }

  const roleIds = Array.isArray(input?.scope?.roleIds)
    ? input.scope.roleIds.filter((id) => typeof id === "string" && id).slice(0, MAX_VALUES)
    : [];

  const at = now();
  return {
    ok: true,
    rule: {
      id: String(input?.id ?? "").trim() || null,
      name,
      note: String(input?.note ?? "").trim().slice(0, NOTE_MAX),
      action,
      state,
      scope: { roleIds },
      labels,
      conditions: conditions.map((condition) => ({
        field: condition.field,
        op: condition.op,
        value: condition.value,
      })),
      updatedAt: at,
      updatedBy: by,
    },
  };
}

/** Is this rule scoped to the role this applicant applied to? */
export function inScope(rule, row) {
  const roleIds = rule?.scope?.roleIds ?? [];
  if (!roleIds.length) return true;           // no scope = every role
  return roleIds.includes(row?.roleId);
}

// ── plain English, for the rule card ───────────────────────────────────────

const OP_WORDS = {
  any_of: "is one of", contains: "contains", is: "is",
  at_least: "at least", at_most: "at most",
  after: "after", before: "before", between: "between",
};

/**
 * One readable line per condition. `names` maps ids to names so a card reads
 * "Attended Harvard University" rather than an opaque cuid.
 */
export function describeCondition(condition, names = {}) {
  const field = FIELDS[condition?.field];
  if (!field) return "(unknown condition)";
  const { op, value } = condition;
  if (op === "is") return `${field.label}: ${value ? "yes" : "no"}`;
  if (op === "between") return `${field.label} between ${value?.[0]} and ${value?.[1]}`;
  if (op === "any_of") {
    const shown = (Array.isArray(value) ? value : [value]).map((v) => names[v] ?? v);
    const head = shown.slice(0, 3).join(", ");
    const rest = shown.length > 3 ? ` and ${shown.length - 3} more` : "";
    return `${field.label} ${head}${rest}`;
  }
  return `${field.label} ${OP_WORDS[op] ?? op} ${value}`;
}

export function describeRule(rule, names = {}) {
  // The rule's own labels fill the gaps the caller's directory has; the
  // caller's names still win, because a directory tracks renames.
  const merged = { ...(rule?.labels ?? {}), ...names };
  return (rule?.conditions ?? []).map((condition) => describeCondition(condition, merged));
}
