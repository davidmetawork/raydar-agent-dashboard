import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const page = readFileSync(new URL("../applicants.html", import.meta.url), "utf8");
const extract = (start, end) => page.slice(page.indexOf(start), page.indexOf(end, page.indexOf(start)));
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function helpers(STATE) {
  return runInNewContext(extract("function applicantListRow(", "function profileId(") +
    extract("const PROBLEM_GUIDANCE", "function renderProblems(") +
    "; ({ applicantListRow, problemApplicantRow, problemRowHtml });", {
    STATE, esc, RaydarNav: { href: key => "/applicants#profile=" + key },
    appliedRole: row => row.roleTitle || "Role still resolving", appliedCompany: row => row.company || "Company unavailable",
    applicationMomentText: row => row.appliedAt ? "Applied " + row.appliedAt : "",
    shortDate: value => value, parseDate: value => new Date(value), relTime: () => "2 hours ago",
    invitationAgeText: seconds => seconds + "s",
  });
}

test("Problems use the exact application across all stored lists and refresh their cached lookup", () => {
  const ready = { key: "ready", name: "Ready Person", roleTitle: "Engineer", company: "Ready Co" };
  const preparing = { key: "pending", applicationId: "application-pending", name: "Pending <Person>", roleTitle: "Researcher", company: "Source Co", appliedAt: "2026-09-01" };
  const STATE = { snapshot: { queue: [ready], stream: [] }, profilePreparingRows: [preparing],
    applicantRowsV2: { ready: { application: { applicationId: "application-ready" } } } };
  const h = helpers(STATE);
  assert.equal(h.problemApplicantRow({ applicationId: "application-pending", key: "ready" }), preparing,
    "a stale display key cannot select another application");
  assert.equal(h.problemApplicantRow({ applicationId: "unknown", key: "ready" }), null);
  const html = h.problemRowHtml({ applicationId: "application-pending", code: "applied_hiring_company_unknown", ageSeconds: null });
  assert.match(html, /Pending &lt;Person&gt;/);
  assert.match(html, /Applied to <b>Researcher<\/b> @ Source Co/);
  assert.match(html, /Applied 2026-09-01/);
  assert.match(html, /data-open="pending"/);
  assert.match(html, /Raydar source review/);
  assert.match(html, /Issue start time is unavailable/);
  assert.doesNotMatch(html, /Open for 0s|unassigned|being determined/);
  STATE.profilePreparingRows = [{ ...preparing, name: "Updated Name" }];
  assert.equal(h.applicantListRow("pending").name, "Updated Name");
});

test("problem ownership and retry evidence override default guidance, and a real zero age is retained", () => {
  const h = helpers({ snapshot: { queue: [], stream: [] }, applicantRowsV2: {}, profilePreparingRows: [] });
  const html = h.problemRowHtml({ code: "profile_preparing", owner: "Assigned operator", reason: "Waiting on exact source receipt", nextAction: "Retry source receipt", ageSeconds: 0 });
  assert.match(html, /Assigned operator/);
  assert.match(html, /Waiting on exact source receipt/);
  assert.match(html, /Retry source receipt/);
  assert.match(html, /Open for 0s/);
});

test("opening a Preparing record preserves navigation and reads no provider or unrelated candidate profile", () => {
  const row = { key: "pending", profileKey: "opaque-source", name: "Preparing" };
  const STATE = { modal: null };
  let reads = 0, renders = 0, opened;
  const h = runInNewContext(extract("function openProfile(", "function restoreProfileFocus(") + "; openProfile;", {
    STATE, applicantListRow: () => row, profileId: r => r.profileKey,
    queueRows: () => [], streamRows: () => [], ensureRoom() {}, placeModal() {},
    $: () => ({ classList: { add() {} }, scrollTop: 7 }), lockOuterScroll() {},
    RaydarNav: { open: (...args) => { opened = args; } }, closeProfile() {},
    renderModal: () => { renders++; }, fetchProfile: () => { reads++; throw Error("Unexpected provider read"); },
  });
  h("pending", { restoreFocus: true });
  assert.equal(reads, 0);
  assert.equal(renders, 1);
  assert.equal(STATE.modal.source, "preparing");
  assert.equal(STATE.modal.returnFocusKey, "pending");
  assert.equal(opened[2], "pending");
});
