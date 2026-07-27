// Candidate reply classifier for Para AI interview-request outreach.
//
// Two layers, deliberately separated (the same split as extract.mjs):
//   1. EXTRACTION stays literal. The model records only what the candidate
//      actually wrote, with a verbatim quote for every signal. It never
//      decides an action.
//   2. POLICY interprets. classifyReply() below turns literal signals into an
//      intent, recording {stated, routed, rule} so every interpretation is
//      auditable on the review card.
//
// Policy, per David's locked answers (2026-07-28):
//   - Hedged or conditional interest IS a yes. Conditions ride along as
//     routed constraints; they never downgrade the intent.
//   - Only an EXPLICIT refusal is a no.
//   - Off-market requires an explicit statement that they have stopped looking
//     (accepted an offer, taken a role, not searching). "Not interested in this
//     one" is a pass, never off-market.
//   - Anything else is uncertain and goes to review.

const MACHINE_SUBJECT = /^\s*(out of office|automatic reply|auto[- ]?reply|autoreply|undeliverable|delivery status notification|mail delivery|returned mail|delivery has failed)/i;
const MACHINE_HEADERS = ["auto-submitted", "x-autoreply", "x-autorespond", "precedence"];
const MACHINE_SENDERS = /^(mailer-daemon|postmaster|no-?reply|noreply|donotreply|do-not-reply|bounces?)@/i;

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// Quoted history and signatures are not new statements by the candidate.
// Trimming them keeps the classifier from re-reading our own outbound copy
// (which contains the role pitch) as if the candidate had written it.
export function stripQuotedReply(body) {
  const raw = String(body || "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const kept = [];
  for (const line of lines) {
    if (/^\s*On .{10,90}\bwrote:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && kept.length) break;
    if (/^\s*_{10,}\s*$/.test(line) && kept.length) break;
    if (/^\s*--\s*$/.test(line) && kept.length) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Machine mail is filtered out entirely rather than routed to review: an
// auto-responder is not a human decision, and queueing it would make the review
// lane noise. It still counts as a reply for the OUTREACH ladder stop, which is
// deliberately a separate, looser test in outreach-gmail.mjs.
export function isMachineReply(message, bodyText = "") {
  const subject = text(headerOf(message, "Subject"));
  if (MACHINE_SUBJECT.test(subject)) return true;
  const headers = (message?.payload?.headers || []).map((header) => String(header?.name || "").toLowerCase());
  if (MACHINE_HEADERS.some((name) => headers.includes(name))) return true;
  const from = text(headerOf(message, "From")).toLowerCase();
  const address = (from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [""])[0];
  if (address && MACHINE_SENDERS.test(address)) return true;
  const body = text(bodyText).toLowerCase();
  if (!body) return true;
  return /\b(i am|i'm) (currently )?(out of (the )?office|on (annual |parental |maternity |paternity )?leave)\b/.test(body)
    && body.length < 700;
}

function headerOf(message, name) {
  return (message?.payload?.headers || []).find(
    (header) => String(header?.name || "").toLowerCase() === String(name || "").toLowerCase(),
  )?.value || null;
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["signals", "summary"],
  properties: {
    signals: {
      type: "object",
      additionalProperties: false,
      properties: {
        interestStated: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: { type: ["string", "null"], enum: ["positive", "negative", "none", null] },
            conditional: { type: ["boolean", "null"] },
            quote: { type: ["string", "null"] },
          },
        },
        refusalStated: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: { type: ["boolean", "null"] },
            quote: { type: ["string", "null"] },
          },
        },
        noLongerSearchingStated: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: { type: ["boolean", "null"] },
            quote: { type: ["string", "null"] },
          },
        },
        rolesReferenced: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              mention: { type: ["string", "null"] },
              sentiment: { type: ["string", "null"], enum: ["positive", "negative", "unclear", null] },
              quote: { type: ["string", "null"] },
            },
          },
        },
        conditions: { type: "array", items: { type: "string" } },
        questionAsked: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: { type: ["boolean", "null"] },
            quote: { type: ["string", "null"] },
          },
        },
        schedulingOnly: { type: ["boolean", "null"] },
      },
    },
    summary: { type: "string" },
  },
};

const prompt = `You read a single email reply from a job candidate to a recruiter who told them a hiring manager wants to interview them for a specific role.

Record ONLY what the candidate explicitly wrote. You are an extractor, not a decision maker. Never infer, never soften, never embellish.

Rules:
- Every signal you set MUST carry a short verbatim quote copied exactly from the reply. If you cannot quote it, leave the signal null.
- interestStated.value is "positive" only when the candidate expresses willingness to move forward, talk, interview, or learn more. Set conditional=true when that willingness carries a condition ("if it's remote", "as long as the salary works"). Hedged enthusiasm is still positive.
- interestStated.value is "negative" only when they decline THIS opportunity.
- refusalStated.value is true only for an explicit decline (they say no, not interested, pass, or ask not to be submitted).
- noLongerSearchingStated.value is true ONLY when they say they have stopped job searching altogether: they accepted an offer, signed, started a new role, are staying put, or are no longer looking. A decline of this one role is NOT this signal.
- rolesReferenced captures any specific role or company they name, with the sentiment attached to that mention.
- conditions lists any stated requirement in their own words.
- schedulingOnly is true when the reply is purely logistics (availability, times, rescheduling) with no interest statement either way.
- summary is one neutral sentence describing what they said. No interpretation, no recommendation.`;

export function normalizeSignals(raw) {
  const quoted = (node) => {
    const quote = text(node?.quote);
    return quote ? quote.slice(0, 400) : null;
  };
  const interest = raw?.interestStated || {};
  const refusal = raw?.refusalStated || {};
  const stopped = raw?.noLongerSearchingStated || {};
  const question = raw?.questionAsked || {};
  // A signal without a verbatim quote is discarded: the evidence requirement is
  // the whole reason the extractor is trustworthy enough to act on.
  const interestQuote = quoted(interest);
  const refusalQuote = quoted(refusal);
  const stoppedQuote = quoted(stopped);
  return {
    interestStated: {
      value: interestQuote && ["positive", "negative", "none"].includes(interest.value) ? interest.value : null,
      conditional: interestQuote ? interest.conditional === true : null,
      quote: interestQuote,
    },
    refusalStated: { value: refusalQuote ? refusal.value === true : null, quote: refusalQuote },
    noLongerSearchingStated: { value: stoppedQuote ? stopped.value === true : null, quote: stoppedQuote },
    rolesReferenced: (Array.isArray(raw?.rolesReferenced) ? raw.rolesReferenced : [])
      .map((row) => ({
        mention: text(row?.mention) || null,
        sentiment: ["positive", "negative", "unclear"].includes(row?.sentiment) ? row.sentiment : null,
        quote: text(row?.quote)?.slice(0, 400) || null,
      }))
      .filter((row) => row.mention),
    conditions: (Array.isArray(raw?.conditions) ? raw.conditions : []).map(text).filter(Boolean).slice(0, 8),
    questionAsked: { value: quoted(question) ? question.value === true : null, quote: quoted(question) },
    schedulingOnly: raw?.schedulingOnly === true,
  };
}

// Guard against a model quoting something the candidate never wrote. Any signal
// whose quote is not present in the reply body is dropped, not trusted.
export function enforceQuoteFidelity(signals, bodyText) {
  const haystack = text(bodyText).toLowerCase();
  const present = (quote) => {
    const needle = text(quote).toLowerCase();
    if (!needle) return false;
    if (haystack.includes(needle)) return true;
    // Tolerate light punctuation/whitespace drift in the quote.
    const loose = needle.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const looseHay = haystack.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ");
    return Boolean(loose) && looseHay.includes(loose);
  };
  const drop = (node) => (node?.quote && present(node.quote) ? node : { value: null, conditional: null, quote: null });
  return {
    ...signals,
    interestStated: drop(signals.interestStated),
    refusalStated: drop(signals.refusalStated),
    noLongerSearchingStated: drop(signals.noLongerSearchingStated),
    questionAsked: drop(signals.questionAsked),
    rolesReferenced: signals.rolesReferenced.filter((row) => !row.quote || present(row.quote)),
  };
}

// THE POLICY LAYER. Literal signals in, one intent out, every step recorded.
export function classifyReply(signals, { pendingRequests = [] } = {}) {
  const provenance = [];
  const record = (field, stated, routed, rule) => provenance.push({ field, stated, routed, rule });

  const stoppedSearching = signals.noLongerSearchingStated?.value === true;
  const refused = signals.refusalStated?.value === true;
  const interest = signals.interestStated?.value || null;
  const conditional = signals.interestStated?.conditional === true;

  if (stoppedSearching) {
    record("intent", "no longer searching", "off_market", "explicit_off_market");
    return {
      intent: "off_market",
      confidence: "definitive",
      evidence: signals.noLongerSearchingStated.quote,
      targetRequestIds: pendingRequests.map((request) => request.id),
      conditions: signals.conditions,
      provenance,
    };
  }

  if (interest === "positive") {
    record(
      "intent",
      conditional ? "conditional interest" : "interest",
      "yes",
      conditional ? "conditional_yes_is_yes" : "explicit_yes",
    );
    if (conditional) record("conditions", signals.conditions.join("; ") || "none", "carried to submission", "conditions_ride_along");
    const targeted = matchNamedRequests(signals, pendingRequests, "positive");
    // Multi-request ambiguity is the one place looseness would cost a third
    // party: submitting to the wrong hiring manager wastes their time. With
    // more than one request open and no role named, route to review.
    if (pendingRequests.length > 1 && !targeted.length) {
      record("target", `${pendingRequests.length} pending requests, none named`, "review", "ambiguous_target");
      return {
        intent: "uncertain",
        confidence: "ambiguous_target",
        evidence: signals.interestStated.quote,
        reviewReason: "yes_but_multiple_pending_requests",
        targetRequestIds: pendingRequests.map((request) => request.id),
        conditions: signals.conditions,
        provenance,
      };
    }
    const targets = targeted.length ? targeted : pendingRequests.map((request) => request.id);
    record("target", targeted.length ? "named role" : "single pending request", targets.join(",") || "none", targeted.length ? "named_role" : "sole_pending");
    return {
      intent: "yes",
      confidence: "definitive",
      evidence: signals.interestStated.quote,
      targetRequestIds: targets,
      conditions: signals.conditions,
      provenance,
    };
  }

  if (refused || interest === "negative") {
    record("intent", "explicit decline", "no", "explicit_refusal");
    const targeted = matchNamedRequests(signals, pendingRequests, "negative");
    if (pendingRequests.length > 1 && !targeted.length) {
      record("target", `${pendingRequests.length} pending requests, none named`, "review", "ambiguous_target");
      return {
        intent: "uncertain",
        confidence: "ambiguous_target",
        evidence: signals.refusalStated.quote || signals.interestStated.quote,
        reviewReason: "no_but_multiple_pending_requests",
        targetRequestIds: pendingRequests.map((request) => request.id),
        conditions: signals.conditions,
        provenance,
      };
    }
    const targets = targeted.length ? targeted : pendingRequests.map((request) => request.id);
    record("target", targeted.length ? "named role" : "single pending request", targets.join(",") || "none", targeted.length ? "named_role" : "sole_pending");
    return {
      intent: "no",
      confidence: "definitive",
      evidence: signals.refusalStated.quote || signals.interestStated.quote,
      targetRequestIds: targets,
      conditions: signals.conditions,
      provenance,
    };
  }

  const reason = signals.schedulingOnly
    ? "scheduling_only"
    : signals.questionAsked?.value === true
      ? "candidate_asked_a_question"
      : "no_explicit_decision";
  record("intent", signals.interestStated.quote || "no explicit decision", "review", reason);
  return {
    intent: "uncertain",
    confidence: "none",
    evidence: signals.interestStated.quote || signals.questionAsked?.quote || null,
    reviewReason: reason,
    targetRequestIds: pendingRequests.map((request) => request.id),
    conditions: signals.conditions,
    provenance,
  };
}

function matchNamedRequests(signals, pendingRequests, sentiment) {
  const mentions = signals.rolesReferenced.filter(
    (row) => row.sentiment === sentiment || row.sentiment === null,
  );
  if (!mentions.length) return [];
  const hits = new Set();
  for (const request of pendingRequests) {
    const role = text(request.roleName).toLowerCase();
    const company = text(request.companyName).toLowerCase();
    for (const mention of mentions) {
      const needle = text(mention.mention).toLowerCase();
      if (!needle || needle.length < 3) continue;
      if ((company && (needle.includes(company) || company.includes(needle)))
        || (role && (needle.includes(role) || role.includes(needle)))) {
        hits.add(request.id);
      }
    }
  }
  // Only an UNAMBIGUOUS single target counts as named. Two matches means the
  // reply spans requests and a human should split it.
  return hits.size === 1 ? [...hits] : [];
}

async function callAnthropic(body, fetchImpl) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API || "";
  if (!apiKey) throw new Error("Anthropic API key not configured");
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.PARAAI_MODEL || "claude-fable-5",
      max_tokens: 2048,
      system: prompt,
      messages: [{ role: "user", content: body }],
      tools: [{ name: "record_reply_signals", description: "Record only the signals explicitly present in the candidate's reply.", input_schema: schema }],
      tool_choice: { type: "tool", name: "record_reply_signals" },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new Error(parsed?.error?.message || `reply classification failed: ${response.status}`);
  const tool = (parsed?.content || []).find((item) => item?.type === "tool_use" && item?.name === "record_reply_signals");
  if (!tool?.input) throw new Error("reply classification returned no structured signals");
  return { raw: tool.input, model: parsed?.model || process.env.PARAAI_MODEL || "claude-fable-5", provider: "anthropic" };
}

async function callOpenAI(body, fetchImpl) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OpenAI API key not configured");
  const model = process.env.PARAAI_OPENAI_MODEL || "gpt-5.6-luna";
  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: prompt }, { role: "user", content: body }],
      tools: [{ type: "function", function: { name: "record_reply_signals", parameters: schema } }],
      tool_choice: { type: "function", function: { name: "record_reply_signals" } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new Error(parsed?.error?.message || `reply classification failed: ${response.status}`);
  const call = parsed?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.arguments) throw new Error("reply classification returned no structured signals");
  return { raw: JSON.parse(call.function.arguments), model: parsed?.model || model, provider: "openai" };
}

export async function extractReplySignals(bodyText, { fetchImpl = fetch } = {}) {
  const body = text(bodyText);
  if (!body) throw new Error("reply body is empty");
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  if (!hasAnthropic && !hasOpenAI) throw new Error("No classification model API key configured");
  let result = null;
  if (hasAnthropic) {
    try { result = await callAnthropic(body, fetchImpl); }
    catch (error) { if (!hasOpenAI) throw error; }
  }
  if (!result) result = await callOpenAI(body, fetchImpl);
  const signals = enforceQuoteFidelity(normalizeSignals(result.raw?.signals), body);
  return { signals, summary: text(result.raw?.summary) || null, model: result.model, provider: result.provider };
}
