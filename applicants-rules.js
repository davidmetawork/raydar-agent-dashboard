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
    draft: null,              // the rule being edited, or null
    preview: null,            // last preview result for the draft
    previewing: false,
    hits: null,               // { ruleId, rows } while the hits panel is open
    running: false,
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
  .rules-head { display:flex; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:16px; }
  .rules-head .grow { flex:1; min-width:240px; }
  .rules-head h2 { margin:0 0 4px; font-size:16px; font-weight:700; }
  .rules-head p { margin:0; font-size:12.5px; color:var(--ink-2); line-height:1.5; max-width:64ch; }
  .rules-actions { display:flex; gap:8px; align-items:center; }
  .manual-run { display:flex; flex-direction:column; align-items:flex-end; gap:5px; }
  .manual-run .note { font-size:10.5px; color:var(--ink-3); }
  .rule-run-result { margin:-5px 0 14px; padding:10px 13px; border:1px solid var(--line); border-radius:10px;
    background:var(--cream); color:var(--ink-2); font-size:12px; line-height:1.45; }
  .killswitch { display:inline-flex; align-items:center; gap:8px; font-size:12px; font-weight:600;
    border:1px solid var(--line); background:var(--card); border-radius:999px; padding:7px 13px; cursor:pointer; }
  .killswitch.on { background:var(--bad-bg); border-color:var(--bad); color:var(--bad); }
  .rule-card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px;
    margin-bottom:10px; box-shadow:var(--shadow); }
  .rule-card.paused { opacity:.62; }
  .rule-top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .rule-name { font-weight:700; font-size:14.5px; }
  .rule-act { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em;
    padding:3px 9px; border-radius:999px; }
  .rule-act.interview { background:var(--good-bg); color:var(--good); }
  .rule-act.pass { background:var(--muted-bg); color:var(--ink-2); }
  .rule-states { margin-left:auto; display:inline-flex; border:1px solid var(--line); border-radius:999px; overflow:hidden; }
  .rule-states button { border:0; background:transparent; font:600 11.5px "Inter Variable",sans-serif;
    padding:6px 12px; cursor:pointer; color:var(--ink-3); }
  .rule-states button.on { background:var(--ink); color:var(--cream); }
  .rule-states button.on[data-rule-state="live"] { background:var(--good); color:#fff; }
  .rule-conds { margin:10px 0 0; padding:0; list-style:none; display:flex; flex-wrap:wrap; gap:6px; }
  .rule-conds li { font-size:12px; background:var(--muted-bg); color:var(--ink-2); border-radius:7px; padding:4px 9px; }
  .rule-conds li.approx::after { content:" ~"; color:var(--warn); font-weight:700; }
  .rule-note { margin:9px 0 0; font-size:12.5px; color:var(--ink-2); font-style:italic; }
  .rule-meta { margin-top:11px; padding-top:10px; border-top:1px solid var(--line-2);
    display:flex; gap:16px; flex-wrap:wrap; font-size:11.5px; color:var(--ink-3); align-items:center; }
  .rule-meta b { color:var(--ink-2); font-variant-numeric:tabular-nums; }
  .rule-meta .spacer { margin-left:auto; display:flex; gap:8px; }
  .rule-meta button { border:1px solid var(--line); background:var(--card); border-radius:8px;
    font:600 11.5px "Inter Variable",sans-serif; padding:4px 10px; cursor:pointer; color:var(--ink-2); }
  .rule-meta button:hover { color:var(--ink); }
  .rule-meta button.danger:hover { color:var(--bad); border-color:var(--bad); }

  .rules-empty { background:var(--card); border:1px dashed var(--line); border-radius:14px;
    padding:34px 24px; text-align:center; color:var(--ink-2); }
  .rules-empty h3 { margin:0 0 6px; font-size:15px; color:var(--ink); }
  .rules-empty p { margin:0 auto 16px; font-size:13px; max-width:52ch; line-height:1.55; }

  .redit { position:fixed; inset:0; background:rgba(20,16,8,.34); display:none; z-index:60;
    align-items:flex-start; justify-content:center; padding:34px 16px; overflow:auto; }
  .redit.on { display:flex; }
  .redit-card { background:var(--card); border-radius:18px; width:min(720px,100%); box-shadow:0 24px 60px -20px rgba(20,16,8,.4);
    padding:22px 24px 20px; }
  .redit h3 { margin:0 0 3px; font-size:16px; }
  .redit .hint { font-size:12px; color:var(--ink-3); margin:0 0 16px; }
  .redit label { display:block; font-size:11px; font-weight:700; text-transform:uppercase;
    letter-spacing:.06em; color:var(--ink-3); margin:0 0 5px; }
  .redit input[type=text], .redit textarea, .redit select {
    width:100%; border:1px solid var(--line); border-radius:9px; padding:8px 10px;
    font:400 13px "Inter Variable",sans-serif; background:var(--cream); color:var(--ink); }
  .redit textarea { resize:vertical; min-height:52px; }
  .redit .row { display:flex; gap:10px; margin-bottom:14px; }
  .redit .row > div { flex:1; }
  .cgroup { border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-bottom:10px; background:var(--cream); }
  .cgroup h4 { margin:0 0 2px; font-size:12.5px; font-weight:700; }
  .cgroup .note { margin:0 0 10px; font-size:11.5px; color:var(--warn); line-height:1.45; }
  .cond { display:flex; gap:8px; align-items:flex-start; margin-bottom:8px; }
  .cond select, .cond input { font-size:12.5px; }
  .cond .f { flex:1.4; } .cond .o { flex:.8; } .cond .v { flex:1.6; }
  .cond .x { border:1px solid var(--line); background:var(--card); border-radius:8px; cursor:pointer;
    width:30px; height:34px; color:var(--ink-3); font-size:14px; flex:none; }
  .cond .x:hover { color:var(--bad); border-color:var(--bad); }
  .multi { border:1px solid var(--line); border-radius:9px; background:var(--cream); padding:6px; max-height:132px; overflow:auto; }
  .multi label { display:flex; gap:7px; align-items:center; text-transform:none; letter-spacing:0;
    font-size:12.5px; font-weight:400; color:var(--ink); margin:0; padding:3px 4px; cursor:pointer; }
  .multi input { width:auto; }
  .picksearch { width:100%; margin-bottom:5px; }
  .pickmore { font-size:11.5px; color:var(--ink-3); padding:4px 4px 2px; }
  .addcond { border:1px dashed var(--line); background:transparent; border-radius:9px; width:100%;
    padding:8px; font:600 12px "Inter Variable",sans-serif; color:var(--ink-2); cursor:pointer; }
  .addcond:hover { color:var(--ink); border-color:var(--ink-3); }
  .preview { border:1px solid var(--line); border-radius:12px; padding:13px 15px; margin:14px 0 4px; background:var(--cream); }
  .preview .n { font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; }
  .preview .sub { font-size:12px; color:var(--ink-2); margin-top:3px; line-height:1.5; }
  .preview .skips { font-size:11.5px; color:var(--ink-3); margin-top:6px; }
  .preview .samples { margin-top:9px; display:flex; flex-wrap:wrap; gap:5px; }
  .preview .samples span { font-size:11.5px; background:var(--card); border:1px solid var(--line);
    border-radius:7px; padding:3px 8px; color:var(--ink-2); }
  .redit-foot { display:flex; gap:9px; align-items:center; margin-top:16px; }
  .redit-foot .spacer { margin-left:auto; display:flex; gap:9px; }
  .redit-err { color:var(--bad); font-size:12.5px; font-weight:600; }
  .hits-list { margin:0; padding:0; list-style:none; }
  .hits-list li { border-bottom:1px solid var(--line-2); padding:9px 0; font-size:12.5px; }
  .hits-list li:last-child { border-bottom:0; }
  .hits-list .why { color:var(--ink-3); font-size:11.5px; margin-top:2px; }

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
      await load();
      throw new Error("Somebody else changed the rules while you were editing. Reloaded — try again.");
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
    const page = pageState();
    if (page && payload.generation) page.generation = payload.generation;
    state.loaded = true;
  }

  /* ── rendering the list ──────────────────────────────────────────────── */
  function describe(condition, rule) {
    const f = field(condition.field);
    if (!f) return "(unknown condition)";
    const value = condition.value;
    if (condition.op === "is") return f.label + (value ? ": yes" : ": no");
    if (condition.op === "between") return f.label + " between " + value[0] + " and " + value[1];
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

  function ruleCardHtml(rule) {
    const stats = state.stats[rule.id] || {};
    const paused = state.pausedAll || rule.state === "off";
    const conds = (rule.conditions || []).map((c) => {
      const f = field(c.field);
      return '<li class="' + (f && f.approximate ? "approx" : "") + '">' + enc(describe(c, rule)) + "</li>";
    }).join("");
    const scope = (rule.scope && rule.scope.roleIds && rule.scope.roleIds.length)
      ? rule.scope.roleIds.length + " role" + (rule.scope.roleIds.length === 1 ? "" : "s")
      : "All roles";
    return '<div class="rule-card' + (paused ? " paused" : "") + '">' +
      '<div class="rule-top">' +
        '<span class="rule-name">' + enc(rule.name) + "</span>" +
        '<span class="rule-act ' + enc(rule.action) + '">' + (rule.action === "interview" ? "Interview" : "Pass") + "</span>" +
        '<span class="rule-states">' +
          ["off", "watching", "live"].map((s) =>
            '<button data-rule-state="' + s + '" data-id="' + enc(rule.id) + '" class="' + (rule.state === s ? "on" : "") + '">' +
            (s === "off" ? "Off" : s === "watching" ? "Watching" : "Live") + "</button>").join("") +
        "</span>" +
      "</div>" +
      '<ul class="rule-conds">' + conds + "</ul>" +
      (rule.note ? '<p class="rule-note">' + enc(rule.note) + "</p>" : "") +
      '<div class="rule-meta">' +
        "<span>" + enc(scope) + "</span>" +
        "<span>Actioned <b>" + (stats.fired || 0) + "</b></span>" +
        (rule.state === "watching" ? "<span>Would have actioned <b>" + (stats.wouldFire || 0) + "</b></span>" : "") +
        "<span>" + (stats.firedAt ? "Last fired " + enc(window.relTime ? window.relTime(stats.firedAt) : stats.firedAt) : "Never fired") + "</span>" +
        '<span class="spacer">' +
          '<button data-rule-hits="' + enc(rule.id) + '">Last 10 it hit</button>' +
          '<button data-rule-edit="' + enc(rule.id) + '">Edit</button>' +
          '<button data-rule-dupe="' + enc(rule.id) + '">Duplicate</button>' +
          '<button class="danger" data-rule-del="' + enc(rule.id) + '">Delete</button>' +
        "</span>" +
      "</div>" +
    "</div>";
  }

  function render() {
    const host = el("rulesView");
    if (!host) return;
    if (!state.loaded) { host.innerHTML = '<div class="empty">Loading rules…</div>'; return; }

    const live = state.rules.filter((r) => r.state === "live").length;
    const watching = state.rules.filter((r) => r.state === "watching").length;
    const pending = typeof pendingRows === "function" ? pendingRows().length : 0;
    const result = state.lastRun;
    const skipped = Object.values(result?.skipped || {}).reduce((sum, n) => sum + Number(n || 0), 0);
    const resultText = !result ? "" : result.parked
      ? "Last run did not make decisions: " + result.parked.replaceAll("_", " ") + "."
      : "Last run checked " + Number(result.considered || result.pending || 0).toLocaleString()
        + " candidates, made " + Number(result.decided || 0).toLocaleString()
        + " decisions, and skipped " + skipped.toLocaleString() + ".";
    const head =
      '<div class="rules-head">' +
        '<div class="grow">' +
          "<h2>Rules run only when you press this button</h2>" +
          "<p>Run rules now checks every undecided applicant in the published review queue in one pass. A Live rule can press Interview or Pass; a Watching rule only counts matches. " +
          "It includes every tier and never overrules a decision a person already made. " +
          "<b>Some applicants have no work or education history in the provider profile</b> — " +
          "history conditions skip them, while application conditions still work.</p>" +
        "</div>" +
        '<div class="rules-actions">' +
          '<button class="killswitch' + (state.pausedAll ? " on" : "") + '" id="rulesPause">' +
            (state.pausedAll ? "● All rules paused" : "Pause all rules") + "</button>" +
          '<button class="primary" id="rulesNew">New rule</button>' +
          '<div class="manual-run"><button class="primary" id="rulesRun"' +
            (state.running || state.pausedAll || (!live && !watching) ? " disabled" : "") + ">" +
            (state.running ? "Running…" : "Run rules now") + "</button>" +
            '<span class="note">' + pending.toLocaleString() + " pending · " + live + " live · " + watching + " watching</span></div>" +
        "</div>" +
      "</div>";

    const body = state.rules.length
      ? state.rules.map(ruleCardHtml).join("")
      : '<div class="rules-empty"><h3>No rules yet</h3>' +
        "<p>Start one from scratch, or open any applicant and use <b>Make this a rule</b> to build one " +
        "from their real background.</p>" +
        '<button class="primary" id="rulesNewEmpty">Create the first rule</button></div>';

    host.innerHTML = head +
      (resultText ? '<div class="rule-run-result">' + enc(resultText) + "</div>" : "") +
      (state.pausedAll && state.rules.length
        ? '<div class="banner danger" style="display:flex"><div>●</div><div><strong>Every rule is paused.</strong>' +
          "<span>Nothing will be actioned when you press Run rules now until you switch this back on.</span></div></div>"
        : "") +
      (live && !state.pausedAll ? "" : "") +
      body;

    const pause = el("rulesPause");
    if (pause) pause.onclick = togglePause;
    const run = el("rulesRun");
    if (run) run.onclick = runRules;
    for (const id of ["rulesNew", "rulesNewEmpty"]) {
      const button = el(id);
      if (button) button.onclick = () => openEditor(null);
    }
  }

  /* ── the editor ──────────────────────────────────────────────────────── */
  function blankRule() {
    return { id: null, name: "", note: "", action: "interview", state: "off", scope: { roleIds: [] }, conditions: [] };
  }

  function openEditor(rule) {
    state.draft = rule ? JSON.parse(JSON.stringify(rule)) : blankRule();
    state.preview = null;
    renderEditor();
    el("ruleEditor").classList.add("on");
    schedulePreview();
  }
  function closeEditor() {
    state.draft = null;
    el("ruleEditor").classList.remove("on");
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

  function valueControl(condition, index) {
    const f = field(condition.field);
    if (!f) return "";
    if (f.kind === "bool") {
      return '<select class="v" data-ci="' + index + '" data-part="value">' +
        '<option value="true"' + (condition.value === true ? " selected" : "") + ">Yes</option>" +
        '<option value="false"' + (condition.value === false ? " selected" : "") + ">No</option></select>";
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
      const big = options.length > 12;
      options.sort((a, b) => {
        const pick = chosen.includes(b[0]) - chosen.includes(a[0]);
        return pick || String(a[1]).localeCompare(String(b[1]));
      });
      pickOptions[index] = options;
      return '<div class="v">' +
        (big ? '<input class="picksearch" type="text" placeholder="Search all ' + options.length + '…" data-ci="' + index + '" data-part="filter">' : "") +
        '<div class="multi" data-ci="' + index + '">' + pickListHtml(options, chosen, index, "") +
        "</div></div>";
    }
    if (condition.op === "between") {
      const v = Array.isArray(condition.value) ? condition.value : ["", ""];
      return '<div class="v" style="display:flex;gap:6px">' +
        '<input type="text" inputmode="numeric" value="' + enc(v[0]) + '" data-ci="' + index + '" data-part="from" placeholder="from">' +
        '<input type="text" inputmode="numeric" value="' + enc(v[1]) + '" data-ci="' + index + '" data-part="to" placeholder="to"></div>';
    }
    return '<input class="v" type="text" value="' + enc(condition.value == null ? "" : condition.value) + '" ' +
      'data-ci="' + index + '" data-part="value" placeholder="' + (f.kind === "number" || f.kind === "year" ? "number" : "text") + '">';
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
      '<select class="f" data-ci="' + index + '" data-part="field">' +
        choices.map((c) => '<option value="' + enc(c.name) + '"' + (c.name === condition.field ? " selected" : "") + ">" + enc(c.label) + "</option>").join("") +
      "</select>" +
      '<select class="o" data-ci="' + index + '" data-part="op">' +
        (f ? f.ops : []).map((o) => '<option value="' + enc(o) + '"' + (o === condition.op ? " selected" : "") + ">" +
          enc({ any_of: "is one of", contains: "contains", is: "is", at_least: "at least", at_most: "at most", after: "after", before: "before", between: "between" }[o] || o) + "</option>").join("") +
      "</select>" +
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

    el("ruleEditorCard").innerHTML =
      "<h3>" + (draft.id ? "Edit rule" : "New rule") + "</h3>" +
      '<p class="hint">Every condition must be true for the rule to act.</p>' +
      '<div class="row">' +
        '<div style="flex:2"><label for="ruleName">Name</label>' +
          '<input id="ruleName" type="text" maxlength="80" value="' + enc(draft.name) + '" placeholder="Harvard undergrads"></div>' +
        '<div><label for="ruleAction">Then</label><select id="ruleAction">' +
          '<option value="interview"' + (draft.action === "interview" ? " selected" : "") + ">Interview them</option>" +
          '<option value="pass"' + (draft.action === "pass" ? " selected" : "") + ">Pass on them</option>" +
        "</select></div>" +
      "</div>" +
      '<div class="row"><div><label for="ruleNote">Why this exists (optional)</label>' +
        '<textarea id="ruleNote" maxlength="400" placeholder="So the rest of the team knows what this is for.">' + enc(draft.note) + "</textarea></div></div>" +
      (groups || '<div class="cgroup"><p class="note" style="color:var(--ink-3)">No conditions yet — add one below.</p></div>') +
      '<select class="addcond" id="ruleAddCond"><option value="">+ Add a condition…</option>' + addOptions + "</select>" +
      previewHtml() +
      '<div class="redit-foot">' +
        '<span class="redit-err" id="ruleErr"></span>' +
        '<span class="spacer">' +
          '<button class="ghost" id="ruleCancel">Cancel</button>' +
          '<button class="primary" id="ruleSave">Save rule</button>' +
        "</span>" +
      "</div>";

    wireEditor();
  }

  function previewHtml() {
    if (state.previewing) return '<div class="preview"><div class="sub">Checking who this would match…</div></div>';
    const preview = state.preview;
    if (!preview) return '<div class="preview"><div class="sub">Add a condition to see who this matches.</div></div>';
    const skips = Object.entries(preview.skipped || {});
    // Complete predicates, not fragments: "12 with not yet prewarmed" is what
    // you get when the sentence is assembled from a shared connective.
    const words = {
      no_profile_history: "with no work or education history in Paraform",
      no_facts_yet: "not yet prewarmed",
      facts_version_stale: "awaiting a fresh prewarm",
      unknown_field: "blocked by an unknown field",
      rule_has_no_conditions: "skipped: the rule has no conditions",
    };
    return '<div class="preview">' +
      '<div class="n">' + preview.matched + " of " + preview.considered + "</div>" +
      '<div class="sub">applicants awaiting review would be <b>' +
        (state.draft.action === "interview" ? "interviewed" : "passed") + "</b> by this rule.</div>" +
      (skips.length ? '<div class="skips">Skipped: ' +
        skips.map(([reason, count]) => count + " " + (words[reason] || reason)).join(", ") + ".</div>" : "") +
      (preview.samples && preview.samples.length
        ? '<div class="samples">' + preview.samples.map((s) => "<span>" + enc(s.name || s.key) + "</span>").join("") + "</div>"
        : "") +
    "</div>";
  }

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 420);
  }
  async function runPreview() {
    const draft = state.draft;
    if (!draft || !draft.conditions.length || !draft.name.trim()) { state.preview = null; repaintPreview(); return; }
    state.previewing = true;
    repaintPreview();
    try {
      state.preview = await api({ op: "preview", rule: draft, ...applicantGeneration() });
    } catch { state.preview = null; }
    state.previewing = false;
    repaintPreview();
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
    if (["ids", "levels", "ranks", "tiers"].includes(f.kind)) return [];
    if (f.kind === "number" || f.kind === "year") return 0;
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
    el("ruleAction").onchange = (e) => { draft.action = e.target.value; repaintPreview(); };
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
          condition.value = [Number(inputs[0].value) || 0, Number(inputs[1].value) || 0];
          schedulePreview();
        };
      } else if (part === "value") {
        const f = field(condition.field);
        node.oninput = node.onchange = (e) => {
          const raw = e.target.value;
          condition.value = f.kind === "bool" ? raw === "true"
            : (f.kind === "number" || f.kind === "year") ? (Number(raw) || 0)
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
    return labels;
  }

  async function saveDraft() {
    const error = el("ruleErr");
    error.textContent = "";
    el("ruleSave").disabled = true;
    try {
      await api({ op: "save", rev: state.rev, rule: { ...state.draft, labels: labelsForDraft(state.draft) } });
      await load();
      closeEditor();
      render();
      toast("Rule saved.");
    } catch (e) {
      error.textContent = e.message;
    } finally {
      const save = el("ruleSave");
      if (save) save.disabled = false;
    }
  }

  /* ── list actions ────────────────────────────────────────────────────── */
  async function togglePause() {
    try {
      await api({ op: "pauseAll", rev: state.rev, paused: !state.pausedAll });
      await load(); render();
      toast(state.pausedAll ? "All rules paused." : "Rules enabled for manual runs.");
    } catch (e) { toast(e.message, true); }
  }

  async function runRules() {
    if (state.running || state.pausedAll) return;
    const pending = typeof pendingRows === "function" ? pendingRows().length : 0;
    const active = state.rules.filter((r) => r.state === "live" || r.state === "watching").length;
    if (!active) { toast("There are no Live or Watching rules to run.", true); return; }
    if (!window.confirm("Run " + active + " active rule" + (active === 1 ? "" : "s") + " against all "
      + pending.toLocaleString() + " pending applicants now?\n\nLive rules may record Interview or Pass decisions; Watching rules never write decisions.")) return;
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
    if (!rule || rule.state === next) return;
    if (next === "live" && rule.action === "interview") {
      const stats = state.stats[id] || {};
      const seen = rule.state === "watching" && stats.wouldFire ? " It has matched " + stats.wouldFire + " so far while watching." : "";
      if (!window.confirm('Make "' + rule.name + '" Live?\n\nIt will be considered only the next time you press Run rules now; send-ready matches will then be queued for the invite loop.' + seen)) return;
    }
    try {
      await api({ op: "setState", rev: state.rev, id, state: next });
      await load(); render();
    } catch (e) { toast(e.message, true); }
  }

  async function deleteRule(id) {
    const rule = state.rules.find((r) => r.id === id);
    if (!rule || !window.confirm('Delete "' + rule.name + '"? Decisions it already made are not affected.')) return;
    try {
      await api({ op: "delete", rev: state.rev, id });
      await load(); render();
      toast("Rule deleted.");
    } catch (e) { toast(e.message, true); }
  }

  async function showHits(id) {
    const rule = state.rules.find((r) => r.id === id);
    try {
      const payload = await api({ op: "hits", id });
      state.draft = null;
      el("ruleEditorCard").innerHTML =
        "<h3>" + enc(rule ? rule.name : "Rule") + "</h3>" +
        '<p class="hint">The last applicants this rule actioned, newest first.</p>' +
        (payload.hits.length
          ? '<ul class="hits-list">' + payload.hits.map((hit) =>
            "<li><b>" + enc(hit.name || hit.key) + "</b> · " + enc(hit.roleTitle || "") +
            ' <span style="color:var(--ink-3)">' + enc(hit.at ? hit.at.slice(0, 16).replace("T", " ") : "") + "</span>" +
            '<div class="why">' + enc((hit.evidence || []).map((e) => e.matched).join(" · ")) + "</div></li>").join("") + "</ul>"
          : '<div class="rules-empty" style="padding:20px"><p>This rule has not actioned anybody yet.</p></div>') +
        '<div class="redit-foot"><span class="spacer"><button class="ghost" id="ruleCancel">Close</button></span></div>';
      el("ruleCancel").onclick = closeEditor;
      el("ruleEditor").classList.add("on");
    } catch (e) { toast(e.message, true); }
  }

  /* ── "Make this a rule" from an open profile ─────────────────────────── */
  function fromApplicant(cuId, row) {
    const s = pageState();
    const profile = (s && s.profiles[cuId]) || {};
    const draft = blankRule();
    draft.name = "";
    const schools = (profile.education || []).filter((e) => e.schoolId);
    if (schools.length) {
      draft.conditions.push({ field: "school.id", op: "any_of", value: [schools[0].schoolId] });
      draft.conditions.push({ field: "school.level", op: "any_of", value: [] });
    }
    const jobs = (profile.experiences || []).filter((e) => e.companyId);
    if (jobs.length) draft.conditions.push({ field: "job.companyId", op: "any_of", value: [jobs[0].companyId] });
    if (!draft.conditions.length && row && row.roleId) {
      draft.conditions.push({ field: "application.roleId", op: "any_of", value: [row.roleId] });
    }
    // The directory is built from prewarmed profiles, so a school this person
    // has may not be in it yet. Seed it from what we are looking at rather than
    // showing an id the reader cannot recognise.
    for (const school of schools) if (school.schoolId) state.directories.schools[school.schoolId] = school.school || school.schoolId;
    for (const job of jobs) if (job.companyId) state.directories.companies[job.companyId] = job.companyName || job.companyId;

    if (typeof window.dismissProfile === "function") window.dismissProfile();
    window.setView("rules");
    setTimeout(() => {
      state.draft = draft;
      state.preview = null;
      renderEditor();
      el("ruleEditor").classList.add("on");
      const name = el("ruleName");
      if (name) name.focus();
    }, 0);
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
    overlay.innerHTML = '<div class="redit-card" id="ruleEditorCard"></div>';
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEditor(); });
    document.body.appendChild(overlay);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("on")) closeEditor();
    });

    document.addEventListener("click", (e) => {
      const node = e.target.closest ? e.target.closest("[data-rule-state],[data-rule-edit],[data-rule-del],[data-rule-hits],[data-rule-dupe]") : null;
      if (!node) return;
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
      try { await load(); } catch (e) { if (!state.loaded) toast(e.message, true); }
      render();
      paintBadge();
    },
    fromApplicant,
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
      .catch(() => { if (viewIsRules()) render(); });
  }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
