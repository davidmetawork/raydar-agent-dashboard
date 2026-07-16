import { randomUUID } from "node:crypto";
import { stripHtml } from "./model.mjs";

const text = (value) => String(value ?? "").trim();
const norm = (value) => text(value).toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
const plain = (value) => norm(value).replace(/[^a-z0-9]+/g, " ").trim();
const escapeHtml = (value) => text(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

export const FIRST_NAME_TOKEN = '<span data-value="Candidate First Name" data-type="token" contenteditable="false" style="background-color: rgb(219, 217, 241); padding: 2px 4px; border-radius: 4px;">Candidate First Name</span>';
export const FOLLOWUP_ONE_HTML = `<p>Hey ${FIRST_NAME_TOKEN},</p><p></p><p>Any interest in this role?</p><p></p><p>Hope to hear from you.</p><p></p><p>Best,</p>`;
export const FOLLOWUP_TWO_HTML = `<p>Hi ${FIRST_NAME_TOKEN},</p><p></p><p>Following up one last time.</p><p></p><p>We have a ton of roles I think you'd be a strong fit for.</p><p></p><p>If you are ever on the market or want some company intel, I'd love to chat.</p><p></p><p>Best,</p><p>David</p>`;

const OUTREACH_DOMAINS = new Set([
  "heyraydar.com",
  "raydarmesh.com",
  "raydarcareers.com",
  "raydarwork.com",
  "runraydar.com",
  "raydarflow.com",
  "raydarmatch.com",
  "matchraydar.com",
]);
const OUTREACH_LOCALS = new Set(["david", "davidp", "david.phillips"]);

export function canonicalRoleName(role = {}) {
  const company = text(role.company);
  const title = text(role.title);
  if (!company || !title) throw new Error("Paraform role requires company and title before assets can be prepared");
  return `${company} - ${title}`;
}

function abbreviation(value) {
  return text(value).split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0]).join("").toLowerCase();
}

export function rankedCatalogMatches(items = [], role = {}) {
  const target = canonicalRoleName(role);
  const company = text(role.company);
  const title = text(role.title);
  const targetPlain = plain(target);
  const titleAbbreviation = abbreviation(title);
  return items.map((item) => {
    const name = text(item?.name);
    let score = 0;
    let kind = null;
    if (norm(name) === norm(target)) { score = 100; kind = "exact"; }
    else if (plain(name) === targetPlain) { score = 90; kind = "normalized-exact"; }
    else if (norm(name) === norm(`${company} - ${titleAbbreviation}`) || norm(name) === norm(`${company} ${titleAbbreviation}`)) { score = 80; kind = "company-title-abbreviation"; }
    else if (norm(name) === norm(`Outreach for ${title}`)) { score = 60; kind = "outreach-title"; }
    else if (norm(name) === norm(title)) { score = 50; kind = "title-only"; }
    else if (norm(name) === norm(company)) { score = 40; kind = "company-only"; }
    return { item, score, kind };
  }).filter((match) => match.score).sort((a, b) => b.score - a.score || text(a.item.name).localeCompare(text(b.item.name)));
}

export function chooseCatalogMatch(items = [], role = {}) {
  const matches = rankedCatalogMatches(items, role);
  if (!matches.length) return null;
  const top = matches.filter((match) => match.score === matches[0].score);
  if (top.length > 1) throw new Error(`multiple Paraform assets match ${canonicalRoleName(role)} at the same confidence`);
  return top[0];
}

export function selectOutreachAccounts(accounts = []) {
  const selected = [];
  for (const account of accounts) {
    const email = text(account?.email).toLowerCase();
    const id = text(account?.id || account?.account_id);
    const [local, domain] = email.split("@");
    if (!id || !local || !domain || email === "david@raydar.xyz") continue;
    if (!OUTREACH_LOCALS.has(local) || !OUTREACH_DOMAINS.has(domain)) continue;
    selected.push({ id, email });
  }
  selected.sort((a, b) => a.email.localeCompare(b.email));
  if (!selected.length) throw new Error("no approved Raydar outreach inboxes are active");
  if (selected.some((account) => account.email === "david@raydar.xyz")) throw new Error("primary Raydar inbox must never be used for sourcing");
  return selected;
}

function titleCase(value) {
  return text(value).split(/\s+/).filter(Boolean).slice(0, 3)
    .map((part) => /^(AI|ML|B2B|B2C|SaaS)$/i.test(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function buildSequenceSubject(context = {}) {
  const funding = text(context.fundingAmount);
  const stage = text(context.stage);
  const title = text(context.title).replaceAll(" - ", ", ");
  const industry = titleCase(context.industry);
  if (!/^\$[\d.]+[KMB]$/i.test(funding)) throw new Error("structured Paraform funding amount is required for the sequence subject");
  if (!stage) throw new Error("structured Paraform funding stage is required for the sequence subject");
  if (!title || !industry) throw new Error("role title and a 1-3 word industry are required for the sequence subject");
  const remote = /\bremote\b/i.test(text(context.workplace)) && !/hybrid|on-site|onsite|in-office/i.test(text(context.workplace));
  const subject = `${remote ? "REMOTE: " : ""}${funding} ${stage} - ${title} - ${industry}`;
  if (subject.includes("—") || norm(subject).includes(norm(context.company))) throw new Error("sequence subject violates the locked format");
  return `<p>${escapeHtml(subject)}</p>`;
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  if (amount >= 1_000_000) return `$${Number((amount / 1_000_000).toFixed(1))}M`;
  if (amount >= 1_000) return `$${Number((amount / 1_000).toFixed(1))}K`;
  return `$${amount}`;
}

function inlineHtml(value) {
  let raw = text(value);
  if (raw.includes("—")) throw new Error("sequence copy may not contain em dashes");
  raw = raw.replace(/<strong>/gi, "___STRONG_OPEN___").replace(/<\/strong>/gi, "___STRONG_CLOSE___");
  raw = raw.replace(/<[^>]+>/g, " ");
  raw = escapeHtml(raw).replaceAll("___STRONG_OPEN___", "<strong>").replaceAll("___STRONG_CLOSE___", "</strong>");
  return raw.replace(/\s+/g, " ").trim();
}

function ensureSentence(value) {
  const normalized = text(value).replace(/^,+\s*/, "");
  return /[.!?]$/.test(stripHtml(normalized)) ? normalized : `${normalized}.`;
}

function wordCountFromHtml(value) {
  const normalized = stripHtml(value).replace(/https?:\/\/\S+/g, "link").trim();
  return normalized ? normalized.split(/\s+/).length : 0;
}

function replaceFirstNameWithToken(body) {
  if (body.includes('data-value="Candidate First Name"')) return body;
  const patterns = [
    /\{\{\s*(?:candidate\s+)?first[ _-]?name\s*\}\}/i,
    /\{\s*(?:candidate\s+)?first[ _-]?name\s*\}/i,
    /\[\s*(?:candidate\s+)?first[ _-]?name\s*\]/i,
  ];
  for (const pattern of patterns) if (pattern.test(body)) return body.replace(pattern, FIRST_NAME_TOKEN);
  return body;
}

export function buildIntroEmail(context = {}, sections = {}) {
  if (context.inmail?.subject && context.inmail?.bodyHtml) {
    const body = replaceFirstNameWithToken(text(context.inmail.bodyHtml));
    if (!body.includes('data-value="Candidate First Name"')) throw new Error("existing LinkedIn InMail needs a recognized first-name token before it can be copied verbatim");
    return {
      subject: /^<p[ >]/i.test(context.inmail.subject) ? context.inmail.subject : `<p>${escapeHtml(context.inmail.subject)}</p>`,
      body,
      source: "linkedin-inmail",
    };
  }
  const company = text(context.company);
  const companyUrl = text(context.companyUrl);
  const shareUrl = text(context.shareUrl);
  const lower = money(context.salaryLowerBound);
  const upper = money(context.salaryUpperBound);
  if (!company || !companyUrl || !shareUrl) throw new Error("company website and candidate-facing Paraform share link are required");
  if (!lower || !upper) throw new Error("structured compensation range is required for the sequence intro");
  const opening = inlineHtml(sections.openingHtml);
  const traction = inlineHtml(sections.tractionHtml);
  const rolePitch = inlineHtml(sections.rolePitchHtml);
  if (!opening || !rolePitch) throw new Error("sequence intro requires company and role copy");
  if (plain(opening).includes(plain(company))) throw new Error("AI opening must not repeat the company name inserted by the template");
  const companyLink = `<a target="_blank" rel="noopener noreferrer" class="text-blue-500 underline" href="${escapeHtml(companyUrl)}"><strong>${escapeHtml(company)}</strong></a>`;
  const rows = [
    `<p>Hi ${FIRST_NAME_TOKEN},</p>`,
    "<p></p>",
    `<p>I'm working with ${companyLink}, ${ensureSentence(opening)}</p>`,
  ];
  if (traction) rows.push("<p></p>", `<p>${ensureSentence(traction)}</p>`);
  rows.push("<p></p>", `<p>${ensureSentence(rolePitch)}</p>`);
  if (context.engineering) {
    const stack = inlineHtml(sections.stack || (context.techStack || []).join(", "));
    if (!stack) throw new Error("engineering outreach requires a verified Stack line");
    rows.push("<p></p>", `<p>Stack: ${stack.replace(/^Stack:\s*/i, "")}</p>`);
  }
  rows.push(
    "<p></p>",
    `<p><strong>Comp: ${lower}-${upper} Base + Competitive Equity &amp; Benefits</strong></p>`,
    "<p></p>",
    `<p><strong>See JD here</strong>: <a target="_blank" rel="noopener noreferrer" class="text-blue-500 underline" href="${escapeHtml(shareUrl)}">${escapeHtml(shareUrl)}</a></p>`,
    "<p></p>",
    "<p>Interested? Grab time here: calendly.com/raydar-xyz</p>",
    "<p></p>",
    "<p>Best,</p>",
  );
  const body = rows.join("");
  const words = wordCountFromHtml(body);
  if (words < 100 || words > 180) throw new Error(`sequence intro must be 100-180 words; received ${words}`);
  if (body.includes("—")) throw new Error("sequence intro may not contain em dashes");
  return { subject: buildSequenceSubject(context), body, source: "fresh-draft", words };
}

export function buildSequenceSteps(context, sections, { idFactory = randomUUID } = {}) {
  const intro = buildIntroEmail(context, sections);
  const base = { attachments: [], step_kind: "EMAIL", task_type: null, task_due_days: null, weight: 1 };
  return {
    intro,
    steps: [
      { ...base, id: idFactory(), name: "Step 1", step_number: 1, wait_time: 3, subject: intro.subject, body: intro.body },
      { ...base, id: idFactory(), name: "Step 2", step_number: 2, wait_time: 4, subject: "", body: FOLLOWUP_ONE_HTML },
      { ...base, id: idFactory(), name: "Step 3", step_number: 3, wait_time: 2, subject: "", body: FOLLOWUP_TWO_HTML },
    ],
  };
}

export function sequenceSettings({ name, accountIds, now = new Date() }) {
  const startDate = new Date(now);
  if (Number.isNaN(startDate.getTime())) throw new Error("valid sequence date required");
  return { name, accountIds: [...accountIds], startDate };
}

function campaignEmails(campaign) {
  return (campaign?.campaign_to_accounts || []).map((item) => text(item?.account?.email).toLowerCase()).filter(Boolean).sort();
}

export function auditSequence(campaign, { name, projectId, company, expectedEmails = [], expectedSteps = null, startDate = null } = {}) {
  const warnings = [];
  const dangers = [];
  const steps = [...(campaign?.steps || [])].sort((a, b) => Number(a.step_number) - Number(b.step_number));
  if (text(campaign?.name) !== name) warnings.push("sequence name is not the exact Company - Job Title label");
  if (text(campaign?.project_id) !== projectId) dangers.push("sequence is linked to a different Project");
  if (campaign?.role_id != null) warnings.push("Role field is not blank");
  if (campaign?.auto_add_project_candidates !== false) warnings.push("auto-add new Project candidates is not disabled");
  if (campaign?.enabled !== false) dangers.push("sequence is enabled or already started");
  if (campaign?.has_sent_emails) dangers.push("sequence has already sent emails");
  if (campaign?.timezone !== "America/Los_Angeles") warnings.push("timezone is not America/Los_Angeles");
  if (campaign?.time_start !== "09:00" || campaign?.time_end !== "18:00") warnings.push("send window is not 09:00-18:00");
  if (Number(campaign?.daily_limit) !== 20) warnings.push("daily inbox limit is not 20");
  if (campaign?.include_signature !== false) warnings.push("signature is not disabled");
  if (campaign?.enable_tracking !== true) warnings.push("open/click tracking is not enabled");
  if (campaign?.prioritize_existing_candidates !== false) warnings.push("prioritize existing candidates is not disabled");
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  if (JSON.stringify(campaign?.days_to_send || []) !== JSON.stringify(weekdays)) warnings.push("send days are not business days only");
  if (startDate && text(campaign?.start_date).slice(0, 10) !== new Date(startDate).toISOString().slice(0, 10)) warnings.push("first-email date is not the creation date");
  const actualEmails = campaignEmails(campaign);
  const wantedEmails = [...expectedEmails].map((email) => text(email).toLowerCase()).sort();
  if (actualEmails.includes("david@raydar.xyz")) dangers.push("primary david@raydar.xyz inbox is attached");
  if (wantedEmails.length && JSON.stringify(actualEmails) !== JSON.stringify(wantedEmails)) warnings.push(`attached inbox set differs from live approved inventory (${actualEmails.length}/${wantedEmails.length})`);
  if (steps.length !== 3) warnings.push("sequence does not contain exactly three email steps");
  if (steps[0]?.wait_time !== 3 || steps[1]?.wait_time !== 4) warnings.push("sequence waits are not 3 days then 4 days");
  if (steps[1]?.subject !== "" || steps[2]?.subject !== "") warnings.push("follow-up subjects are not blank");
  if (steps[1]?.body !== FOLLOWUP_ONE_HTML || steps[2]?.body !== FOLLOWUP_TWO_HTML) warnings.push("follow-up bodies do not match the locked playbook");
  const introBody = text(steps[0]?.body);
  const introSubject = stripHtml(steps[0]?.subject);
  if (!introBody.includes('data-value="Candidate First Name"')) warnings.push("intro does not use the Candidate First Name merge chip");
  if (introBody.includes("—") || introSubject.includes("—")) warnings.push("intro contains an em dash");
  if (company && norm(introSubject).includes(norm(company))) warnings.push("intro subject contains the company name");
  for (const required of ["<strong>Comp:", "<strong>See JD here</strong>", "calendly.com/raydar-xyz"]) if (!introBody.includes(required)) warnings.push(`intro is missing ${stripHtml(required)}`);
  if (expectedSteps) {
    for (let index = 0; index < 3; index++) {
      if (steps[index]?.subject !== expectedSteps[index]?.subject || steps[index]?.body !== expectedSteps[index]?.body || Number(steps[index]?.wait_time) !== Number(expectedSteps[index]?.wait_time)) {
        dangers.push(`sequence step ${index + 1} failed exact creation readback`);
      }
    }
  }
  return { warnings: [...new Set(warnings)], dangers: [...new Set(dangers)], accountCount: actualEmails.length, emails: actualEmails };
}

const compositionPrompt = `You write only factual cold-sourcing outreach copy from a Paraform role brief. Return three inline-HTML fragments. Allowed markup is <strong>...</strong> only. Never use an em dash. Never fabricate or resolve conflicts yourself: structured fields in the supplied context win. The final renderer inserts the company name and links, compensation, JD, Calendly, greeting, and signoff, so do not include those. openingHtml is the phrase after "I'm working with [Company]," and must not repeat the company name. tractionHtml is one short traction, funding, customer, growth, or investor paragraph and may be empty only if no verified traction exists. rolePitchHtml is two or three concise sentences about the role, team, location/work model, and distinctive ownership. Bold only key numbers and high-signal phrases. Target 65-115 total words across the three fragments. For engineering roles, stack is a verified comma-separated stack; otherwise it must be empty.`;

const compositionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["openingHtml", "tractionHtml", "rolePitchHtml", "stack"],
  properties: {
    openingHtml: { type: "string" },
    tractionHtml: { type: "string" },
    rolePitchHtml: { type: "string" },
    stack: { type: "string" },
  },
};

function firstSentence(value) {
  return text(value).split(/(?<=[.!?])\s+/)[0] || "";
}

function actionPhrase(value) {
  let phrase = text(value).replace(/[.!?]+$/, "").replaceAll("—", ",");
  const replacements = [
    [/^Owning\b/i, "own"], [/^Conducting\b/i, "conduct"], [/^Leading\b/i, "lead"],
    [/^Working\b/i, "work"], [/^Handling\b/i, "handle"], [/^Building\b/i, "build"],
    [/^Managing\b/i, "manage"], [/^Driving\b/i, "drive"], [/^Developing\b/i, "develop"],
    [/^Creating\b/i, "create"], [/^Supporting\b/i, "support"], [/^Designing\b/i, "design"],
  ];
  for (const [pattern, replacement] of replacements) if (pattern.test(phrase)) return phrase.replace(pattern, replacement);
  return phrase ? phrase[0].toLowerCase() + phrase.slice(1) : "";
}

function trimWords(value, max) {
  const words = text(value).split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ").replace(/[,;:]$/, "")}`;
}

export function deterministicSequenceSections(context = {}) {
  let mission = firstSentence(context.companySummary);
  mission = mission
    .replace(/^we(?:'|’)?re\s+/i, "an ")
    .replace(/^we\s+/i, "a team that ")
    .replaceAll("—", ",");
  if (!mission || mission.toLowerCase().includes(text(context.company).toLowerCase())) {
    mission = `a ${text(context.industry) || "growing"} company building its next stage of growth`;
  }
  mission = trimWords(mission.replace(/[.!?]+$/, ""), 28);
  const traction = context.fundingAmount && context.stage
    ? `The company has raised <strong>${text(context.fundingAmount)}</strong> and is at the <strong>${text(context.stage)}</strong> stage`
    : "";
  const actions = (context.responsibilities || []).map(actionPhrase).filter(Boolean).slice(0, 3);
  const roleRows = [`As the <strong>${text(context.title)}</strong>, you'll ${actions[0] || "own the priorities and outcomes described in the role brief"}`];
  if (actions[1]) roleRows.push(`You'll also ${actions[1]}`);
  if (actions[2]) roleRows.push(`You will ${actions[2]}`);
  if (context.workplace) roleRows.push(`This is <strong>${text(context.workplace)}</strong>`);
  roleRows.push("You will work closely with the team and have clear ownership across the role's core priorities");
  const sections = {
    openingHtml: mission,
    tractionHtml: traction,
    rolePitchHtml: roleRows.map(ensureSentence).join(" "),
    stack: context.engineering ? (context.techStack || []).join(", ") : "",
    model: "deterministic-role-facts",
  };
  // The same renderer is the validator: deterministic fallback is permitted
  // only when it satisfies every locked formatting/content rule.
  buildIntroEmail(context, sections);
  return sections;
}

export async function draftSequenceSections(context, { fetchImpl = fetch } = {}) {
  if (context?.inmail) return {};
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API || "";
  const fallback = (reason) => ({ ...deterministicSequenceSections(context), fallbackReason: text(reason).slice(0, 120) || null });
  if (!apiKey) return fallback("anthropic-not-configured");
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.SOURCING_SEQUENCE_MODEL || process.env.PARAAI_MODEL || "claude-fable-5",
        max_tokens: 1800,
        temperature: 0,
        system: compositionPrompt,
        messages: [{ role: "user", content: JSON.stringify({ context, priorValidationError: lastError }) }],
        tools: [{ name: "compose_sourcing_intro", description: "Compose factual inline fragments for the locked Raydar sourcing sequence.", input_schema: compositionSchema }],
        tool_choice: { type: "tool", name: "compose_sourcing_intro" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return fallback(`anthropic-http-${response.status}`);
    const tool = (body?.content || []).find((item) => item?.type === "tool_use" && item?.name === "compose_sourcing_intro");
    if (!tool?.input) return fallback("anthropic-no-structured-copy");
    try {
      buildIntroEmail(context, tool.input);
      return { ...tool.input, model: body?.model || null, usage: body?.usage || null };
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 300);
    }
  }
  return fallback(lastError || "anthropic-copy-failed-validation");
}
