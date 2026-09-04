import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../submissions-v2.html", import.meta.url), "utf8");
const css = await readFile(new URL("../submissions-v2.css", import.meta.url), "utf8");
const js = await readFile(new URL("../submissions-v2.js", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const vercelIgnore = await readFile(new URL("../.vercelignore", import.meta.url), "utf8");
const dockerIgnore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
const dockerfiles = await Promise.all([
  "../resume-renderer/Dockerfile",
  "../resume-renderer-v2/Dockerfile",
  "../submissions-v2-worker/Dockerfile",
  "../submissions-v2-purge/Dockerfile",
].map((pathname) => readFile(new URL(pathname, import.meta.url), "utf8")));
const surface = `${html}\n${css}\n${js}`;

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("Submissions V2 ships the three-page searchable Activity-style shell", () => {
  assert.match(html, /<title>Raydar · Submissions V2<\/title>/);
  assert.match(html, /data-page="interested"/);
  assert.match(html, /data-page="needs_review"/);
  assert.match(html, /data-page="not_interested"/);
  assert.match(html, /id="candidate-search"[^>]+placeholder="Search candidate name"/);
  assert.match(html, /id="display-count"/);
  assert.match(html, /id="load-more"/);
  assert.match(css, /--cream:#f6f3e9/);
  assert.match(css, /\.submission-row\{[^}]*cursor:default/);
});

test("Interested keeps current work above a visibly separate permanent Submitted history", () => {
  assert.match(js, /rowGroupHtml\("ready", "Ready to submit", active\)/);
  assert.match(js, /rowGroupHtml\("submitted", "Submitted history", submitted\)/);
  assert.ok(js.indexOf('rowGroupHtml("ready"') < js.indexOf('rowGroupHtml("submitted"'));
  assert.match(css, /\.row-group\+\.row-group\{border-top:12px solid var\(--cream\)\}/);
  assert.match(css, /\.row-group\.submitted \.row-group-heading/);
});

test("rows are inert except for explicit keyboard-accessible controls", () => {
  const row = between(js, "function rowHtml(row)", "function bindRows()");
  assert.match(row, /<article class="submission-row/);
  assert.doesNotMatch(row, /onclick=|data-href=|role="button"|tabindex=/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-selected="true"/);
});

test("dialogs are modal, focus-managed, and expose their labels", () => {
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-subtitle"/);
  assert.match(js, /function trapDialogFocus\(event\)/);
  assert.match(js, /STATE\.dialogReturnFocus/);
  assert.match(js, /\$\("shell"\)\.inert = true/);
  assert.match(js, /returnFocus\?\.isConnected/);
  assert.match(js, /event\.key === "Escape"/);
});

test("forbidden resume and Paraform controls do not exist", () => {
  assert.doesNotMatch(surface, /\bGenerate Resume\b/i);
  assert.doesNotMatch(surface, /resume[-_ ]preview|Preview Resume/i);
  assert.doesNotMatch(surface, /contenteditable|resume[-_ ]editor|Edit Resume/i);
  assert.match(js, /async function autoDownloadResume\(row\)/);
  assert.doesNotMatch(html, /<form\b|formaction=|action="[^"]*submit/i);

  const regeneration = between(js, "async function regenerateResume(id)", "async function autoDownloadResume(row)");
  assert.doesNotMatch(regeneration, /downloadResume\(|anchor\.click\(|download-ticket/);
  assert.match(regeneration, /command\("regenerate"/);
  assert.doesNotMatch(regeneration, /openDialog\(|candidate_context|source_note|uploads/);

  const submit = between(js, "async function openSubmit(id)", "async function command(action");
  assert.match(submit, /\/submit-open/);
  assert.match(submit, /window\.open\("about:blank", "_blank"\)/);
  assert.match(submit, /navigateSubmitPopup\(popup, url\)/);
  assert.doesNotMatch(submit, /attachment|resume\/upload|submit_candidate|native/i);
});

test("all nested V2 API paths dispatch through one deployable Vercel function", () => {
  assert.ok(vercel.rewrites.some((rewrite) => rewrite.source === "/api/submissions-v2/:route*"
    && rewrite.destination === "/api/submissions-v2-dispatch?route=:route"));
  assert.equal(vercel.functions["api/submissions-v2-dispatch.mjs"].maxDuration, 300);
  assert.equal(vercel.functions["api/submissions-v2/[...route].mjs"], undefined);
  assert.match(vercelIgnore, /scripts\/provision-submissions-v2-roles\.sql/);
});

test("remote container builds exclude local secrets while retaining every Docker COPY source", () => {
  const rules = new Set(dockerIgnore.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
  assert.ok(rules.has("**"));
  assert.ok(rules.has("**/.env.*"));
  assert.ok(rules.has("**/*secret*"));
  assert.equal([...rules].some((rule) => /vercel/u.test(rule) && rule.startsWith("!")), false);
  for (const source of ["package.json", "package-lock.json"]) assert.ok(rules.has(`!${source}`));
  for (const directory of ["api", "fonts", "resume-renderer", "resume-renderer-v2", "submissions-v2-worker", "submissions-v2-purge"]) {
    assert.ok(rules.has(`!${directory}/`), `missing Docker context directory ${directory}`);
    assert.ok(rules.has(`!${directory}/**`), `missing Docker context contents ${directory}`);
  }
  for (const dockerfile of dockerfiles) {
    for (const line of dockerfile.split(/\r?\n/u).filter((value) => /^COPY\s+/u.test(value))) {
      const parts = line.trim().split(/\s+/u).slice(1, -1);
      for (const source of parts) {
        const normalized = source.replace(/\/$/u, "");
        const topLevel = normalized.split("/")[0];
        assert.ok(rules.has(`!${normalized}`) || rules.has(`!${topLevel}/**`), `Docker COPY source is excluded: ${source}`);
      }
    }
  }
});
