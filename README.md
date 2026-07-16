# raydar-agent-dashboard

Static host and isolated serverless tools for **monitor.raydar.xyz**. The main
Monitor page loads its frozen status contract from `webview-lake.vercel.app`.
Standalone workspaces live at `/sequences`, `/enrich`, and `/sourcing`.

The Sourcing workspace turns an approved Paraform role into a versioned native
filter set and job-specific evaluation rubric, maps the role to a review Project
and cold-sourcing Sequence, retrieves up to 100 profiles with Paraform Search,
and files only the agent-ranked candidates that clear the configured hard
requirements, score, and save limit. Runs and structured reviewer feedback live
in the scoped Raydar KV store; full candidate profiles remain in Paraform.
Paraform role read, native Search, Project writes, and Sequence writes are
separately gated by deployment flags. Ranking fails closed when OpenAI is not
configured or does not return schema-valid evaluations. `SOURCING_ACCESS_KEY` is
an immediate private auth path while Raydar-domain Google OAuth is the intended
multi-user path.

Source of truth for the dashboard UI lives in the agent system repo
(`webview/dashboard.html`); this is a deployment copy.
