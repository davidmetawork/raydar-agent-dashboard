# raydar-agent-dashboard — repo instructions

This repo serves **monitor.raydar.xyz** (static shell on Vercel team
"Raydar", slug `raydar-xyz` — transferred from the retired `raydar1` team
2026-07-14, team renamed from `lazy-prompt` the same day; live data comes
from webview-lake.vercel.app, the slug-independent project domain). Pushing
to `main` auto-deploys production.

## Hard rules

- The dashboard's data inputs/wiring are governed by a FROZEN contract.
  Before AND after any change that could affect what the dashboard reads or
  displays, run `webview/scripts/dashboard-contract-check.mjs` from the main
  Raydar repo (`/Users/davidphillips/Documents/Claude/Projects/Raydar` on
  David's machine). Spec: that repo's `docs/DASHBOARD-CONTRACT.md`.

## THE DOCS CONTRACT (mandatory, every session)

Raydar's documentation site (docs.raydar.xyz) lives in the main Raydar repo
at `docs-site/` — NOT in this repo. When you build or change anything here —
dashboard features, Sequences, Enrich, Calls viewer, /api/seq endpoints —
you MUST update the matching registry page there in the same session:

1. Edit the page under
   `/Users/davidphillips/Documents/Claude/Projects/Raydar/docs-site/src/content/docs/`
   (relevant pages: products/monitor.md, products/sequences.md,
   products/enrich.md, products/calls-viewer.md, reference/dashboard-contract.md).
   Schema: `docs-site/src/content.config.ts`; guide:
   `docs-site/src/content/docs/reference/registry-guide.md`.
2. Verify: `cd docs-site && npm run build` (a secrets guard blocks
   credential-shaped content).
3. Commit in the main Raydar repo AND publish:
   `cd docs-site && vercel deploy --prod --yes`.

Statuses must reflect reality (live/beta/paused/internal/deprecated). Never
put credentials, tokens, or candidate PII in docs pages.
