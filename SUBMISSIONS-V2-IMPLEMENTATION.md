# Submissions V2 implementation and local verification

Status: this is an isolated local build on `/submissions-v2`; it has not been deployed or activated, V1 remains unchanged, and both the environment and durable Postgres runtime controls default to disabled.

## What is implemented

| Area | Isolated V2 implementation |
| --- | --- |
| UI | `submissions-v2.html`, `submissions-v2.css`, and `submissions-v2.js` provide searchable Interested, Needs Review, and permanent Not Interested pages with inert rows and explicit actions. |
| API | `api/submissions-v2/` provides strict human/admin/machine authentication, CSRF and origin checks, cursor lists, search, review commands, private downloads, navigation-only Submit, health, controls, and Master Inbox intake. |
| State | `migrations/submissions-v2/` creates the isolated `submissions_v2` Postgres schema with immutable evidence/audit records, exact candidate-role uniqueness, first-response decisions, fenced jobs, review consistency, artifact promotion guards, globally bound private-object ownership, and all durable controls off. |
| Sources | Master Inbox events are replay-safe and encrypted; curated-list reconciliation, Paraform candidate/role indexes, and authoritative submission-proof reads run as bounded worker jobs. |
| Resume | A candidate-original readable resume is the sole source blocker; optional call, LinkedIn, role, company, and intake context feed a claim ledger, pinned strategist, independent grounding validator, private artifact archive, and deterministic one-or-two-page renderer. |
| Worker | `submissions-v2-worker/` claims fenced jobs only when the matching environment and durable controls are both enabled; it receives one-minute exact-path read/write capabilities from the API broker and has no broad Blob token or delete operation. |
| Renderer | `resume-renderer-v2/` exposes authenticated `/render-v2` and `/extract-v2`, uses the bundled official Raydar lockup, produces selectable ATS-parity PDFs, and avoids request-body logging. |
| Purge | `submissions-v2-purge/` is a separately credentialed, default-off executor; ordinary API/worker roles have no DELETE grants, every case path is selected through its exact storage owner, and ownerless expired writes are handled only by the isolated routine lane. |

## End-to-end flow

1. A versioned Master Inbox event, curated-list observation, or deliberate teammate action creates immutable source evidence.
2. Candidate and role binding resolves exact Paraform identities; ambiguity, questions, unavailable roles, missing original resumes, classifier failures, or preparation failures go to Needs Review.
3. Clear negative intent creates permanent Not Interested history and a durable Slack outbox event; clear positive intent is hidden in `preparing_resume` while the artifact is built.
4. Resume preparation collects provenance-tagged sources, extracts claims, chooses the role-specific layout, validates every retained claim, renders and read-backs PDF/ATS/manifest artifacts, then atomically promotes the complete set.
5. Only the promoted artifact exposes Download Resume; regeneration creates another archived version without replacing the candidate's Paraform resume.
6. Submit records the open event and opens the exact stored Paraform role URL; it never submits, attaches a file, sends a message, or spends a Paraform credit.
7. A later proof job may mark the row submitted only after an authoritative exact candidate-role Paraform application read.

## Safety and activation model

- Environment flags and the single durable `submissions_v2.runtime_controls` row are ANDed, so either layer being off holds the corresponding UI/source/generation work.
- Migration `001_foundation.sql` seeds every durable flag false, and `.env.submissions-v2.example` keeps every environment flag false.
- Private source text, supplements, checkpoints, and artifacts are encrypted or stored in private Blob paths; public rows expose only safe projections.
- Every private path is transactionally bound to one immutable storage owner, legacy 001-010 rows are backfilled before migration 011 activates guards, and generation-owned artifacts/instructions are constrained to the same candidate-role pair.
- Model work is pinned, bounded to five minutes and $2 per resume, and fails closed before an unbudgeted call.
- No deployment, production source enablement, live model call, Slack post, candidate action, Paraform write, or runtime-control activation was performed as part of this build.

## Local verification

The current local verification on 2026-09-01 passes 202/202 focused V2 tests, including both a
fresh database and an exact populated 001-010 to 011 upgrade. A clean disposable Postgres database
applied all eleven migrations twice with digest/idempotence checks, retained every runtime control
off, and passed the least-privilege role probes. The independent security and data-integrity audit
passed with no remaining blocker, production dependency audit reports zero vulnerabilities, and the
production-shaped Vercel build and nested-route smoke tests pass. The frozen unchanged-V1 and
renderer results are 36/36 and 12/12 respectively.
The frozen repository-wide result is 2,778 passing, six unchanged unrelated legacy failures, and
one skip; the newly integrated upstream applicant tests pass separately.

Run these only against local/test services with all activation flags left false.

```bash
npm ci
```

Create the isolated local database once (skip `createdb` when it already exists); the full suite applies the digest-checked migrations itself:

```bash
createdb raydar_submissions_v2_test
SUBMISSIONS_V2_TEST_DATABASE_URL=postgresql://localhost:5432/raydar_submissions_v2_test node --test test/submissions-v2-*.test.mjs
SUBMISSIONS_V2_DATABASE_URL=postgresql://localhost:5432/raydar_submissions_v2_test node scripts/migrate-submissions-v2.mjs
```

Verify the Python renderer in an isolated virtual environment:

```bash
python3 -m venv /tmp/raydar-submissions-v2-renderer-venv
/tmp/raydar-submissions-v2-renderer-venv/bin/pip install -r resume-renderer-v2/requirements.txt
(cd resume-renderer-v2 && /tmp/raydar-submissions-v2-renderer-venv/bin/python -m unittest test_app.py)
```

For a read-only visual shell check, serve the repository and open `/submissions-v2.html`; authenticated APIs should remain unavailable while controls are disabled:

```bash
python3 -m http.server 4179
```

Before any future launch, rerun the V2 suites, V1 regression suites, dashboard contract check, renderer tests, and a representative source-to-download shadow flow, then require separate approval to configure secrets, deploy services, or enable either control layer.
