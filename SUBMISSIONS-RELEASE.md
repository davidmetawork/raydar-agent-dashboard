# Releasing Submissions

Monitor and the isolated Fly worker must be released from the same merged source, including the September 2 V2 fixes now retained on main.

1. Merge current `origin/main` into the release branch; never deploy a stale feature branch over Monitor.
2. Run the relevant V2 tests, protected V1 tests, and the canonical Raydar frozen dashboard contract check; inspect the actual page and provider-backed source evidence for the changed flows.
3. Run `node scripts/submissions-release.mjs --write`, then `npm run submissions-v2:release`; commit both generated manifests together with the source changes.
4. Publish the tested branch and merge to main; the Vercel build and GitHub check reject a stale or missing Submissions manifest.
5. Deploy `raydar-submissions-v2-worker` from the same source with `flyctl deploy --config submissions-v2-worker/fly.toml` and preserve existing secrets, controls, and the original activation boundary.
6. Read back the Monitor production alias and its source SHA, the Fly image, and the `release.digest` returned by both authenticated `/api/submissions-v2/health` and the worker `/health`; both digests must match the committed manifest.
7. Verify the authenticated page, normal source checkpoints, and relevant real candidate flows without creating test interest or sending candidate messages.

The digest covers V2 UI/API/worker/renderer/migrations, package pins, and the shared auth, Paraform, and Sequence Inbox modules it directly uses; it does not prove provider credentials, source coverage, or successful resume preparation.

The Vercel project build command is `npm run submissions-v2:release:vercel`, which verifies the deployed UI/API/shared files against the same full committed manifest while permitting only worker, renderer, migration and purge files deliberately excluded by `.vercelignore`; GitHub and local release checks verify the full source set. Old branches without the guard fail rather than quietly removing V2; do not override or remove it for unrelated Monitor changes.

Email scope rollout and bounded recovery are documented in the Raydar completion PRD and source map; apply the Inbox migration before deploying its multi-role producer, preserve the existing Interview cursor, and let the separately scoped Gmail cursor catch up from the existing activation timestamp.

The isolated `submissions-v2-worker/repair-role-evidence.mjs` utility is read-only by default and requires `--plan=<absolute-private-plan-path>` with `--apply=<inspected-plan-digest>` for a matching freshly revalidated plan; applying also requires the existing API database principal, preserves source evidence, and queues the ordinary classifier through first-response and Review resolution checks.
