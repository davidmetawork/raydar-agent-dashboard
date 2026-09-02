import { ResumeContractError, deepFreeze, normalizeEvidenceText, sha256 } from "../api/submissions-v2/_lib/resume/source-bundle.mjs";
import { TEMPLATE_TOKENS } from "./contract.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function brandAsset(value) {
  const input = String(value || "").trim();
  const match = /^data:image\/(?:png|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/u.exec(input);
  if (!match) {
    throw new ResumeContractError(
      "OFFICIAL_BRAND_ASSET_REQUIRED",
      "The renderer requires an embedded official Raydar lockup asset",
    );
  }
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length) throw new ResumeContractError("OFFICIAL_BRAND_ASSET_INVALID", "The Raydar brand asset is empty");
  return { uri: input, sha256: sha256(bytes), byteLength: bytes.length };
}

function highlightedHtml(node) {
  const ranges = node.emphasis.map((phrase) => {
    const start = node.text.indexOf(phrase);
    return { start, end: start + phrase.length, phrase };
  }).sort((left, right) => left.start - right.start || right.end - left.end);
  let cursor = 0;
  let html = "";
  for (const range of ranges) {
    if (range.start < cursor) {
      throw new ResumeContractError("RESUME_EMPHASIS_OVERLAP", "Inline emphasis phrases cannot overlap", {
        nodeId: node.id,
      });
    }
    html += escapeHtml(node.text.slice(cursor, range.start));
    html += `<strong>${escapeHtml(range.phrase)}</strong>`;
    cursor = range.end;
  }
  html += escapeHtml(node.text.slice(cursor));
  return html;
}

function nodeHtml(node, className) {
  return `<div class="${className}" data-content-id="${escapeHtml(node.id)}">${highlightedHtml(node)}</div>`;
}

function sectionHtml(section) {
  const entries = section.entries.map((entry) => {
    const header = entry.header.map((node) => nodeHtml(node, "entry-header-line")).join("");
    const body = entry.body.map((node) => `<li>${nodeHtml(node, "entry-body-line")}</li>`).join("");
    return `<article class="resume-entry" data-entry-id="${escapeHtml(entry.id)}"><header class="entry-header">${header}</header>${body ? `<ul class="entry-body">${body}</ul>` : ""}</article>`;
  }).join("");
  return `<section class="resume-section resume-section--${escapeHtml(section.kind)}" data-section-id="${escapeHtml(section.id)}"><h2>${escapeHtml(section.title)}</h2>${entries}</section>`;
}

function stylesheet(density) {
  const scale = density === "compact" ? 0.96 : density === "airy" ? 1.04 : 1;
  return `
@font-face{font-family:"PP Grafier Display";src:url("../fonts/pp-grafier-display-variable.woff2") format("woff2");font-weight:300 800;font-style:normal;font-display:block}
@font-face{font-family:"Inter";src:url("../fonts/inter-latin-var.woff2") format("woff2");font-weight:300 800;font-style:normal;font-display:block}
@page{size:Letter;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:${TEMPLATE_TOKENS.colors.white};color:${TEMPLATE_TOKENS.colors.ink};font-family:"Inter",sans-serif;font-size:${TEMPLATE_TOKENS.typography.primaryBodyPt}pt;line-height:${TEMPLATE_TOKENS.typography.lineHeightRatio};letter-spacing:0}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.resume{width:8.5in;min-height:11in;padding-bottom:.78in;border-top:4pt solid ${TEMPLATE_TOKENS.colors.violet}}
.resume-header{position:relative;height:1.4056in;margin:0 0 .278in;padding:.23in ${TEMPLATE_TOKENS.page.marginIn}in;background:${TEMPLATE_TOKENS.colors.beigeHeader};break-inside:avoid}
.brand-lockup{position:absolute;top:.36in;right:.597in;width:1.278in;height:auto;object-fit:contain}
.candidate-name{max-width:5.55in;font-family:"PP Grafier Display",serif;font-size:${29 * scale}pt;line-height:1;font-weight:500}
.candidate-headline{max-width:5.55in;margin-top:.07in;color:${TEMPLATE_TOKENS.colors.violetText};font-size:${10.3 * scale}pt;font-weight:500;text-transform:uppercase}
.candidate-contact{display:flex;flex-wrap:wrap;gap:.04in .12in;margin-top:.10in;color:${TEMPLATE_TOKENS.colors.muted};font-size:${TEMPLATE_TOKENS.typography.supportingPt}pt}
.resume-grid{display:grid;grid-template-columns:4.9167in 2.375in;gap:.0417in;align-items:start;margin:0 ${TEMPLATE_TOKENS.page.marginIn}in}
.resume-main,.resume-sidebar{min-width:0}
.resume-sidebar{min-height:8.47in;padding:.14in;background:${TEMPLATE_TOKENS.colors.warmSidebar};border-radius:10px}
.resume-section{margin:0 0 ${0.18 * scale}in;break-inside:auto}
.resume-section:last-child{margin-bottom:0}
.resume-section h2{margin:0 0 ${0.09 * scale}in;padding:0 0 .045in;border-bottom:1px solid ${TEMPLATE_TOKENS.colors.violet};font-family:"PP Grafier Display",serif;font-size:12.2pt;line-height:1.1;font-weight:500}
.resume-sidebar .resume-section h2{border-color:${TEMPLATE_TOKENS.colors.rule};font-size:10.6pt}
.resume-entry{margin:0 0 ${0.14 * scale}in;break-inside:avoid}
.resume-entry:last-child{margin-bottom:0}
.entry-header{display:block;margin-bottom:.04in}
.entry-header-line:first-child{font-size:9.6pt;font-weight:700;color:${TEMPLATE_TOKENS.colors.ink}}
.entry-header-line:nth-child(n+2){font-size:7.8pt;font-weight:500;color:${TEMPLATE_TOKENS.colors.violetText}}
.entry-body{margin:0;padding:0;list-style:none}
.entry-body li{position:relative;margin:0 0 ${0.045 * scale}in;padding-left:0.12in;break-inside:avoid}
.entry-body li::before{content:"";position:absolute;left:0;top:0.44em;width:4px;height:4px;border-radius:50%;background:${TEMPLATE_TOKENS.colors.orange}}
.entry-body-line{font-size:${Math.max(8.5, 8.5 * scale)}pt;color:${TEMPLATE_TOKENS.colors.body}}
.resume-sidebar .entry-header{display:block}
.resume-sidebar .entry-header-line{margin:0 0 0.03in;font-size:${8.45 * scale}pt}
.resume-sidebar .entry-body{padding:0}.resume-sidebar .entry-body li{padding-left:0}.resume-sidebar .entry-body li::before{display:none}
.resume-sidebar .entry-body-line{font-size:${TEMPLATE_TOKENS.typography.supportingPt}pt;color:${TEMPLATE_TOKENS.colors.body}}
.resume-section--metrics{display:grid;grid-template-columns:1fr 1fr;gap:6pt}.resume-section--metrics h2{grid-column:1/-1}
.resume-section--metrics .resume-entry{margin:0;padding:7pt;background:${TEMPLATE_TOKENS.colors.white};border-radius:7px}
.resume-section--metrics .entry-header-line:first-child{color:${TEMPLATE_TOKENS.colors.violetText};font-size:14pt}
strong{font-weight:760;color:${TEMPLATE_TOKENS.colors.ink}}
.resume-footer{position:fixed;right:${TEMPLATE_TOKENS.page.marginIn}in;bottom:.43in;left:${TEMPLATE_TOKENS.page.marginIn}in;padding-top:.09in;border-top:1px solid ${TEMPLATE_TOKENS.colors.rule};color:${TEMPLATE_TOKENS.colors.muted};font-size:6.8pt}
.practice-footer{position:fixed;right:0;bottom:-0.31in;left:0;text-align:center;color:#8a2333;font-size:7.5pt;font-weight:800;text-transform:uppercase;letter-spacing:.03em}
@media print{.resume{min-height:auto}}
`;
}

export function renderResumeHtml(ast, plan, {
  officialBrandAsset,
  practice = false,
} = {}) {
  const brand = brandAsset(officialBrandAsset);
  const main = ast.sections.filter((section) => section.placement === "main").map(sectionHtml).join("");
  const sidebar = ast.sections.filter((section) => section.placement === "sidebar").map(sectionHtml).join("");
  const contact = ast.candidate.contact.map((node) => nodeHtml(node, "contact-item")).join("");
  const profile = ast.summary ? `<section class="resume-section resume-section--profile"><h2>Profile</h2><div class="entry-body-line" data-content-id="${escapeHtml(ast.summary.id)}">${highlightedHtml(ast.summary)}</div></section>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(ast.candidate.name.text)} — Resume</title><style>${stylesheet(plan.density)}</style></head><body><main class="resume" data-template-version="raydar-resume-template-v0.2" data-expected-pages="${plan.expectedPages}"><header class="resume-header"><img class="brand-lockup" src="${escapeHtml(brand.uri)}" alt="Raydar"><div class="candidate-name">${highlightedHtml(ast.candidate.name)}</div><div class="candidate-headline">${highlightedHtml(ast.candidate.headline)}</div>${contact ? `<div class="candidate-contact">${contact}</div>` : ""}</header><div class="resume-grid"><div class="resume-main">${profile}${main}</div>${sidebar ? `<aside class="resume-sidebar">${sidebar}</aside>` : ""}</div><footer class="resume-footer">Prepared by Raydar</footer>${practice ? '<footer class="practice-footer">Practice — not for submission</footer>' : ""}</main></body></html>`;
  return deepFreeze({
    html,
    htmlSha256: sha256(html),
    brandAssetId: TEMPLATE_TOKENS.brandAssetId,
    brandAssetSha256: brand.sha256,
    brandAssetByteLength: brand.byteLength,
  });
}

export function renderAtsText(ast) {
  const lines = [ast.candidate.name.text, ast.candidate.headline.text];
  if (ast.candidate.contact.length) lines.push(ast.candidate.contact.map((item) => item.text).join(" | "));
  if (ast.summary) lines.push("", "PROFILE", ast.summary.text);
  for (const section of ast.sections) {
    lines.push("", section.title.toUpperCase());
    for (const entry of section.entries) {
      lines.push(entry.header.map((item) => item.text).join(" | "));
      for (const node of entry.body) lines.push(`- ${node.text}`);
    }
  }
  const atsText = `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim()}\n`;
  return deepFreeze({ atsText, atsSha256: sha256(atsText) });
}
