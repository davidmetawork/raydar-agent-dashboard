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
  { id: "fly", label: "Fly apps" },
  { id: "n8n", label: "n8n" },
  { id: "actions", label: "GitHub Actions" },
  { id: "desktop", label: "Desktop lanes" },
  { id: "deps", label: "Dependencies" },
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
  ...[
    ["gha-cron-backstop", "Cron backstop", 150],
    ["gha-human-outcomes", "Human outcomes", 450],
    ["gha-trademark-watch", "Trademark watch", 3000],
    ["gha-paraai-curate", "Para AI curate", 150],
    ["gha-curate-deadman", "Curate dead-man", 3000],
    ["gha-clients-snapshot", "Clients snapshot", 3000],
    ["gha-health-backstop", "Health backstop", 150],
    // */15 cadence; 60 min silent = four missed runs. Auto-heals lifecycle
    // endpoint evictions, so ITS death would re-open the Omar failure mode.
    ["gha-lifecycle-watchdog", "Lifecycle watchdog", 60],
  ].map(([lane, name, maxSilenceMin]) => ({
    id: lane,
    name,
    group: "actions",
    tier: 2,
    kind: "beat",
    probe: { lane, maxSilenceMin },
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
  ...[
    ["hm-chase", "HM update chase", 75],                          // every 30m
    ["tn-reenable", "Talent Network re-enable", 1800],            // daily
    ["resume-feed", "Resume feed", 40],                           // every 15m
    ["booking-resume-sync", "Booking resume sync", 20],           // every 5m
    ["booking-resume-retry", "Booking resume retry", 40],         // every 15m
    ["booking-resume-email-index", "Booking resume email index", 1800], // daily
    ["applicant-hub-worker", "Applicant hub worker", 20],         // KeepAlive, reporter
    ["applicant-hub-watchdog", "Applicant hub watchdog", 30],     // every 10m
    ["archive-backfill", "Archive backfill", 75],                 // every 30m
    ["resume-chase", "Resume chase", 75],                         // every 30m
    ["resume-watchdog-v2", "Resume watchdog", 20],                // KeepAlive, reporter
    ["resume-ledger-backup-v2", "Resume ledger backup", 1800],    // daily
    ["resume-juicebox-bridge-v1", "Juicebox bridge", 20],         // KeepAlive, reporter
    ["paraai-interest-observer", "Para AI interest observer", 30],// every 10m
  ].map(([lane, name, maxSilenceMin]) => ({
    id: `lane-${lane}`,
    name,
    group: "desktop",
    tier: 2,
    kind: "beat",
    probe: { lane, maxSilenceMin },
    registry: "/operations/monitoring-canaries/",
  })),
  {
    id: "lane-resume-forward-v2",
    name: "Resume forward",
    group: "desktop",
    tier: 3,
    kind: "beat",
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
