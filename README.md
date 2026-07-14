# raydar-agent-dashboard

Static host for the Raydar AI screening-agent dashboard, served at
**agent-dashboard.raydar.xyz**. The page is self-contained: it loads its data
(and logo) from the agent system's API at `webview-lake.vercel.app`
(`/api/status`, which sets `Access-Control-Allow-Origin: *`), so this project
holds no secrets and needs no environment variables or build step.

Source of truth for the dashboard UI lives in the agent system repo
(`webview/dashboard.html`); this is a deployment copy.
