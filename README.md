# raydar-agent-dashboard

Static host and isolated serverless tools for **monitor.raydar.xyz**. The main
Monitor page loads its frozen status contract from `webview-lake.vercel.app`.
Standalone workspaces live at `/sequences`, `/enrich`, and `/sourcing`.

The Sourcing workspace turns an approved Paraform role into a versioned rubric,
maps the role to a review Project and optional Sequence, and persists runs plus
structured reviewer feedback in the scoped Raydar KV store. Paraform role read,
native Search, Project writes, and Sequence writes are separately gated by
deployment flags. `SOURCING_ACCESS_KEY` is an immediate private auth path while
Raydar-domain Google OAuth remains the intended multi-user replacement.

Source of truth for the dashboard UI lives in the agent system repo
(`webview/dashboard.html`); this is a deployment copy.
