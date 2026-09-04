"use strict";

import { listFailureDisposition, listScopeIsCurrent, navigateSubmitPopup, reconcileListPages, resumeUiState } from "/submissions-v2-ui-state.mjs";

const $ = (id) => document.getElementById(id);
const PAGE_LABELS = Object.freeze({
  interested: "Interested",
  needs_review: "Needs Review",
  not_interested: "Not Interested",
});
const EMPTY = Object.freeze({
  interested: "No interested candidates right now",
  needs_review: "No candidates need review",
  not_interested: "No not-interested candidates right now",
});
const URL_HOSTS = Object.freeze({
  candidate: ["paraform.com"],
  linkedin: ["linkedin.com"],
  raydar: ["raydar.xyz"],
  signal: ["raydar.xyz", "paraform.com", "mail.google.com"],
  submit: ["paraform.com"],
  storage: ["vercel-storage.com"],
});
const ACTIVE_GENERATION_STATES = new Set([
  "queued", "collecting", "extracting", "strategizing", "validating", "rendering", "archiving",
]);
const AUTO_DOWNLOAD_STORAGE_KEY = "raydar.submissions-v2.pending-resume-downloads.v1";

function pendingDownloadsFromSession() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(AUTO_DOWNLOAD_STORAGE_KEY) || "{}");
    return new Map(Object.entries(parsed).filter(([pairId, artifactId]) => pairId && typeof artifactId === "string"));
  } catch { return new Map(); }
}

function persistPendingDownloads() {
  try { sessionStorage.setItem(AUTO_DOWNLOAD_STORAGE_KEY, JSON.stringify(Object.fromEntries(STATE.pendingDownloads))); }
  catch { /* A blocked session store must not stop generation or download. */ }
}

const STATE = {
  page: "interested", query: "", rows: [], nextCursor: null, loading: false,
  totalCount: null, listSequence: 0, listRequest: null, countsRequest: null,
  counts: { interested: 0, needs_review: 0, not_interested: 0, actionable: 0 },
  session: null, authConfig: null, csrf: "", active: null, searchTimer: null, pollTimer: null,
  searchRequests: new Map(), generating: new Set(), dialogReturnFocus: null,
  pendingDownloads: pendingDownloadsFromSession(), downloadsInFlight: new Set(),
  popoverAnchor: null, popoverCloseTimer: null, signinStarted: false, rowActions: new Set(),
};

if (new URLSearchParams(location.search).has("embed")) document.body.classList.add("embed");

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

function safeUrl(value, allowed = [], { sameOrigin = true } = {}) {
  try {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const url = new URL(raw, location.origin);
    if (sameOrigin && url.origin === location.origin) return url.href;
    if (url.protocol !== "https:") return "";
    if (!allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return "";
    return url.href;
  } catch { return ""; }
}

function isGenerationActive(row) {
  return ACTIVE_GENERATION_STATES.has(String(row?.generation_status || "").toLowerCase());
}

function rowActionKey(id, action) { return `${action}:${String(id)}`; }
function rowActionPending(id, action) { return STATE.rowActions.has(rowActionKey(id, action)); }
function rowCapability(row, name, fallback) {
  const value = row?.capabilities?.[name];
  return typeof value === "boolean" ? value : fallback;
}

async function withRowAction(id, action, work) {
  const key = rowActionKey(id, action);
  if (STATE.rowActions.has(key)) return;
  STATE.rowActions.add(key);
  renderRows();
  try { return await work(); }
  finally {
    STATE.rowActions.delete(key);
    renderRows();
  }
}

function fmtWhen(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })} · ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function filenamePart(value, fallback) {
  return String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || fallback;
}

function suggestedResumeFilename(row) {
  return `${filenamePart(row.candidate_name || row.provisional_name, "Candidate")}__${filenamePart(row.company, "Company")}__${filenamePart(row.role_title, "Role")}__Raydar__${new Date().toISOString().slice(0, 10)}.pdf`;
}

function filePickerWindow() {
  try { if (window.top && window.top.location.origin === location.origin) return window.top; }
  catch { /* A cross-origin parent cannot provide the picker. */ }
  return window;
}

function toast(message, error = false) {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast${error ? " error" : ""}`;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 6000);
}

async function request(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { accept: "application/json", ...(options.headers || {}) };
  if (!["GET", "HEAD"].includes(method)) {
    headers["content-type"] ||= "application/json";
    headers["x-raydar-csrf"] = STATE.csrf;
    headers["idempotency-key"] ||= crypto.randomUUID();
  }
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options, method, headers });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) showSignin();
  if (!response.ok || body.ok === false) {
    const error = new Error(body.detail || body.error || `Request failed (${response.status})`);
    error.code = body.error || "request_failed";
    error.status = response.status;
    error.current = body.current || null;
    throw error;
  }
  return body;
}

async function publicJson(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function linkedIcon(kind, href, label) {
  const safe = safeUrl(href, URL_HOSTS[kind] || []);
  if (!safe) return "";
  const icon = kind === "linkedin"
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0A66C2" d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z"/></svg>'
    : '<svg viewBox="1145.967 795.987 149.896 149.273" aria-hidden="true"><path fill="currentColor" d="M1273.44 827.735C1271.52 829.651 1271.04 833.124 1272.6 835.4C1289.93 860.668 1286.56 895.876 1262.49 917.313C1238.42 938.749 1203.4 938.15 1179.94 917.792C1152.26 893.841 1151.17 851.926 1176.69 826.538C1194.02 809.293 1219.05 804.263 1240.83 811.449C1245.28 812.886 1246.49 818.514 1243.24 821.867L1242.63 822.466C1240.95 824.143 1238.42 824.741 1236.14 824.023C1217.72 818.155 1196.54 823.304 1183.07 839.352C1167.78 857.555 1168.14 884.619 1183.67 902.583C1202.56 924.259 1235.66 925.097 1255.75 905.217C1271.28 889.769 1274.28 866.297 1264.54 847.854C1262.61 844.142 1257.68 843.543 1254.67 846.417C1252.74 848.333 1252.26 851.208 1253.59 853.603C1261.41 868.572 1258.28 887.733 1244.08 899.23C1229.88 910.726 1209.9 909.888 1196.66 898.272C1180.54 884.14 1180.06 859.59 1194.98 844.741C1200.39 839.352 1207.13 835.999 1214.11 834.681C1220.25 833.603 1224.1 841.028 1219.65 845.339C1218.81 846.178 1217.72 846.777 1216.52 847.016C1210.98 847.974 1205.81 850.968 1201.96 855.758C1194.98 864.381 1195.1 876.955 1201.96 885.697C1211.11 897.074 1227.95 897.793 1237.94 887.733C1242.63 883.063 1245.04 876.835 1245.04 870.728C1245.04 865.339 1238.3 862.704 1234.45 866.536C1233.37 867.614 1232.65 869.051 1232.65 870.608C1232.65 874.32 1230.96 878.033 1227.47 880.428C1223.62 883.063 1218.21 883.182 1214.35 880.428C1207.98 876.117 1207.37 867.375 1212.55 862.225C1214.6 860.189 1217.12 859.111 1219.77 858.872C1222.42 858.632 1224.94 857.195 1226.87 855.279L1264.06 818.275C1266.82 815.52 1266.34 810.97 1263.21 808.814C1232.41 787.976 1189.2 792.527 1163.57 822.466C1139.98 850.249 1140.1 891.565 1163.93 919.229C1192.69 952.521 1243.36 953.838 1273.92 923.42C1299.8 897.673 1302.81 857.674 1282.83 828.574C1280.66 825.46 1276.09 824.981 1273.32 827.735H1273.44Z"/></svg>';
  return `<a class="identity-link ${kind}" href="${esc(safe)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(label)}" title="${esc(label)}">${icon}</a>`;
}

function rowIdentity(row) {
  const name = row.candidate_name || row.provisional_name || "Unknown candidate";
  const candidateUrl = safeUrl(row.candidate_url, URL_HOSTS.candidate);
  const nameHtml = candidateUrl
    ? `<a class="candidate-name" href="${esc(candidateUrl)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`
    : `<span class="identity-placeholder">${esc(name)}</span>`;
  return `<div class="identity-cell"><div class="identity-line">${nameHtml}<span class="identity-links">${linkedIcon("linkedin", row.linkedin_url, `Open ${name} on LinkedIn`)}${linkedIcon("raydar", row.raydar_url, `Open ${name} in Raydar`)}</span></div></div>`;
}

function cautionButton(row) {
  const cautions = Array.isArray(row.resume_cautions) ? row.resume_cautions : [];
  if (!cautions.length) return "";
  return `<button class="icon-button warning caution" type="button" data-id="${esc(row.case_id)}" aria-label="Resume source caution" title="Resume source caution">!</button>`;
}

function resumeProgressHtml(row) {
  const resume = resumeUiState(row);
  if (!resume.preparing && !resume.generating) return "";
  const labels = {
    queued: "Resume preparation queued",
    collecting: "Collecting resume evidence",
    extracting: "Checking resume details",
    strategizing: "Planning the role-specific resume",
    validating: "Validating the resume",
    rendering: "Rendering the resume",
    archiving: "Finalizing the resume",
  };
  const failed = ["failed", "cancelled", "held"].includes(resume.status);
  const label = failed ? "Resume preparation needs attention" : (labels[resume.status] || "Preparing resume");
  const detail = row.preparation_error_detail || (resume.hasArtifact ? "Prior resume is still available." : "Download and Submit unlock when the resume is ready.");
  return `<div class="resume-progress" role="status"><span class="progress-dot" aria-hidden="true"></span><span>${esc(label)}${resume.hasArtifact ? " · updating" : ""}</span><small>${esc(detail)}</small></div>`;
}

function interestedActions(row) {
  const id = String(row.case_id || "");
  const submitted = row.submission_status === "proven";
  const resume = resumeUiState(row);
  const generating = resume.generating || STATE.generating.has(id);
  const downloading = rowActionPending(id, "download");
  const submitting = rowActionPending(id, "submit");
  const canDownload = rowCapability(row, "can_download", resume.hasArtifact);
  const canSubmit = rowCapability(row, "can_submit", resume.hasArtifact);
  const canRegenerate = rowCapability(row, "can_regenerate", resume.hasArtifact);
  const canCorrect = rowCapability(row, "can_correct", !submitted);
  const canDuplicate = rowCapability(row, "can_duplicate", Boolean(row.candidate_id));
  const historyLabel = submitted ? '<span class="submitted-label">SUBMITTED</span>' : "";
  const correct = submitted ? "" : `<button class="button text correct" data-id="${esc(id)}" type="button" ${canCorrect ? "" : "disabled"}>Correct</button>`;
  const submit = submitted ? "" : `<button class="button primary submit" data-id="${esc(id)}" type="button" ${!canSubmit || submitting ? "disabled" : ""} title="${!canSubmit ? "Resume is still being prepared" : ""}">${submitting ? "Opening…" : "Submit"}</button>`;
  const rerunIcon = '<svg class="rerun-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  return `${historyLabel}${correct}<button class="button secondary download" data-id="${esc(id)}" type="button" ${!canDownload || downloading ? "disabled" : ""} title="${!canDownload ? "Resume is still being prepared" : ""}">${downloading ? "Downloading…" : "Download Resume"}</button>${cautionButton(row)}<button class="icon-button regenerate${generating ? " spinning" : ""}" data-id="${esc(id)}" type="button" aria-label="${generating ? "Generating resume" : "Regenerate resume"}" title="${generating ? "Generating resume" : "Regenerate resume"}" aria-busy="${generating}" ${generating || !canRegenerate ? "disabled" : ""}>${rerunIcon}</button><button class="button secondary duplicate" data-id="${esc(id)}" type="button" ${canDuplicate ? "" : "disabled"}>Duplicate</button>${submit}`;
}

function reviewActions(row) {
  const ageHours = Math.max(0, (Date.now() - Date.parse(row.signal_at || "")) / 3600000);
  return `<div class="review-actions"><span class="review-age${ageHours >= 24 ? " old" : ""}">${ageHours >= 24 ? `${Math.floor(ageHours)}h` : ""}</span><button class="icon-button review-triangle review-reasons" data-id="${esc(row.case_id || row.signal_id)}" type="button" aria-label="Needs review" title="Needs review"></button><button class="button secondary review-action" data-id="${esc(row.case_id || row.signal_id)}" type="button">${esc(row.primary_action_label || "Review")}</button></div>`;
}

function negativeActions(row) {
  return row.corrected_destination
    ? `<span class="submitted-label">Corrected to ${esc(PAGE_LABELS[row.corrected_destination] || row.corrected_destination)}</span>`
    : `<button class="button text correct" data-id="${esc(row.case_id)}" type="button">Correct</button>`;
}

function rowHtml(row) {
  const role = row.company && row.role_title ? `${row.company} · ${row.role_title}` : row.role_label || (row.offered_role_count > 1 ? "Multiple offered roles" : "Role not identified");
  const signalUrl = safeUrl(row.signal_url, URL_HOSTS.signal);
  const signal = signalUrl ? `<a class="signal-link" href="${esc(signalUrl)}" target="_blank" rel="noopener noreferrer">Signal</a>` : '<span class="role-muted">Signal unavailable</span>';
  const reason = STATE.page === "not_interested" ? `<div class="reason-line">${esc(row.negative_reason || "No reason provided")}</div>` : "";
  const actions = STATE.page === "interested" ? interestedActions(row) : STATE.page === "needs_review" ? reviewActions(row) : negativeActions(row);
  const progress = STATE.page === "interested" ? resumeProgressHtml(row) : "";
  return `<article class="submission-row${row.submission_status === "proven" ? " submitted" : ""}" data-id="${esc(row.case_id || row.signal_id)}">${rowIdentity(row)}<div class="role-cell"><div class="role-title">${esc(role)}</div>${progress}${reason}</div><div class="signal-cell">${signal}</div><time class="time-cell" datetime="${esc(row.signal_at || "")}">${esc(fmtWhen(row.signal_at))}</time><div class="row-actions">${actions}</div></article>`;
}

function bindRows() {
  document.querySelectorAll(".download").forEach((node) => { node.onclick = () => downloadResume(node.dataset.id); });
  document.querySelectorAll(".regenerate").forEach((node) => { node.onclick = () => regenerateResume(node.dataset.id); });
  document.querySelectorAll(".duplicate").forEach((node) => { node.onclick = () => openDuplicate(node.dataset.id); });
  document.querySelectorAll(".correct").forEach((node) => { node.onclick = () => openCorrect(node.dataset.id); });
  document.querySelectorAll(".submit").forEach((node) => { node.onclick = () => openSubmit(node.dataset.id); });
  document.querySelectorAll(".review-action").forEach((node) => { node.onclick = () => openReview(node.dataset.id); });
  document.querySelectorAll(".review-reasons,.caution").forEach(bindPopoverButton);
}

function rowFor(id) { return STATE.rows.find((row) => String(row.case_id || row.signal_id) === String(id)); }

function renderRows() {
  const container = $("rows");
  if (!STATE.rows.length) container.innerHTML = `<div class="empty-state"><strong>${esc(EMPTY[STATE.page])}</strong>${STATE.query ? "Try another candidate name." : ""}</div>`;
  else if (STATE.page === "interested") {
    const preparing = STATE.rows.filter((row) => row.submission_status !== "proven" && resumeUiState(row).preparing);
    const active = STATE.rows.filter((row) => row.submission_status !== "proven" && !resumeUiState(row).preparing);
    const submitted = STATE.rows.filter((row) => row.submission_status === "proven");
    container.innerHTML = `${rowGroupHtml("preparing", "Preparing resumes", preparing)}${rowGroupHtml("ready", "Ready to submit", active)}${rowGroupHtml("submitted", "Submitted history", submitted)}`;
  } else container.innerHTML = STATE.rows.map(rowHtml).join("");
  const total = Number.isFinite(STATE.totalCount) && STATE.totalCount >= STATE.rows.length ? STATE.totalCount : STATE.rows.length;
  $("display-count").textContent = `${STATE.rows.length}${total > STATE.rows.length ? ` of ${total}` : ""} candidate${total === 1 ? "" : "s"}`;
  $("current-page-title").textContent = `${PAGE_LABELS[STATE.page]} candidates`;
  $("pagination").hidden = !STATE.nextCursor;
  $("add-candidate").hidden = STATE.page !== "interested";
  container.setAttribute("aria-busy", "false");
  bindRows();
  reportHeight();
}

function rowGroupHtml(key, label, rows) {
  if (!rows.length) return "";
  return `<section class="row-group ${esc(key)}" aria-labelledby="row-group-${esc(key)}"><h3 class="row-group-heading" id="row-group-${esc(key)}"><span>${esc(label)}</span><span>${rows.length}</span></h3>${rows.map(rowHtml).join("")}</section>`;
}

function renderCounts() {
  $("count-interested").textContent = STATE.counts.interested || 0;
  $("count-needs-review").textContent = STATE.counts.needs_review || 0;
  $("count-not-interested").textContent = STATE.counts.not_interested || 0;
  if (window.parent !== window) window.parent.postMessage({ type: "raydar-submissions-v2-counts", count: STATE.counts.actionable || 0 }, location.origin);
}

function renderHealth(health = {}) {
  const node = $("source-health");
  const delayed = health.delayed || health.database === "unavailable";
  node.className = `source-health ${delayed ? "delayed" : "current"}`;
  node.textContent = delayed ? `Updates delayed${health.last_success_at ? ` · last success ${fmtWhen(health.last_success_at)}` : ""}` : "Sources current";
  const banner = $("delay-banner");
  banner.hidden = !delayed;
  banner.textContent = delayed ? "Updates are delayed. Raydar is keeping the last confirmed rows visible while source updates recover." : "";
}

async function loadCounts() {
  STATE.countsRequest?.abort();
  const controller = new AbortController();
  STATE.countsRequest = controller;
  try {
    const data = await request("/api/submissions-v2/counts", { signal: controller.signal });
    if (STATE.countsRequest !== controller) return;
    STATE.counts = data.counts || STATE.counts;
    renderCounts();
    renderHealth(data.health || {});
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    if (STATE.countsRequest === controller) STATE.countsRequest = null;
  }
}

async function loadRows({ append = false, refresh = false } = {}) {
  if (append && STATE.loading) return;
  STATE.listRequest?.abort();
  const controller = new AbortController();
  const scope = { sequence: ++STATE.listSequence, page: STATE.page, query: STATE.query };
  let cursor = append ? STATE.nextCursor : null;
  const preserveRows = refresh && !append && STATE.rows.length > 0;
  const minimumRows = preserveRows ? STATE.rows.length : 0;
  STATE.listRequest = controller;
  STATE.loading = true;
  $("rows").setAttribute("aria-busy", "true");
  $("load-more").disabled = true;
  $("load-more").textContent = append ? "Loading…" : "Load more";
  if (!append && !preserveRows) $("rows").innerHTML = '<div class="loading-row">Loading submissions…</div>';
  try {
    const pages = [];
    do {
      const params = new URLSearchParams({ page: scope.page, limit: "100" });
      if (scope.query) params.set("q", scope.query);
      if (cursor) params.set("cursor", cursor);
      const data = await request(`/api/submissions-v2/list?${params}`, { signal: controller.signal });
      if (!listScopeIsCurrent(scope, STATE)) return;
      pages.push(data);
      cursor = data.next_cursor || null;
    } while (refresh && !append && cursor && pages.reduce((count, pageData) => count + (pageData.rows || []).length, 0) < minimumRows);
    if (!listScopeIsCurrent(scope, STATE)) return;
    const list = reconcileListPages({ pages, append, currentRows: STATE.rows });
    STATE.rows = list.rows;
    STATE.nextCursor = list.nextCursor;
    STATE.totalCount = list.totalCount;
    let completedRegeneration = false;
    const completedDownloads = [];
    let failedRegeneration = false;
    for (const row of STATE.rows) {
      const id = String(row.case_id || "");
      if (!id) continue;
      const wasGenerating = STATE.generating.has(id);
      const status = String(row.generation_status || "").toLowerCase();
      if (isGenerationActive(row)) STATE.generating.add(id);
      else if (row.generation_status) {
        STATE.generating.delete(id);
        if (wasGenerating && status === "succeeded") completedRegeneration = true;
      }
      if (STATE.pendingDownloads.has(id)) {
        const priorArtifactId = STATE.pendingDownloads.get(id);
        if (status === "succeeded" && row.current_artifact_id && row.current_artifact_id !== priorArtifactId) {
          STATE.pendingDownloads.delete(id);
          completedDownloads.push(row);
        } else if (["failed", "cancelled", "held"].includes(status)) {
          STATE.pendingDownloads.delete(id);
          failedRegeneration = true;
        }
      }
    }
    persistPendingDownloads();
    renderHealth(pages[0]?.health || {});
    renderRows();
    if (completedDownloads.length) {
      for (const row of completedDownloads) autoDownloadResume(row);
    } else if (failedRegeneration) toast("Resume generation failed safely; no new file was saved.", true);
    else if (completedRegeneration) toast("The new resume is ready to download.");
  } catch (error) {
    if (error.name === "AbortError") return;
    const failure = listFailureDisposition({ scope, state: STATE, append, refresh });
    if (failure === "ignore") return;
    if (failure === "preserve") {
      $("rows").setAttribute("aria-busy", "false");
      toast(`${append ? "Could not load more." : "Could not refresh."} Showing the last loaded candidates. ${error.message}`, true);
      return;
    }
    $("rows").innerHTML = `<div class="empty-state"><strong>Submissions are unavailable</strong>${esc(error.message)}</div>`;
    $("rows").setAttribute("aria-busy", "false");
  } finally {
    if (STATE.listRequest === controller) {
      STATE.listRequest = null;
      STATE.loading = false;
      $("load-more").disabled = false;
      $("load-more").textContent = "Load more";
    }
  }
}

function switchPage(page) {
  if (!PAGE_LABELS[page] || page === STATE.page) return;
  STATE.page = page; STATE.rows = []; STATE.nextCursor = null; STATE.totalCount = null;
  document.querySelectorAll(".page-tab").forEach((node) => {
    const active = node.dataset.page === page;
    node.classList.toggle("active", active);
    node.setAttribute("aria-selected", String(active));
  });
  $("rows").setAttribute("aria-labelledby", `tab-${page.replaceAll("_", "-")}`);
  loadRows();
}

function closePopover() {
  clearTimeout(STATE.popoverCloseTimer);
  document.querySelector(".popover")?.remove();
  if (STATE.popoverAnchor) {
    STATE.popoverAnchor.setAttribute("aria-expanded", "false");
    STATE.popoverAnchor.removeAttribute("aria-controls");
    STATE.popoverAnchor = null;
  }
}

function schedulePopoverClose() {
  clearTimeout(STATE.popoverCloseTimer);
  STATE.popoverCloseTimer = setTimeout(closePopover, 120);
}

function bindPopoverButton(node) {
  const kind = node.classList.contains("caution") ? "caution" : "review";
  node.setAttribute("aria-haspopup", "dialog");
  node.setAttribute("aria-expanded", "false");
  node.onpointerenter = () => showPopover(node, rowFor(node.dataset.id), kind);
  node.onpointerleave = schedulePopoverClose;
  node.onfocus = () => showPopover(node, rowFor(node.dataset.id), kind);
  node.onblur = schedulePopoverClose;
  node.onclick = (event) => {
    event.stopPropagation();
    showPopover(node, rowFor(node.dataset.id), kind);
  };
}

function showPopover(anchor, row, kind) {
  closePopover();
  const items = kind === "caution" ? row?.resume_cautions : row?.review_reasons;
  const pop = document.createElement("div");
  const popoverId = `submission-popover-${String(row?.case_id || row?.signal_id || "item").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  pop.id = popoverId; pop.className = "popover"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", kind === "caution" ? "Resume source coverage" : "Needs review reasons");
  pop.innerHTML = `<strong>${kind === "caution" ? "Resume source coverage" : "Needs review"}</strong><ul>${(items || []).map((item) => `<li>${esc(item.label || item.detail || item.code || item)}${item.impact ? ` — ${esc(item.impact)}` : ""}</li>`).join("") || "<li>Review details are unavailable.</li>"}</ul>`;
  STATE.popoverAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-controls", popoverId);
  document.body.appendChild(pop);
  pop.onpointerenter = () => clearTimeout(STATE.popoverCloseTimer);
  pop.onpointerleave = schedulePopoverClose;
  pop.onclick = (event) => event.stopPropagation();
  const box = anchor.getBoundingClientRect(); const width = Math.min(330, innerWidth - 30);
  pop.style.left = `${Math.max(15, Math.min(innerWidth - width - 15, box.right - width))}px`;
  pop.style.top = `${Math.min(innerHeight - pop.offsetHeight - 15, box.bottom + 7)}px`;
}

function openDialog({ eyebrow = "Submissions", title, subtitle = "", body, footer }) {
  closePopover();
  if ($("modal").hidden) STATE.dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $("dialog-eyebrow").textContent = eyebrow; $("dialog-title").textContent = title; $("dialog-subtitle").textContent = subtitle;
  $("dialog-body").innerHTML = body; $("dialog-footer").innerHTML = footer; $("modal").hidden = false;
  $("shell").inert = true; $("shell").setAttribute("aria-hidden", "true"); document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    const first = $("dialog-body").querySelector("input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])") || $("dialog-close");
    first.focus();
  });
  reportHeight();
}
function closeDialog() {
  if ($("modal").hidden) return;
  $("modal").hidden = true; STATE.active = null; $("shell").inert = false; $("shell").removeAttribute("aria-hidden"); document.body.classList.remove("modal-open");
  const returnFocus = STATE.dialogReturnFocus; STATE.dialogReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
  reportHeight();
}

function dialogStillActive(active) { return STATE.active === active && !$("modal").hidden; }

function trapDialogFocus(event) {
  if (event.key !== "Tab" || $("modal").hidden) return;
  const focusable = [...$("modal").querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hidden && node.getClientRects().length);
  if (!focusable.length) { event.preventDefault(); $("modal").querySelector(".dialog")?.focus(); return; }
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

async function searchIndex(kind, query, target) {
  const needle = query.trim();
  STATE.searchRequests.get(target.id)?.abort();
  if (needle.length < 2) { STATE.searchRequests.delete(target.id); target.innerHTML = ""; return; }
  const controller = new AbortController();
  STATE.searchRequests.set(target.id, controller);
  target.innerHTML = '<div class="loading-row">Searching…</div>';
  try {
    const params = new URLSearchParams({ q: needle, limit: "50" });
    const data = await request(`/api/submissions-v2/search/${kind}?${params}`, { signal: controller.signal });
    if (STATE.searchRequests.get(target.id) !== controller) return;
    target.innerHTML = (data.results || []).map((item) => `<button class="search-result" type="button" data-value="${esc(item.id)}"><strong>${esc(item.name || `${item.company} · ${item.title}`)}</strong><small>${esc(item.headline || item.company || item.title || "")}</small></button>`).join("") || '<div class="empty-state">No results found.</div>';
  } catch (error) {
    if (error.name !== "AbortError") target.innerHTML = `<div class="error-text">${esc(error.message)}</div>`;
  } finally {
    if (STATE.searchRequests.get(target.id) === controller) STATE.searchRequests.delete(target.id);
  }
}

function bindSearchSelection(container, key) {
  container.onclick = (event) => {
    const result = event.target.closest(".search-result"); if (!result) return;
    container.querySelectorAll(".search-result").forEach((node) => node.classList.toggle("selected", node === result));
    STATE.active[key] = result.dataset.value;
    STATE.active[`${key}_label`] = result.querySelector("strong")?.textContent || "";
    updateConfirmState();
  };
}

function bindMultiSearchSelection(container, key) {
  container.onclick = (event) => {
    const result = event.target.closest(".search-result"); if (!result) return;
    const values = new Set(STATE.active?.[key] || []);
    if (values.has(result.dataset.value)) values.delete(result.dataset.value);
    else values.add(result.dataset.value);
    STATE.active[key] = [...values];
    result.classList.toggle("selected", values.has(result.dataset.value));
    result.setAttribute("aria-pressed", String(values.has(result.dataset.value)));
    updateReviewConfirmState();
  };
}

function reviewReasonCodes(row) {
  return new Set((row?.review_reasons || []).map((reason) => String(reason.code || "")));
}

function updateReviewConfirmState() {
  const button = $("dialog-confirm");
  if (!button || STATE.active?.mode !== "review_binding") return;
  button.disabled = !STATE.active.candidate_id || (STATE.active.role_required && !(STATE.active.role_ids || []).length);
}

async function runReviewAction(action, input, pendingLabel) {
  const button = $("dialog-confirm");
  if (button) { button.disabled = true; button.textContent = pendingLabel; }
  try {
    await command(action, input);
    closeDialog();
    await Promise.all([loadCounts(), loadRows()]);
  } catch (error) {
    if (button && !$("modal").hidden) { button.disabled = false; button.textContent = button.dataset.label || "Try again"; }
    toast(error.message, true);
  }
}

function updateConfirmState() {
  const confirm = $("dialog-confirm"); if (!confirm || !STATE.active) return;
  if (STATE.active.mode === "review_binding") return updateReviewConfirmState();
  confirm.disabled = (STATE.active.mode === "add" && !(STATE.active.candidate_id && STATE.active.role_id)) ||
    (STATE.active.mode === "duplicate" && !STATE.active.role_id);
}

function openAddCandidate() {
  STATE.active = { mode: "add", candidate_id: null, role_id: null };
  openDialog({ title: "Add Candidate", subtitle: "Choose an existing Paraform candidate and one active role.", body: `<label class="field"><span class="field-label">Candidate name</span><input id="candidate-query" autocomplete="off" placeholder="Start typing a name" /></label><div class="choice-list" id="candidate-results"></div><label class="field"><span class="field-label">Company or role</span><input id="role-query" autocomplete="off" placeholder="Start typing a company or title" /></label><div class="choice-list" id="role-results"></div>`, footer: '<button class="button secondary" id="dialog-cancel" type="button">Cancel</button><button class="button primary" id="dialog-confirm" type="button" disabled>Add Candidate</button>' });
  const cq = $("candidate-query"), rq = $("role-query"), cr = $("candidate-results"), rr = $("role-results");
  cq.oninput = () => { clearTimeout(cq.timer); cq.timer = setTimeout(() => searchIndex("candidates", cq.value, cr), 250); };
  rq.oninput = () => { clearTimeout(rq.timer); rq.timer = setTimeout(() => searchIndex("roles", rq.value, rr), 250); };
  bindSearchSelection(cr, "candidate_id"); bindSearchSelection(rr, "role_id");
  $("dialog-cancel").onclick = closeDialog; $("dialog-confirm").onclick = confirmAdd;
}

async function confirmAdd() {
  const button = $("dialog-confirm"), active = STATE.active;
  if (!button || !dialogStillActive(active) || button.disabled) return;
  button.disabled = true; button.textContent = "Preparing…";
  try {
    const result = await command("add_candidate", { candidate_id: active.candidate_id, role_id: active.role_id });
    const candidateLabel = active.candidate_id_label || "";
    if (dialogStillActive(active)) {
      closeDialog();
      if (result.existing && PAGE_LABELS[result.state]) {
        STATE.page = result.state; STATE.query = candidateLabel; STATE.rows = []; STATE.nextCursor = null; $("candidate-search").value = candidateLabel;
        document.querySelectorAll(".page-tab").forEach((node) => { const pageActive = node.dataset.page === STATE.page; node.classList.toggle("active", pageActive); node.setAttribute("aria-selected", String(pageActive)); });
        toast(`Already in ${PAGE_LABELS[result.state]}; showing it now.`);
      } else toast("Preparing resume — the candidate will appear when ready.");
    }
    await Promise.all([loadCounts(), loadRows({ refresh: true })]);
  } catch (error) { if (dialogStillActive(active)) { button.disabled = false; button.textContent = "Add Candidate"; } toast(error.message, true); }
}

function openDuplicate(id) {
  const row = rowFor(id); if (!row) return;
  STATE.active = { mode: "duplicate", case_id: id, candidate_id: row.candidate_id, candidate_id_label: row.candidate_name, role_id: null, expected_version: row.state_version };
  openDialog({ title: "Duplicate Candidate", subtitle: `${row.candidate_name} · choose only the new role.`, body: `<div class="selection-summary"><strong>${esc(row.candidate_name)}</strong><br><span>${esc(row.company)} · ${esc(row.role_title)}</span></div><label class="field"><span class="field-label">New company or role</span><input id="role-query" autocomplete="off" placeholder="Search active Paraform roles" /></label><div class="choice-list" id="role-results"></div>`, footer: '<button class="button secondary" id="dialog-cancel" type="button">Cancel</button><button class="button primary" id="dialog-confirm" type="button" disabled>Duplicate</button>' });
  const query = $("role-query"), results = $("role-results"); query.oninput = () => { clearTimeout(query.timer); query.timer = setTimeout(() => searchIndex("roles", query.value, results), 250); };
  bindSearchSelection(results, "role_id"); $("dialog-cancel").onclick = closeDialog;
  $("dialog-confirm").onclick = async () => {
    const button = $("dialog-confirm"), active = STATE.active;
    if (!button || !dialogStillActive(active) || button.disabled) return;
    button.disabled = true; button.textContent = "Preparing…";
    try {
      const candidateLabel = active.candidate_id_label || "";
      const result = await command("duplicate", active);
      if (dialogStillActive(active)) {
        closeDialog();
        if (result.existing && PAGE_LABELS[result.state]) {
          STATE.page = result.state; STATE.query = candidateLabel; STATE.rows = []; STATE.nextCursor = null; $("candidate-search").value = candidateLabel;
          document.querySelectorAll(".page-tab").forEach((node) => { const pageActive = node.dataset.page === STATE.page; node.classList.toggle("active", pageActive); node.setAttribute("aria-selected", String(pageActive)); });
          toast(`Already in ${PAGE_LABELS[result.state]}; showing it now.`);
        } else toast("Preparing the role-specific resume.");
      }
      await Promise.all([loadCounts(), loadRows({ refresh: true })]);
    } catch (error) {
      if (dialogStillActive(active)) { button.disabled = false; button.textContent = "Duplicate"; }
      toast(error.message, true);
    }
  };
}

function openCorrect(id) {
  const row = rowFor(id); if (!row) return;
  STATE.active = { case_id: id, expected_version: row.state_version };
  const options = STATE.page === "interested" ? '<option value="needs_review">Needs Review</option><option value="not_interested">Not Interested</option>' : '<option value="interested">Interested</option><option value="needs_review">Needs Review</option>';
  openDialog({ title: "Correct classification", subtitle: `${row.candidate_name} · ${row.company} · ${row.role_title}`, body: `<label class="field"><span class="field-label">Move to</span><select id="correction-destination">${options}</select></label><label class="field"><span class="field-label">Short correction note</span><textarea id="correction-note" maxlength="500" placeholder="Why is this being corrected?"></textarea></label>`, footer: '<button class="button secondary" id="dialog-cancel" type="button">Cancel</button><button class="button primary" id="dialog-confirm" type="button">Save correction</button>' });
  $("dialog-cancel").onclick = closeDialog; $("dialog-confirm").onclick = async () => {
    const button = $("dialog-confirm"), active = STATE.active;
    const note = $("correction-note").value.trim(); if (!note) return toast("Add a short correction note.", true);
    if (!button || !dialogStillActive(active) || button.disabled) return;
    button.disabled = true; button.textContent = "Saving…";
    try {
      await command("correct", { ...active, destination: $("correction-destination").value, note });
      if (dialogStillActive(active)) closeDialog();
      await Promise.all([loadCounts(), loadRows({ refresh: true })]);
    } catch (error) {
      if (dialogStillActive(active)) { button.disabled = false; button.textContent = "Save correction"; }
      toast(error.message, true);
    }
  };
}

function openReview(id) {
  const row = rowFor(id); if (!row) return;
  const codes = reviewReasonCodes(row);
  STATE.active = { case_id: row.case_id || null, signal_id: row.signal_id || null, expected_version: row.state_version || 0 };
  const reasons = (row.review_reasons || []).map((reason) => `<li><strong>${esc(reason.label || reason.code)}</strong>${reason.detail ? ` — ${esc(reason.detail)}` : ""}</li>`).join("");
  const header = `<div class="coverage"><h3>Open reasons</h3><ul>${reasons || "<li>Review details unavailable.</li>"}</ul></div>`;
  const subtitle = `${row.candidate_name || row.provisional_name || "Unknown candidate"} · ${row.company || "Role not identified"}`;

  if (!row.case_id && (codes.has("candidate_not_found") || codes.has("candidate_ambiguous") || codes.has("role_unclear"))) {
    const needsCandidate = !row.candidate_id || codes.has("candidate_not_found") || codes.has("candidate_ambiguous");
    const needsRole = codes.has("role_unclear") || !row.role_id;
    STATE.active = { ...STATE.active, mode: "review_binding", candidate_id: needsCandidate ? null : row.candidate_id, role_ids: [], role_required: needsRole };
    const candidateLink = codes.has("candidate_not_found")
      ? '<p class="field-help"><a class="inline-link" href="https://www.paraform.com/candidates" target="_blank" rel="noopener noreferrer">Add the candidate in Paraform first</a>, then search again here.</p>'
      : "";
    const candidatePicker = needsCandidate
      ? `${candidateLink}<label class="field"><span class="field-label">Paraform candidate</span><input id="candidate-query" autocomplete="off" placeholder="Search candidate name" /></label><div class="choice-list" id="candidate-results"></div>`
      : `<div class="selection-summary"><strong>${esc(row.candidate_name)}</strong><br><span>Matched Paraform candidate</span></div>`;
    const offeredRoles = Array.isArray(row.offered_roles) ? row.offered_roles : [];
    const offeredChoices = offeredRoles.map((offered) => `<button class="search-result" type="button" data-value="${esc(offered.role_id)}" aria-pressed="false"><strong>${esc([offered.company, offered.title].filter(Boolean).join(" · ") || offered.role_id)}</strong><small>Offered in the original message</small></button>`).join("");
    const rolePicker = needsRole
      ? offeredChoices
        ? `<div class="field"><span class="field-label">Exact offered role or roles</span><div class="choice-list" id="role-results">${offeredChoices}</div><p class="field-help">Select only roles offered in the original sent message.</p></div>`
        : `<label class="field"><span class="field-label">Confirmed active Paraform role</span><input id="review-role-query" autocomplete="off" placeholder="Search company or role" /></label><div class="choice-list" id="role-results"></div><p class="field-help">Use the source email and choose the exact role you confirmed.</p>`
      : "";
    openDialog({ title: "Match the signal", subtitle, body: `${header}${candidatePicker}${rolePicker}<label class="field"><span class="field-label">Resolution note</span><textarea id="review-note" maxlength="500" placeholder="What did you confirm?"></textarea></label>`, footer: '<button class="button secondary" id="dialog-cancel" type="button">Cancel</button><button class="button primary" id="dialog-confirm" data-label="Continue" type="button" disabled>Continue</button>' });
    if (needsCandidate) {
      const query = $("candidate-query"), results = $("candidate-results");
      query.oninput = () => { clearTimeout(query.timer); query.timer = setTimeout(() => searchIndex("candidates", query.value, results), 250); };
      bindSearchSelection(results, "candidate_id");
    }
    if (needsRole) {
      bindMultiSearchSelection($("role-results"), "role_ids");
      const roleQuery = $("review-role-query");
      if (roleQuery) roleQuery.oninput = () => { clearTimeout(roleQuery.timer); roleQuery.timer = setTimeout(() => searchIndex("roles", roleQuery.value, $("role-results")), 250); };
    }
    updateReviewConfirmState();
    $("dialog-cancel").onclick = closeDialog;
    $("dialog-confirm").onclick = () => {
      const note = $("review-note").value.trim(); if (!note) return toast("Add a short resolution note.", true);
      return runReviewAction("resolve_review", { ...STATE.active, note }, "Checking…");
    };
    return;
  }

  if (codes.has("candidate_original_resume_missing")) {
    const candidateUrl = safeUrl(row.candidate_url, URL_HOSTS.candidate);
    openDialog({ title: "Add the original resume", subtitle, body: `${header}<p>Add the candidate-original resume in Paraform, then recheck this item.</p>${candidateUrl ? `<a class="button secondary inline-action" href="${esc(candidateUrl)}" target="_blank" rel="noopener noreferrer">Open candidate in Paraform</a>` : ""}`, footer: '<button class="button secondary" id="dialog-cancel" type="button">Cancel</button><button class="button primary" id="dialog-confirm" data-label="Recheck" type="button">Recheck</button>' });
    $("dialog-cancel").onclick = closeDialog;
    $("dialog-confirm").onclick = () => runReviewAction("recheck", STATE.active, "Rechecking…");
    return;
  }

  if (codes.has("classification_failed")) {
    openDialog({ title: "Retry classification", subtitle, body: `${header}<p>The approved classifier paths failed safely, so no interest decision was guessed.</p>`, footer: '<button class="button secondary" id="dialog-cancel" type="button">Cancel</button><button class="button primary" id="dialog-confirm" data-label="Retry classification" type="button">Retry classification</button>' });
    $("dialog-cancel").onclick = closeDialog;
    $("dialog-confirm").onclick = () => runReviewAction("retry_classification", { signal_id: row.signal_id }, "Retrying…");
    return;
  }

  if (codes.has("resume_preparation_failed")) {
    openDialog({ title: "Retry resume preparation", subtitle, body: `${header}<p>Resume preparation exhausted its safe retries and can be started again.</p>`, footer: '<button class="button secondary" id="dialog-cancel" type="button">Cancel</button><button class="button primary" id="dialog-confirm" data-label="Retry preparation" type="button">Retry preparation</button>' });
    $("dialog-cancel").onclick = closeDialog;
    $("dialog-confirm").onclick = () => runReviewAction("retry_preparation", STATE.active, "Retrying…");
    return;
  }

  if (codes.has("role_unavailable")) {
    const roleUrl = safeUrl(row.role_url, URL_HOSTS.submit);
    openDialog({ title: "Role is unavailable", subtitle, body: `${header}<p>Positive intent is preserved, but this role cannot be prepared until its Paraform state is resolved.</p>${roleUrl ? `<a class="button secondary inline-action" href="${esc(roleUrl)}" target="_blank" rel="noopener noreferrer">Inspect role in Paraform</a>` : ""}`, footer: '<button class="button secondary" id="dialog-cancel" type="button">Cancel</button><button class="button primary" id="dialog-confirm" data-label="Duplicate to another role" type="button">Duplicate to another role</button>' });
    $("dialog-cancel").onclick = closeDialog;
    $("dialog-confirm").onclick = () => { closeDialog(); openDuplicate(row.case_id); };
    return;
  }

  const signalUrl = safeUrl(row.signal_url, URL_HOSTS.signal);
  openDialog({ title: "Review the candidate signal", subtitle, body: `${header}${signalUrl ? `<a class="button secondary inline-action" href="${esc(signalUrl)}" target="_blank" rel="noopener noreferrer">Open Signal</a>` : '<p class="field-help">The original Signal link is unavailable.</p>'}<label class="field"><span class="field-label">Decision</span><select id="review-decision"><option value="interested">Interested</option><option value="not_interested">Not Interested</option><option value="needs_review">Keep in Needs Review</option></select></label><label class="field"><span class="field-label">Resolution note</span><textarea id="review-note" maxlength="500"></textarea></label>`, footer: '<button class="button secondary" id="dialog-cancel" type="button">Cancel</button><button class="button primary" id="dialog-confirm" data-label="Resolve" type="button">Resolve</button>' });
  $("dialog-cancel").onclick = closeDialog;
  $("dialog-confirm").onclick = () => {
    const note = $("review-note").value.trim(); if (!note) return toast("Add a short resolution note.", true);
    return runReviewAction("resolve_review", { ...STATE.active, destination: $("review-decision").value, note }, "Saving…");
  };
}

async function regenerateResume(id) {
  const row = rowFor(id); if (!row) return;
  const key = String(id);
  if (STATE.generating.has(key) || isGenerationActive(row)) return;
  STATE.pendingDownloads.set(key, String(row.current_artifact_id || ""));
  persistPendingDownloads();
  STATE.generating.add(key);
  renderRows();
  toast("Regeneration started; the finished resume will save to Downloads automatically.");
  try {
    await command("regenerate", { case_id: id, expected_version: row.state_version });
    await loadRows();
  } catch (error) {
    if (error.code === "resume_regeneration_in_progress") {
      STATE.generating.add(key);
      renderRows();
      toast("Resume generation is already running; the finished resume will save to Downloads automatically.");
      return;
    }
    STATE.pendingDownloads.delete(key);
    persistPendingDownloads();
    STATE.generating.delete(key);
    renderRows();
    toast(error.message, true);
  }
}

async function autoDownloadResume(row) {
  const id = String(row?.case_id || "");
  if (!id || STATE.downloadsInFlight.has(id)) return;
  STATE.downloadsInFlight.add(id);
  try {
    const data = await request(`/api/submissions-v2/pairs/${encodeURIComponent(id)}/resume/download-ticket`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ expected_version: row.state_version }) });
    const downloadUrl = safeUrl(data.url, URL_HOSTS.storage);
    if (!downloadUrl) throw new Error("Resume download link was invalid.");
    const response = await fetch(downloadUrl, { credentials: "same-origin", cache: "no-store" });
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok || !contentType.startsWith("application/pdf")) throw new Error("The resume file could not be downloaded.");
    const bytes = await response.arrayBuffer();
    if (String.fromCharCode(...new Uint8Array(bytes).slice(0, 5)) !== "%PDF-") throw new Error("The resume file was not a valid PDF.");
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = data.filename || suggestedResumeFilename(row);
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    setTimeout(() => { anchor.remove(); URL.revokeObjectURL(objectUrl); }, 1_000);
    toast(`Saved ${anchor.download} to Downloads.`);
  } catch (error) {
    toast(`${error.message || "The resume could not be saved automatically"} Click Download Resume to save it manually.`, true);
  } finally {
    STATE.downloadsInFlight.delete(id);
  }
}

async function downloadResume(id) {
  const row = rowFor(id); if (!row) return;
  if (!rowCapability(row, "can_download", Boolean(row.current_artifact_id))) return toast("The resume is still being prepared.", true);
  return withRowAction(id, "download", async () => {
    const pickerHost = filePickerWindow();
    if (typeof pickerHost.showSaveFilePicker === "function") {
      try {
      const handle = await pickerHost.showSaveFilePicker({
        suggestedName: suggestedResumeFilename(row),
        startIn: "downloads",
        types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
      });
      const data = await request(`/api/submissions-v2/pairs/${encodeURIComponent(id)}/resume/download-ticket`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ expected_version: row.state_version }) });
      const downloadUrl = safeUrl(data.url, URL_HOSTS.storage);
      if (!downloadUrl) throw new Error("Resume download link was invalid.");
      const response = await fetch(downloadUrl, { credentials: "same-origin", cache: "no-store" });
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!response.ok || !contentType.startsWith("application/pdf")) throw new Error("The resume file could not be downloaded.");
      const bytes = await response.arrayBuffer();
      if (String.fromCharCode(...new Uint8Array(bytes).slice(0, 5)) !== "%PDF-") throw new Error("The resume file was not a valid PDF.");
      const writable = await handle.createWritable();
      try { await writable.write(bytes); await writable.close(); }
      catch (error) { await writable.abort().catch(() => {}); throw error; }
      toast(`Saved ${handle.name || data.filename || "resume.pdf"}.`);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
        toast(error.message || "The resume could not be saved.", true);
        return;
      }
    }
    const viewer = window.open("about:blank", "_blank");
    if (viewer) viewer.opener = null;
    try {
      const data = await request(`/api/submissions-v2/pairs/${encodeURIComponent(id)}/resume/download-ticket`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ expected_version: row.state_version }) });
      const downloadUrl = safeUrl(data.url, URL_HOSTS.storage);
      if (!downloadUrl) throw new Error("Resume download link was invalid.");
      if (viewer) viewer.location.replace(downloadUrl); else window.location.assign(downloadUrl);
      toast("The resume opened securely; use the PDF viewer's download button to save it.");
    } catch (error) { if (viewer) viewer.close(); toast(error.message, true); }
  });
}

async function openSubmit(id) {
  const row = rowFor(id); if (!row) return;
  if (!rowCapability(row, "can_submit", Boolean(row.current_artifact_id))) return toast("The resume is still being prepared.", true);
  const popup = window.open("about:blank", "_blank");
  if (!popup) return toast("Allow popups to open the Paraform role.", true);
  popup.opener = null;
  return withRowAction(id, "submit", async () => {
    try {
      const data = await request(`/api/submissions-v2/pairs/${encodeURIComponent(id)}/submit-open`, { method: "POST", body: JSON.stringify({ expected_version: row.state_version }) });
      const url = safeUrl(data.redirect_url, URL_HOSTS.submit);
      if (!navigateSubmitPopup(popup, url)) throw new Error("Paraform role link was invalid.");
      await loadRows({ refresh: true });
    } catch (error) { popup.close(); toast(error.message, true); }
  });
}

async function command(action, input = {}) {
  try {
    return await request("/api/submissions-v2/command", { method: "POST", body: JSON.stringify({ action, ...input }) });
  } catch (error) {
    if (error.status === 409) {
      await Promise.allSettled([loadCounts(), loadRows({ refresh: true })]);
      if (error.code !== "resume_regeneration_in_progress") {
        error.message = "This item changed, so the latest version was refreshed; please try again.";
        error.code = "state_conflict_refreshed";
      }
    }
    throw error;
  }
}

function showSignin(message = "") {
  $("signin").hidden = false; $("shell").inert = true; $("shell").setAttribute("aria-hidden", "true");
  if (message) $("signin-error").textContent = message;
  if (STATE.signinStarted) return;
  STATE.signinStarted = true;
  const render = () => {
    const clientId = STATE.authConfig?.googleClientId;
    if (!clientId) { $("signin-error").textContent = "Google sign-in is not configured, so Submissions is unavailable."; return; }
    if (!window.google?.accounts?.id) return setTimeout(render, 250);
    google.accounts.id.initialize({ client_id: clientId, callback: async ({ credential }) => { try { await RaydarAuth.signIn(credential); location.reload(); } catch (error) { $("signin-error").textContent = error.message; } } });
    google.accounts.id.renderButton($("gsi-button"), { theme: "outline", size: "large", shape: "pill" });
  };
  render();
}

function reportHeight() {
  if (window.parent !== window) window.parent.postMessage({ type: "raydar-submissions-v2-height", height: Math.max(document.body.scrollHeight, 620) }, location.origin);
}

async function boot() {
  try {
    STATE.authConfig = await publicJson("/api/auth/config");
    if (!STATE.authConfig.googleClientId || !STATE.authConfig.durableSessionEnabled) return showSignin("Google sign-in is not fully configured, so Submissions is unavailable.");
    STATE.session = await request("/api/submissions-v2/session"); STATE.csrf = STATE.session.csrf_token || "";
    if (!STATE.session.authenticated) return showSignin();
    await Promise.all([loadCounts(), loadRows()]);
    STATE.pollTimer = setInterval(() => { loadCounts().catch(() => {}); loadRows({ refresh: true }).catch(() => {}); }, 30_000);
  } catch (error) {
    if ([401, 403].includes(error.status)) showSignin(); else { $("rows").innerHTML = `<div class="empty-state"><strong>Submissions V2 is not available</strong>${esc(error.message)}</div>`; renderHealth({ delayed: true }); }
  }
}

document.querySelectorAll(".page-tab").forEach((node) => { node.onclick = () => switchPage(node.dataset.page); });
$("candidate-search").oninput = (event) => { clearTimeout(STATE.searchTimer); STATE.searchTimer = setTimeout(() => { STATE.query = event.target.value.trim(); STATE.nextCursor = null; STATE.totalCount = null; loadRows(); }, 220); };
$("load-more").onclick = () => loadRows({ append: true }); $("add-candidate").onclick = openAddCandidate;
$("dialog-close").onclick = closeDialog; $("modal").onclick = (event) => { if (event.target === $("modal")) closeDialog(); };
document.addEventListener("click", (event) => { if (!event.target.closest(".popover,.review-reasons,.caution")) closePopover(); });
document.addEventListener("keydown", (event) => {
  trapDialogFocus(event);
  if (event.key === "Escape") { closePopover(); if (!$("modal").hidden) closeDialog(); }
});
window.addEventListener("pagehide", () => {
  STATE.listRequest?.abort(); STATE.countsRequest?.abort();
  for (const controller of STATE.searchRequests.values()) controller.abort();
  clearInterval(STATE.pollTimer);
});
new ResizeObserver(reportHeight).observe(document.body);
boot();
