/* Profile-side entry into Applicant Rules.
 *
 * This chooser deliberately knows only four facts that are already visible on
 * one profile row: stable school/company/role ids, plus the literal job-title
 * or degree text. It never classifies a degree, saves a rule, changes a rule's
 * state, or runs rules. Its only output is an unsaved structured seed handed to
 * applicants-rules.js, whose server catalog, preview and validation remain the
 * authority.
 */
(function () {
  "use strict";

  const chooser = {
    open: false,
    cuId: null,
    row: null,
    sources: [],
    source: null,
    selected: new Set(),
    returnFocus: null,
    profileAriaHidden: null,
    profileWasInert: false,
  };

  const text = (value, max = 160) => String(value ?? "").trim().slice(0, max);
  const validId = (value) => {
    const id = text(value, 81);
    return id && id.length <= 80 ? id : null;
  };
  const enc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
  const pageState = () => (typeof STATE === "undefined" ? null : STATE);

  function profileSources(cuId, row) {
    const profile = pageState()?.profiles?.[cuId] || {};
    const sources = [];
    const roleId = validId(row?.roleId);
    if (roleId) {
      sources.push({
        kind: "application",
        index: 0,
        record: row,
        title: text(row?.roleTitle) || "This role",
        subtitle: text(row?.company) || "Applied role",
      });
    }
    (Array.isArray(profile.experiences) ? profile.experiences : []).forEach((record, index) => {
      if (!validId(record?.companyId) && !text(record?.roleTitle, 120)) return;
      sources.push({
        kind: "experience",
        index,
        record,
        title: text(record?.roleTitle) || "Role",
        subtitle: text(record?.companyName) || "Experience",
      });
    });
    (Array.isArray(profile.education) ? profile.education : []).forEach((record, index) => {
      if (!validId(record?.schoolId) && !text(record?.degree, 120)) return;
      sources.push({
        kind: "education",
        index,
        record,
        title: text(record?.school) || "School",
        subtitle: text(record?.degree) || "Education",
      });
    });
    return sources;
  }

  function factsFor(source) {
    if (!source) return [];
    const record = source.record || {};
    if (source.kind === "application") {
      const id = validId(record.roleId);
      if (!id) return [];
      const label = text(record.roleTitle, 120) || id;
      return [{
        id: "application-role",
        title: `Applied to ${label}`,
        detail: "Exact role",
        checked: true,
        condition: { field: "application.roleId", op: "any_of", value: [id] },
        labels: { [id]: label },
      }];
    }
    if (source.kind === "experience") {
      const id = validId(record.companyId);
      const company = text(record.companyName, 120) || id;
      const title = text(record.roleTitle, 120);
      const facts = [];
      if (id) facts.push({
        id: "experience-company",
        title: `Worked at ${company}`,
        detail: "Exact company",
        checked: true,
        condition: { field: "job.companyId", op: "any_of", value: [id] },
        labels: { [id]: company },
      });
      if (title) facts.push({
        id: "experience-title",
        title: `Job title contains “${title}”`,
        detail: "Text match · approximate",
        approximate: true,
        checked: !id,
        condition: { field: "job.title", op: "contains", value: title },
        labels: {},
      });
      return facts;
    }
    if (source.kind === "education") {
      const id = validId(record.schoolId);
      const school = text(record.school, 120) || id;
      const degree = text(record.degree, 120);
      const facts = [];
      if (id) facts.push({
        id: "education-school",
        title: `Attended ${school}`,
        detail: "Exact school",
        checked: true,
        condition: { field: "school.id", op: "any_of", value: [id] },
        labels: { [id]: school },
      });
      if (degree) facts.push({
        id: "education-degree",
        title: `Degree text contains “${degree}”`,
        detail: "Text match · approximate",
        approximate: true,
        checked: !id,
        condition: { field: "school.degreeText", op: "contains", value: degree },
        labels: {},
      });
      return facts;
    }
    return [];
  }

  function suggestedName(source, selectedFacts) {
    if (!source) return "New rule";
    const record = source.record || {};
    if (source.kind === "application") return `${text(record.roleTitle) || "Role"} applicants`.slice(0, 80);
    if (source.kind === "experience") {
      const usesCompany = selectedFacts.some((fact) => fact.id === "experience-company");
      return (usesCompany
        ? `${text(record.companyName) || "Selected company"} experience`
        : `${text(record.roleTitle) || "Selected"} job titles`).slice(0, 80);
    }
    const usesSchool = selectedFacts.some((fact) => fact.id === "education-school");
    return (usesSchool
      ? `${text(record.school) || "Selected school"} education`
      : `${text(record.degree) || "Selected"} degrees`).slice(0, 80);
  }

  /** Build the only object this module may hand to the Rules controller. */
  function createSeed(source, selectedIds) {
    const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
    const facts = factsFor(source).filter((fact) => selected.has(fact.id));
    const labels = {};
    for (const fact of facts) Object.assign(labels, fact.labels);
    return {
      name: suggestedName(source, facts),
      conditions: facts.map((fact) => ({
        field: fact.condition.field,
        op: fact.condition.op,
        value: Array.isArray(fact.condition.value) ? [...fact.condition.value] : fact.condition.value,
      })),
      labels,
    };
  }

  function kindLabel(source) {
    return source.kind === "application" ? "Applied role" : source.kind === "experience" ? "Experience" : "Education";
  }

  function mount() {
    if (document.getElementById("ruleFactChooser")) return;
    const overlay = document.createElement("div");
    overlay.id = "ruleFactChooser";
    overlay.className = "rf-overlay";
    overlay.innerHTML = '<section class="rf-card" role="dialog" aria-modal="true" aria-labelledby="rfTitle" tabindex="-1"></section>';
    overlay.addEventListener("click", (event) => {
      // Do not let the Applicants backdrop treat chooser clicks as clicks
      // outside the underlying profile.
      event.stopPropagation();
      if (event.target === overlay) close();
    });
    document.body.appendChild(overlay);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    try {
      if (typeof parentWin === "function") {
        const outer = parentWin();
        outer?.addEventListener("resize", place);
        outer?.addEventListener("scroll", place, { passive: true });
      }
    } catch {}
  }

  function place() {
    const overlay = document.getElementById("ruleFactChooser");
    if (!overlay?.classList.contains("open")) return;
    let embedded = false;
    let band = null;
    try {
      embedded = typeof parentWin === "function" && Boolean(parentWin());
      band = typeof viewBand === "function" ? viewBand() : null;
    } catch {}
    overlay.classList.toggle("embedded", embedded);
    overlay.style.top = embedded && band ? `${band.top}px` : "";
    overlay.style.height = embedded && band ? `${Math.max(0, band.bottom - band.top)}px` : "";
  }

  function listHtml() {
    if (!chooser.sources.length) {
      return '<div class="rf-empty">This profile has no school, company, job title, degree text, or applied role that can become an exact rule condition.</div>';
    }
    return '<div class="rf-list">' + chooser.sources.map((source, index) =>
      '<button type="button" class="rf-source" data-rf-source="' + index + '">' +
        '<span class="rf-source-kind">' + enc(kindLabel(source)) + '</span>' +
        '<span class="rf-source-copy"><b>' + enc(source.title) + '</b><span>' + enc(source.subtitle) + '</span></span>' +
        '<span class="rf-source-arrow" aria-hidden="true">›</span>' +
      '</button>').join("") + '</div>';
  }

  function detailHtml(source) {
    const facts = factsFor(source);
    return '<button type="button" class="rf-back" id="rfBack">‹ Choose a different detail</button>' +
      '<div class="rf-chosen"><b>' + enc(source.title) + '</b><span>' + enc(source.subtitle) + '</span></div>' +
      '<div class="rf-facts">' + facts.map((fact) =>
        '<label class="rf-fact"><input type="checkbox" data-rf-fact="' + enc(fact.id) + '"' +
          (chooser.selected.has(fact.id) ? " checked" : "") + '><span class="rf-fact-copy"><b>' + enc(fact.title) +
          '</b><span' + (fact.approximate ? ' class="rf-approx"' : "") + '>' + enc(fact.detail) + '</span></span></label>').join("") +
      '</div>';
  }

  function render() {
    const card = document.querySelector("#ruleFactChooser .rf-card");
    if (!card) return;
    const person = text(pageState()?.profiles?.[chooser.cuId]?.name || chooser.row?.name) || "this applicant";
    const detail = Boolean(chooser.source);
    card.innerHTML =
      '<div class="rf-head"><div class="rf-head-copy"><div class="rf-eyebrow">Create from profile</div>' +
        '<h2 id="rfTitle">' + (detail ? "What should match?" : `Choose a fact from ${enc(person)}`) + '</h2>' +
        '<p>' + (detail
          ? "Choose which details should match; you can refine the rule next."
          : "Choose a school, a past role, or the role they applied for.") + '</p></div>' +
        '<button type="button" class="rf-close" id="rfClose" aria-label="Close fact chooser">✕</button></div>' +
      '<div class="rf-body">' + (detail ? detailHtml(chooser.source) : listHtml()) + '</div>' +
      '<div class="rf-foot"><span class="rf-foot-note">Nothing is saved or run here.</span><span class="rf-foot-actions">' +
        '<button type="button" class="ghost" id="rfCancel">Cancel</button>' +
        (detail ? '<button type="button" class="primary" id="rfContinue"' + (chooser.selected.size ? "" : " disabled") + '>Continue to rule</button>' : "") +
      '</span></div>';

    card.querySelector("#rfClose").onclick = close;
    card.querySelector("#rfCancel").onclick = close;
    card.querySelectorAll("[data-rf-source]").forEach((button) => {
      button.onclick = () => selectSource(chooser.sources[Number(button.dataset.rfSource)]);
    });
    const back = card.querySelector("#rfBack");
    if (back) back.onclick = () => { chooser.source = null; chooser.selected.clear(); render(); focusFirst(); };
    card.querySelectorAll("[data-rf-fact]").forEach((input) => {
      input.onchange = () => {
        if (input.checked) chooser.selected.add(input.dataset.rfFact);
        else chooser.selected.delete(input.dataset.rfFact);
        const next = card.querySelector("#rfContinue");
        if (next) next.disabled = chooser.selected.size === 0;
      };
    });
    const next = card.querySelector("#rfContinue");
    if (next) next.onclick = continueToRule;
  }

  function focusFirst() {
    const card = document.querySelector("#ruleFactChooser .rf-card");
    const first = card?.querySelector("[data-rf-source], [data-rf-fact], #rfContinue, #rfCancel");
    (first || card)?.focus();
  }

  function selectSource(source) {
    if (!source) return;
    chooser.source = source;
    chooser.selected = new Set(factsFor(source).filter((fact) => fact.checked).map((fact) => fact.id));
    render();
    focusFirst();
  }

  function start(cuId, row, target) {
    mount();
    if (chooser.open) close();
    chooser.open = true;
    chooser.cuId = text(cuId, 120);
    chooser.row = row || null;
    chooser.sources = profileSources(chooser.cuId, chooser.row);
    chooser.source = null;
    chooser.selected.clear();
    chooser.returnFocus = document.activeElement;
    const profileModal = document.getElementById("profileModal");
    if (profileModal) {
      chooser.profileAriaHidden = profileModal.getAttribute("aria-hidden");
      chooser.profileWasInert = Boolean(profileModal.inert);
      profileModal.inert = true;
      profileModal.setAttribute("aria-hidden", "true");
    }
    if (target?.kind) {
      const index = Number(target.index || 0);
      const found = chooser.sources.find((source) => source.kind === target.kind && source.index === index);
      if (found) selectSource(found);
    }
    if (!chooser.source) render();
    const overlay = document.getElementById("ruleFactChooser");
    overlay.classList.add("open");
    place();
    focusFirst();
  }

  function close() {
    const overlay = document.getElementById("ruleFactChooser");
    if (!overlay?.classList.contains("open")) return;
    overlay.classList.remove("open");
    chooser.open = false;
    chooser.source = null;
    chooser.selected.clear();
    const profileModal = document.getElementById("profileModal");
    if (profileModal) {
      profileModal.inert = chooser.profileWasInert;
      if (chooser.profileAriaHidden == null) profileModal.removeAttribute("aria-hidden");
      else profileModal.setAttribute("aria-hidden", chooser.profileAriaHidden);
    }
    chooser.profileAriaHidden = null;
    chooser.profileWasInert = false;
    // Cancel returns to the same open profile and the control that launched the
    // chooser, preserving the reviewer's place in the queue.
    if (chooser.returnFocus?.isConnected) chooser.returnFocus.focus();
  }

  function continueToRule() {
    if (!chooser.source || !chooser.selected.size) return;
    const cuId = chooser.cuId;
    const row = chooser.row;
    const seed = createSeed(chooser.source, chooser.selected);
    close();
    if (seed.conditions.length) window.RaydarRules?.fromApplicant(cuId, row, seed);
  }

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-rule-fact-kind]");
    if (!button) return;
    const modal = pageState()?.modal;
    if (!modal) return;
    event.preventDefault();
    event.stopPropagation();
    start(modal.cu, modal.row, {
      kind: button.dataset.ruleFactKind,
      index: Number(button.dataset.ruleFactIndex || 0),
    });
  });

  document.addEventListener("keydown", (event) => {
    if (!chooser.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const card = document.querySelector("#ruleFactChooser .rf-card");
    const focusable = [...(card?.querySelectorAll('button:not([disabled]), input:not([disabled])') || [])]
      .filter((item) => item.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === card)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === card)) {
      event.preventDefault(); first.focus();
    }
  }, true);

  window.RaydarRuleFacts = Object.freeze({ start, close, createSeed, factsFor });
})();
