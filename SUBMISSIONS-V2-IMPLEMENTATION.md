# Submissions V2 implementation and production verification

Status: production-active on Monitor `/submissions-v2` since the forward-only cutoff
`2026-09-02T02:45:14.308Z`; all five environment ceilings and durable control epoch 1 are enabled,
while unchanged V1 `/submissions` remains the rollback surface.

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
- Migration `001_foundation.sql` and `.env.submissions-v2.example` still default every new installation off; production was explicitly enabled only after deployment and readback.
- Private source text, supplements, checkpoints, and artifacts are encrypted or stored in private Blob paths; public rows expose only safe projections.
- Every private path is transactionally bound to one immutable storage owner, legacy 001-010 rows are backfilled before migration 011 activates guards, and generation-owned artifacts/instructions are constrained to the same candidate-role pair.
- Model work is pinned, bounded to five minutes and $2 per resume, and fails closed before an unbudgeted call.
- Activation is forward-only and created no source event or candidate-role pair from standing Curated history; Monitor still performs no submission, resume attachment, candidate message, or Paraform credit spend.

## Production activation evidence

- Monitor deployment `dpl_CS1BCemva69nZxquRDLC9uUKxk22` and Master Inbox deployment
  `dpl_Jra8kxegMWJdrtktW9tv3SSwZLX3` are Ready and production-aliased.
- The dedicated worker, V2 renderer, ClamAV scanner, and isolated purge executor pass live health
  checks; the renderer reports exact approved brand/font/template identifiers.
- Production Neon has migrations 001-013 and scoped API, worker, and purge identities; the two
  activation-time least-privilege defects were repaired without granting either deployment identity
  direct runtime-control update authority.
- Master Inbox reconciliation succeeds without Gmail polling, the initial Curated read seeded 24
  snapshots with zero historical candidate actions, and Paraform candidate/role indexes populate
  through paced continuation jobs.
- No synthetic candidate signal was inserted; the first organic post-cutoff signal remains the
  production proof for classification through resume download and proof reconciliation.

## Local verification

The current local verification on 2026-09-01 passes 205/205 focused V2 tests, including both a
fresh database and an exact populated 001-010 to 011 upgrade. A clean disposable Postgres database
applied all thirteen migrations with digest/idempotence checks, retained every runtime control
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

For future changes, rerun the V2 and V1 suites, dashboard contract check, renderer tests, and a
representative source-to-download flow before redeploying; use either environment ceilings or the
durable controls for immediate rollback.
