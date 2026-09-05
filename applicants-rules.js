/* Rules view for the Applicants tab.
 *
 * A separate classic script rather than more inline page: applicants.html is
 * already 1,400 lines and this is a self-contained surface. It reads the same
 * globals the page defines (STATE, esc, toast, $) and hands itself back through
 * window.RaydarRules, which setView() calls.
 *
 * EVERY CHOICE COMES FROM THE SERVER. The field catalog, the operators, the
 * degree levels and the school/company directories all arrive from
 * GET /api/applicants/rules. Nothing about what a rule may say is duplicated
 * here, because a mirrored copy would be wrong the first time anyone adds a
 * field — and the mismatch would show up as a rule that previews one way and
 * fires another.
 */
(function () {
  "use strict";

  const state = {
    loaded: false, rev: 0, pausedAll: false,
    rules: [], stats: {}, catalog: [], groups: [], degreeLevels: [],
    directories: { schools: {}, companies: {} },
    fundedEmployers: { activeSnapshotId: null, snapshots: [] },
    draft: null,              // the rule being edited, or null
    preview: null,            // last preview result for the draft
    previewing: false,
    hits: null,               // { ruleId, rows } while the hits panel is open
    running: false,
    loadError: null, previewError: null, previewSerial: 0, editorRev: 0, staleDraft: false, saving: false, returnFocus: null, scopeSelected: false, modalSerial: 0,
    lastRun: null,
  };

  const el = (id) => document.getElementById(id);
  /* The page declares its globals with `const`, which puts them in the global
     LEXICAL scope — reachable as a bare identifier from another classic
     script, but NOT present on `window`. Guarding with `window.STATE` silently
     never fires; this is how you actually ask. */
  const pageState = () => (typeof STATE === "undefined" ? null : STATE);
  const viewIsRules = () => { const s = pageState(); return !!s && s.view === "rules"; };
  const enc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const field = (name) => state.catalog.find((f) => f.name === name) || null;
  const applicantGeneration = () => typeof window.RaydarApplicantsGeneration === "function"
    ? window.RaydarApplicantsGeneration()
    : {};
  /* Directory first (it tracks renames), then the labels the rule was saved
     with, then the bare id. The middle step is what keeps a rule readable when
     it names a school the prewarm has not reached yet. */
  const nameFor = (id, rule) =>
    state.directories.schools[id]
    || state.directories.companies[id]
    || (rule && rule.labels && rule.labels[id])
    || id;

  /* ── styles ──────────────────────────────────────────────────────────── */
  const CSS = `
  .reasonbar { position:fixed; left:50%; transform:translateX(-50%) translateY(10px); bottom:70px;
    background:var(--card); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow);
    padding:11px 14px; z-index:55; display:none; opacity:0; transition:opacity .16s ease, transform .16s ease;
    max-width:min(640px,92vw); }
  .reasonbar.on { display:block; opacity:1; transform:translateX(-50%) translateY(0); }
  .reasonbar .q { font-size:12px; color:var(--ink-2); margin-bottom:8px; }
  .reasonbar .q b { color:var(--ink); }
  .reasonbar .chips2 { display:flex; flex-wrap:wrap; gap:6px; }
  .reasonbar button { border:1px solid var(--line); background:var(--cream); border-radius:999px;
    font:600 12px "Inter Variable",sans-serif; padding:5px 12px; cursor:pointer; color:var(--ink-2); }
  .reasonbar button:hover { border-color:var(--ink); color:var(--ink); }
  .reasonbar .skip { margin-left:4px; border:0; background:transparent; color:var(--ink-3); }
  `;

  /* The reasons a Pass may carry. Mirrors PASS_REASONS in
     api/applicants/_lib/decision-record.mjs — the server drops anything not on
     its own list, so a drift here degrades to "no reason recorded" rather than
     to a wrong one. */
  const PASS_REASONS = [
    ["wrong_seniority", "Wrong seniority"],
    ["wrong_industry", "Wrong industry"],
    ["no_relevant_experience", "No relevant experience"],
    ["job_hopper", "Job hopper"],
    ["not_credible", "Not credible"],
    ["other", "Other"],
  ];

  /* ── api ─────────────────────────────────────────────────────────────── */
  async function api(body, method) {
    const response = await fetch("/api/applicants/rules" + (method === "GET" ? "?with=directories" : ""), {
      method: method || "POST",
      credentials: "same-origin",
      headers: method === "GET" ? {} : { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409 && payload.error === "rules_changed") {
      state.staleDraft = Boolean(state.draft);
      await load();
      throw new Error("Rules changed elsewhere; close and reopen this rule to review the latest version.");
    }
    if (!response.ok || payload.ok === false) throw new Error(payload.detail || payload.error || "Request failed.");
    return payload;
  }

  async function load() {
    const payload = await api(null, "GET");
    state.rev = payload.rev;
    state.pausedAll = payload.pausedAll;
    state.rules = payload.rules || [];
    state.stats = payload.stats || {};
    state.catalog = payload.catalog || [];
    state.groups = payload.groups || [];
    state.degreeLevels = payload.degreeLevels || [];
    state.directories = payload.directories || { schools: {}, companies: {} };
    state.fundedEmployers = payload.fundedEmployers || { activeSnapshotId: null, snapshots: [] };
    const page = pageState();
    if (page && payload.generation) page.generation = payload.generation;
    state.loaded = true;
    state.loadError = null;
  }

  /* ── rendering the list ──────────────────────────────────────────────── */
  const fundedSnapshot = (id) => (state.fundedEmployers.snapshots || []).find((item) => item.id === id) || null;
  function fundedSnapshotLabel(id) {
    const snapshot = fundedSnapshot(id);
    if (!snapshot) return id || "Snapshot unavailable";
    const day = String(snapshot.generatedAt || "").slice(0, 10);
    const companies = Number(snapshot.companyCount || 0);
    const ids = Number(snapshot.reviewedParaformIdCount || 0);
    const bridges = Number(snapshot.reviewedSourceNameCount || 0);
    return companies.toLocaleString() + (companies === 1 ? " company · " : " companies · ")
      + ids.toLocaleString() + (ids === 1 ? " verified company ID · " : " verified company IDs · ")
      + bridges.toLocaleString() + (bridges === 1 ? " reviewed name bridge · as of " : " reviewed name bridges · as of ") + day;
  }
  function describe(condition, rule) {
    const f = field(condition.field);
    if (!f) return "(unknown condition)";
    const value = condition.value;
    if (condition.op === "is") return f.label + (value ? ": yes" : ": no");
    if (condition.op === "between") return f.label + " between " + value[0] + " and " + value[1];
    if (condition.op === "member_of") return f.label + ": " + fundedSnapshotLabel(value);
    if (condition.op === "any_of") {
      const shown = (Array.isArray(value) ? value : [value]).map((v) => {
        if (f.kind === "levels") return (state.degreeLevels.find((l) => l.id === v) || {}).label || v;
        return f.picker ? nameFor(v, rule) : v;
      });
      return f.label + " " + shown.slice(0, 3).join(", ") + (shown.length > 3 ? " and " + (shown.length - 3) + " more" : "");
    }
    const words = { contains: "contains", at_least: "at least", at_most: "at most", after: "after", before: "before" };
    return f.label + " " + (words[condition.op] || condition.op) + " " + value;
  }

  const stateLabel = (value) => ({ live: "Ready", watching: "Preview only", off: "Off" }[value] || "Off");
  function stateOptions(value) {
    return ["live", "watching", "off"].map((item) => '<option value="' + item + '"' +
      (value === item ? " selected" : "") + '>' + stateLabel(item) + '</option>').join("");
  }
  function scopeLabel(rule) {
    const ids = rule.scope?.roleIds || [];
    if (!ids.length) return "All roles";
    const names = Object.fromEntries(roleOptions());
    return ids.map((id) => names[id] || rule.labels?.[id] || id).join(", ");
  }
  function ruleCardHtml(rule) {
    const stats = state.stats[rule.id] || {};
    const id = enc(rule.id);
    const conditions = (rule.conditions || []).map((condition) => enc(describe(condition, rule)) +
      (field(condition.field)?.approximate ? ' <span class="rule-approx">' + (field(condition.field)?.kind === 'text' ? 'text match' : 'estimate') + '</span>' : "")).join(' <span class="rule-and">and</span> ');
    return '<article class="rule-card' + (rule.state === "off" ? ' paused' : '') + '">' +
      '<div class="rule-main"><div class="rule-title-line"><span class="rule-act ' + enc(rule.action) + '">' +
      (rule.action === "interview" ? 'Interview' : 'Pass') + '</span><h3 class="rule-name">' + enc(rule.name) + '</h3></div>' +
      '<p class="rule-summary">' + conditions + '</p><div class="rule-meta"><span>' + enc(scopeLabel(rule)) + '</span><span>' +
      Number(stats.fired || 0).toLocaleString() + ' decisions' +
      (rule.state === "watching" ? ' · ' + Number(stats.wouldFire || 0).toLocaleString() + ' preview matches' : '') +
      '</span></div></div><div class="rule-controls"><select class="rule-state" data-rule-mode="' + id +
      '" aria-label="Run mode for ' + enc(rule.name) + '">' + stateOptions(rule.state) + '</select>' +
      '<button class="rule-edit" data-rule-edit="' + id + '" aria-label="Edit ' + enc(rule.name) + '">Edit</button>' +
      '<details class="rule-more"><summary aria-label="More options for ' + enc(rule.name) + '">•••</summary><div class="rule-menu">' +
      '<button data-rule-hits="' + id + '">View history</button><button data-rule-dupe="' + id + '">Duplicate rule</button>' +
      '<button class="danger" data-rule-del="' + id + '">Delete rule</button></div></details></div></article>';
  }

  function render() {
    const host = el("rulesView");
    if (!host) return;
    if (!state.loaded) {
      host.innerHTML = '<div class="rules-empty" role="status">' + (state.loadError ?
        '<h3>Rules couldn’t load</h3><p>' + enc(state.loadError) + '</p><button class="ghost" id="rulesRetry">Try again</button>' : 'Loading rules…') + '</div>';
      if (el("rulesRetry")) el("rulesRetry").onclick = () => window.RaydarRules.show();
      return;
    }
    const live = state.rules.filter((r) => r.state === "live").length;
    const watching = state.rules.filter((r) => r.state === "watching").length;
    const pending = pageState()?.snapshot && typeof pendingRows === "function" ? pendingRows().length : null;
    const result = state.lastRun;
    const skipped = Object.values(result?.skipped || {}).reduce((sum, n) => sum + Number(n || 0), 0);
    const resultText = !result ? "" : result.parked
      ? "No decisions made: " + result.parked.replaceAll("_", " ") + "."
      : Number(result.considered ?? result.pending ?? 0).toLocaleString() + " applicants checked · " + Number(result.decided || 0).toLocaleString() + " decisions · " + skipped.toLocaleString() + " rule checks skipped";
    host.innerHTML = '<div class="rules-head"><div class="grow"><div class="rules-eyebrow">Manual only</div>' +
      '<h2>Rules</h2><p>Choose what matters. Run when you’re ready.</p></div><div class="rules-actions">' +
      '<button class="ghost" id="rulesNew">＋ New rule</button><button class="primary" id="rulesRun"' +
      (state.running || state.pausedAll || state.loadError || pending === null || (!live && !watching) ? ' disabled' : '') + '>' +
      (state.running ? 'Running…' : 'Run rules now') + '</button></div></div>' +
      '<div class="rules-context"><span>' + (pending === null ? 'Waiting for applicants…' : pending.toLocaleString() + ' awaiting review') +
      ' <span aria-hidden="true">·</span> ' + live + ' ready' + (watching ? ' · ' + watching + ' preview only' : '') +
      '</span><button class="rules-pause" id="rulesPause">' + (state.pausedAll ? 'Resume rules' : 'Pause all') + '</button></div>' +
      (state.loadError ? '<div class="rule-run-result" role="alert">Rules could not refresh: ' + enc(state.loadError) + ' <button id="rulesRetry">Try again</button></div>' : '') +
      (resultText ? '<div class="rule-run-result" role="status">' + enc(resultText) + '</div>' : '') +
      (state.pausedAll ? '<div class="rule-run-result">All rules are paused; resume them when you’re ready to run.</div>' : '') +
      (state.rules.length ? '<div class="rules-list">' + state.rules.map(ruleCardHtml).join('') + '</div>' :
        '<div class="rules-empty"><div class="rules-empty-icon" aria-hidden="true">＋</div><h3>Your judgment, saved.</h3><p>Create a rule here, or choose a school, company, or other fact in an applicant’s profile.</p><button class="ghost" id="rulesNewEmpty">Create a rule</button></div>') +
      '<details class="rules-help"><summary>How rules work</summary><p>Rules run only when you press this button: <b>Run rules now</b>. Saving or changing a rule never runs it. Ready rules make decisions; Preview only rules count matches.</p><p>Rules check all undecided applicants in the published review queue, across every tier, and leave existing decisions alone. Interview rules skip applicants already emailed for that role. Missing facts are skipped. If rules disagree, Pass takes priority.</p><p>Interview decisions enter the existing invitation process and can be held by its checks; a match is not proof of an email being sent.</p></details>';
    el("rulesPause").onclick = togglePause;
    el("rulesRun").onclick = runRules;
    if (el("rulesRetry")) el("rulesRetry").onclick = () => window.RaydarRules.show();
    for (const id of ["rulesNew", "rulesNewEmpty"]) if (el(id)) el(id).onclick = () => openEditor(null);
    host.querySelectorAll('[data-rule-mode]').forEach((select) => {
      select.onchange = () => setRuleState(select.dataset.ruleMode, select.value);
    });
    paintBadge();
  }

  /* ── the editor ──────────────────────────────────────────────────────── */
  function blankRule() {
    return { id: null, name: "", note: "", action: "interview", state: "live", scope: { roleIds: [] }, conditions: [] };
  }

  function openEditor(rule) {
    if (state.running) return;
    if (!state.loaded || state.loadError) { toast("Reload Rules before editing.", true); return; }
    state.modalSerial += 1;
    state.returnFocus = document.activeElement;
    state.draft = rule ? JSON.parse(JSON.stringify(rule)) : blankRule();
    state.editorRev = state.rev;
    state.scopeSelected = Boolean(state.draft.scope?.roleIds?.length);
    state.staleDraft = false;
    state.preview = null;
    state.previewError = null;
    renderEditor();
    showEditor();
    schedulePreview();
  }
  function showEditor() {
    if (typeof ensureRoom === "function") ensureRoom();
    el("ruleEditor").classList.add("on");
    placeEditor();
    if (typeof lockOuterScroll === "function") lockOuterScroll(true);
    el("ruleEditorCard").focus();
  }
  function placeEditor() {
    const overlay = el("ruleEditor");
    if (!overlay?.classList.contains("on")) return;
    const embedded = typeof parentWin === "function" && parentWin();
    const band = typeof viewBand === "function" ? viewBand() : null;
    overlay.classList.toggle("embedded", Boolean(embedded));
    overlay.style.top = embedded && band ? band.top + 'px' : '';
    overlay.style.height = embedded && band ? Math.max(0, band.bottom - band.top) + 'px' : '';
  }
  function closeEditor() {
    if (state.saving) return;
    state.modalSerial += 1;
    state.previewSerial += 1;
    clearTimeout(previewTimer);
    state.draft = null;
    state.previewing = false;
    el("ruleEditor").classList.remove("on");
    if (typeof lockOuterScroll === "function") lockOuterScroll(false);
    if (typeof OVERLAY !== "undefined" && OVERLAY.restoreScroll != null) {
      try { parentWin()?.scrollTo({ top: OVERLAY.restoreScroll, behavior: "auto" }); } catch {}
      OVERLAY.restoreScroll = null;
    }
    if (state.returnFocus?.isConnected && state.returnFocus.getClientRects().length) state.returnFocus.focus();
    else (viewIsRules() ? el("rulesNew") : el("pillRules"))?.focus();
  }
  function suggestedName(draft) {
    return (draft.conditions || []).map((c) => describe(c, draft)).join(' + ').slice(0, 80) || "New rule";
  }
  function modeSummary(value) {
    return value === 'off' ? 'Saved as Off.' : value === 'watching' ? 'Preview only on your next run.' : 'Ready for your next manual run.';
  }
  function preparedDraft(draft) {
    return { ...draft, name: draft.name.trim() || suggestedName(draft), labels: labelsForDraft(draft) };
  }

  /* THE PICKER RENDERS A WINDOW OVER THE DIRECTORY, AND THE FILTER SEARCHES
     THE WHOLE OF IT. The directories are far bigger than a checkbox list can
     hold (measured 2026-08-25: 1,464 schools, 5,496 companies), so only the
     first PICK_WINDOW entries are ever drawn. That cap is only safe because
     the filter re-renders from the full list: filtering by hiding already-
     drawn rows — which is what this did until 2026-08-25 — makes every entry
     past the cap unreachable no matter what you type. Alphabetically the
     schools cap fell in the G's, so UC Berkeley, Yale and Stanford could not
     be picked at all, and 5,096 of the companies were invisible. */
  const PICK_WINDOW = 400;
  /* condition index -> its full [id, label] list, so the filter can search
     the directory rather than the DOM. Rebuilt on every editor render. */
  const pickOptions = {};

  function pickListHtml(options, chosen, index, needle) {
    const term = String(needle || "").trim().toLowerCase();
    // A chosen entry always survives the filter: an edit must never hide its
    // own selection, which is also what keeps the checkbox list truthful.
    const hits = term
      ? options.filter(([id, label]) => chosen.includes(id) || String(label).toLowerCase().includes(term))
      : options;
    const shown = hits.slice(0, PICK_WINDOW);
    const labels = shown.map(([id, label]) =>
      '<label><input type="checkbox" data-ci="' + index + '" data-part="pick" value="' + enc(id) + '"' +
      (chosen.includes(id) ? " checked" : "") + "><span>" + enc(label) + "</span></label>").join("");
    if (hits.length > shown.length) {
      return labels + '<div class="pickmore">' + (hits.length - shown.length) +
        " more — type above to narrow the list.</div>";
    }
    if (!hits.length) return '<div class="pickmore">Nothing here matches that.</div>';
    return labels;
  }

  function pickerSummary(condition, options) {
    const chosen = Array.isArray(condition.value) ? condition.value : [];
    if (!chosen.length) return 'Choose…';
    const labels = Object.fromEntries(options);
    return chosen.slice(0, 2).map((id) => labels[id] || nameFor(id, state.draft)).join(', ') + (chosen.length > 2 ? ' + ' + (chosen.length - 2) + ' more' : '');
  }

  function valueControl(condition, index) {
    const f = field(condition.field);
    if (!f) return "";
    if (f.kind === "bool") {
      return '<select class="v" data-ci="' + index + '" data-part="value" aria-label="Condition value">' +
        '<option value="true"' + (condition.value === true ? " selected" : "") + ">Yes</option>" +
        '<option value="false"' + (condition.value === false ? " selected" : "") + ">No</option></select>";
    }
    if (f.kind === "snapshot") {
      const snapshots = [...(state.fundedEmployers.snapshots || [])];
      if (condition.value && !snapshots.some((item) => item.id === condition.value)) {
        snapshots.push({ id: condition.value, unavailable: true });
      }
      return '<div class="v"><select data-ci="' + index + '" data-part="value" aria-label="Funded employer snapshot">' +
        (snapshots.length ? snapshots.map((item) => '<option value="' + enc(item.id) + '"' +
          (condition.value === item.id ? ' selected' : '') + '>' + enc(item.unavailable ? item.id + ' (unavailable)' : fundedSnapshotLabel(item.id)) + '</option>').join('')
          : '<option value="">No verified snapshot imported</option>') + '</select>' +
        '<details class="hint"><summary>About this list</summary><p>Private verified company research from ' +
        enc((fundedSnapshot(condition.value) || {}).provider || 'verified sources') +
        '. US, UK and Canada; at least $1m total funding; Seed through Series D round from Sep 5, 2011 through Sep 5, 2026. Work history matches through a verified Paraform company ID, or—when the source omitted an ID—an exact company name separately checked across Paraform CRM and against the official domain. Ambiguous or unreviewed names cannot match.</p></details></div>';
    }
    if (f.kind === "levels" || f.kind === "ranks" || f.kind === "tiers" || f.kind === "ids") {
      const chosen = Array.isArray(condition.value) ? condition.value : [];
      let options = [];
      if (f.kind === "levels") options = state.degreeLevels.map((l) => [l.id, l.label]);
      else if (f.kind === "ranks") options = ["S", "A", "B", "C"].map((r) => [r, r + " tier"]);
      else if (f.kind === "tiers") options = ["S", "A", "B", "C"].map((r) => [r, r + " tier"]).concat([["unrated", "Unrated"]]);
      else if (f.picker === "schools") options = Object.entries(state.directories.schools);
      else if (f.picker === "companies") options = Object.entries(state.directories.companies);
      else if (f.picker === "roles") options = roleOptions();

      // Directories run to thousands, so a picker over one gets a filter box.
      // Chosen entries are pinned to the top so an edit never hides its own
      // selection behind a search term.
      for (const id of chosen) if (!options.some(([key]) => key === id)) options.push([id, nameFor(id, state.draft)]);
      const big = options.length > 12;
      options.sort((a, b) => {
        const pick = chosen.includes(b[0]) - chosen.includes(a[0]);
        return pick || String(a[1]).localeCompare(String(b[1]));
      });
      pickOptions[index] = options;
      return '<div class="v"><details class="rule-picker"' + (chosen.length ? '' : ' open') + '><summary data-pick-summary="' + index + '">' +
        enc(pickerSummary(condition, options)) + '</summary><div class="rule-picker-body">' +
        (big ? '<input class="picksearch" type="text" placeholder="Search all ' + options.length + '…" data-ci="' + index + '" data-part="filter" aria-label="Search choices">' : "") +
        '<div class="multi" data-ci="' + index + '">' + pickListHtml(options, chosen, index, "") +
        "</div></div></details></div>";
    }
    if (condition.op === "between") {
      const v = Array.isArray(condition.value) ? condition.value : ["", ""];
      return '<div class="v" style="display:flex;gap:6px">' +
        '<input type="text" inputmode="numeric" value="' + enc(v[0]) + '" data-ci="' + index + '" data-part="from" placeholder="from" aria-label="From">' +
        '<input type="text" inputmode="numeric" value="' + enc(v[1]) + '" data-ci="' + index + '" data-part="to" placeholder="to" aria-label="To"></div>';
    }
    return '<input class="v" type="text" value="' + enc(condition.value == null ? "" : condition.value) + '" ' +
      'data-ci="' + index + '" data-part="value" aria-label="Condition value" placeholder="' + (f.kind === "number" || f.kind === "year" ? "number" : "text") + '">';
  }

  function roleOptions() {
    const seen = new Map();
    const s = pageState();
    const rows = (s && s.snapshot && s.snapshot.queue) || [];
    for (const row of rows) if (row.roleId && !seen.has(row.roleId)) seen.set(row.roleId, row.roleTitle || row.roleId);
    return [...seen.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }

  function conditionHtml(condition, index) {
    const f = field(condition.field);
    const group = f ? f.group : "applicant";
    const choices = state.catalog.filter((c) => c.group === group);
    return '<div class="cond">' +
      '<select class="f" data-ci="' + index + '" data-part="field" aria-label="Condition field">' +
        choices.map((c) => '<option value="' + enc(c.name) + '"' + (c.name === condition.field ? " selected" : "") + ">" + enc(c.label) + "</option>").join("") +
      "</select>" +
      (f?.ops.length === 1 ? '<span class="o rule-fixed-op">' + enc({ any_of: 'is', contains: 'contains', is: 'is', member_of: 'in verified list' }[condition.op] || condition.op) + '</span>' : '<select class="o" data-ci="' + index + '" data-part="op" aria-label="Comparison">' +
        (f ? f.ops : []).map((o) => '<option value="' + enc(o) + '"' + (o === condition.op ? " selected" : "") + ">" +
          enc({ any_of: "is one of", contains: "contains", is: "is", at_least: "at least", at_most: "at most", after: "after", before: "before", between: "between", member_of: "in verified list" }[o] || o) + "</option>").join("") +
      "</select>") +
      valueControl(condition, index) +
      '<button class="x" data-ci="' + index + '" data-part="remove" aria-label="Remove condition">✕</button>' +
    "</div>";
  }

  function renderEditor() {
    const draft = state.draft;
    if (!draft) return;
    for (const key of Object.keys(pickOptions)) delete pickOptions[key];
    const byGroup = new Map();
    draft.conditions.forEach((condition, index) => {
      const f = field(condition.field);
      const group = f ? f.group : "applicant";
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push([condition, index]);
    });

    const groups = state.groups.map((group) => {
      const rows = byGroup.get(group.id) || [];
      if (!rows.length) return "";
      return '<div class="cgroup"><h4>' + enc(group.label) + "</h4>" +
        (group.note ? '<p class="note">' + enc(group.note) + "</p>" : "") +
        rows.map(([condition, index]) => conditionHtml(condition, index)).join("") + "</div>";
    }).join("");

    const addOptions = state.groups.map((group) =>
      '<optgroup label="' + enc(group.label) + '">' +
      state.catalog.filter((c) => c.group === group.id)
        .map((c) => '<option value="' + enc(c.name) + '">' + enc(c.label) + "</option>").join("") +
      "</optgroup>").join("");

    const scoped = draft.scope?.roleIds || [];
    const scopedMode = state.scopeSelected || scoped.length > 0;
    const roles = roleOptions();
    for (const id of scoped) if (!roles.some(([key]) => key === id)) roles.push([id, draft.labels?.[id] || id]);
    el("ruleEditorCard").innerHTML =
      '<div class="redit-head"><div><div class="rules-eyebrow">' + (draft.id ? 'Saved rule' : 'New rule') + '</div><h3 id="ruleEditorTitle">' +
      (draft.id ? enc(draft.name) : 'What should we look for?') + '</h3></div><button class="redit-close" id="ruleClose" aria-label="Close rule editor">✕</button></div>' +
      '<div class="redit-body"><section class="rule-step"><div class="rule-step-title"><span>1</span><h4>Match these conditions</h4></div><p class="hint">All conditions must match the same applicant.</p>' +
      (groups || '<div class="rule-start">Choose a fact below to begin, such as a school or job title.</div>') +
      '<select class="addcond" id="ruleAddCond" aria-label="Add a condition"><option value="">＋ Add a condition</option>' + addOptions + '</select></section>' +
      '<section class="rule-step"><div class="rule-step-title"><span>2</span><h4>Choose what happens</h4></div><div class="rule-outcomes">' +
      ['interview', 'pass'].map((action) => '<button type="button" data-draft-action="' + action + '" aria-pressed="' + (draft.action === action) + '" class="rule-outcome' + (draft.action === action ? ' selected' : '') + '"><b>' +
      (action === 'interview' ? 'Interview' : 'Pass') + '</b><span>' + (action === 'interview' ? 'Request an invitation' : 'Move out of review') + '</span></button>').join('') + '</div></section>' +
      previewHtml() +
      '<details class="rule-settings"' + (scopedMode ? ' open' : '') + '><summary>Name, scope & settings</summary><div class="rule-settings-body">' +
      '<label for="ruleName">Rule name</label><input id="ruleName" type="text" maxlength="80" value="' + enc(draft.name) + '" placeholder="' + enc(suggestedName(draft)) + '">' +
      '<p class="hint">Leave blank to name it from your conditions.</p>' +
      '<label for="ruleScopeMode">Applies to</label><select id="ruleScopeMode"><option value="all"' + (!scopedMode ? ' selected' : '') + '>All roles</option><option value="selected"' + (scopedMode ? ' selected' : '') + '>Selected roles</option></select>' +
      '<div id="ruleScopeChoices" class="multi"' + (!scopedMode ? ' hidden' : '') + '>' + roles.map(([id,label]) => '<label><input type="checkbox" data-rule-scope="' + enc(id) + '"' + (scoped.includes(id) ? ' checked' : '') + '><span>' + enc(label) + '</span></label>').join('') + '</div>' +
      '<label for="ruleMode">When I run rules</label><select id="ruleMode">' + stateOptions(draft.state) + '</select>' +
      '<label for="ruleNote">Note <span>(optional)</span></label><textarea id="ruleNote" maxlength="400" placeholder="Why this rule matters">' + enc(draft.note) + '</textarea></div></details></div>' +
      '<div class="redit-foot"><div class="redit-foot-note"><span id="ruleModeSummary">' + modeSummary(draft.state) + '</span><br>Saving never runs a rule.<span class="redit-err" id="ruleErr" role="alert"></span></div><div class="spacer"><button class="ghost" id="ruleCancel">Cancel</button><button class="primary" id="ruleSave">Save rule</button></div></div>';

    wireEditor();
  }

  function previewHtml() {
    if (state.previewing) return '<div class="preview" role="status"><div class="sub">Checking matches…</div></div>';
    if (state.previewError) return '<div class="preview preview-error" role="status"><b>Preview unavailable</b><div class="sub">' + enc(state.previewError) + '</div></div>';
    const preview = state.preview;
    if (!preview) return '<div class="preview" role="status"><div class="sub">Your matching applicants will appear here.</div></div>';
    const skips = Object.entries(preview.skipped || {});
    const behavior = state.draft.state === 'off' ? 'This rule is Off and will be skipped when you run rules.' : state.draft.state === 'watching' ? 'Preview only counts these matches when you run rules; it makes no decisions.' : (state.draft.action === 'interview' ? 'These applicants would get an interview request when you run rules.' : 'These applicants would be passed when you run rules.');
    const words = { already_emailed: 'already emailed for this role', no_profile_history: 'missing work or education history', no_facts_yet: 'waiting for profile data', facts_version_stale: 'waiting for updated profile data', employment_history_not_refreshed: 'waiting for full employer history refresh', no_employment_history: 'missing employment history', employment_company_id_missing: 'employer has no reviewed identity', membership_snapshot_missing: 'verified employer snapshot unavailable' };
    return '<div class="preview" role="status"><div class="preview-heading"><span class="n">' + Number(preview.matched).toLocaleString() + '</span><span>matching applicant' + (preview.matched === 1 ? '' : 's') + '</span></div>' +
      '<div class="sub">Out of ' + Number(preview.considered).toLocaleString() + ' awaiting review in this rule’s scope. ' + behavior + '</div>' +
      (skips.length ? '<details class="skips"><summary>' + skips.reduce((sum, [,n]) => sum + Number(n), 0).toLocaleString() + ' skipped for missing facts or other checks</summary><p>' +
        skips.map(([reason,count]) => Number(count).toLocaleString() + ' ' + enc(words[reason] || reason.replaceAll('_', ' '))).join('<br>') + '</p></details>' : '') +
      (preview.samples?.length ? '<div class="samples">' + preview.samples.map((sample) => '<span>' + enc(sample.name || sample.key) + '</span>').join('') + '</div>' : '') + '</div>';
  }

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    state.previewSerial += 1;
    state.preview = null;
    state.previewError = null;
    state.previewing = Boolean(state.draft?.conditions.length);
    repaintPreview();
    previewTimer = setTimeout(runPreview, 420);
  }
  async function runPreview() {
    const draft = state.draft;
    const serial = state.previewSerial;
    if (!draft || !draft.conditions.length) { state.previewing = false; repaintPreview(); return; }
    if (state.scopeSelected && !draft.scope?.roleIds?.length) {
      state.previewing = false; state.previewError = 'Choose at least one role, or use All roles.'; repaintPreview(); return;
    }
    const request = { op: 'preview', rule: preparedDraft(draft), ...applicantGeneration() };
    try {
      const preview = await api(request);
      if (serial !== state.previewSerial || state.draft !== draft) return;
      state.preview = preview;
    } catch (error) {
      if (serial !== state.previewSerial || state.draft !== draft) return;
      state.previewError = error.message === 'generation_changed_refresh_required'
        ? 'The applicant list changed; close this editor, refresh Applicants, and try again.' : error.message;
    }
    if (serial === state.previewSerial && state.draft === draft) { state.previewing = false; repaintPreview(); }
  }
  function repaintPreview() {
    const host = el("ruleEditorCard");
    if (!host) return;
    const current = host.querySelector(".preview");
    if (!current) return;
    const holder = document.createElement("div");
    holder.innerHTML = previewHtml();
    current.replaceWith(holder.firstChild);
  }

  function defaultValueFor(f) {
    if (f.kind === "bool") return true;
    if (f.kind === "snapshot") return state.fundedEmployers.activeSnapshotId || "";
    if (["ids", "levels", "ranks", "tiers"].includes(f.kind)) return [];
    if (f.kind === "number" || f.kind === "year") return "";
    return "";
  }

  /** Toggling one entry in a picker. Shared, because the filter redraws the
   *  list and the redrawn checkboxes must behave exactly like the first ones. */
  const pickHandler = (condition) => (e) => {
    const list = Array.isArray(condition.value) ? condition.value.slice() : [];
    const at = list.indexOf(e.target.value);
    if (e.target.checked && at < 0) list.push(e.target.value);
    if (!e.target.checked && at >= 0) list.splice(at, 1);
    condition.value = list;
    const summary = el("ruleEditorCard")?.querySelector('[data-pick-summary="' + e.target.dataset.ci + '"]');
    if (summary) summary.textContent = pickerSummary(condition, pickOptions[e.target.dataset.ci] || []);
    schedulePreview();
  };

  function bindPicks(container, condition) {
    container.querySelectorAll('input[data-part="pick"]').forEach((box) => {
      box.onchange = pickHandler(condition);
    });
  }

  function wireEditor() {
    const draft = state.draft;
    el("ruleName").oninput = (e) => { draft.name = e.target.value; schedulePreview(); };
    el("ruleNote").oninput = (e) => { draft.note = e.target.value; };
    el("ruleClose").onclick = closeEditor;
    el("ruleMode").onchange = (e) => { draft.state = e.target.value; if (el("ruleModeSummary")) el("ruleModeSummary").textContent = modeSummary(draft.state); repaintPreview(); };
    el("ruleScopeMode").onchange = (e) => {
      state.scopeSelected = e.target.value === 'selected';
      el("ruleScopeChoices").hidden = !state.scopeSelected;
      if (e.target.value === 'all') { draft.scope = { roleIds: [] }; el("ruleScopeChoices").querySelectorAll('input').forEach((box) => { box.checked = false; }); }
      schedulePreview();
    };
    el("ruleEditorCard").querySelectorAll('[data-rule-scope]').forEach((box) => { box.onchange = () => {
      draft.scope = { roleIds: [...el("ruleScopeChoices").querySelectorAll('input:checked')].map((node) => node.dataset.ruleScope) };
      schedulePreview();
    }; });
    el("ruleEditorCard").querySelectorAll('[data-draft-action]').forEach((button) => { button.onclick = () => {
      draft.action = button.dataset.draftAction;
      el("ruleEditorCard").querySelectorAll('[data-draft-action]').forEach((other) => { const selected = other === button; other.classList.toggle('selected', selected); other.setAttribute('aria-pressed', String(selected)); });
      schedulePreview();
    }; });
    el("ruleCancel").onclick = closeEditor;
    el("ruleSave").onclick = saveDraft;
    el("ruleAddCond").onchange = (e) => {
      const f = field(e.target.value);
      if (!f) return;
      draft.conditions.push({ field: f.name, op: f.ops[0], value: defaultValueFor(f) });
      renderEditor();
      schedulePreview();
    };

    const card = el("ruleEditorCard");
    card.querySelectorAll("[data-ci]").forEach((node) => {
      const index = Number(node.dataset.ci);
      const part = node.dataset.part;
      const condition = draft.conditions[index];
      if (!condition) return;
      if (part === "remove") {
        node.onclick = () => { draft.conditions.splice(index, 1); renderEditor(); schedulePreview(); };
      } else if (part === "field") {
        node.onchange = (e) => {
          const f = field(e.target.value);
          draft.conditions[index] = { field: f.name, op: f.ops[0], value: defaultValueFor(f) };
          renderEditor(); schedulePreview();
        };
      } else if (part === "op") {
        node.onchange = (e) => {
          condition.op = e.target.value;
          if (condition.op === "between") condition.value = ["", ""];
          else if (Array.isArray(condition.value)) condition.value = defaultValueFor(field(condition.field));
          renderEditor(); schedulePreview();
        };
      } else if (part === "pick") {
        node.onchange = pickHandler(condition);
      } else if (part === "filter") {
        node.oninput = (e) => {
          const list = node.parentNode.querySelector(".multi");
          if (!list) return;
          const chosen = Array.isArray(condition.value) ? condition.value : [];
          list.innerHTML = pickListHtml(pickOptions[index] || [], chosen, index, e.target.value);
          // The rows are new elements, so they carry none of wireEditor's
          // handlers — rebinding here is what keeps a filtered row clickable.
          bindPicks(list, condition);
        };
      } else if (part === "from" || part === "to") {
        node.oninput = () => {
          const inputs = card.querySelectorAll('[data-ci="' + index + '"][data-part="from"], [data-ci="' + index + '"][data-part="to"]');
          condition.value = [...inputs].map((input) => input.value.trim() === "" ? "" : Number(input.value));
          schedulePreview();
        };
      } else if (part === "value") {
        const f = field(condition.field);
        node.oninput = node.onchange = (e) => {
          const raw = e.target.value;
          condition.value = f.kind === "bool" ? raw === "true"
            : (f.kind === "number" || f.kind === "year") ? (raw.trim() === "" ? "" : Number(raw))
              : raw;
          schedulePreview();
        };
      }
    });
  }

  /** Every id the draft references, with the best name we can show for it. */
  function labelsForDraft(draft) {
    const labels = { ...(draft.labels || {}) };
    for (const condition of draft.conditions || []) {
      const f = field(condition.field);
      if (!f || !f.picker || !Array.isArray(condition.value)) continue;
      const source = f.picker === "schools" ? state.directories.schools
        : f.picker === "companies" ? state.directories.companies
          : Object.fromEntries(roleOptions());
      for (const id of condition.value) if (source[id]) labels[id] = source[id];
    }
    const roles = Object.fromEntries(roleOptions());
    for (const id of draft.scope?.roleIds || []) if (roles[id]) labels[id] = roles[id];
    return labels;
  }

  async function saveDraft() {
    if (state.saving || !state.draft) return;
    const error = el("ruleErr");
    error.textContent = "";
    if (state.staleDraft) { error.textContent = 'Rules changed elsewhere; close and reopen this rule to review the latest version.'; return; }
    if (el("ruleScopeMode").value === 'selected' && !state.draft.scope?.roleIds?.length) { error.textContent = 'Choose at least one role, or use All roles.'; return; }
    state.saving = true;
    el("ruleSave").disabled = true;
    try {
      await api({ op: "save", rev: state.editorRev, rule: preparedDraft(state.draft) });
      state.saving = false;
      closeEditor();
      try { await load(); } catch (refreshError) { state.loadError = refreshError.message; }
      render(); paintBadge();
      toast("Rule saved; it will only run when you choose Run rules now.");
    } catch (e) {
      error.textContent = e.message;
    } finally {
      state.saving = false;
      const save = el("ruleSave");
      if (save) save.disabled = state.staleDraft;
    }
  }

  /* ── list actions ────────────────────────────────────────────────────── */
  async function togglePause() {
    if (state.running) return;
    try {
      await api({ op: "pauseAll", rev: state.rev, paused: !state.pausedAll });
      await load(); render();
      toast(state.pausedAll ? "All rules paused." : "Rules enabled for manual runs.");
    } catch (e) { toast(e.message, true); }
  }

  async function runRules() {
    if (state.running || state.pausedAll || state.loadError || !pageState()?.snapshot) return;
    const pending = typeof pendingRows === "function" ? pendingRows().length : 0;
    const active = state.rules.filter((r) => r.state === "live" || r.state === "watching").length;
    if (!active) { toast("There are no Ready or Preview only rules to run.", true); return; }
    if (!window.confirm("Run " + active + " active rule" + (active === 1 ? "" : "s") + " against all "
      + pending.toLocaleString() + " pending applicants now?\n\nReady rules may record Interview or Pass decisions; Preview only rules never write decisions.")) return;
    state.running = true;
    state.lastRun = null;
    render();
    try {
      const response = await fetch("/api/applicants/rules-tick", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(applicantGeneration()),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        if (typeof showGate === "function") showGate();
        throw new Error("Signed out — sign in and run again.");
      }
      if (!response.ok || payload.ok === false) throw new Error(payload.detail || payload.error || "Rule run failed.");
      state.lastRun = payload;
      if (typeof loadFeed === "function") await loadFeed();
      await load();
      toast(payload.parked
        ? "Rules did not run: " + payload.parked.replaceAll("_", " ") + "."
        : "Rules checked " + Number(payload.considered || payload.pending || 0).toLocaleString()
          + " applicants and made " + Number(payload.decided || 0).toLocaleString() + " decisions.", Boolean(payload.parked));
    } catch (e) {
      toast(e.message, true);
    } finally {
      state.running = false;
      render();
      paintBadge();
    }
  }

  async function setRuleState(id, next) {
    const rule = state.rules.find((r) => r.id === id);
    if (!rule || rule.state === next || state.running) { render(); return; }
    try {
      await api({ op: "setState", rev: state.rev, id, state: next });
      await load(); render();
    } catch (e) { render(); toast(e.message, true); }
  }

  async function deleteRule(id) {
    if (state.running) return;
    const rule = state.rules.find((r) => r.id === id);
    if (!rule || !window.confirm('Delete "' + rule.name + '"? Decisions it already made are not affected.')) return;
    try {
      await api({ op: "delete", rev: state.rev, id });
      await load(); render();
      toast("Rule deleted.");
    } catch (e) { toast(e.message, true); }
  }

  async function showHits(id) {
    const serial = ++state.modalSerial;
    const rule = state.rules.find((r) => r.id === id);
    try {
      const payload = await api({ op: "hits", id });
      if (serial !== state.modalSerial) return;
      state.draft = null;
      el("ruleEditorCard").innerHTML =
        '<h3 id="ruleEditorTitle">' + enc(rule ? rule.name : "Rule") + "</h3>" +
        '<p class="hint">Recent decisions made by this rule, newest first; preview matches do not appear here.</p>' +
        (payload.hits.length
          ? '<ul class="hits-list">' + payload.hits.map((hit) =>
            "<li><b>" + enc(hit.name || hit.key) + "</b> · " + enc(hit.roleTitle || "") +
            ' <span style="color:var(--ink-3)">' + enc(hit.at ? hit.at.slice(0, 16).replace("T", " ") : "") + "</span>" +
            '<div class="why">' + enc((hit.evidence || []).map((e) => e.matched).join(" · ")) + "</div></li>").join("") + "</ul>"
          : '<div class="rules-empty" style="padding:20px"><p>This rule has not made any decisions yet.</p></div>') +
        '<div class="redit-foot"><span class="spacer"><button class="ghost" id="ruleCancel">Close</button></span></div>';
      el("ruleCancel").onclick = closeEditor;
      state.returnFocus = document.activeElement;
      showEditor();
    } catch (e) { toast(e.message, true); }
  }

  /* ── "Make this a rule" from an open profile ─────────────────────────── */
  async function fromApplicant(cuId, row, seed) {
    mount();
    try {
      await load();
      if (!seed?.conditions?.length) {
        if (window.RaydarRuleFacts) window.RaydarRuleFacts.start(cuId, row);
        return;
      }
      const draft = { ...blankRule(), ...seed, id: null };
      if (typeof dismissProfile === 'function') dismissProfile();
      openEditor(draft);
    } catch (error) { toast(error.message, true); }
  }

  /* ── the optional reason chip row after a Pass ───────────────────────── */
  let reasonTimer = null;
  function offerReason(key, row) {
    const bar = el("reasonBar");
    if (!bar) return;
    clearTimeout(reasonTimer);
    bar.innerHTML =
      '<div class="q">Passed <b>' + enc((row && row.name) || "this applicant") + "</b>. Why? <i>(optional)</i></div>" +
      '<div class="chips2">' +
      PASS_REASONS.map(([id, label]) => '<button data-reason="' + id + '">' + enc(label) + "</button>").join("") +
      '<button class="skip" data-reason="">Skip</button></div>';
    bar.classList.add("on");
    bar.querySelectorAll("[data-reason]").forEach((button) => {
      button.onclick = async () => {
        const reason = button.dataset.reason;
        bar.classList.remove("on");
        if (!reason) return;
        try {
          // Re-writes the same decision with the reason attached. The record is
          // already saved, so a failure here loses the reason and nothing else.
          const page = pageState();
          const existing = page?.local?.[key] || page?.decisions?.[key] || {};
          await fetch("/api/applicants/decision", {
            method: "POST", credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key, action: "pass", reason, ...applicantGeneration(),
              requestId: existing.requestId, inputRevision: row?.inputRevision,
              readinessRevision: row?.readinessRevision, decisionRevision: row?.decisionRevision,
              name: row && row.name, roleTitle: row && row.roleTitle }),
          });
        } catch { /* the pass itself already stands */ }
      };
    });
    // Long enough to notice and use, short enough not to follow you down the
    // queue. Reviewing is the job; this is a bonus.
    reasonTimer = setTimeout(() => bar.classList.remove("on"), 7000);
  }

  /* ── boot ────────────────────────────────────────────────────────────── */
  function mount() {
    if (el("ruleEditor")) return;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const bar = document.createElement("div");
    bar.className = "reasonbar";
    bar.id = "reasonBar";
    document.body.appendChild(bar);

    const overlay = document.createElement("div");
    overlay.className = "redit";
    overlay.id = "ruleEditor";
    overlay.innerHTML = '<div class="redit-card" id="ruleEditorCard" role="dialog" aria-modal="true" aria-labelledby="ruleEditorTitle" tabindex="-1"></div>';
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEditor(); });
    document.body.appendChild(overlay);
    document.addEventListener("keydown", (e) => {
      if (!overlay.classList.contains("on")) return;
      if (e.key === "Escape") { e.stopImmediatePropagation(); closeEditor(); }
      if (e.key === "Tab") {
        const items = [...overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary')].filter((item) => item.getClientRects().length);
        const first = items[0], last = items[items.length - 1];
        if (!first) return;
        if (e.shiftKey && (document.activeElement === first || document.activeElement === el("ruleEditorCard"))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === el("ruleEditorCard"))) { e.preventDefault(); first.focus(); }
      }
    });

    window.addEventListener("resize", placeEditor);
    window.addEventListener("scroll", placeEditor, { passive: true });
    try { if (typeof parentWin === "function") { const pw = parentWin(); pw?.addEventListener("resize", placeEditor); pw?.addEventListener("scroll", placeEditor, { passive: true }); } } catch {}
    document.addEventListener("click", (e) => {
      document.querySelectorAll('#rulesView .rule-more[open]').forEach((menu) => { if (!menu.contains(e.target)) menu.open = false; });
      const node = e.target.closest ? e.target.closest("[data-rule-state],[data-rule-edit],[data-rule-del],[data-rule-hits],[data-rule-dupe]") : null;
      if (!node) return;
      const menu = node.closest(".rule-more"); if (menu) menu.open = false;
      if (node.dataset.ruleState) return setRuleState(node.dataset.id, node.dataset.ruleState);
      if (node.dataset.ruleEdit) return openEditor(state.rules.find((r) => r.id === node.dataset.ruleEdit));
      if (node.dataset.ruleDupe) {
        const source = state.rules.find((r) => r.id === node.dataset.ruleDupe);
        if (!source) return;
        const copy = JSON.parse(JSON.stringify(source));
        copy.id = null; copy.state = "off"; copy.name = source.name + " (copy)";
        delete copy.versions; delete copy.version; delete copy.createdAt; delete copy.createdBy;
        return openEditor(copy);
      }
      if (node.dataset.ruleDel) return deleteRule(node.dataset.ruleDel);
      if (node.dataset.ruleHits) return showHits(node.dataset.ruleHits);
    });
  }

  function paintBadge() {
    const badge = el("rulesCount");
    if (!badge) return;
    const live = state.pausedAll ? 0 : state.rules.filter((r) => r.state === "live").length;
    badge.textContent = live ? String(live) : "";
  }

  window.RaydarRules = {
    async show() {
      mount();
      // ALWAYS refresh. Rules are shared — a teammate can add or arm one while
      // this tab sits open — and a stale rule list is the one thing that would
      // make somebody arm a duplicate or assume a rule is off when it is live.
      if (!state.loaded) render();
      try { await load(); } catch (e) { state.loadError = e.message; }
      render();
      paintBadge();
    },
    fromApplicant,
    refreshView: () => { if (viewIsRules()) render(); },
    offerReason,
    /** Name for a rule id, so an automatic decision's byline reads in words.
     *  Null until the Rules view has been opened at least once this session. */
    ruleName: (id) => {
      const rule = state.rules.find((r) => r.id === id);
      return rule ? rule.name : null;
    },
    /** Live rule count, for the pill's badge. */
    liveCount: () => (state.pausedAll ? 0 : state.rules.filter((r) => r.state === "live").length),
  };

  /* This script is parsed AFTER the page's inline script has already called
     init(), so a visitor arriving on /applicants#rules has been switched to
     the Rules view before window.RaydarRules existed — setView found nothing
     to call and left the pane empty. Boot therefore does two things: warm the
     rules so the pill badge and automatic-decision bylines are right, and, if
     the Rules view is ALREADY the active one, paint it. */
  function boot() {
    mount();
    load()
      .then(() => {
        paintBadge();
        if (viewIsRules()) render();
      })
      .catch((error) => { state.loadError = error.message; if (viewIsRules()) render(); });
  }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
