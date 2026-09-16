# raydar-agent-dashboard

Static host and isolated serverless tools for **monitor.raydar.xyz**. The main
Monitor page loads its frozen status contract from `webview-lake.vercel.app`.
Standalone workspaces live at `/sequences`, `/enrich`, `/sourcing`, and the separately gated
`/master-inbox`; the existing `/inbox` remains the independent Sequence Reply Inbox.

Every internal page shares one Raydar Google login. The server exchanges the
verified Google credential for a `raydar.xyz` domain-wide, HttpOnly
trusted-browser cookie with a rolling one-year lifetime, so monitor, docs,
training, Sequences, Enrich, Prep, Para AI, and Sourcing do not prompt again.
Allowed Google-account domains are `raydar.xyz`, `raydargroup.com`, and
`davidphillips.world`. `AUTH_SESSION_SECRET` signs the cookie; rotating it on all
protected projects revokes every trusted-browser session. Standalone `/c/<id>`
call links remain intentionally public capability URLs.

The Sourcing workspace turns an approved Paraform role into a versioned native
filter set and job-specific evaluation rubric, maps the role to a review Project
and cold-sourcing Sequence, retrieves up to 100 profiles with Paraform Search,
and files only the agent-ranked candidates that clear the configured hard
requirements, score, and save limit. Runs and structured reviewer feedback live
in the scoped Raydar KV store; full candidate profiles remain in Paraform.
Paraform role read, native Search, Project writes, and Sequence writes are
separately gated by deployment flags. Ranking fails closed when OpenAI is not
configured or does not return schema-valid evaluations. `SOURCING_ACCESS_KEY`
remains a private break-glass auth path alongside the live Raydar-domain Google
session.

Source of truth for the dashboard UI lives in the agent system repo
(`webview/dashboard.html`); this is a deployment copy.

Master Inbox's browser receives no Gmail credential and persists no message content; its protected
serverless proxy requires `MASTER_INBOX_BASE`, `MASTER_INBOX_SERVICE_KEY`, and the same
`MASTER_INBOX_SESSION_ASSERTION_KEY` as the mailbox service, and every live deployment/navigation
change requires the separately approved Master Inbox launch manifest.

## Temporary ParaAI background pause

The operator-owned KV key `ops:paraform-background-pause:v1:paraai-worker`
accepts the exact record shape `{"pauseId":"incident-id","paused":true}`.
It stops every authenticated `/api/paraai/worker` mode before dispatch, including
the Fly tick and Vercel recovery cron, and suppresses Paraform health probes.
Health reports paused/non-ready; Fly may remain running and receive successful
no-op responses. Webhook ingestion and durable queued jobs are not removed.
A missing key preserves normal behavior; unreadable/malformed control state
fails closed. Independent manual ParaAI action routes are outside this brake.

Capture raw key state before changing it. To restore an originally absent key,
atomically compare the exact owned record and delete only if unchanged; do not
reset feature approvals or consume queued work manually. The September 16
incident's authority is the main Raydar repo task
`pause-paraform-background-systems` and restore manifest
`docs/runs/2026-09-16-paraform-background-pause.json`.
