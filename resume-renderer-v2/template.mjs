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
  const scale = density === "compact" ? 0.94 : density === "airy" ? 1.07 : 1;
  return `
@font-face{font-family:"PP Grafier Display";src:url("../fonts/pp-grafier-display-variable.woff2") format("woff2");font-weight:300 800;font-style:normal;font-display:block}
@font-face{font-family:"Inter";src:url("../fonts/inter-latin-var.woff2") format("woff2");font-weight:300 800;font-style:normal;font-display:block}
@page{size:Letter;margin:${TEMPLATE_TOKENS.page.marginIn}in}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:${TEMPLATE_TOKENS.colors.white};color:${TEMPLATE_TOKENS.colors.ink};font-family:"Inter",sans-serif;font-size:${TEMPLATE_TOKENS.typography.primaryBodyPt}pt;line-height:${TEMPLATE_TOKENS.typography.lineHeightRatio};letter-spacing:0}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.resume{width:100%;min-height:9.9in}
.resume-header{position:relative;margin:0 0 ${0.22 * scale}in;padding:${0.22 * scale}in ${0.24 * scale}in;background:${TEMPLATE_TOKENS.colors.beigeHeader};border-radius:14px;break-inside:avoid}
.brand-lockup{position:absolute;top:${0.2 * scale}in;right:${0.22 * scale}in;width:0.92in;height:auto;object-fit:contain}
.candidate-name{max-width:76%;font-family:"PP Grafier Display",serif;font-size:${21 * scale}pt;line-height:1.05;font-weight:500}
.candidate-headline{max-width:76%;margin-top:0.05in;color:${TEMPLATE_TOKENS.colors.muted};font-size:${9.7 * scale}pt;font-weight:600}
.candidate-contact{display:flex;flex-wrap:wrap;gap:0.05in 0.16in;margin-top:${0.1 * scale}in;color:${TEMPLATE_TOKENS.colors.muted};font-size:${TEMPLATE_TOKENS.typography.supportingPt}pt}
.resume-summary{margin:0 0 ${0.16 * scale}in;padding:0 0 ${0.14 * scale}in;border-bottom:1px solid ${TEMPLATE_TOKENS.colors.violet};font-size:${9.4 * scale}pt}
.resume-grid{display:grid;grid-template-columns:minmax(0,2.25fr) minmax(1.55in,0.86fr);gap:${0.25 * scale}in;align-items:start}
.resume-main,.resume-sidebar{min-width:0}
.resume-sidebar{padding:${0.18 * scale}in;background:${TEMPLATE_TOKENS.colors.warmSidebar};border-radius:12px}
.resume-section{margin:0 0 ${0.18 * scale}in;break-inside:auto}
.resume-section:last-child{margin-bottom:0}
.resume-section h2{margin:0 0 ${0.09 * scale}in;padding:0 0 0.045in;border-bottom:1px solid ${TEMPLATE_TOKENS.colors.violet};font-family:"PP Grafier Display",serif;font-size:${12.2 * scale}pt;line-height:1.1;font-weight:500}
.resume-entry{margin:0 0 ${0.14 * scale}in;break-inside:avoid}
.resume-entry:last-child{margin-bottom:0}
.entry-header{display:flex;flex-wrap:wrap;align-items:baseline;gap:0.02in 0.1in;margin-bottom:0.04in}
.entry-header-line:first-child{font-weight:750}
.entry-header-line{font-size:${8.9 * scale}pt}
.entry-header-line:nth-child(n+3){margin-left:auto;color:${TEMPLATE_TOKENS.colors.muted};font-size:${TEMPLATE_TOKENS.typography.supportingPt}pt}
.entry-body{margin:0;padding:0;list-style:none}
.entry-body li{position:relative;margin:0 0 ${0.045 * scale}in;padding-left:0.12in;break-inside:avoid}
.entry-body li::before{content:"";position:absolute;left:0;top:0.44em;width:4px;height:4px;border-radius:50%;background:${TEMPLATE_TOKENS.colors.orange}}
.entry-body-line{font-size:${8.75 * scale}pt}
.resume-sidebar .entry-header{display:block}
.resume-sidebar .entry-header-line{margin:0 0 0.03in;font-size:${8.45 * scale}pt}
.resume-sidebar .entry-body-line{font-size:${TEMPLATE_TOKENS.typography.supportingPt}pt}
.resume-section--metrics .resume-entry{padding:0.08in;background:${TEMPLATE_TOKENS.colors.white};border-radius:8px}
strong{font-weight:760;color:${TEMPLATE_TOKENS.colors.ink}}
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(ast.candidate.name.text)} — Resume</title><style>${stylesheet(plan.density)}</style></head><body><main class="resume" data-template-version="raydar-resume-template-v0.1" data-expected-pages="${plan.expectedPages}"><header class="resume-header"><img class="brand-lockup" src="${escapeHtml(brand.uri)}" alt="Raydar"><div class="candidate-name">${highlightedHtml(ast.candidate.name)}</div><div class="candidate-headline">${highlightedHtml(ast.candidate.headline)}</div>${contact ? `<div class="candidate-contact">${contact}</div>` : ""}</header>${ast.summary ? `<div class="resume-summary" data-content-id="${escapeHtml(ast.summary.id)}">${highlightedHtml(ast.summary)}</div>` : ""}<div class="resume-grid"><div class="resume-main">${main}</div>${sidebar ? `<aside class="resume-sidebar">${sidebar}</aside>` : ""}</div>${practice ? '<footer class="practice-footer">Practice — not for submission</footer>' : ""}</main></body></html>`;
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
  if (ast.summary) lines.push("", ast.summary.text);
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
