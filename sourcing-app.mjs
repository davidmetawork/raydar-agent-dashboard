import { FEEDBACK_REASONS, applyFeedback, proposeNextRun, summarizeFeedback } from "/sourcing-domain.mjs";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const STATE = {
  config: null,
  token: null,
  key: sessionStorage.getItem("raydar.sourcing.key") || null,
  roles: [],
  options: { projects: [], sequences: [] },
  workspace: null,
  roleState: null,
  runs: [],
  currentRun: null,
  demo: [],
  selectedEnroll: new Set(),
};

if (new URLSearchParams(location.search).has("embed")) document.body.classList.add("embed");

function authHeaders(json = false) {
  const headers = {};
  if (STATE.token) headers.Authorization = `Bearer ${STATE.token}`;
  if (STATE.key) headers["x-app-key"] = STATE.key;
  if (json) headers["content-type"] = "application/json";
  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...authHeaders(Boolean(options.body)), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const error = new Error(data.detail || String(data.error || `HTTP ${response.status}`).replaceAll("_", " "));
    error.code = data.error;
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function status(kind, label) {
  const element = $("status");
  element.className = `pill ${kind}`;
  element.innerHTML = `<span class="dot"></span>${esc(label)}`;
}

function blocker(title, body, icon = "🔒") {
  $("blocker").innerHTML = `<div>${icon}</div><div><strong>${esc(title)}</strong><span>${esc(body)}</span></div>`;
}

function tags(values, negative = false) {
  return (values || []).map((value) => `<span class="chip${negative ? " neg" : ""}">${esc(value)}</span>`).join("");
}

function bullets(values, empty) {
  return values?.length ? `<ul>${values.map((value) => `<li>${esc(value)}</li>`).join("")}</ul>` : `<div class="empty">${esc(empty)}</div>`;
}

function renderReasons() {
  const reasons = STATE.config?.feedbackReasons || FEEDBACK_REASONS;
  $("reasons").innerHTML = reasons.map((reason) => `<span class="reason">${esc(reason.label)}</span>`).join("");
}

function renderGate() {
  const modes = STATE.config?.authModes || [];
  $("gate").style.display = "flex";
  $("keyGate").style.display = modes.includes("access-key") ? "flex" : "none";
  $("gateOr").style.display = modes.includes("access-key") && modes.includes("google") ? "block" : "none";
  if (modes.includes("google") && STATE.config.googleClientId) {
    (function startGoogle() {
      if (!(window.google?.accounts?.id)) return setTimeout(startGoogle, 150);
      google.accounts.id.initialize({ client_id: STATE.config.googleClientId, callback: onCredential });
      google.accounts.id.renderButton($("gsi"), { theme: "filled_black", size: "large", text: "signin_with", shape: "pill" });
    })();
  }
}

function describeCapabilities() {
  const config = STATE.config;
  if (!config.roleReadApproved) {
    status("locked", "role access awaiting approval");
    blocker("Role access is gated", "The sanctioned role-data flag is not configured. No Paraform call will run.");
    return;
  }
  if (!config.searchApproved) {
    status("ready", "briefing mode ready");
    blocker("Role briefing is live; Search is gated", "You can digest jobs and test the feedback lab now. Project and Sequence catalogs stay unread until their Paraform capability approvals are enabled.", "✓");
    return;
  }
  if (!config.projectWritesApproved) {
    status("ready", "Search evaluation mode");
    blocker("Search is live; Project filing is gated", "Runs can be evaluated in Raydar, but candidates will not be written to Paraform Projects.", "◌");
    return;
  }
  if (!config.sequenceWritesApproved) {
    status("ready", "sourcing + review ready");
    blocker("Sourcing and Project review are live", "Sequence enrollment remains separately gated and requires explicit confirmation.", "✓");
    return;
  }
  status("ready", "end-to-end ready");
  blocker("All controlled capabilities are ready", "Search, review-project filing, feedback reruns and confirmation-gated enrollment are enabled.", "✓");
}

async function authenticatedStart() {
  $("gateErr").textContent = "";
  try {
    await Promise.all([loadRoles(), loadOptions()]);
    $("gate").style.display = "none";
    describeCapabilities();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      STATE.key = null;
      STATE.token = null;
      sessionStorage.removeItem("raydar.sourcing.key");
      $("gateErr").textContent = "That credential was not accepted.";
      renderGate();
      return;
    }
    $("gateErr").textContent = error.message;
    renderGate();
  }
}

async function submitKey() {
  const key = $("accessKey").value.trim();
  if (!key) return;
  STATE.key = key;
  sessionStorage.setItem("raydar.sourcing.key", key);
  await authenticatedStart();
}

function onCredential(response) {
  try {
    const payload = JSON.parse(atob(response.credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const domain = (payload.hd || (payload.email || "").split("@")[1] || "").toLowerCase();
    if (!(STATE.config.allowedDomains || []).includes(domain)) throw new Error("Use an approved Raydar account.");
    STATE.token = response.credential;
    authenticatedStart();
  } catch (error) {
    $("gateErr").textContent = error.message || "Sign-in failed";
  }
}

async function loadRoles() {
  const select = $("role");
  select.disabled = true;
  select.innerHTML = '<option value="">Loading approved roles…</option>';
  const data = await api("/api/sourcing/roles");
  STATE.roles = data.roles || [];
  select.innerHTML = '<option value="">Choose a role…</option>' + STATE.roles.map((role) => `<option value="${esc(role.id)}">${esc(`${role.company ? `${role.company} · ` : ""}${role.title}`)}</option>`).join("");
  select.disabled = false;
  $("refresh").disabled = false;
  const wanted = new URLSearchParams(location.search).get("roleId");
  if (wanted && STATE.roles.some((role) => role.id === wanted)) {
    select.value = wanted;
    await loadRole(wanted);
  }
}

async function loadOptions() {
  const data = await api("/api/sourcing/options");
  STATE.options = { projects: data.projects || [], sequences: data.sequences || [] };
  renderMapping();
}

function renderRubric(rubric) {
  const positives = [...(rubric.searchSignals?.titles || []), ...(rubric.searchSignals?.skills || []), ...(rubric.searchSignals?.companies || []), ...(rubric.searchSignals?.locations || [])];
  if (rubric.searchSignals?.experience) positives.push(rubric.searchSignals.experience);
  const exclusions = [...(rubric.exclusions?.titles || []), ...(rubric.exclusions?.skills || []), ...(rubric.exclusions?.companies || []), ...(rubric.exclusions?.criteria || [])];
  $("rubric").innerHTML = `<div class="panel"><h3>Must-haves</h3>${bullets(rubric.mustHaves, "No structured must-haves returned.")}</div>` +
    `<div class="panel"><h3>Positive signals</h3><div class="chips">${tags(positives) || '<span class="empty">No structured positive filters returned.</span>'}</div>${bullets(rubric.preferences, "No separate preferences returned.")}</div>` +
    `<div class="panel"><h3>Exclusions</h3><div class="chips">${tags(exclusions, true) || '<span class="empty">No explicit exclusions returned.</span>'}</div></div>`;
  const role = rubric.role || {};
  $("roleMeta").innerHTML = [role.company, role.location, role.workplace, role.employment].filter(Boolean).map((value) => `<span class="tag">${esc(value)}</span>`).join("");
  $("roleSummary").textContent = role.summary || "";
}

function renderLanes(ideas) {
  if (!ideas.length) {
    $("lanes").innerHTML = '<div class="lane"><div class="empty">The agent will use three rubric-derived Search angles.</div></div>';
    return;
  }
  $("lanes").innerHTML = ideas.slice(0, 3).map((idea, index) => {
    const filters = idea.filters || {};
    const positive = [...(filters.targetTitles || []), ...(filters.skills || []), ...(filters.idealCompanies || []), ...(filters.locations || [])];
    if (filters.experience) positive.push(filters.experience);
    const negative = [...(filters.excludedTitles || []), ...(filters.excludedSkills || []), ...(filters.avoidCompanies || [])];
    return `<div class="lane"><div class="num">Lane ${index + 1}</div><h3>${esc(idea.name)}</h3><p>${esc(idea.rationale || idea.query || "Paraform role-derived search")}</p><div class="chips">${tags(positive)}${tags(negative, true)}</div></div>`;
  }).join("");
}

function renderMapping() {
  const roleId = $("role").value;
  const project = $("project");
  const sequence = $("sequence");
  project.innerHTML = '<option value="">Choose a review project…</option>' + STATE.options.projects.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  sequence.innerHTML = '<option value="">No sequence mapped yet</option>' + STATE.options.sequences.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}${item.enabled ? "" : " · disabled"}</option>`).join("");
  const mapping = STATE.roleState?.mapping;
  if (mapping) {
    project.value = mapping.reviewProjectId || "";
    sequence.value = mapping.sequenceId || "";
    $("candidateCap").value = mapping.candidateCap || 100;
  } else {
    project.value = "";
    sequence.value = "";
    $("candidateCap").value = 100;
  }
  project.disabled = !roleId;
  sequence.disabled = !roleId;
  $("candidateCap").disabled = !roleId;
  $("saveMapping").disabled = !roleId;
  updateRunControls();
}

function updateRunControls() {
  const mapping = STATE.roleState?.mapping;
  const ready = Boolean(mapping && STATE.config?.searchApproved);
  $("runSearch").disabled = !ready;
  if (!mapping) $("runNote").textContent = "Choose a review project and save the job mapping first.";
  else if (!STATE.config?.searchApproved) $("runNote").textContent = "Mapping saved. Native Search is waiting on the Paraform automation approval flag.";
  else if (!STATE.config?.projectWritesApproved) $("runNote").textContent = "Search is ready in evaluation mode; Project writes remain disabled.";
  else $("runNote").textContent = `Ready: up to ${mapping.candidateCap} candidates → ${mapping.reviewProjectName}.`;
}

async function loadRole(roleId) {
  if (!roleId) return;
  STATE.currentRun = null;
  STATE.demo = [];
  STATE.selectedEnroll.clear();
  $("rubric").innerHTML = '<div class="panel"><div class="skeleton"></div><div class="skeleton"></div></div>'.repeat(3);
  $("lanes").innerHTML = '<div class="lane"><div class="skeleton"></div><div class="skeleton"></div></div>'.repeat(3);
  try {
    const [workspace, mapping, recent] = await Promise.all([
      api(`/api/sourcing/role?roleId=${encodeURIComponent(roleId)}`),
      api(`/api/sourcing/mapping?roleId=${encodeURIComponent(roleId)}`),
      api(`/api/sourcing/runs?roleId=${encodeURIComponent(roleId)}`),
    ]);
    STATE.workspace = workspace;
    STATE.roleState = mapping.state;
    STATE.runs = recent.runs || [];
    renderRubric(workspace.rubric);
    renderLanes(workspace.searchIdeas || []);
    renderMapping();
    renderRunHistory();
    history.replaceState(null, "", `/sourcing?roleId=${encodeURIComponent(roleId)}`);
    if (STATE.runs[0]) await loadRun(STATE.runs[0].id);
    else renderReview();
  } catch (error) {
    $("rubric").innerHTML = `<div class="panel"><div class="empty">${esc(error.message)}</div></div>`;
    $("lanes").innerHTML = '<div class="lane"><div class="empty">Search ideas unavailable.</div></div>';
  }
}

async function saveMapping() {
  const roleId = $("role").value;
  if (!roleId || !$("project").value) return blocker("Mapping incomplete", "Choose the review project before saving.", "!");
  const button = $("saveMapping");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const data = await api("/api/sourcing/mapping", {
      method: "POST",
      body: JSON.stringify({
        roleId,
        reviewProjectId: $("project").value,
        sequenceId: $("sequence").value || null,
        candidateCap: Number($("candidateCap").value),
      }),
    });
    STATE.roleState = data.state;
    renderMapping();
    blocker("Job mapping saved", `${data.state.mapping.reviewProjectName}${data.state.mapping.sequenceName ? ` → ${data.state.mapping.sequenceName}` : " · sequence not mapped yet"}.`, "✓");
  } catch (error) {
    blocker("Mapping could not be saved", error.message, "!");
  } finally {
    button.textContent = "Save mapping";
    button.disabled = false;
  }
}

function renderRunHistory() {
  if (!STATE.runs.length) {
    $("runHistory").innerHTML = "";
    return;
  }
  $("runHistory").innerHTML = `<span class="note">Recent:</span><select id="runPicker">${STATE.runs.map((run) => `<option value="${esc(run.id)}"${STATE.currentRun?.id === run.id ? " selected" : ""}>${esc(`${new Date(run.createdAt).toLocaleString()} · ${run.state} · ${run.counts?.review || 0} review`)}</option>`).join("")}</select>`;
  $("runPicker").addEventListener("change", (event) => loadRun(event.target.value));
}

async function loadRun(runId) {
  const data = await api(`/api/sourcing/run?runId=${encodeURIComponent(runId)}`);
  STATE.currentRun = data.run;
  STATE.demo = [];
  STATE.selectedEnroll = new Set([...STATE.selectedEnroll].filter((id) => data.run.candidates.some((candidate) => candidate.id === id && ["good", "enrollment_queued"].includes(candidate.state))));
  renderRunHistory();
  renderReview();
}

async function runSearch() {
  const button = $("runSearch");
  button.disabled = true;
  button.textContent = "Searching Paraform…";
  $("runNote").textContent = "Running bounded Search lanes, dedup checks and Project filing. Keep this tab open.";
  try {
    const data = await api("/api/sourcing/runs", {
      method: "POST",
      body: JSON.stringify({ roleId: $("role").value, candidateCap: Number($("candidateCap").value) }),
    });
    STATE.currentRun = data.run;
    STATE.selectedEnroll.clear();
    STATE.runs = [{
      id: data.run.id,
      roleId: data.run.roleId,
      state: data.run.state,
      revision: data.run.revision,
      createdAt: data.run.createdAt,
      counts: data.run.counts,
    }, ...STATE.runs.filter((run) => run.id !== data.run.id)].slice(0, 12);
    renderRunHistory();
    renderReview();
    blocker("Native Search run is ready for review", `${data.run.counts.review || 0} candidates need a verdict; ${data.run.counts.deduped || 0} were blocked by dedup.`, "✓");
  } catch (error) {
    blocker("Native Search did not complete", error.message, "!");
  } finally {
    button.textContent = "Run native Search";
    updateRunControls();
  }
}

const DEMO = [
  { id: "demo-01", name: "Candidate A", title: "Operations Manager", company: "Northstar", location: "New York", laneName: "Core match", state: "discovered" },
  { id: "demo-02", name: "Candidate B", title: "Customer Success Lead", company: "Harbor", location: "Remote", laneName: "Adjacent titles", state: "discovered" },
  { id: "demo-03", name: "Candidate C", title: "Software Engineer", company: "Orbit", location: "San Francisco", laneName: "Core match", state: "discovered" },
  { id: "demo-04", name: "Candidate D", title: "Junior Platform Engineer", company: "Atlas", location: "Remote", laneName: "Company-led", state: "discovered" },
  { id: "demo-05", name: "Candidate E", title: "Staff Platform Engineer", company: "Beacon", location: "New York", laneName: "Core match", state: "discovered" },
  { id: "demo-06", name: "Candidate F", title: "Senior Infrastructure Engineer", company: "Summit", location: "Boston", laneName: "Adjacent titles", state: "discovered" },
];

function loadDemo(withLabels = false) {
  STATE.currentRun = null;
  STATE.demo = DEMO.map((candidate) => ({ ...candidate }));
  if (withLabels) {
    const labels = [["bad", "wrong_title"], ["bad", "wrong_title"], ["bad", "too_junior"], ["bad", "too_junior"], ["good", null], ["maybe", null]];
    STATE.demo = STATE.demo.map((candidate, index) => applyFeedback(candidate, { verdict: labels[index][0], reason: labels[index][1] }));
  }
  renderReview();
}

function verdictButton(candidate, verdict, label, real) {
  const active = candidate.feedback?.verdict === verdict || (verdict === "bad" && candidate.pendingBad);
  return `<button class="vbtn ${verdict}${active ? " on" : ""}" data-candidate="${esc(candidate.id)}" data-verdict="${verdict}" data-real="${real ? "1" : "0"}">${label}</button>`;
}

function candidateHref(candidate) {
  if (candidate.candidateUserId) return `https://www.paraform.com/candidates?id=${encodeURIComponent(candidate.candidateUserId)}`;
  if (!candidate.linkedinSlug) return "";
  return candidate.linkedinSlug.startsWith("http") ? candidate.linkedinSlug : `https://www.linkedin.com/in/${candidate.linkedinSlug.replace(/^\/+|\/+$/g, "")}`;
}

function reviewable(candidate) {
  return ["discovered", "in_review", "good", "maybe", "bad", "enrollment_blocked"].includes(candidate.state);
}

function renderReview() {
  const real = Boolean(STATE.currentRun);
  const candidates = real ? STATE.currentRun.candidates || [] : STATE.demo;
  const feedback = candidates.map((candidate) => candidate.feedback || {});
  const summary = summarizeFeedback(feedback);
  $("statUnreviewed").textContent = summary.unreviewed;
  $("statGood").textContent = summary.good;
  $("statMaybe").textContent = summary.maybe;
  $("statBad").textContent = summary.bad;
  $("reviewQueue").hidden = !candidates.length;
  $("feedbackMode").innerHTML = real
    ? `<div><strong>Persisted review queue · run ${esc(STATE.currentRun.id.slice(-8))}</strong><span>${esc(`${STATE.currentRun.counts?.projectFiled || 0} filed to ${STATE.currentRun.mapping.reviewProjectName}; revision ${STATE.currentRun.revision}.`)}</span></div><div class="labbtns"><span class="tag">rubric v${esc(STATE.roleState?.rubricVersions?.find((version) => version.id === STATE.currentRun.rubricVersionId)?.version || "?")}</span></div>`
    : '<div><strong>Feedback lab · synthetic candidates</strong><span>Exercise the review rules locally before the first live run.</span></div><div class="labbtns"><button id="loadDemoInner" class="btn secondary">Load blank batch</button><button id="loadSampleInner" class="btn">Load example labels</button></div>';
  if (!real) {
    $("loadDemoInner")?.addEventListener("click", () => loadDemo(false));
    $("loadSampleInner")?.addEventListener("click", () => loadDemo(true));
  }
  $("reviewRows").innerHTML = candidates.map((candidate) => {
    const blocked = candidate.state === "dedup_blocked";
    const href = candidateHref(candidate);
    const name = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(candidate.name)} ↗</a>` : esc(candidate.name);
    const showReason = candidate.pendingBad || candidate.feedback?.verdict === "bad";
    const options = '<option value="">Choose why…</option>' + FEEDBACK_REASONS.map((reason) => `<option value="${reason.id}"${candidate.feedback?.reason === reason.id ? " selected" : ""}>${esc(reason.label)}</option>`).join("");
    const canEnroll = real && ["good", "enrollment_queued"].includes(candidate.state) && candidate.projectStatus === "filed" && Boolean(STATE.currentRun.mapping.sequenceId);
    const feedbackControls = blocked
      ? `<span class="tag">blocked · ${esc(candidate.dedupReason || "dedup")}</span>`
      : candidate.state === "enrolled"
        ? '<span class="tag">enrolled ✓</span>'
        : reviewable(candidate)
          ? `<div class="verdicts">${verdictButton(candidate, "good", "Good", real)}${verdictButton(candidate, "maybe", "Maybe", real)}${verdictButton(candidate, "bad", "Bad", real)}</div>${showReason ? `<select class="reason-select" data-reason-for="${esc(candidate.id)}" data-real="${real ? "1" : "0"}">${options}</select><input class="feedback-note" data-note-for="${esc(candidate.id)}" data-real="${real ? "1" : "0"}" placeholder="Optional note" value="${esc(candidate.feedback?.note || "")}" />` : ""}`
          : `<span class="tag">${esc(candidate.state)}</span>`;
    const enroll = canEnroll ? `<label class="note"><input class="enroll-check" type="checkbox" data-enroll-id="${esc(candidate.id)}"${STATE.selectedEnroll.has(candidate.id) ? " checked" : ""} /> ${candidate.state === "enrollment_queued" ? "retry sequence readback" : "add to sequence"}</label>` : "";
    const meta = [candidate.title, candidate.company, candidate.location].filter(Boolean).join(" · ");
    return `<tr class="${blocked ? "blocked-row" : ""}"><td><div class="candidate-title">${name}</div><div class="candidate-meta">${esc(meta)}</div><div class="meta"><span class="tag">project: ${esc(candidate.projectStatus || "n/a")}</span>${enroll}</div></td><td>${esc(candidate.laneName || candidate.laneId || "—")}</td><td>${feedbackControls}</td></tr>`;
  }).join("");
  const next = proposeNextRun(feedback);
  const decided = new Set((STATE.currentRun?.proposalDecisions || []).flatMap((decision) => decision.acceptedReasons || []));
  if (next.proposals.length) {
    $("proposals").innerHTML = next.proposals.map((proposal) => `<div class="proposal"><label>${real ? `<input type="checkbox" data-proposal="${esc(proposal.reason)}"${decided.has(proposal.reason) ? " disabled" : ""} />` : ""}<span><b>${proposal.evidence}× ${esc(FEEDBACK_REASONS.find((reason) => reason.id === proposal.reason)?.label || proposal.reason)}</b> · ${esc(proposal.action)} <span class="tag">${esc(proposal.scope)}</span>${decided.has(proposal.reason) ? ' <span class="tag">approved</span>' : ""}</span></label></div>`).join("") + (real ? '<div class="mini-actions"><button id="approveProposals" class="btn secondary">Approve selected for next run</button></div>' : "");
    $("approveProposals")?.addEventListener("click", approveProposals);
  } else {
    $("proposals").innerHTML = '<div class="empty">No repeated pattern has enough evidence yet. Two matching Bad reasons create a proposal.</div>';
  }
  updateEnrollButton();
}

async function setRealFeedback(candidateId, verdict, reason = null) {
  const note = document.querySelector(`[data-note-for="${CSS.escape(candidateId)}"]`)?.value || null;
  try {
    const data = await api("/api/sourcing/feedback", {
      method: "POST",
      body: JSON.stringify({ runId: STATE.currentRun.id, candidateId, verdict, reason, note, expectedRevision: STATE.currentRun.revision }),
    });
    STATE.currentRun = data.run;
    renderReview();
  } catch (error) {
    if (error.code === "revision_conflict") await loadRun(STATE.currentRun.id);
    blocker("Feedback was not saved", error.message, "!");
  }
}

function setDemoVerdict(candidateId, verdict, reason = null) {
  const index = STATE.demo.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) return;
  if (verdict === "bad" && !reason) STATE.demo[index] = { ...STATE.demo[index], pendingBad: true };
  else STATE.demo[index] = { ...applyFeedback(STATE.demo[index], { verdict, reason }), pendingBad: false };
  renderReview();
}

async function approveProposals() {
  const acceptedReasons = [...document.querySelectorAll("[data-proposal]:checked")].map((input) => input.dataset.proposal);
  if (!acceptedReasons.length) return;
  try {
    const data = await api("/api/sourcing/proposals", {
      method: "POST",
      body: JSON.stringify({ runId: STATE.currentRun.id, acceptedReasons, expectedRevision: STATE.currentRun.revision }),
    });
    STATE.currentRun = data.run;
    STATE.roleState.activeRubricVersionId = data.rubricVersion.id;
    STATE.roleState.rubricVersions.push(data.rubricVersion);
    renderReview();
    blocker("Next rubric version approved", `Version ${data.rubricVersion.version} will govern the next native Search run.`, "✓");
  } catch (error) {
    blocker("Rubric update was not saved", error.message, "!");
  }
}

function updateEnrollButton() {
  const count = STATE.selectedEnroll.size;
  const ready = Boolean(STATE.currentRun && STATE.config?.sequenceWritesApproved && STATE.currentRun.mapping?.sequenceId && count);
  $("enroll").disabled = !ready;
  $("enroll").textContent = count ? `Send ${count} selected Good to sequence` : "Send selected Good to sequence";
}

async function enrollSelected() {
  const candidateIds = [...STATE.selectedEnroll];
  const expected = `ENROLL ${candidateIds.length}`;
  const confirmation = window.prompt(`This will add ${candidateIds.length} candidate${candidateIds.length === 1 ? "" : "s"} to ${STATE.currentRun.mapping.sequenceName}. Type ${expected} to confirm.`);
  if (confirmation === null) return;
  try {
    const data = await api("/api/sourcing/enroll", {
      method: "POST",
      body: JSON.stringify({ runId: STATE.currentRun.id, candidateIds, confirmation, expectedRevision: STATE.currentRun.revision }),
    });
    STATE.currentRun = data.run;
    STATE.selectedEnroll.clear();
    renderReview();
    blocker("Sequence handoff finished", `${data.enrolled} enrolled; ${data.blocked} blocked by safety checks or vendor policy.`, "✓");
  } catch (error) {
    if (STATE.currentRun?.id) await loadRun(STATE.currentRun.id).catch(() => {});
    blocker("Sequence handoff did not complete", error.message, "!");
  }
}

async function init() {
  try {
    const response = await fetch("/api/sourcing/config");
    STATE.config = await response.json();
    renderReasons();
    if (!STATE.config.authRequired) {
      status("locked", "authentication required");
      blocker("Authentication is not configured", "Set SOURCING_ACCESS_KEY or GOOGLE_CLIENT_ID before this workspace can read Paraform data.");
      return;
    }
    if (!STATE.config.stateStoreConfigured) {
      status("locked", "state store required");
      blocker("Durable state is not configured", "Connect the Raydar KV store before mappings, runs or feedback can be saved.");
      return;
    }
    if (!STATE.config.paraformSessionConfigured) {
      status("locked", "Paraform session required");
      blocker("Paraform session is not configured", "An admin must configure the shared service session.");
      return;
    }
    if (STATE.key || STATE.token) await authenticatedStart();
    else renderGate();
  } catch {
    status("locked", "configuration unavailable");
    blocker("Configuration unavailable", "The sourcing API could not be reached.");
  }
}

$("keySubmit").addEventListener("click", submitKey);
$("accessKey").addEventListener("keydown", (event) => { if (event.key === "Enter") submitKey(); });
$("role").addEventListener("change", (event) => loadRole(event.target.value));
$("refresh").addEventListener("click", loadRoles);
$("saveMapping").addEventListener("click", saveMapping);
$("runSearch").addEventListener("click", runSearch);
$("loadDemo").addEventListener("click", () => loadDemo(false));
$("loadSample").addEventListener("click", () => loadDemo(true));
$("enroll").addEventListener("click", enrollSelected);
$("reviewRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-verdict]");
  if (!button) return;
  const candidate = (STATE.currentRun?.candidates || STATE.demo).find((item) => item.id === button.dataset.candidate);
  if (button.dataset.verdict === "bad") {
    candidate.pendingBad = true;
    renderReview();
  } else if (button.dataset.real === "1") setRealFeedback(button.dataset.candidate, button.dataset.verdict);
  else setDemoVerdict(button.dataset.candidate, button.dataset.verdict);
});
$("reviewRows").addEventListener("change", (event) => {
  if (event.target.matches("[data-reason-for]") && event.target.value) {
    if (event.target.dataset.real === "1") setRealFeedback(event.target.dataset.reasonFor, "bad", event.target.value);
    else setDemoVerdict(event.target.dataset.reasonFor, "bad", event.target.value);
  }
  if (event.target.matches("[data-enroll-id]")) {
    if (event.target.checked) STATE.selectedEnroll.add(event.target.dataset.enrollId);
    else STATE.selectedEnroll.delete(event.target.dataset.enrollId);
    updateEnrollButton();
  }
  if (event.target.matches("[data-note-for]") && event.target.dataset.real === "1") {
    const candidate = STATE.currentRun?.candidates.find((item) => item.id === event.target.dataset.noteFor);
    if (candidate?.feedback?.verdict) setRealFeedback(candidate.id, candidate.feedback.verdict, candidate.feedback.reason);
  }
});

renderReasons();
init();
