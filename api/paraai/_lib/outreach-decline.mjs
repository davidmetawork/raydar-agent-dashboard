// Per-role decline memory.
//
// HISTORY. The intent gate (outreach-intent.mjs) answers one question: is this
// candidate still on the market. Its rubric deliberately treats "not interested
// in this particular role" as OPEN, because a no to one role is not a no to the
// market — that is correct, and it is also why a candidate who names a role they
// do not want kept receiving email about that exact role. On 2026-07-31 a
// candidate wrote "I'm not interested in Kapwing or Toku" while a Toku request
// sat pending; nothing in the lane could hear it. Only an unrelated bug (a
// transient Gmail error that had parked the request) stopped the send.
//
// This module is the missing half: availability is candidate-level, this is
// role-level, and the two are recorded and enforced separately.
//
// THE CLOSED SET IS THE WHOLE SAFETY ARGUMENT. The model never names a role
// freely; it chooses from roles we can prove the candidate knows about, keyed by
// a small integer that is mapped back to a roleId here. Anything outside the set
// is dropped. That set must include PENDING requests and not just roles we have
// emailed, because Paraform's digest page lists a candidate's pending interview
// requests — which is exactly how the 07-31 candidate came to decline a role we
// had never written to him about.
//
// FAIL CLOSED ON RECORDING, NOT ON SENDING. The asymmetry runs the opposite way
// to the intent gate. A missed decline sends one unwanted email: visible,
// survivable, and no worse than today. A WRONGLY recorded decline silently drops
// a candidate from a role they wanted, and nothing downstream would ever reveal
// it. So when the model is unavailable or unparseable this records NOTHING and
// says so, rather than guessing from phrases. There is no deterministic fallback
// on purpose: "not interested" sits one clause away from "not interested in
// relocating", and a regex cannot tell those apart.

const clean = (value) => String(value || "").trim();

// One-flip kill switch, mirroring PARAAI_OUTREACH_INTENT_DISABLED. Set it and
// the next tick stops extracting declines; already-latched declines still block,
// because forgetting a decline a candidate actually made is not a safe default.
export function roleDeclineGateDisabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(
    String(env.PARAAI_OUTREACH_ROLE_DECLINE_DISABLED || "").toLowerCase(),
  );
}

const RUBRIC = `You decide which specific job openings a candidate has explicitly turned down.

You are given the candidate's own replies to a recruiter, and a numbered list of
openings the candidate has been told about. Return the numbers of the openings
the candidate has EXPLICITLY declined.

The bar is high and the default is to return nothing.

Return an opening when the candidate names it, or names its company, and says
they do not want it: "I'm not interested in Kapwing or Toku", "Toku isn't for
me", "pass on the Acme role", "no to the second one" when the list makes that
unambiguous.

Do NOT return an opening when:
- the candidate is silent about it. Declining one opening says nothing about the
  others; return only the ones actually named.
- the candidate declines something that is not in the list.
- the candidate raises a question, a concern, or a condition rather than a
  refusal: "is this remote?", "the comp seems low", "I'd need 2 days a week",
  "not sure this is for me" are all still live.
- the candidate says they are off the market generally, or asks to stop being
  contacted, without naming an opening. That is availability, judged elsewhere.
- the candidate declines a company that merely resembles one in the list. Match
  the company, not a similar-sounding word.
- you are unsure which opening they meant. Ambiguity is not a decline.

A decline silently removes that opening from everything the candidate will ever
be told about, so a wrong answer costs them a job they wanted. When in doubt,
return nothing.`;

const SCHEMA = {
  type: "object",
  properties: {
    declined: {
      type: "array",
      items: { type: "integer" },
      description: "Numbers from the provided list that the candidate explicitly declined. Empty if none.",
    },
    reason: {
      type: "string",
      description: "One short sentence on why, naming the openings. Empty if none were declined.",
    },
  },
  required: ["declined"],
};

/**
 * The closed set: every opening we can show the candidate knows about.
 *
 * Two sources, unioned by roleId. `state.matches` is what we emailed them.
 * `history` rows are their Paraform submission requests, which the digest page
 * lists whether or not we ever wrote about them — without those, a decline of a
 * role we have not yet emailed is unmatchable, which is the exact 07-31 case.
 */
export function declinableRoles(state, history = []) {
  const byRoleId = new Map();
  const add = (roleId, roleName, companyName) => {
    const id = clean(roleId);
    if (!id || byRoleId.has(id)) return;
    byRoleId.set(id, { roleId: id, roleName: clean(roleName), companyName: clean(companyName) });
  };
  for (const match of Object.values(state?.matches || {})) {
    add(match?.roleId, match?.roleName, match?.companyName);
  }
  const candidateUserId = clean(state?.candidateUserId);
  for (const request of history || []) {
    if (clean(request?.candidateUserId) !== candidateUserId) continue;
    add(request?.roleId, request?.roleName, request?.companyName);
  }
  return [...byRoleId.values()];
}

export async function extractDeclinedRolesWithModel(messages, roles, {
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const apiKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_API || "";
  if (!apiKey) {
    const error = new Error("Anthropic API key not configured");
    error.code = "OUTREACH_DECLINE_NOT_CONFIGURED";
    throw error;
  }
  const model = env.PARAAI_OUTREACH_DECLINE_MODEL || env.PARAAI_MODEL || "claude-fable-5";
  // Integer keys, not role ids: the model cannot invent a number that maps to a
  // real opening, whereas it could plausibly emit a well-formed cuid.
  const numbered = roles.map((role, index) => ({
    number: index + 1,
    company: role.companyName,
    role: role.roleName,
  }));
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: RUBRIC,
      messages: [{
        role: "user",
        content: `Openings the candidate has been told about:\n${JSON.stringify(numbered)}\n\nCandidate replies, oldest first:\n\n${JSON.stringify(messages)}`,
      }],
      tools: [{
        name: "record_declined_roles",
        description: "Record which listed openings the candidate explicitly declined.",
        input_schema: SCHEMA,
      }],
      tool_choice: { type: "tool", name: "record_declined_roles" },
    }),
    // Same 10s ceiling as intent classification, for the same reason: this runs
    // per candidate inside a 120s function that still has Gmail and Paraform
    // work to do afterwards.
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `decline extraction failed: ${response.status}`);
    error.code = "OUTREACH_DECLINE_HTTP_ERROR";
    throw error;
  }
  const tool = (body?.content || []).find(
    (item) => item?.type === "tool_use" && item?.name === "record_declined_roles",
  );
  if (!tool?.input || !Array.isArray(tool.input.declined)) {
    const error = new Error("decline extraction returned no usable answer");
    error.code = "OUTREACH_DECLINE_UNPARSED";
    throw error;
  }
  // The closed-set filter. Out-of-range, duplicate, and non-integer answers are
  // dropped rather than repaired — a number we cannot map is not evidence.
  const roleIds = [...new Set(
    tool.input.declined
      .map((number) => roles[Number(number) - 1]?.roleId)
      .filter(Boolean),
  )];
  return { roleIds, reason: clean(tool.input.reason).slice(0, 300), model: body?.model || model };
}

/**
 * Returns { roleIds, source }. `source` is "model" only when a real answer came
 * back; every failure path returns an empty list with the reason, so a caller
 * can tell "nothing declined" from "we could not tell" and never confuse them.
 */
export async function classifyDeclinedRoles(messages, roles, {
  fetchImpl = fetch,
  env = process.env,
  attempts = 2,
} = {}) {
  if (roleDeclineGateDisabled(env)) return { roleIds: [], source: "disabled" };
  const rows = (Array.isArray(messages) ? messages : []).filter((row) => clean(row?.text));
  if (!rows.length || !roles?.length) return { roleIds: [], source: "empty" };
  let lastError = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      const result = await extractDeclinedRolesWithModel(rows, roles, { fetchImpl, env });
      return { ...result, source: "model" };
    } catch (error) {
      lastError = error;
      if (clean(error?.code) === "OUTREACH_DECLINE_NOT_CONFIGURED") break;
    }
  }
  return {
    roleIds: [],
    source: "unavailable",
    error: clean(lastError?.code || lastError?.message).slice(0, 120) || null,
  };
}

/**
 * Latch. Declines accumulate and are never removed here — clearing one is an
 * explicit operator action, so an automatic pass can never quietly un-decline a
 * role. The first detection wins, so a later re-read cannot move the timestamp
 * and make an old decline look fresh.
 */
export function mergeDeclinedRoles(existing, roleIds, {
  roles = [],
  detectedAt = new Date().toISOString(),
  evidenceMessageId = null,
  source = "model",
} = {}) {
  const next = { ...(existing || {}) };
  for (const roleId of roleIds || []) {
    const id = clean(roleId);
    if (!id || next[id]) continue;
    const role = roles.find((row) => row.roleId === id) || {};
    next[id] = {
      roleId: id,
      roleName: role.roleName || null,
      companyName: role.companyName || null,
      declinedAt: detectedAt,
      // The message id, not the candidate's words: a human can open the thread
      // and read it in context, and we never duplicate their text into state.
      evidenceMessageId: evidenceMessageId || null,
      source,
    };
  }
  return next;
}

export function roleDeclined(state, roleId) {
  const id = clean(roleId);
  if (!id) return null;
  return state?.declinedRoles?.[id] || null;
}

export function declinedRoleCount(state) {
  return Object.keys(state?.declinedRoles || {}).length;
}
