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
      url: "https://book.raydar.xyz/api/health",
      timeoutMs: 10000,
      okStatuses: [200, 503], // 503 is a real health answer here, not a transport failure
      evaluate: "bookingDoor",
    },
    registry: "/products/raydar-scheduler/",
    note: "The /api/hold gate candidates actually feel.",
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
    id: "scheduler-detail",
    name: "Scheduler readiness",
    group: "pipeline",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://book.raydar.xyz/api/health",
      authEnv: "SCHEDULER_HEALTH_READ_KEY",
      timeoutMs: 12000,
      okStatuses: [200, 503],
      evaluate: "schedulerDetail",
    },
    registry: "/products/raydar-scheduler/",
    note: "The door can be open while readiness degrades — separate tile on purpose.",
  },
  {
    id: "lifecycle-reminders",
    name: "Lifecycle reminders",
    group: "pipeline",
    tier: 2,
    kind: "pull",
    probe: {
      url: "https://raydar-lifecycle.vercel.app/api/reminders-health",
      authEnv: "CALL_REMINDER_HEALTH_READ_KEY",
      timeoutMs: 10000,
      okStatuses: [200, 401, 503],
      evaluate: "reminderHealth",
    },
    registry: "/products/lifecycle-automation/",
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
  {
    id: "gh-actions-api",
    name: "GitHub Actions API",
    group: "actions",
    tier: 3,
    kind: "pull",
    probe: {
      url: "https://api.github.com/repos/davidmetawork/raydar/actions/runs?per_page=60",
      authEnv: "GH_HEALTH_TOKEN",
      authScheme: "Bearer",
      timeoutMs: 12000,
      evaluate: "ghActionsFetch",
    },
    registry: "/operations/monitoring-canaries/",
    note: "One fetch per tick; the per-workflow tiles below derive from it.",
  },
  ...[
    ["gha-cron-backstop", "Cron backstop", "cron-backstop.yml", 90],
    ["gha-human-outcomes", "Human outcomes", "human-outcomes.yml", 180],
    ["gha-trademark-watch", "Trademark watch", "trademark-watch.yml", 1440],
    ["gha-paraai-curate", "Para AI curate", "paraai-curate.yml", 60],
    ["gha-curate-deadman", "Curate dead-man", "paraai-curate-health.yml", 1440],
    ["gha-clients-snapshot", "Clients snapshot", "clients-snapshot.yml", 1440],
  ].map(([id, name, workflowFile, cadenceMin]) => ({
    id,
    name,
    group: "actions",
    tier: 2,
    kind: "derived",
    probe: { evaluate: "ghWorkflow", workflowFile, cadenceMin },
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
    ["resume-forward-v2", "Resume forward", 20],                  // every 5m
    ["resume-watchdog-v2", "Resume watchdog", 20],                // KeepAlive, reporter
    ["resume-ledger-backup-v2", "Resume ledger backup", 1800],    // daily
    ["resume-juicebox-bridge-v1", "Juicebox bridge", 20],         // KeepAlive, reporter
    ["paraai-interest-observer", "Para AI interest observer", 30],// every 10m
    ["cohort-booking-watch", "Cohort booking watch", 1800],       // daily once scheduled
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
