import { createHash } from "node:crypto";

const clean = (value) => String(value || "").trim();

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function anchor(label, href) {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function paragraphHtml(lines) {
  return lines.map((line) => `<p>${line || "<br>"}</p>`).join("\n");
}

function variantIndex(seed, size) {
  const digest = createHash("sha256").update(clean(seed)).digest();
  return digest.readUInt32BE(0) % size;
}

export function companySlug(companyName) {
  return clean(companyName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function roleShareUrl({ companyName, roleId }) {
  const slug = companySlug(companyName);
  const id = clean(roleId);
  if (!slug || !id) throw new Error("companyName and roleId are required");
  return `https://www.paraform.com/share/${slug}/${encodeURIComponent(id)}`;
}

export function initialSubject(companyName) {
  return `1st Round - Interview Request @ ${clean(companyName)} 🎉`;
}

export function initialMatchCopy({
  firstName,
  roleName,
  companyName,
  roleUrl,
  digestUrl,
}) {
  const first = clean(firstName) || "there";
  const roleLabel = `${clean(roleName)} @ ${clean(companyName)}`;
  const text = [
    `Hey ${first},`,
    "",
    "Hope you are doing well!",
    "",
    `I wanted to check in and see if you would be interested in this ${roleLabel} (${clean(roleUrl)})`,
    "",
    "I shared a redacted version of your resume with the Founder and the team would love to chat if you are interested.",
    "",
    `I may get more interest on your profile from other clients soon and will add all interview requests you get here: ${clean(digestUrl)}`,
    "",
    "Let me know!",
    "",
    "Thanks,",
  ].join("\n");
  const html = paragraphHtml([
    `Hey ${escapeHtml(first)},`,
    "Hope you are doing well!",
    `I wanted to check in and see if you would be interested in this ${anchor(roleLabel, roleUrl)}`,
    "I shared a redacted version of your resume with the Founder and the team would love to chat if you are interested.",
    `I may get more interest on your profile from other clients soon and will add all interview requests you get here: ${anchor(digestUrl, digestUrl)}`,
    "Let me know!",
    "Thanks,",
  ]);
  return { subject: initialSubject(companyName), text, html, variant: "initial_exact" };
}

const LATER_MATCH_VARIANTS = Object.freeze([
  {
    opening: (role) => `Another interview request just came in for the ${role}`,
    fit: "The founders think your background could be a really strong fit!",
    ask: "Would you be open to connecting with the team to learn more?",
    reminder: "As a reminder, I am keeping all of your requests together here:",
  },
  {
    opening: (role) => `You just received another interview request for the ${role}`,
    fit: "The team thinks you could be a very strong match!",
    ask: "Open to having a conversation with the founders?",
    reminder: "I am continuing to add every request in one place for you to review:",
  },
  {
    opening: (role) => `A new interview request just came through for the ${role}`,
    fit: "The founders were excited about your background and think you could be a strong fit!",
    ask: "Would you be open to connecting with the team to discuss?",
    reminder: "I am keeping all of these requests together for you here:",
  },
  {
    opening: (role) => `You have another interview request for the ${role}`,
    fit: "The team reviewed your profile and thinks there could be a really strong match!",
    ask: "Open to learning more directly from the founders?",
    reminder: "You can continue reviewing all of your requests in one place here:",
  },
]);

export function additionalMatchCopy({
  firstName,
  roleName,
  companyName,
  roleUrl,
  digestUrl,
  ordinal,
  variationSeed,
}) {
  const first = clean(firstName) || "there";
  const roleLabel = `${clean(roleName)} @ ${clean(companyName)}`;
  if (Number(ordinal) === 2) {
    const text = [
      `Hey ${first},`,
      "",
      `You just got a new interview request for the ${roleLabel} (${clean(roleUrl)})`,
      "",
      "The founders think you would be a very strong match!",
      "",
      "Open to connecting with the team to discuss?",
      "",
      `Reminder that I am adding all of these requests in one place for you to review: ${clean(digestUrl)}`,
      "",
      "Let me know!",
      "",
      "Thanks,",
      "David",
    ].join("\n");
    const html = paragraphHtml([
      `Hey ${escapeHtml(first)},`,
      `You just got a new interview request for the ${anchor(roleLabel, roleUrl)}`,
      "The founders think you would be a very strong match!",
      "Open to connecting with the team to discuss?",
      `Reminder that I am adding all of these requests in one place for you to review: ${anchor(digestUrl, digestUrl)}`,
      "Let me know!",
      "Thanks,<br>David",
    ]);
    return { subject: null, text, html, variant: "second_exact" };
  }

  const index = variantIndex(variationSeed || `${ordinal}:${roleLabel}`, LATER_MATCH_VARIANTS.length);
  const variant = LATER_MATCH_VARIANTS[index];
  const text = [
    `Hey ${first},`,
    "",
    `${variant.opening(roleLabel)} (${clean(roleUrl)})`,
    "",
    variant.fit,
    "",
    variant.ask,
    "",
    `${variant.reminder} ${clean(digestUrl)}`,
    "",
    "Let me know!",
    "",
    "Thanks,",
    "David",
  ].join("\n");
  const html = paragraphHtml([
    `Hey ${escapeHtml(first)},`,
    variant.opening(anchor(roleLabel, roleUrl)),
    variant.fit,
    variant.ask,
    `${variant.reminder} ${anchor(digestUrl, digestUrl)}`,
    "Let me know!",
    "Thanks,<br>David",
  ]);
  return { subject: null, text, html, variant: `later_${index + 1}` };
}

const ADDITIONAL_FOLLOWUP_VARIANTS = Object.freeze([
  {
    opening: (role) => `Just following up on the ${role} interview request I sent over.`,
    ask: "Would you be open to connecting with the team?",
  },
  {
    opening: (role) => `Wanted to follow up on the ${role} interview request.`,
    ask: "Open to a conversation with the founders?",
  },
  {
    opening: (role) => `Checking back on the ${role} request I shared.`,
    ask: "Would you be interested in connecting with the team?",
  },
]);

export function followupCopy({
  firstName,
  roleName,
  companyName,
  roleUrl,
  ordinal,
  followupNumber,
  variationSeed,
}) {
  const first = clean(firstName) || "there";
  const roleLabel = `${clean(roleName)} @ ${clean(companyName)}`;
  const linkedText = `${roleLabel} (${clean(roleUrl)})`;
  let opening;
  let ask;
  let variant;

  if (Number(ordinal) === 1 && Number(followupNumber) === 1) {
    opening = `Following up here to see if you had a chance to review the ${linkedText} interview request.`;
    ask = "Let me know if you'd be open to connecting with the team!";
    variant = "initial_followup_1";
  } else if (Number(ordinal) === 1) {
    opening = `Any interest in exploring the ${linkedText}?`;
    ask = "If not, no worries! It would still be helpful to know if this one misses the mark.";
    variant = "initial_followup_2";
  } else {
    const index = variantIndex(
      variationSeed || `${ordinal}:${followupNumber}:${roleLabel}`,
      ADDITIONAL_FOLLOWUP_VARIANTS.length,
    );
    const selected = ADDITIONAL_FOLLOWUP_VARIANTS[index];
    opening = selected.opening(linkedText);
    ask = selected.ask;
    variant = `additional_followup_${index + 1}`;
  }

  const htmlOpening = opening.replace(linkedText, anchor(roleLabel, roleUrl));
  const text = [
    `Hey ${first},`,
    "",
    opening,
    "",
    ask,
    "",
    "Thanks,",
    "David",
  ].join("\n");
  const html = paragraphHtml([
    `Hey ${escapeHtml(first)},`,
    htmlOpening,
    ask,
    "Thanks,<br>David",
  ]);
  return { subject: null, text, html, variant };
}
