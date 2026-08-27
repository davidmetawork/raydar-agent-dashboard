// THE CHECK CATALOG — the single source of truth for what the Health tab watches.
//
// Spec: docs/PRD-SYSTEM-HEALTH-TAB-2026-08-07.md §6 (main repo davidmetawork/raydar).
// Adding a system = adding a row here. Nothing else needs to change.
//
// tier 1 => a DOWN pages immediately (candidate-facing, revenue or a live call)
// tier 2 => digest only
// tier 3 => cosmetic, digest only
//
// kind "pull"    -> fetch probe.url, run evaluators[probe.evaluate]
//     "beat"     -> desktop lane; DOWN when no heartbeat within maxSilenceMin
//     "derived"  -> computed from other checks' results (evaluator gets all)

export const GROUPS = [
  { id: "candidate", label: "Candidate-facing" },
  { id: "pipeline", label: "Pipeline" },
  { id: "email", label: "Email lanes" },
  { id: "fly", label: "Fly apps" },
  { id: "n8n", label: "n8n" },
  { id: "actions", label: "GitHub Actions" },
  { id: "desktop", label: "Desktop lanes" },
  { id: "deps", label: "Dependencies" },
];

// Beat lanes that touch the david@raydar.xyz per-user Gmail bucket. Their
// warn/fail beat notes are eligible 429 witnesses for the email-inbox-david
// tile (a beat from resume-feed is NOT — that lane reads resume@metawork.us,
// a separate bucket that stayed green through the whole 2026-08-09 lockout).
export const DAVID_MAILBOX_BEAT_LANES = [
  "booking-resume-sync",
  "booking-resume-retry",
  "interview-invites",
  "hm-chase",
  "tn-reenable",
];

export const CATALOG = [
  // ---------- A. candidate-facing (tier 1: DOWN pages) ----------
  {
    id: "booking-door",
    name: "Agent booking door",
    group: "candidate",
    tier: 1,
    kind: "pull",
    probe: {
      // Probe the ACTUAL hold path, not the health mirror. On 2026-08-07 the
      // domain served a deployment whose receipt failed signature verification:
      // health said agentAdmission:true (it mirrors the health expression,
      // which skips attestation) while every real hold 503'd on sourceAttested.
      // The tile lied green through a live outage. Ground truth is a POST to
      // /api/hold with a deliberately non-slot startMs: admission is asserted
      // BEFORE slot matching, so an open door answers 409 slot_taken with zero
      // side effects, and a closed door answers 503.
      kind: "holdProbe",
      url: "https://book.raydar.xyz/api/hold",
      healthUrl: "https://book.raydar.xyz/api/health",
      timeoutMs: 12000,
      evaluate: "bookingDoorHold",
    },
    registry: "/products/raydar-scheduler/",
    note: "POSTs a non-slot hold: 409 = door open, 503 = closed. Zero side effects.",
  },
  {
    id: "screener-uplink",
    name: "Screener audio bridge",
    group: "candidate",
    tier: 1,
    kind: "pull",
    probe: {
      url: "https://raydar-audio-bridge.fly.dev/health",
      timeoutMs: 8000,
      evaluate: "bridge",
    },
    registry: "/products/screener/",
    note: "Dead bridge = screenings cannot run.",
  },
  {
    id: "screener-feed",
    name: "Screener status feed",
    group: "candidate",
    tier: 1,
    kind: "pull",
    probe: {
      url: "https://webview-lake.vercel.app/api/status",
      timeoutMs: 15000, // cache-miss slow path; timeout => UNKNOWN, never DOWN
      okStatuses: [200, 503],
      evaluate: "webviewStatus",
    },
    registry: "/products/monitor/",
  },
  {
    id: "paraform-session",
    name: "Paraform session",
    group: "candidate",
    tier: 1,
    kind: "derived",
    probe: { evaluate: "paraformSession" },
    registry: "/products/sequences/",
    note: "Every Paraform-touching lane dies with the cookie.",
  },
  {
    id: "calls-api",
    name: "Calls API",
    group: "candidate",
    tier: 1,
    kind: "pull",
    probe: {
      url: "https://raydar-calls.vercel.app/api/health",
      timeoutMs: 8000,
      evaluate: "okTrue",
    },
    registry: "/products/calls-viewer/",
  },

  // ---------- B. pipeline ----------
  {
    id: "lifecycle-reminders",
    name: "Lifecycle reminders",
    group: "pipeline",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "nativeReminders" },
    registry: "/products/lifecycle-automation/",
    note: "Read from the scheduler's public health, which already aggregates it.",
  },
  // Candidate-facing lifecycle lanes, probed for EXISTENCE (401 = alive,
  // 404 = evicted by a stale deploy). Tier 1: a candidate who asked the AI
  // for a human is waiting on the first of these; four evictions happened on
  // 2026-08-08 alone and none was visible on this board. The GitHub Actions
  // lifecycle-lane-watchdog auto-heals the 404 within ~15 min; this row is
  // the minutes-scale page so a human knows it happened.
  {
    id: "lifecycle-human-handoff",
    name: "Human handoff lane",
    group: "pipeline",
    tier: 1,
    kind: "pull",
    probe: {
      url: "https://raydar-lifecycle.vercel.app/api/human-handoff",
      timeoutMs: 8000,
      evaluate: "authGated",
    },
    registry: "/products/human-handoff/",
  },
  {
    id: "lifecycle-connector-chase",
    name: "Connector chase lane",
    group: "pipeline",
    tier: 1,
    kind: "pull",
    probe: {
      url: "https://raydar-lifecycle.vercel.app/api/connector-chase",
      timeoutMs: 8000,
      evaluate: "authGated",
    },
    registry: "/products/connector-referral-followups/",
  },
  {
    id: "paraai-lane",
    name: "Para AI automation",
    group: "pipeline",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://monitor.raydar.xyz/api/paraai/health",
      timeoutMs: 12000,
      evaluate: "paraaiLane",
    },
    registry: "/products/paraai-matchmaker/",
  },
  {
    id: "seq-guardian",
    name: "Sequence booking stop",
    group: "pipeline",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://monitor.raydar.xyz/api/seq/health",
      timeoutMs: 12000,
      evaluate: "seqHealth",
    },
    registry: "/products/sequences/",
  },
  {
    id: "inbox-health",
    name: "Inbox",
    group: "pipeline",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://monitor.raydar.xyz/api/inbox/health",
      timeoutMs: 10000,
      evaluate: "okTrue",
    },
    registry: "/products/inbox/",
  },
  {
    id: "enrich-health",
    name: "Enrich",
    group: "pipeline",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://monitor.raydar.xyz/api/enrich/health",
      timeoutMs: 10000,
      evaluate: "okTrue",
    },
    registry: "/products/enrich/",
  },
  {
    id: "docs-site",
    name: "docs.raydar.xyz",
    group: "pipeline",
    tier: 3,
    kind: "pull",
    probe: {
      url: "https://docs.raydar.xyz",
      timeoutMs: 8000,
      redirect: "manual",
      okStatuses: [200, 301, 302, 307, 308],
      evaluate: "reachable",
    },
    registry: "/",
    note: "A 307 to the Google gate IS the healthy signal.",
  },
  {
    id: "clients-site",
    name: "clients.raydar.xyz",
    group: "pipeline",
    tier: 3,
    kind: "pull",
    probe: {
      url: "https://clients.raydar.xyz",
      timeoutMs: 8000,
      redirect: "manual",
      okStatuses: [200, 301, 302, 307, 308],
      evaluate: "reachable",
    },
    registry: "/products/clients-site/",
  },

  // ---------- B2. email lanes ----------
  // Email is Raydar's largest silent-failure surface (480 unalerted send
  // failures 2026-08-04; the ~37h david@ mailbox lockout 2026-08-09/10).
  // Spec: docs/PRD-EMAIL-LANES-HEALTH-2026-08-13.md (main repo).
  //
  // DESIGN RULE: never probe Gmail actively — during a lockout every call
  // re-quotes the now+15min penalty, so a monitoring probe would hold the
  // lock open. Everything here derives from witnesses that already exist.
  {
    id: "email-inbox-david",
    name: "david@raydar.xyz mailbox",
    group: "email",
    tier: 1,
    kind: "derived",
    probe: { evaluate: "gmailInboxDavid", davidLanes: DAVID_MAILBOX_BEAT_LANES },
    registry: "/products/email-lanes-health/",
    note: "Can automations use the shared mailbox right now? DOWN needs two independent 429 witnesses; one witness is DEGRADED (a breaker is handling it).",
  },
  {
    id: "email-mailroom",
    name: "Mailroom send service",
    group: "email",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://raydar-mailroom.vercel.app/api/health",
      timeoutMs: 8000,
      evaluate: "okTrue",
    },
    registry: "/products/mailroom/",
    note: "Email System v2's shared outbox (own Vercel project + Neon DB). ok:false means rows parked for review or a mailbox brake armed — read /emails for which.",
  },
  {
    id: "email-precall-reminders",
    name: "Pre-call reminder emails",
    group: "email",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://raydar-lifecycle.vercel.app/api/reminders-health",
      authEnv: "CALL_REMINDER_HEALTH_READ_KEY",
      timeoutMs: 10000,
      okStatuses: [200, 401, 503],
      evaluate: "reminderHealth",
    },
    registry: "/products/pre-call-reminders/",
    note: "T-24h/T-1h reminder emails to booked candidates, sent as david@raydar.xyz from the lifecycle project.",
  },
  {
    id: "email-human-handoff",
    name: "Human handoff emails",
    group: "email",
    tier: 2,
    kind: "pull",
    probe: {
      // The lane's own state file (identifier-free by design): health
      // heartbeat, pending queue depth, per-day send counters. Raw read of
      // the anonymously readable secret-by-URL gist — the API JSON path is
      // NOT equivalent (its truncation flag recreated the 2026-08-10 outage).
      urlEnv: "LIFECYCLE_GIST_ID",
      url: () =>
        `https://gist.githubusercontent.com/davidmetawork/${process.env.LIFECYCLE_GIST_ID}/raw/human-handoff.json`,
      timeoutMs: 10000,
      evaluate: "lifecycleEmailLane",
    },
    registry: "/products/human-handoff/",
    note: "Emails David when a screener candidate asks for a human — the candidate is waiting on this send. Sent as david@raydar.xyz.",
  },
  {
    id: "email-connector-chase",
    name: "Connector chase emails",
    group: "email",
    tier: 2,
    kind: "pull",
    probe: {
      urlEnv: "LIFECYCLE_GIST_ID",
      url: () =>
        `https://gist.githubusercontent.com/davidmetawork/${process.env.LIFECYCLE_GIST_ID}/raw/connector-chase.json`,
      timeoutMs: 10000,
      evaluate: "lifecycleEmailLane",
    },
    registry: "/products/connector-referral-followups/",
    note: "Referral follow-up emails to connectors (peaks ~150/day), sent as david@raydar.xyz. quota.retryAfter here is a persisted Gmail-429 witness.",
  },
  {
    id: "email-paraai-outreach",
    name: "Para AI outreach emails",
    group: "email",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "paraaiOutreachEmail" },
    registry: "/products/paraai-outreach/",
    note: "Interview-request outreach sent as david@raydar.xyz by the Para AI worker. An armed fleet breaker means a 429 was observed minutes ago.",
  },
  {
    id: "email-scheduler-sender",
    name: "Scheduler booking emails",
    group: "email",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "schedulerSenderEmail" },
    registry: "/products/raydar-scheduler/",
    note: "Booking confirmations/reschedules/native reminders from the scheduler's own delegated identity — a separate Gmail bucket from david@ (it sent 233/24h through the 08-10 lockout).",
  },
  {
    id: "email-paraform-mailboxes",
    name: "Paraform sending mailboxes",
    group: "email",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://monitor.raydar.xyz/api/health/mailboxes",
      authEnv: "HEALTH_BEAT_KEY",
      timeoutMs: 15000,
      evaluate: "paraformMailboxes",
    },
    registry: "/products/email-lanes-health/",
    note: "The Paraform sending fleet on Raydar's ten outreach domains plus david@raydar.xyz. Inventory and full-campaign status are cached 25 min to respect Paraform background-load limits.",
  },
  {
    id: "email-paraform-sequences",
    name: "Paraform sequence email",
    group: "email",
    tier: 3,
    kind: "derived",
    probe: { evaluate: "paraformSequencesEmail" },
    registry: "/products/sequences/",
    note: "Candidate outreach the Paraform platform sends on our behalf (applicant ladders, no-show/no-match follow-ups, cold sequences).",
  },
  // Desktop email lanes, moved here from the generic desktop list so every
  // email lane lives in one section. Same ids — samples and transition
  // history survive; the desktop-runner collapse keys on `runner`, not group.
  ...[
    ["resume-feed", "Resume feed (resume@ ingest)", 40,
      "Reads resume@metawork.us (its own mailbox and quota — stayed green through the 08-10 lockout); creates Paraform candidates from new resumes."],
    ["booking-resume-sync", "Booking resume sync", 20,
      "Reads david@raydar.xyz for Paraform booking mail and attaches resumes; honors the shared Gmail backoff file."],
    ["booking-resume-retry", "Booking resume retry", 40,
      "Retry half of booking-resume; same mailbox and runtime family."],
    ["booking-resume-email-index", "Booking resume email index", 1800,
      "Nightly Paraform CRM email-address index — identity data, no mail transport."],
    ["archive-backfill", "Archive backfill (resume@)", 75,
      "Gmail metadata reads over the resume@ historical corpus."],
    ["applicant-hub-worker", "Applicant hub worker", 20,
      "Consumes the resume@metawork.us ingestion WAL (KeepAlive service; the health reporter beats for it)."],
  ].map(([lane, name, maxSilenceMin, note]) => ({
    id: `lane-${lane}`,
    name,
    group: "email",
    tier: 2,
    kind: "beat",
    runner: "desktop",
    probe: { lane, maxSilenceMin },
    registry: "/operations/monitoring-canaries/",
    note,
  })),
  {
    id: "lane-interview-invites",
    name: "Interview invite emails",
    group: "email",
    tier: 2,
    kind: "beat",
    runner: "desktop",
    // 09:10/13:10/17:10 local — the longest NORMAL gap is the 16h overnight
    // one, so the windows are sized to the schedule's real shape, not to a
    // fantasy hourly cadence: one missed run is DEGRADED, a whole missed
    // day is DOWN. (Its plist has posted beats all along — run-with-beat.sh
    // is baked into the template — but without this row the sink answered
    // 404 unknown_lane and the lane stayed invisible.)
    probe: { lane: "interview-invites", degradedAfterMin: 990, maxSilenceMin: 1470 },
    registry: "/products/email-lanes-health/",
    note: "Invite emails walking applicants toward booking, sent as david@raydar.xyz at 09:10/13:10/17:10 (call-evidence oracle re-checked before every step).",
  },
  {
    id: "lane-apps-script-auto-reply",
    name: "Apps Script auto-reply",
    group: "email",
    tier: 3,
    kind: "beat",
    runner: "desktop",
    paused: true,
    probe: { lane: "apps-script-auto-reply", maxSilenceMin: 75 },
    registry: "/products/email-lanes-health/",
    note: "Paraform candidate auto-reply running INSIDE david@'s account on a 30-min trigger (activateLiveAutomation() reinstalls 10-min — re-fix after every activation). Paused until David adds a UrlFetchApp beat to the script.",
  },

  // ---------- C. fly ----------
  {
    id: "fly-paraai-worker",
    name: "Para AI worker (Fly)",
    group: "fly",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://raydar-paraai-worker.fly.dev/healthz",
      timeoutMs: 8000,
      evaluate: "reachable",
    },
    registry: "/products/paraai-matchmaker/",
  },
  {
    id: "fly-prepdoc",
    name: "Prep doc service (Fly)",
    group: "fly",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://raydar-prepdoc.fly.dev/health",
      timeoutMs: 8000,
      evaluate: "reachable",
    },
    registry: "/products/prep-docs/",
  },
  {
    id: "fly-bridge",
    name: "Audio bridge machine",
    group: "fly",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "bridgeMachine" },
    registry: "/products/screener/",
    note: "Same fetch as the candidate tile; shows uptime and live-call metrics.",
  },

  // ---------- D. n8n ----------
  {
    id: "n8n-workflows",
    name: "n8n workflows",
    group: "n8n",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "n8nWatchdog" },
    registry: "/operations/monitoring-canaries/",
    note: "Reads the existing hourly watchdog's state. READ-ONLY on seqguard:n8nwatch.",
  },

  // ---------- E. GitHub Actions ----------
  // Each scheduled Action posts a heartbeat at the end of its run instead of
  // being polled through the GitHub API. That needs no token, and it proves the
  // workflow actually RAN rather than that GitHub's API says it did.
  // GitHub documents scheduled events as best-effort: they can be delayed or
  // dropped under load. One missed window is therefore DEGRADED; only sustained
  // silence is DOWN. A workflow that runs and reports failure is still DOWN
  // immediately in beatLane(). A completed run may instead report `warn` when
  // the lane operated safely but quarantined a bounded candidate-level issue;
  // that is DEGRADED immediately, while stale beats still become DOWN.
  {
    id: "gha-scheduler-cron-guard",
    name: "Scheduler cron control",
    group: "actions",
    tier: 1,
    kind: "beat",
    // The guard's cron is */5, but GitHub does NOT deliver that: measured over
    // 2026-08-12, every scheduled gap exceeded 30 minutes (median 80, max 107)
    // while every run SUCCEEDED. A 30-minute dead-man on a best-effort
    // scheduler is therefore a 100%-false-alarm lane — and because this lane is
    // tier 1, that false silence took the whole public rollup to 503 and broke
    // the external dead-man that health-backstop.yml depends on. Windows are
    // now set from observed delivery, not from the cron string. No real signal
    // is lost: beatLane() returns DOWN on a `fail` beat before it looks at any
    // window, so a genuinely disabled Vercel cron still pages immediately.
    probe: {
      lane: "gha-scheduler-cron-guard",
      degradedAfterMin: 120,
      maxSilenceMin: 240,
    },
    registry: "/products/raydar-scheduler/",
    note: "Exact Vercel project cron-control proof; a fail beat pages immediately.",
  },
  ...[
    ["gha-cron-backstop", "Cron backstop", 150, 360],
    ["gha-human-outcomes", "Human outcomes", 450, 720],
    ["gha-trademark-watch", "Trademark watch", 3000, 4320],
    ["gha-paraai-curate", "Para AI curate", 150, 360],
    ["gha-curate-deadman", "Curate dead-man", 3000, 4320],
    ["gha-clients-snapshot", "Clients snapshot", 3000, 4320],
    ["gha-health-backstop", "Health backstop", 150, 360],
    // */15 cadence; 60 min silent = four missed runs. Auto-heals lifecycle
    // endpoint evictions, so ITS death would re-open the Omar failure mode.
    ["gha-lifecycle-watchdog", "Lifecycle watchdog", 60, 120],
    // Both match-watch workflows have been POSTing these lanes since arming
    // (2026-08-21) and 404ing for want of a row — which made every green run
    // report FAILED at the workflow level. Daily lanes, windows sized like
    // the other daily Actions (trademark-watch): GitHub's scheduler is
    // best-effort, so the windows come from observed delivery, not the cron.
    ["gha-match-watch", "Match watch", 3000, 4320],
    ["gha-match-watch-deadman", "Match watch dead-man", 3000, 4320],
    // The interview lane cut over from launchd to Actions on 2026-08-22; the
    // desktop rows below in the launchd group went paused the same day.
    // Hourly lane inside a 5:00-19:00 PT window: 240 min silent covers the
    // overnight gap without crying wolf all night... no — overnight IS
    // silent by design (quiet window), so the window must span it: worst
    // legitimate gap is 19:10 -> 05:10 = 600 min, plus GitHub drift.
    ["gha-interview-invites", "LinkedIn applicant emails", 720, 900],
    // The missed-interviewer alarm (dispatch-watch.yml): every 30 min, one
    // query over past confirmed agent bookings that never dispatched a bot.
    // Born from the 2026-08-19..25 outage that nothing else could see.
    ["gha-dispatch-watch", "Missed-interviewer alarm", 75, 180],
  ].map(([lane, name, degradedAfterMin, maxSilenceMin]) => ({
    id: lane,
    name,
    group: "actions",
    tier: 2,
    kind: "beat",
    probe: { lane, degradedAfterMin, maxSilenceMin },
    registry: "/operations/monitoring-canaries/",
  })),

  // ---------- F. desktop lanes (heartbeats) ----------
  {
    id: "desktop-runner",
    name: "Desktop runner",
    group: "desktop",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "desktopRunner" },
    registry: "/operations/monitoring-canaries/",
    note: "Collapses a laptop-offline event into ONE tile instead of a wall of red.",
  },
  // maxSilenceMin is each lane's REAL launchd cadence x2.5, read from its plist
  // (not estimated): too tight cries wolf, too loose hides a dead lane.
  // The three KeepAlive services never exit, so they cannot beat for
  // themselves — ops/health-beat/health-reporter.mjs beats for them every
  // 5 minutes based on whether launchd is holding a PID.
  // (The email-touching desktop lanes live in the "email" group above; they
  // still carry runner:"desktop" so the runner-offline collapse sees them.)
  ...[
    ["tn-reenable", "Talent Network re-enable", 1800],            // daily
    ["applicant-hub-watchdog", "Applicant hub watchdog", 30],     // every 10m
    ["resume-watchdog-v2", "Resume watchdog", 20],                // KeepAlive, reporter
    ["resume-ledger-backup-v2", "Resume ledger backup", 1800],    // daily
    ["resume-juicebox-bridge-v1", "Juicebox bridge", 20],         // KeepAlive, reporter
  ].map(([lane, name, maxSilenceMin]) => ({
    id: `lane-${lane}`,
    name,
    group: "desktop",
    tier: 2,
    kind: "beat",
    runner: "desktop",
    probe: { lane, maxSilenceMin },
    registry: "/operations/monitoring-canaries/",
  })),
  {
    id: "lane-resume-chase",
    name: "Resume chase emails",
    group: "email",
    tier: 3,
    kind: "beat",
    runner: "desktop",
    paused: true,
    // maxSilenceMin is the window this lane carried before retirement (75m).
    // A beat row must keep its window even while paused: the evaluator compares
    // `mins > probe.maxSilenceMin`, and an undefined window makes that NaN
    // comparison always false — un-pausing the row would read permanently green.
    probe: { lane: "resume-chase", maxSilenceMin: 75 },
    note: "Retired 2026-08-18 on David's order: resumes are now mandatory at booking (book.raydar.xyz) or arrive via Workable, so nothing is chased. Launchd job booted out; state archived.",
    registry: "/products/human-call-resume-chase/",
  },
  {
    id: "lane-hm-chase",
    name: "HM update chase",
    group: "email",
    tier: 3,
    kind: "beat",
    runner: "desktop",
    paused: true,
    probe: { lane: "hm-chase", maxSilenceMin: 75 },
    registry: "/products/hm-update-chase/",
    note: "expected-unloaded (retired 2026-08-08; drafted/sent HM update emails as david@raydar.xyz; restart requires explicit approval and cadence redesign)",
  },
  {
    id: "lane-resume-forward-v2",
    name: "Resume forward",
    group: "email",
    tier: 3,
    kind: "beat",
    runner: "desktop",
    paused: true,
    probe: { lane: "resume-forward-v2", maxSilenceMin: 20 },
    registry: "/products/resume-feed/",
    note: "expected-unloaded (Resume Feed owns new-mail ingestion)",
  },
  {
    id: "lane-cohort-booking-watch",
    name: "Cohort booking watch",
    group: "desktop",
    tier: 3,
    kind: "beat",
    runner: "desktop",
    paused: true,
    probe: { lane: "cohort-booking-watch", maxSilenceMin: 1800 },
    registry: "/operations/monitoring-canaries/",
    note: "not currently scheduled locally",
  },
  {
    id: "lane-resume-migration-v2",
    name: "Resume migration v2",
    group: "desktop",
    tier: 3,
    kind: "beat",
    runner: "desktop",
    paused: true,
    probe: { lane: "resume-migration-v2", maxSilenceMin: 3000 },
    registry: "/products/resume-mailbox/",
    note: "expected-unloaded (Waterfall freeze)",
  },
  {
    id: "lane-interview-sheet-mirror",
    name: "Interview sheet mirror",
    group: "desktop",
    tier: 3,
    kind: "beat",
    runner: "desktop",
    paused: true,
    probe: { lane: "interview-sheet-mirror", maxSilenceMin: 180 },
    registry: "/products/interview-sheet-agent/",
    note: "not currently scheduled locally",
  },

  // ---------- G. dependencies ----------
  {
    id: "recall-api",
    name: "Recall.ai",
    group: "deps",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://us-west-2.recall.ai/api/v1/bot/?limit=1",
      authEnv: "RECALL_AI_API_KEY",
      authScheme: "Token",
      timeoutMs: 10000,
      okStatuses: [200, 401, 403, 429],
      evaluate: "vendorApi",
    },
    registry: "/products/screener/",
  },
  {
    id: "vapi-api",
    name: "Vapi",
    group: "deps",
    tier: 2,
    kind: "pull",
    probe: {
      // ALWAYS pass createdAtGe — the unfiltered /call list times out by design
      // (see src/monitor/orient.mjs in the main repo).
      url: () =>
        `https://api.vapi.ai/call?limit=1&createdAtGe=${
          new Date(Date.now() - 3600_000).toISOString()
        }`,
      authEnv: "VAPI_API_KEY",
      authScheme: "Bearer",
      timeoutMs: 10000,
      okStatuses: [200, 401, 403, 429],
      evaluate: "vendorApi",
    },
    registry: "/products/screener/",
  },
  {
    id: "google-workspace",
    name: "Google Workspace",
    group: "deps",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "googleWorkspace" },
    registry: "/products/raydar-scheduler/",
  },
  {
    id: "neon-db",
    name: "Neon Postgres",
    group: "deps",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "neonDb" },
    registry: "/products/raydar-scheduler/",
  },
  {
    id: "upstash-kv",
    name: "Upstash KV",
    group: "deps",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "upstashKv" },
    registry: "/products/monitor/",
  },
  {
    id: "n8n-cloud",
    name: "n8n Cloud",
    group: "deps",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "n8nCloud" },
    registry: "/operations/monitoring-canaries/",
    note: "The vendor's reachability, separate from whether a workflow is failing.",
  },
  {
    id: "slack-transport",
    name: "Slack delivery",
    group: "deps",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "slackTransport" },
    registry: "/operations/monitoring-canaries/",
    note: "Alerting is itself a dependency — this tile watches the watcher's mouth.",
  },
];

export const byId = new Map(CATALOG.map((c) => [c.id, c]));
export const beatLanes = new Set(
  CATALOG.filter((c) => c.kind === "beat").map((c) => c.probe.lane),
);
