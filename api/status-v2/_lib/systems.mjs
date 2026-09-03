// Status v2's catalog: the two rebuilt systems, drawn.
//
// Spec: PRD-STATUS-V2-2026-09-03 §4 (page), §5 (numbers), §6 (rules). This
// file is the ONLY place the page's vocabulary lives:
//
//   - STATE_WORDS: the five words the page may ever use for a state. No
//     compounds, no operator jargon, no codenames (PRD §4.2, rule R7).
//   - SYSTEMS: two rows, each with a plain-English summary sentence and a
//     fresh flow declaration (decision 6: fresh declarations here, not the
//     map's model) whose nodes carry dotted count keys into the published
//     payloads. The page never derives a count; the publisher counts (R1).
//   - REVIEW_STATE_SENTENCES: the twelve post-call review states in David's
//     words. Post-call copy is fixed here because those states are code.
//   - TODO_RULES: only things exclusively David can do (R9).
//
// APPLICANT LABELS ARE NEVER IN THIS FILE (R14). Every applicant hold bucket
// renders from the payload's own {code, label, count}, so the tab can relabel
// without a redeploy and the page cannot go stale against it.

// ── the five words ──────────────────────────────────────────────────────────
// Keyed by the state id the aggregator emits; the page renders the value and
// nothing else. A sixth word is a bug, and the suite fails on it.
export const STATE_WORDS = {
  sending: "Sending",
  paused: "Paused",
  "not-sending-yet": "Not sending yet",
  "not-running": "Not running",
  "cannot-tell": "Cannot tell",
};

export const STATE_IDS = Object.keys(STATE_WORDS);

// Colour tone per state (PRD §4.2): green Sending, amber Paused and Not
// sending yet (both chosen states, never a fault), red Not running (a second
// witness confirmed it), violet Cannot tell (loud, never green).
export const STATE_TONE = {
  sending: "good",
  paused: "warn",
  "not-sending-yet": "warn",
  "not-running": "bad",
  "cannot-tell": "violet",
};

// Worst-of for a card's spine: lower is worse (R17).
export const STATE_RANK = {
  "not-running": 0,
  "cannot-tell": 1,
  paused: 2,
  "not-sending-yet": 3,
  sending: 4,
};

/** The worst of several state ids — a card's spine takes this (R17). */
export function worstState(ids) {
  const known = (Array.isArray(ids) ? ids : []).filter((id) => id in STATE_RANK);
  if (!known.length) return "cannot-tell";
  return known.reduce((worst, id) => (STATE_RANK[id] < STATE_RANK[worst] ? id : worst), known[0]);
}

// ── the twelve post-call review states (PRD §3.1) ───────────────────────────
// tile: what the drawing shows (short, people-first). sentence: the plain
// English in the evidence drawer, beside the raw code. An unrecognised code is
// rendered "Unrecognised reason (code)" by the aggregator — never borrowed
// copy, because the post-call code maps any unknown state to the profile copy.
export const REVIEW_STATE_SENTENCES = {
  review_call: {
    tile: "Call not confirmed",
    sentence: "The call could not be confirmed as a real, finished conversation.",
  },
  review_identity: {
    tile: "Which person?",
    sentence: "More than one Paraform person could be this candidate, so none was picked.",
  },
  review_crm: {
    tile: "Not on your seat",
    sentence: "This person is not linked to your Paraform seat.",
  },
  review_profile: {
    tile: "Profile missing",
    sentence: "The profile is missing something, or it conflicts with what the call showed.",
  },
  review_preferences: {
    tile: "Preference missing",
    sentence: "A preference the email depends on is missing (location or salary).",
  },
  review_talent_network: {
    tile: "Wrong profile",
    sentence: "Talent Network membership landed on the wrong profile.",
  },
  review_matching: {
    tile: "Matching unfinished",
    sentence: "Role matching did not finish for this person.",
  },
  review_calibration: {
    tile: "Still calibrating",
    sentence: "Roles are still being calibrated under the rate ceiling.",
  },
  review_role_verdict: {
    tile: "Verdict missing",
    sentence: "A fit verdict for the role was never recorded.",
  },
  review_routing: {
    tile: "No safe address",
    sentence: "There is no proven email address for this person.",
  },
  review_thread: {
    tile: "No safe thread",
    sentence: "There is no safe conversation thread to put the email on.",
  },
  review_delivery: {
    tile: "Delivery unproven",
    sentence: "The email may have gone out, but delivery was never proven.",
  },
};

/** Plain copy for a review state code; an unknown code names itself. */
export function reviewStateCopy(code) {
  const known = REVIEW_STATE_SENTENCES[String(code || "")];
  if (known) return { ...known, known: true };
  const raw = String(code || "").trim() || "unknown";
  return {
    tile: `Unrecognised reason (${raw})`,
    sentence: `Unrecognised reason (${raw}). The post-call service has a state this page has never been taught.`,
    known: false,
  };
}

// ── the source registry (PRD §4.5: the header's sources expander) ───────────
// Naming a source that has NEVER once answered is the highest-value honesty on
// the page, so every source is listed here whether or not it exists yet.
export const SOURCES = [
  { id: "live-check", name: "the live check", detail: "the post-call service's own health endpoint" },
  { id: "review-data", name: "the Review data", detail: "the signed post-call review metrics" },
  { id: "post-call-funnel", name: "the post-call funnel", detail: "people-counts for today's calls (step 2)" },
  { id: "applicants-feed", name: "the Applicants tab feed", detail: "the counts the tab itself reads" },
  { id: "applicant-pipeline", name: "the applicant pipeline publisher", detail: "people-counts for the applicant flow (step 3)" },
  { id: "watchdog-beat", name: "the post-call watchdog heartbeat", detail: "the every-10-minute check-in from GitHub" },
];

// ── the two systems ─────────────────────────────────────────────────────────
// A node with no countKey has no publisher yet and renders "—" with its step
// caption; a node whose countKey resolves to null renders "—" too (R5). Every
// node counts PEOPLE unless it declares `unit` (R3).
export const SYSTEMS = [
  {
    id: "post-call",
    name: "Post-interview fit follow-ups",
    summary: "After someone finishes a call with us, this works out which follow-up email they get, and sends it.",
    clockLabel: "Calls that finished today (since 5:00 am PT), wherever they are now",
    clockNote: "Counted by the call's own day, so a late call whose email lands tomorrow still belongs to today.",
    links: [{ label: "open Review", href: "/#review" }],
    poolLink: "/#review",
    flow: {
      counted: true,
      stages: [
        { id: "calls", label: "Calls finished", countKey: "funnel.callsSeen", step: "step 2" },
        { id: "confirmed", label: "Call confirmed", countKey: "funnel.confirmed", step: "step 2" },
        // Stacking inside a drawn column follows this order, so the main line
        // stays on top and the boxes that hang off it sit under it.
        { id: "person", label: "Person confirmed", countKey: "funnel.personConfirmed", step: "step 2" },
        {
          id: "no-email",
          label: "No email owed",
          countKey: "funnel.noEmailOwed",
          note: "no-show, broke, too short",
          step: "step 2",
        },
        { id: "roles", label: "Roles matched", countKey: "funnel.rolesMatched", step: "step 2" },
        {
          id: "waiting-person",
          label: "Waiting on a person",
          kind: "pool",
          countKey: "funnel.openToday",
          poolKey: "funnel.byState",
          poolCopy: "review-state",
          accent: "warn-when-positive",
          tileAccent: "warn-when-positive",
          step: "step 2",
        },
        { id: "sent", label: "Email sent", countKey: "funnel.accepted", step: "step 2" },
        {
          id: "waiting-send",
          label: "Waiting to send",
          countKey: "funnel.waitingToSend",
          note: "timing gate",
          accent: "warn-when-positive",
          step: "step 2",
        },
        { id: "delivered", label: "Delivered", countKey: "funnel.delivered", step: "step 2" },
        {
          id: "unaccounted",
          label: "Not counted anywhere",
          countKey: "funnel.unaccounted",
          onlyWhenPositive: true,
          accent: "bad-when-positive",
          step: "step 2",
        },
      ],
      edges: [
        ["calls", "confirmed"],
        ["confirmed", "no-email"],
        ["confirmed", "person"],
        ["person", "roles"],
        ["roles", "sent"],
        ["sent", "delivered"],
        ["roles", "waiting-send"],
        ["person", "waiting-person"],
      ],
      note: "\"Email sent\" means SendGrid accepted it; \"Delivered\" means a delivery event landed. They are two boxes on purpose.",
    },
  },
  {
    id: "applicant",
    name: "LinkedIn applicant flow",
    summary: "When someone applies to a Raydar job on LinkedIn, this matches them to the right Paraform person and asks you whether to interview them.",
    clockLabel: "Last 7 days · counts start 1 Sep 2026",
    clockNote: "The pipeline only sees applications first observed after the 1 September cutover.",
    links: [{ label: "open Applicants", href: "/#applicants" }],
    poolLink: "/#applicants",
    flow: {
      counted: true,
      stages: [
        { id: "captured", label: "Captured", countKey: "pipeline.captured", step: "step 3" },
        { id: "identified", label: "Person identified", countKey: "pipeline.identified", step: "step 3" },
        { id: "ready", label: "Ready to decide", countKey: "pipeline.readyToDecide", step: "step 3" },
        // Same rule as the post-call row: the line first, then what hangs off it.
        {
          id: "waiting-you",
          label: "Waiting on you",
          kind: "pool",
          countKey: "pipeline.holdsTotal",
          poolKey: "pipeline.holdsByReason",
          poolCopy: "payload",
          accent: "warn-when-positive",
          tileAccent: "warn-when-positive",
          step: "step 3",
        },
        { id: "invited", label: "Invite created", countKey: "pipeline.invited", step: "step 3" },
        { id: "passed", label: "Passed", countKey: "pipeline.passed", step: "step 3" },
        {
          id: "post-decision",
          label: "Waiting on a person",
          countKey: "pipeline.postDecisionHolds",
          note: "after your Interview",
          accent: "warn-when-positive",
          step: "step 3",
        },
        { id: "emailed", label: "Invite emailed", step: "step 3b", stepNote: "delivery not tracked yet" },
        {
          id: "unaccounted",
          label: "Not counted anywhere",
          countKey: "pipeline.unaccounted",
          onlyWhenPositive: true,
          accent: "bad-when-positive",
          step: "step 3",
        },
      ],
      edges: [
        ["captured", "identified"],
        ["identified", "ready"],
        ["identified", "waiting-you"],
        ["waiting-you", "passed"],
        ["ready", "invited"],
        ["ready", "post-decision"],
        ["invited", "emailed"],
      ],
      note: "Your Interview decision moves someone from Waiting on you into Ready to decide; Pass moves them to Passed.",
    },
  },
];

export const SYSTEM_IDS = SYSTEMS.map((row) => row.id);

// ── the David-only to-do rules (R9) ─────────────────────────────────────────
// `when` reads the derived context the aggregator already has. Every rule is
// onlyDavid: nobody else can load a job on his Mac or decide whether an email
// lane switches on. The strip hides when no rule fires.
export const TODO_RULES = [
  {
    id: "applicant-job-unclear",
    onlyDavid: true,
    label: "Check whether the applicant pipeline job is running on your Mac, then reload it or tell me it is paused on purpose.",
    detail: "Nothing has published for a while and no stop reason was recorded, so I cannot tell a planned stop from a crash.",
    // It only reads: this command says what is true, it changes no job.
    command: "launchctl list | grep com.raydar.applicant-core",
    when: (ctx) => ctx?.applicant?.stateId === "cannot-tell" && ctx?.applicant?.reason === "stale-publish",
  },
  {
    id: "applicant-invite-lane",
    onlyDavid: true,
    label: "Decide whether the applicant invite emails switch back on.",
    detail: "The invite email lane is switched off, so nothing is emailed to an applicant until you say so.",
    when: (ctx) => ctx?.applicant?.laneEnabled === false,
  },
];

export const FOOTER = {
  title: "What this page does not cover",
  body: "Everything else — the screener, the Scheduler, match watch, curation, the email hub, sequences, calls, and about 45 other systems — is still on the old Status page. Money is not on this page; the revenue homepage has it. Nothing here reads Gmail or Paraform.",
  link: { label: "old Status", href: "/#status" },
};
