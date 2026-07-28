// Builds the Quick Submit answers from Raydar's own screening-call evidence.
//
// Paraform ships a "Draft with AI" button (openai.mutateGenerate*). We do not
// call it. Raydar owns the screening transcript, so Raydar generates the
// answers and deterministic facts win over anything the model produces — the
// same precedence rule the prep-doc generator uses.
//
// Voice rules come from David's voice pack: spelled-out contractions, short
// paragraphs, no em dashes, plain and specific, never overselling.

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const stripHtml = (value) => text(String(value ?? "").replace(/<[^>]*>/g, " "));

// The house style bans em and en dashes in generated prose (schema-enforced for
// task titles, and applied to every candidate- or client-facing string).
export function scrubDashes(value) {
  return String(value ?? "").replace(/\s*[—–]\s*/g, ", ");
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["great_fit_reason", "question_answers"],
  properties: {
    great_fit_reason: { type: "string" },
    open_ended_submission: { type: ["string", "null"] },
    question_answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question_id", "answer"],
        properties: {
          question_id: { type: "string" },
          answer: { type: "string" },
          grounded: { type: "boolean" },
        },
      },
    },
    salary_explanation: { type: ["string", "null"] },
    additional_notes: { type: ["string", "null"] },
  },
};

const prompt = `You write candidate submission answers for a recruiter named David Phillips, who runs a technical recruiting agency. A hiring manager has asked to interview this candidate and you are filling in the submission form.

Your only source of truth is the screening call transcript and the structured facts supplied. Write in David's voice.

Voice rules:
- Spell out contractions: write "they are" and "cannot", not "they're" and "can't".
- Short paragraphs, one or two sentences each.
- Never use an em dash or en dash. Use a comma or a full stop.
- Plain, specific and warm. Describe what the candidate actually did. Never oversell, never use marketing adjectives like "rockstar" or "world class".
- Refer to the candidate by first name or as "they". Do not guess pronouns.

Grounding rules, which override everything else:
- Every claim must be supported by the transcript or the supplied facts. If the transcript does not cover a question, say so plainly in the answer rather than inventing detail. For example: "We did not cover this on our call, but based on their background at X they have done Y." Only write that when X and Y are actually in the source.
- Never state a fact about salary, visa status, location, notice period or availability that is not in the source.
- Set grounded=false on any answer where you had to write around missing information.

great_fit_reason: at least 60 characters, ideally 3 to 6 sentences. Explain concretely why this person fits this specific role.
open_ended_submission: only when asked for, at least 350 characters, covering the fit plus the substance of the role questions.
question_answers: answer every question you are given, keyed by its question_id.
salary_explanation: only when the candidate's expectations sit outside the role's posted band. State their expectation and any flexibility they mentioned.
additional_notes: optional, under 280 characters, only if there is something genuinely useful the other fields do not carry.`;

function transcriptLines(call) {
  const rows = Array.isArray(call?.transcript) ? call.transcript : [];
  return rows
    .map((row) => `${row?.role === "candidate" ? "CANDIDATE" : "RECRUITER"}: ${text(row?.text)}`)
    .filter((line) => line.length > 12)
    .join("\n")
    .slice(0, 60_000);
}

export function buildAnswerContext({ form, request, call, extracted, replySignals }) {
  const role = form?.role || {};
  const questions = (Array.isArray(role.role_question) ? role.role_question : [])
    .filter((question) => !question.recruiter_only)
    .map((question) => ({
      question_id: question.id,
      question: stripHtml(question.question),
      optional: question.optional === true,
      priority: question.role_question_focus_priority || null,
    }));
  return {
    candidateName: request?.candidateName || form?.candidate?.name || "",
    role: {
      name: role.name || request?.roleName || "",
      company: role.company?.name || request?.companyName || "",
      description: stripHtml(role.description).slice(0, 6_000),
      locations: Array.isArray(role.locations) ? role.locations : [],
      workplace: role.workplaceType || role.workplace || null,
      workplaceText: text(role.workPlaceText) || null,
      salaryBand: [role.salaryLowerBound, role.salaryUpperBound].filter(Boolean).join(" to ") || null,
      visaText: text(role.visa_text) || null,
    },
    questions,
    openEndedRequired: form?.paraAiOpenEnded === true,
    screeningTranscript: transcriptLines(call),
    extractedPreferences: extracted || null,
    candidateReplySignals: replySignals || null,
    defaults: form?.defaultValues || null,
  };
}

async function callModel(payload, fetchImpl) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API || "";
  if (apiKey) {
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.PARAAI_MODEL || "claude-fable-5",
        max_tokens: 4096,
        system: prompt,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
        tools: [{ name: "record_submission_answers", description: "Record the submission answers, grounded in the supplied transcript and facts.", input_schema: schema }],
        tool_choice: { type: "tool", name: "record_submission_answers" },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message || `answer generation failed: ${response.status}`);
    const tool = (body?.content || []).find((item) => item?.type === "tool_use" && item?.name === "record_submission_answers");
    if (!tool?.input) throw new Error("answer generation returned no structured answers");
    return tool.input;
  }
  const openAiKey = process.env.OPENAI_API_KEY || "";
  if (!openAiKey) throw new Error("No answer generation model API key configured");
  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${openAiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.PARAAI_OPENAI_MODEL || "gpt-5.6-luna",
      messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(payload) }],
      tools: [{ type: "function", function: { name: "record_submission_answers", parameters: schema } }],
      tool_choice: { type: "function", function: { name: "record_submission_answers" } },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `answer generation failed: ${response.status}`);
  const call = body?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.arguments) throw new Error("answer generation returned no structured answers");
  return JSON.parse(call.function.arguments);
}

// Assembles the exact createRecruiterQuickSubmission payload. Deterministic
// fields (resume_id, salary defaults, phone screen) are set from the form and
// the call record, never from the model.
export function assemblePayload({ form, generated, call, extracted }) {
  const defaults = form?.defaultValues || {};
  const configs = form?.fieldConfigs || {};
  const openEnded = form?.paraAiOpenEnded === true;
  const missing = form?.missingCandidateFields || {};
  const candidate = form?.candidate || {};

  const payload = {
    agreedToTerms: true,
    resume_id: text(defaults.resume_id),
    ai_draft_used: false,
    question_answers: (generated?.question_answers || [])
      .filter((row) => text(row?.question_id) && text(row?.answer))
      .map((row) => ({ question_id: text(row.question_id), answer: scrubDashes(text(row.answer)) })),
  };

  if (openEnded) payload.open_ended_submission = scrubDashes(text(generated?.open_ended_submission));
  payload.great_fit_reason = scrubDashes(text(generated?.great_fit_reason));

  // The screening call IS the phone screen. Only asserted when a real
  // successful call backs it; never asserted from an absent record.
  payload.phone_screened = Boolean(call?.botId || call?.id);

  if (configs.salary_expectation?.show && defaults.salary_expectation) {
    payload.salary_expectation = {
      lower: text(defaults.salary_expectation.lower),
      upper: text(defaults.salary_expectation.upper),
    };
  }
  const explanation = scrubDashes(text(generated?.salary_explanation));
  if (explanation) payload.salary_explanation = explanation;

  if (configs.visa_sponsorship?.show) {
    const sponsorship = extracted?.sponsorship?.status || extracted?.visa || null;
    // Paraform's submission vocabulary is exactly these two strings.
    if (sponsorship === "VISA") payload.visa_sponsorship = "Available";
    else if (sponsorship === "CITIZEN" || sponsorship === "GREEN_CARD") payload.visa_sponsorship = "Not available";
  }
  if (configs.relocation?.show && extracted?.relocation?.open === true) payload.relocation = "Yes";

  const notes = scrubDashes(text(generated?.additional_notes));
  if (configs.additional_notes?.show && notes) payload.additional_notes = notes.slice(0, 295);

  if (configs.phone_number?.show && text(defaults.phone_number)) payload.phone_number = text(defaults.phone_number);
  if (configs.personal_url?.show && text(defaults.personal_url)) payload.personal_url = text(defaults.personal_url);

  if (missing.name) payload.candidate_name = text(candidate.name);
  if (missing.email) payload.candidate_email = text(candidate.email);
  if (missing.linkedin && text(candidate.linkedin_user)) {
    payload.candidate_linkedin = `https://www.linkedin.com/in/${text(candidate.linkedin_user)}`;
  }
  return payload;
}

export async function generateSubmissionAnswers(context, { fetchImpl = fetch } = {}) {
  const generated = await callModel(context, fetchImpl);
  return {
    great_fit_reason: scrubDashes(text(generated?.great_fit_reason)),
    open_ended_submission: generated?.open_ended_submission ? scrubDashes(text(generated.open_ended_submission)) : null,
    question_answers: Array.isArray(generated?.question_answers) ? generated.question_answers : [],
    salary_explanation: generated?.salary_explanation ? scrubDashes(text(generated.salary_explanation)) : null,
    additional_notes: generated?.additional_notes ? scrubDashes(text(generated.additional_notes)) : null,
    ungrounded: (generated?.question_answers || []).filter((row) => row?.grounded === false).length,
  };
}
