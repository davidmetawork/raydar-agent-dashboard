# Submissions V2 local test workspace

This is a **local-only, isolated test app** for the Submissions V2 rebuild. It listens on [http://127.0.0.1:4525](http://127.0.0.1:4525), uses only the dedicated `submissions_preview` database on loopback port `55439`, and displays synthetic candidates and simulated providers.

It does not deploy anything, replace the current dashboard, contact Gmail, Paraform, Slack, SendGrid, Vercel Blob, or a paid model API, and it does not send a candidate message. Do not use it with a production database, `.env`, browser session, candidate record, or provider credential.

The preview runs the local V2 database, service commands, worker, durable history, private local object storage, resume pipeline, and loopback renderer. Candidate replies, source records, role data, model decisions, provider proof, and notification outcomes are deterministic synthetic fixtures. A green preview demonstrates this local test path only; it is not production coverage, provider-delivery proof, or a release authorization.

## Prerequisites

Use the workspace's Node 22 binary and install the repository dependencies before starting:

```bash
cd /Users/davidphillips/Developer/Projects/raydar-submissions-rebuild-dashboard
npm ci
NODE22=/Users/davidphillips/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node
"$NODE22" --version
```

The preview requires an **isolated PostgreSQL 16 cluster** on `127.0.0.1:55439`, owned by `submissions_dev`, with the database named `submissions_preview`. These commands show one way to provision it on a Mac with Homebrew. Review them before running them; they create only the local preview cluster and database.

```bash
POSTGRES16_BIN="$(brew --prefix postgresql@16)/bin"
PREVIEW_PG="$HOME/.raydar/submissions-rebuild/pgdata"
mkdir -p "$PREVIEW_PG"
"$POSTGRES16_BIN/initdb" --username=submissions_dev --auth=trust --pgdata="$PREVIEW_PG"
"$POSTGRES16_BIN/pg_ctl" -D "$PREVIEW_PG" -l "$PREVIEW_PG/server.log" -o "-h 127.0.0.1 -p 55439" start
"$POSTGRES16_BIN/createdb" -h 127.0.0.1 -p 55439 -U submissions_dev submissions_preview
```

The CLI rejects another host, port, user, database name, URL query, or missing test marker. It generates local preview keys and stores local artifacts below `~/.raydar/submissions-rebuild/`.

The renderer uses a dedicated Python environment at `~/.raydar/submissions-rebuild/renderer-venv/`. It has already been provisioned on this machine. For a fresh machine, install `uv` and provision it once before starting:

```bash
uv venv --python 3.13 "$HOME/.raydar/submissions-rebuild/renderer-venv"
uv pip install --python "$HOME/.raydar/submissions-rebuild/renderer-venv/bin/python" -r resume-renderer-v2/requirements.txt
```

The CLI launches that exact interpreter without downloading dependencies at runtime. The renderer listens only on `127.0.0.1:4526`. In the Codex browser, **Download Resume** opens the validated PDF viewer; its save control can save the file.

## Start, inspect, stop, and reset

Use the direct Node 22 CLI below, or the matching `npm run preview:submissions*` scripts when your default `node` is already Node 22.

```bash
NODE22=/Users/davidphillips/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node

"$NODE22" submissions-preview/cli.mjs status
"$NODE22" submissions-preview/cli.mjs start
open http://127.0.0.1:4525
"$NODE22" submissions-preview/cli.mjs stop
```

`start` applies the local V2 migrations to `submissions_preview`, starts the isolated server and its test worker, and waits for the local health endpoint. `status` only checks that local process. `stop` only stops a process whose command line matches this workspace's preview server.

To erase the synthetic preview database and its local private artifacts, stop it and use the explicit reset confirmation:

```bash
"$NODE22" submissions-preview/cli.mjs reset --confirm=RESET_TEST_DATA
```

Reset drops only `submissions_v2` and `preview` schemas inside the exact dedicated `submissions_preview` database after it reads the preview marker. Start again to recreate a fresh workspace. It does not reset any other database, service, cursor, provider, or deployment.

## User acceptance walkthrough

Open [http://127.0.0.1:4525](http://127.0.0.1:4525). The purple banner and test panel identify the data and providers as synthetic. The worker runs in the background; use the panel status and normal page refreshes while it processes jobs.

1. Select **Load five examples**. Wait for the worker status to become Ready or Working and refresh the list when needed.
2. Find **Ada Sample**. Her positive reply should move through preparation to an interested item with a downloadable test resume. Download and inspect it as a local PDF. Opening **Submit** records only an open/navigation event; it does not mark the item Submitted.
3. On Ada's simulated application page, select **Create test application**. Wait for proof reconciliation. Only the exact synthetic candidate and role proof may move the item to Submitted.
4. Find **Ben Example**. Confirm the negative reply reaches Not Interested and is not converted to interest by later processing.
5. Find **Cora Demo**. Confirm the compensation question reaches Needs Review. Use the normal correction/review controls to exercise a human decision rather than treating the question as positive intent.
6. Find **Dana Sample**. Her first reply deliberately lacks the outbound contract. Select **Publish Dana’s missing contract**. Confirm the original source remains the same and the exact late contract makes eligible work processable without creating a second source or pair.
7. Find **Finn Demo**. The first synthetic preparation is configured to fail. Confirm the error remains reviewable and no false-ready resume appears. In **Failure and pause controls**, restore preparation, then use **Retry preparation** to complete the exact same pair.
8. On an item with a ready resume, use **Regenerate** while the failure switch is enabled. Confirm the earlier validated PDF remains downloadable if regeneration fails. Restore preparation before retrying regeneration.
9. Use **Replay Ada’s reply**. Confirm it is a no-op: the existing source/pair remains and no duplicate preparation job appears.
10. Use the pause control while jobs are pending, observe that the worker reports Paused, then resume it. Try the normal **Add Candidate** and **Duplicate to another role** paths with the synthetic Eli/role records; each action should remain within this local test workspace and preserve the original item's history.

To test a missing original resume, select **Eli Example** under **Failure and pause controls**, select **Hide original resume**, then add Eli to a role. He should reach the missing-resume Review item with no model spend. Select **Restore original resume** and use the normal **Recheck** action. The same pair should prepare successfully from a fresh collection.

The page may expose a source link, simulated candidate/role page, and simulated Paraform application page. They are local test pages, not live Paraform navigation.

## What each result means

| Observation | Meaning in this workspace |
| --- | --- |
| Interested while preparation runs | Positive intent and preparation facts are separate in the V2 projection. |
| Ready PDF download | A synthetic source passed the local resume pipeline and local renderer path. It is not a real candidate resume or a paid-model quality result. |
| Submit open | Recruiter navigation/open evidence only. It is not submission proof. |
| Submitted | The synthetic proof adapter returned the exact candidate/role application and the worker recorded its local proof. |
| Needs Review | A question, missing evidence, unavailable role, or configured preparation failure needs a human path; it is not silently changed to an unrelated final state. |
| Replay | Identical command/source replay returns the existing local result. A changed body under the same identity is rejected. |

## Offline staging tools

The validation script is deliberately offline. It reads JSON snapshots or proposed enrichment contracts and never sends provider requests, changes a source, or executes a repair.

Create and inspect a shadow parity report from complete snapshots:

```bash
NODE22=/Users/davidphillips/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node
"$NODE22" scripts/submissions-rebuild-validation.mjs \
  --mode=parity \
  --before=/absolute/path/before.json \
  --after=/absolute/path/after.json \
  --allowed=/absolute/path/allowed-changes.json \
  --output=/absolute/path/parity-report.json
```

Both snapshots must set `complete: true` and contain a unique candidate/role identity for every pair. Every row must explicitly include `first_signal_id`, `intent_state`, `submission_status`, `artifact_digest`, `negative_history_digest` and integer `state_version`; use explicit nulls for absent artifacts/history, never omit protected facts. The optional allowed-changes file permits only named changes; any other missing, added, or rewritten durable fact causes a nonzero result.

Create a bounded, dry-run repair plan from proposed late-contract enrichments:

```bash
"$NODE22" scripts/submissions-rebuild-validation.mjs \
  --mode=repair-plan \
  --input=/absolute/path/proposed-enrichments.json \
  --output=/absolute/path/repair-plan.json
```

The output is a digest-keyed manifest for review. It does not apply an enrichment. An authorized execution must still pass the normal, guarded enrichment endpoint and current database evidence checks.

## Validation record

Validated locally on 2026-09-05. The full requirement matrix, exact automated totals and release boundaries are in `docs/submissions-rebuild/ACCEPTANCE.md` in the private Raydar branch `codex/submissions-rebuild`.

| Check | Current status |
| --- | --- |
| Local preview start, browser acceptance, and worker lifecycle | Passed; fresh examples loaded for David's own acceptance |
| PDF visual inspection and artifact readback | Passed using the native renderer and private download path |
| Full automated test suite | Passed against separate local databases; see the acceptance record for exact totals |
| Production deployment, activation, provider delivery, and source coverage | Out of scope for this local preview |
