import { FEEDBACK_REASONS, applyFeedback, proposeNextRun, summarizeFeedback } from "/sourcing-domain.mjs";
import {
  DEGREE_TYPES,
  FUNDING_STAGES,
  TALENT_DENSITY_TIERS,
  deriveAgentCriteria,
  deriveNativeFilters,
  emptyEducationClause,
  emptyWorkClause,
  normalizeNativeFilters,
  normalizeRankingConfig,
} from "/sourcing-filters.mjs";

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
  criteriaDraft: null,
  criteriaDirty: false,
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

const parseList = (value) => [...new Set(String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
const joinList = (value) => (value || []).join(", ");
const selectedOptions = (select) => [...(select?.selectedOptions || [])].map((option) => option.value).filter(Boolean);
const numberOrEmpty = (value) => value === undefined || value === null ? "" : value;
const inputNumber = (value) => value === "" || value == null ? undefined : Number(value);

function activeRubricVersion() {
  return STATE.roleState?.rubricVersions?.find((version) => version.id === STATE.roleState.activeRubricVersionId) || null;
}

function optionRows(options, selected = []) {
  const chosen = new Set(selected || []);
  return options.map(([value, label]) => `<option value="${esc(value)}"${chosen.has(value) ? " selected" : ""}>${esc(label)}</option>`).join("");
}

function workClauseHtml(clause, index, kind) {
  const key = `${kind}-${index}`;
  const scope = clause.scope || "any";
  return `<div class="work-clause" data-work-kind="${kind}" data-work-index="${index}">
    <div class="clause-top"><b>${kind === "include" ? "Included" : "Excluded"} work clause ${index + 1}</b><button class="remove-clause" type="button" data-remove-work="${key}">Remove</button></div>
    <div class="segmented" aria-label="Employment timing">
      ${[["any", "Any"], ["current", "Current"], ["past", "Past"]].map(([value, label]) => `<label><input type="radio" name="scope-${key}" value="${value}"${scope === value ? " checked" : ""} /><span>${label}</span></label>`).join("")}
    </div>
    <div class="form-grid" style="margin-top:12px"><div><label>Job titles</label><input data-work-field="titles" value="${esc(joinList(clause.titles))}" placeholder="Software Engineer, PM" /></div><div><label>Companies</label><input data-work-field="companies" value="${esc(joinList(clause.companies))}" placeholder="Stripe, Ramp, Cursor" /><div class="field-help">Company names are matched the same way as typed names in Paraform.</div></div></div>
    <details class="advanced"><summary>Advanced company filters</summary><div class="form-grid">
      <div><label>Company keywords</label><input data-work-field="companyKeywords" value="${esc(joinList(clause.companyKeywords))}" /></div>
      <div><label>Investors</label><input data-work-field="companyInvestors" value="${esc(joinList(clause.companyInvestors))}" /></div>
      <div><label>Headcount min</label><input data-work-field="companyHeadcountMin" type="number" min="0" value="${esc(numberOrEmpty(clause.companyHeadcountMin))}" /></div>
      <div><label>Headcount max</label><input data-work-field="companyHeadcountMax" type="number" min="0" value="${esc(numberOrEmpty(clause.companyHeadcountMax))}" /></div>
      <div><label>Funding stages</label><select data-work-field="companyFundingStages" multiple size="5">${optionRows(FUNDING_STAGES, clause.companyFundingStages)}</select></div>
      <div><label>Funding stage timing</label><select data-work-field="companyFundingStageSemantic"><option value="current"${clause.companyFundingStageSemantic !== "tenure" ? " selected" : ""}>Now</option><option value="tenure"${clause.companyFundingStageSemantic === "tenure" ? " selected" : ""}>While candidate was there</option></select></div>
      <div><label>Total funding min ($)</label><input data-work-field="companyTotalFundingMin" type="number" min="0" value="${esc(numberOrEmpty(clause.companyTotalFundingMin))}" /></div>
      <div><label>Total funding max ($)</label><input data-work-field="companyTotalFundingMax" type="number" min="0" value="${esc(numberOrEmpty(clause.companyTotalFundingMax))}" /></div>
      <div><label>Talent density</label><select data-work-field="companyTalentDensityTiers" multiple size="4">${optionRows(TALENT_DENSITY_TIERS, clause.companyTalentDensityTiers)}</select></div>
    </div></details>
  </div>`;
}

function educationClauseHtml(clause, index) {
  return `<div class="education-clause" data-education-index="${index}"><div class="clause-top"><b>Education clause ${index + 1}</b><button class="remove-clause" type="button" data-remove-education="${index}">Remove</button></div><div class="form-grid three">
    <div><label>Degrees</label><select data-education-field="degreeTypes" multiple size="4">${optionRows(DEGREE_TYPES, clause.degreeTypes)}</select></div>
    <div><label>Schools</label><input data-education-field="schools" value="${esc(joinList(clause.schools))}" placeholder="Stanford, MIT" /></div>
    <div><label>Fields of study</label><input data-education-field="fieldsOfStudy" value="${esc(joinList(clause.fieldsOfStudy))}" placeholder="Computer Science" /></div>
  </div></div>`;
}

function collectWorkClauses(kind) {
  return [...document.querySelectorAll(`[data-work-kind="${kind}"]`)].map((row) => {
    const value = (field) => row.querySelector(`[data-work-field="${field}"]`);
    return {
      ...emptyWorkClause(),
      scope: row.querySelector(`input[name^="scope-"]:checked`)?.value || "any",
      titles: parseList(value("titles")?.value),
      companies: parseList(value("companies")?.value),
      companyKeywords: parseList(value("companyKeywords")?.value),
      companyHeadcountMin: inputNumber(value("companyHeadcountMin")?.value),
      companyHeadcountMax: inputNumber(value("companyHeadcountMax")?.value),
      companyFundingStages: selectedOptions(value("companyFundingStages")),
      companyFundingStageSemantic: value("companyFundingStageSemantic")?.value || "current",
      companyInvestors: parseList(value("companyInvestors")?.value),
      companyTotalFundingMin: inputNumber(value("companyTotalFundingMin")?.value),
      companyTotalFundingMax: inputNumber(value("companyTotalFundingMax")?.value),
      companyTalentDensityTiers: selectedOptions(value("companyTalentDensityTiers")),
    };
  });
}

function collectEducationClauses() {
  return [...document.querySelectorAll("[data-education-index]")].map((row) => ({
    degreeTypes: selectedOptions(row.querySelector('[data-education-field="degreeTypes"]')),
    schools: parseList(row.querySelector('[data-education-field="schools"]')?.value),
    fieldsOfStudy: parseList(row.querySelector('[data-education-field="fieldsOfStudy"]')?.value),
  }));
}

function renderClauseEditors() {
  const filters = STATE.criteriaDraft?.nativeFilters || {};
  const include = filters.workExperienceGroups?.length ? filters.workExperienceGroups : [emptyWorkClause()];
  const education = filters.educationGroups?.length ? filters.educationGroups : [emptyEducationClause()];
  $("includeWorkClauses").innerHTML = include.map((clause, index) => workClauseHtml(clause, index, "include")).join("");
  $("excludeWorkClauses").innerHTML = (filters.excludeWorkExperienceGroups || []).map((clause, index) => workClauseHtml(clause, index, "exclude")).join("");
  $("educationClauses").innerHTML = education.map(educationClauseHtml).join("");
}

function collectCriteria() {
  const nativeFilters = normalizeNativeFilters({
    candidateName: $("fCandidateName").value,
    linkedinSlug: $("fLinkedinSlug").value,
    keyword: $("fKeyword").value,
    excludeKeyword: $("fExcludeKeyword").value,
    workExperienceGroups: collectWorkClauses("include"),
    excludeWorkExperienceGroups: collectWorkClauses("exclude"),
    yoeMin: inputNumber($("fYoeMin").value),
    yoeMax: inputNumber($("fYoeMax").value),
    timeAtCurrentRoleMinYears: inputNumber($("fTenureMin").value),
    timeAtCurrentRoleMaxYears: inputNumber($("fTenureMax").value),
    skills: parseList($("fSkills").value),
    skillsMode: document.querySelector('input[name="skillsMode"]:checked')?.value || "boost",
    excludeSkills: parseList($("fExcludeSkills").value),
    locations: parseList($("fLocations").value),
    excludeLocations: parseList($("fExcludeLocations").value),
    minDegreeType: $("fMinDegree").value || undefined,
    educationGroups: collectEducationClauses(),
    excludeSchools: parseList($("fExcludeSchools").value),
    excludeFieldsOfStudy: parseList($("fExcludeFields").value),
  });
  const rankingConfig = normalizeRankingConfig({
    poolSize: $("poolSize").value,
    saveLimit: $("saveLimit").value,
    minimumScore: $("minimumScore").value,
  }, STATE.roleState?.mapping?.candidateCap || 100);
  return { nativeFilters, agentCriteria: $("agentCriteria").value.trim(), rankingConfig };
}

function updateFlow(config) {
  $("flowPool").textContent = config.poolSize;
  $("flowThreshold").textContent = `${config.minimumScore}+`;
  $("flowSave").textContent = `≤ ${config.saveLimit}`;
}

function renderCriteria() {
  if (!STATE.workspace) return;
  const version = activeRubricVersion();
  const rubric = version?.rubric || STATE.workspace.rubric || {};
  const mappingCap = STATE.roleState?.mapping?.candidateCap || 100;
  const nativeFilters = normalizeNativeFilters(version?.nativeFilters || deriveNativeFilters(rubric));
  const rankingConfig = normalizeRankingConfig(version?.rankingConfig || {}, mappingCap);
  STATE.criteriaDraft = {
    nativeFilters: structuredClone(nativeFilters),
    agentCriteria: version?.agentCriteria || deriveAgentCriteria(rubric, version?.adjustments || []),
    rankingConfig,
  };
  $("criteriaEmpty").hidden = true;
  $("criteriaEditor").hidden = false;
  $("fMinDegree").innerHTML = '<option value="">Any degree</option>' + optionRows(DEGREE_TYPES, nativeFilters.minDegreeType ? [nativeFilters.minDegreeType] : []);
  $("fCandidateName").value = nativeFilters.candidateName || "";
  $("fLinkedinSlug").value = nativeFilters.linkedinSlug || "";
  $("fKeyword").value = nativeFilters.keyword || "";
  $("fExcludeKeyword").value = nativeFilters.excludeKeyword || "";
  $("fYoeMin").value = numberOrEmpty(nativeFilters.yoeMin);
  $("fYoeMax").value = numberOrEmpty(nativeFilters.yoeMax);
  $("fTenureMin").value = numberOrEmpty(nativeFilters.timeAtCurrentRoleMinYears);
  $("fTenureMax").value = numberOrEmpty(nativeFilters.timeAtCurrentRoleMaxYears);
  $("fSkills").value = joinList(nativeFilters.skills);
  document.querySelector(`input[name="skillsMode"][value="${nativeFilters.skillsMode || "boost"}"]`).checked = true;
  $("fExcludeSkills").value = joinList(nativeFilters.excludeSkills);
  $("fLocations").value = joinList(nativeFilters.locations);
  $("fExcludeLocations").value = joinList(nativeFilters.excludeLocations);
  $("fExcludeSchools").value = joinList(nativeFilters.excludeSchools);
  $("fExcludeFields").value = joinList(nativeFilters.excludeFieldsOfStudy);
  $("agentCriteria").value = STATE.criteriaDraft.agentCriteria;
  $("poolSize").value = rankingConfig.poolSize;
  $("saveLimit").value = rankingConfig.saveLimit;
  $("minimumScore").value = rankingConfig.minimumScore;
  $("roleSummary").textContent = rubric.role?.summary || "";
  renderClauseEditors();
  updateFlow(rankingConfig);
  STATE.criteriaDirty = false;
  $("criteriaStatus").textContent = version ? `Using sourcing setup v${version.version}.` : "Role brief loaded. Prepare assets to save this setup.";
  $("saveCriteria").disabled = !STATE.roleState?.mapping;
}

function preserveDraft() {
  if (!STATE.criteriaDraft || $("criteriaEditor").hidden) return;
  try { STATE.criteriaDraft = collectCriteria(); } catch {}
}

function addWorkClause(kind) {
  preserveDraft();
  const key = kind === "include" ? "workExperienceGroups" : "excludeWorkExperienceGroups";
  STATE.criteriaDraft.nativeFilters[key] = [...(STATE.criteriaDraft.nativeFilters[key] || []), emptyWorkClause()];
  renderClauseEditors();
  STATE.criteriaDirty = true;
}

function removeWorkClause(kind, index) {
  preserveDraft();
  const key = kind === "include" ? "workExperienceGroups" : "excludeWorkExperienceGroups";
  STATE.criteriaDraft.nativeFilters[key] = (STATE.criteriaDraft.nativeFilters[key] || []).filter((_, itemIndex) => itemIndex !== index);
  renderClauseEditors();
  STATE.criteriaDirty = true;
}

function addEducationClause() {
  preserveDraft();
  STATE.criteriaDraft.nativeFilters.educationGroups = [...(STATE.criteriaDraft.nativeFilters.educationGroups || []), emptyEducationClause()];
  renderClauseEditors();
  STATE.criteriaDirty = true;
}

function removeEducationClause(index) {
  preserveDraft();
  STATE.criteriaDraft.nativeFilters.educationGroups = (STATE.criteriaDraft.nativeFilters.educationGroups || []).filter((_, itemIndex) => itemIndex !== index);
  renderClauseEditors();
  STATE.criteriaDirty = true;
}

async function saveCriteria({ quiet = false } = {}) {
  const button = $("saveCriteria");
  const criteria = collectCriteria();
  if (!criteria.agentCriteria) throw new Error("Describe what the agent should consider a great candidate.");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const data = await api("/api/sourcing/criteria", {
      method: "POST",
      body: JSON.stringify({ roleId: $("role").value, ...criteria }),
    });
    STATE.roleState = data.state;
    STATE.criteriaDraft = criteria;
    STATE.criteriaDirty = false;
    updateFlow(criteria.rankingConfig);
    $("criteriaStatus").textContent = data.unchanged ? `Sourcing setup v${data.rubricVersion.version} is current.` : `Saved sourcing setup v${data.rubricVersion.version}.`;
    if (!quiet) blocker("Sourcing setup saved", `Version ${data.rubricVersion.version} will govern the next hybrid run.`, "✓");
    updateRunControls();
    return data;
  } finally {
    button.textContent = "Save search setup";
    button.disabled = !STATE.roleState?.mapping;
  }
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
  const role = STATE.workspace?.rubric?.role || STATE.roles.find((item) => item.id === roleId) || {};
  const targetName = role.company && role.title ? `${role.company} - ${role.title}` : "Company - Job Title";
  project.innerHTML = `<option value="">Auto: reuse or create ${esc(targetName)}</option>` + STATE.options.projects.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  sequence.innerHTML = `<option value="">Auto: reuse or create full ${esc(targetName)}</option>` + STATE.options.sequences.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}${item.enabled ? " · active" : " · disabled"}</option>`).join("");
  const mapping = STATE.roleState?.mapping;
  if (mapping) {
    project.value = mapping.reviewProjectId || "";
    sequence.value = mapping.sequenceId || "";
    $("candidateCap").value = mapping.candidateCap || 100;
  } else {
    project.value = STATE.options.projects.find((item) => item.name === targetName)?.id || "";
    sequence.value = STATE.options.sequences.find((item) => item.name === targetName)?.id || "";
    $("candidateCap").value = 100;
  }
  project.disabled = !roleId || !STATE.config?.projectWritesApproved;
  sequence.disabled = !roleId || !STATE.config?.sequenceWritesApproved;
  $("candidateCap").disabled = !roleId;
  $("saveMapping").disabled = !roleId || !STATE.config?.projectWritesApproved || !STATE.config?.sequenceWritesApproved;
  $("mappingPreview").classList.toggle("pending", !mapping);
  $("mappingPreview").textContent = mapping
    ? `Good candidates will be saved to ${mapping.reviewProjectName}.`
    : `Set up this job once. Raydar will reuse or create ${targetName} for review.`;
  $("jobSettings").open = Boolean(roleId && !mapping);
  updateRunControls();
}

function updateRunControls() {
  const mapping = STATE.roleState?.mapping;
  const ready = Boolean(mapping && STATE.config?.searchApproved && STATE.config?.rankingConfigured);
  $("runSearch").disabled = !ready;
  if (!mapping) $("runNote").textContent = "Set up this job's review project first.";
  else if (!STATE.config?.searchApproved) $("runNote").textContent = "Mapping saved. Native Search is waiting on the Paraform automation approval flag.";
  else if (!STATE.config?.rankingConfigured) $("runNote").textContent = "Mapping saved. Candidate ranking needs an OpenAI API key.";
  else if (!STATE.config?.projectWritesApproved) $("runNote").textContent = "Search is ready in evaluation mode; Project writes remain disabled.";
  else $("runNote").textContent = `Ready. Good matches will be saved to ${mapping.reviewProjectName}.`;
}

async function loadRole(roleId) {
  if (!roleId) return;
  STATE.currentRun = null;
  STATE.demo = [];
  STATE.selectedEnroll.clear();
  STATE.criteriaDraft = null;
  $("criteriaEmpty").hidden = false;
  $("criteriaEmpty").textContent = "Loading role brief and saved sourcing setup…";
  $("criteriaEditor").hidden = true;
  try {
    const [workspace, mapping, recent] = await Promise.all([
      api(`/api/sourcing/role?roleId=${encodeURIComponent(roleId)}`),
      api(`/api/sourcing/mapping?roleId=${encodeURIComponent(roleId)}`),
      api(`/api/sourcing/runs?roleId=${encodeURIComponent(roleId)}`),
    ]);
    STATE.workspace = workspace;
    STATE.roleState = mapping.state;
    STATE.runs = recent.runs || [];
    renderMapping();
    renderCriteria();
    renderRunHistory();
    history.replaceState(null, "", `/sourcing?roleId=${encodeURIComponent(roleId)}`);
    if (STATE.runs[0]) await loadRun(STATE.runs[0].id);
    else renderReview();
  } catch (error) {
    $("criteriaEmpty").hidden = false;
    $("criteriaEmpty").textContent = error.message;
    $("criteriaEditor").hidden = true;
  }
}

async function saveMapping() {
  const roleId = $("role").value;
  if (!roleId) return blocker("Role required", "Choose a Paraform role before preparing its assets.", "!");
  const button = $("saveMapping");
  button.disabled = true;
  button.textContent = "Preparing…";
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
    await loadOptions();
    renderMapping();
    renderCriteria();
    const made = [data.provisioned?.projectCreated ? "Project created" : "Project reused", data.provisioned?.sequenceCreated ? "full Sequence created" : "Sequence reused"].join("; ");
    const warnings = data.provisioned?.sequenceWarnings || [];
    blocker(warnings.length ? "Assets mapped with a review warning" : "Project and Sequence ready", `${made}. ${data.state.mapping.reviewProjectName} → ${data.state.mapping.sequenceName}.${warnings.length ? ` ${warnings.join("; ")}` : " Campaign remains not started."}`, warnings.length ? "!" : "✓");
  } catch (error) {
    blocker("Assets could not be prepared", error.message, "!");
  } finally {
    button.textContent = "Set up job";
    button.disabled = !STATE.config?.projectWritesApproved || !STATE.config?.sequenceWritesApproved;
  }
}

function renderRunHistory() {
  if (!STATE.runs.length) {
    $("runHistory").innerHTML = "";
    return;
  }
  const label = (run) => {
    const time = new Date(run.createdAt).toLocaleString();
    if (run.state === "failed") return `${time} · search failed`;
    const saved = Number(run.counts?.projectFiled || 0);
    const reviewed = Number(run.counts?.evaluated || 0);
    const skipped = Number(run.counts?.deduped || 0);
    if (reviewed) return `${time} · ${saved} saved of ${reviewed} reviewed`;
    if (skipped) return `${time} · no new profiles (${skipped} already handled)`;
    return `${time} · no profiles found`;
  };
  $("runHistory").innerHTML = `<span class="note">Past searches:</span><select id="runPicker">${STATE.runs.map((run) => `<option value="${esc(run.id)}"${STATE.currentRun?.id === run.id ? " selected" : ""}>${esc(label(run))}</option>`).join("")}</select>`;
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
  button.textContent = "Searching and reviewing…";
  $("runNote").textContent = "Searching Paraform, reviewing every new profile, and saving only good matches. Keep this tab open.";
  try {
    await saveCriteria({ quiet: true });
    const data = await api("/api/sourcing/runs", {
      method: "POST",
      body: JSON.stringify({ roleId: $("role").value }),
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
    const saved = data.run.counts.projectFiled || 0;
    blocker(saved ? `${saved} candidates saved for review` : "Search complete — nothing saved", saved
      ? `The agent reviewed ${data.run.counts.evaluated || 0} profiles and saved the best matches to ${data.run.mapping.reviewProjectName}.`
      : `The agent reviewed ${data.run.counts.evaluated || 0} new profiles, but none met the current requirements.`, saved ? "✓" : "◌");
  } catch (error) {
    blocker("Hybrid sourcing did not complete", error.message, "!");
  } finally {
    button.textContent = "Search, review & save candidates";
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

function savedForReview(candidate) {
  return candidate.projectStatus === "filed" && candidate.state !== "dedup_blocked";
}

function resultSummary(run, savedCount) {
  const counts = run.counts || {};
  const reviewed = Number(counts.evaluated || 0);
  const skipped = Number(counts.deduped || 0);
  const project = run.mapping?.reviewProjectName || "the review project";
  if (run.state === "failed") return ["This search did not finish", run.error || "Try the search again."];
  if (savedCount) return [
    `${savedCount} good candidate${savedCount === 1 ? "" : "s"} saved to ${project}`,
    `The agent reviewed ${reviewed} new profile${reviewed === 1 ? "" : "s"}. Open a candidate below to review the decision or add feedback.`,
  ];
  if (reviewed) return [
    "No candidates met the requirements",
    `The agent reviewed ${reviewed} new profile${reviewed === 1 ? "" : "s"}; none passed the current requirements, so nothing was saved. Adjust the requirements and search again.`,
  ];
  if (skipped) return [
    "No new candidates to review",
    `${skipped} matching profile${skipped === 1 ? " was" : "s were"} already handled by an earlier search or workflow, so nothing was saved twice.`,
  ];
  return ["No candidates found", "Try broadening the requirements or the optional Paraform filters, then search again."];
}

function renderReview() {
  const real = Boolean(STATE.currentRun);
  const allCandidates = real ? STATE.currentRun.candidates || [] : STATE.demo;
  const candidates = real ? allCandidates.filter(savedForReview) : allCandidates;
  const feedback = candidates.map((candidate) => candidate.feedback || {});
  const summary = summarizeFeedback(feedback);
  $("statUnreviewed").textContent = summary.unreviewed;
  $("statGood").textContent = summary.good;
  $("statMaybe").textContent = summary.maybe;
  $("statBad").textContent = summary.bad;
  $("reviewQueue").hidden = !candidates.length;
  $("reviewStats").hidden = !candidates.length;
  $("reviewLearning").hidden = !candidates.length;
  $("enrollBar").hidden = !candidates.length;
  $("resultFunnel").hidden = !real;
  if (real) {
    const counts = STATE.currentRun.counts || {};
    $("resultFound").textContent = counts.discovered || 0;
    $("resultReviewed").textContent = counts.evaluated || 0;
    $("resultSaved").textContent = counts.projectFiled ?? candidates.length;
    const [title, body] = resultSummary(STATE.currentRun, candidates.length);
    $("feedbackMode").innerHTML = `<strong>${esc(title)}</strong>${esc(body)}`;
  } else {
    $("feedbackMode").innerHTML = "<strong>No search results yet</strong>Run a search above. Good candidates will appear here and in the mapped Paraform project.";
  }
  $("reviewRows").innerHTML = candidates.map((candidate) => {
    const blocked = candidate.state === "dedup_blocked";
    const href = candidateHref(candidate);
    const name = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(candidate.name)} ↗</a>` : esc(candidate.name);
    const showReason = candidate.pendingBad || candidate.feedback?.verdict === "bad";
    const options = '<option value="">Choose why…</option>' + FEEDBACK_REASONS.map((reason) => `<option value="${reason.id}"${candidate.feedback?.reason === reason.id ? " selected" : ""}>${esc(reason.label)}</option>`).join("");
    const canEnroll = real && ["good", "enrollment_queued"].includes(candidate.state) && candidate.projectStatus === "filed" && Boolean(STATE.currentRun.mapping.sequenceId);
    const evaluation = candidate.agentEvaluation;
    const assessment = evaluation
      ? `<div class="assessment"><span class="score">${esc(evaluation.score)}/100 · ${esc(evaluation.confidence)}</span><p>${esc(evaluation.reason)}</p>${evaluation.strengths?.length ? `<ul>${evaluation.strengths.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}${evaluation.concerns?.length ? `<div class="field-help">Watch: ${esc(evaluation.concerns.join(" · "))}</div>` : ""}</div>`
      : `<span class="tag">${blocked ? "dedup blocked" : "not ranked"}</span>`;
    const feedbackControls = blocked
      ? `<span class="tag">blocked · ${esc(candidate.dedupReason || "dedup")}</span>`
      : candidate.state === "enrolled"
        ? '<span class="tag">enrolled ✓</span>'
        : reviewable(candidate)
          ? `<div class="verdicts">${verdictButton(candidate, "good", "Good", real)}${verdictButton(candidate, "maybe", "Maybe", real)}${verdictButton(candidate, "bad", "Bad", real)}</div>${showReason ? `<select class="reason-select" data-reason-for="${esc(candidate.id)}" data-real="${real ? "1" : "0"}">${options}</select><input class="feedback-note" data-note-for="${esc(candidate.id)}" data-real="${real ? "1" : "0"}" placeholder="Optional note" value="${esc(candidate.feedback?.note || "")}" />` : ""}`
          : `<span class="tag">${esc(candidate.state)}</span>`;
    const enroll = canEnroll ? `<label class="note"><input class="enroll-check" type="checkbox" data-enroll-id="${esc(candidate.id)}"${STATE.selectedEnroll.has(candidate.id) ? " checked" : ""} /> ${candidate.state === "enrollment_queued" ? "retry sequence readback" : "add to sequence"}</label>` : "";
    const meta = [candidate.title, candidate.company, candidate.location].filter(Boolean).join(" · ");
    return `<tr class="${blocked ? "blocked-row" : ""}"><td><div class="candidate-title">${name}</div><div class="candidate-meta">${esc(meta)}</div><div class="meta"><span class="tag">project: ${esc(candidate.projectStatus || "n/a")}</span>${enroll}</div></td><td>${assessment}</td><td>${feedbackControls}</td></tr>`;
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
    blocker("Next sourcing version approved", `Version ${data.rubricVersion.version} will govern the next hybrid run.`, "✓");
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
$("saveCriteria").addEventListener("click", () => saveCriteria().catch((error) => blocker("Sourcing setup was not saved", error.message, "!")));
$("runSearch").addEventListener("click", runSearch);
$("addIncludeWork").addEventListener("click", () => addWorkClause("include"));
$("addExcludeWork").addEventListener("click", () => addWorkClause("exclude"));
$("addEducation").addEventListener("click", addEducationClause);
$("criteriaEditor").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-filter-tab]");
  if (tab) {
    document.querySelectorAll("[data-filter-tab]").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelectorAll("[data-filter-panel]").forEach((item) => item.classList.toggle("active", item.dataset.filterPanel === tab.dataset.filterTab));
    return;
  }
  const work = event.target.closest("[data-remove-work]");
  if (work) {
    const [kind, index] = work.dataset.removeWork.split("-");
    removeWorkClause(kind, Number(index));
    return;
  }
  const education = event.target.closest("[data-remove-education]");
  if (education) removeEducationClause(Number(education.dataset.removeEducation));
});
const markCriteriaDirty = () => {
  if ($("criteriaEditor").hidden) return;
  STATE.criteriaDirty = true;
  $("criteriaStatus").textContent = "Unsaved edits — the next run will save them first.";
  try { updateFlow(collectCriteria().rankingConfig); } catch {}
};
$("criteriaEditor").addEventListener("input", markCriteriaDirty);
$("criteriaEditor").addEventListener("change", markCriteriaDirty);
$("loadDemo")?.addEventListener("click", () => loadDemo(false));
$("loadSample")?.addEventListener("click", () => loadDemo(true));
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
