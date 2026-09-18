# Dashboard Paraform telemetry coverage

This document records the dashboard-side coverage for the shared Paraform
request telemetry contract. It describes request metadata only. It does not
authorize a provider probe, a reader resume, a queue replay, a credential
refresh, or a candidate change.

## Covered transport owners

| Source ID | Transport owner | Covered request classes |
| --- | --- | --- |
| `dashboard-sequences` | `api/seq/_lib/core.mjs` | tRPC sequence reads and writes, sequence CRM walks, and profile REST reads |
| `dashboard-booking` | `api/seq/_lib/core.mjs` under booking request context | booking membership, sweep, and canary provider reads/writes |
| `dashboard-health` | `api/seq/_lib/core.mjs` under health request context | direct Paraform health and mailbox-roster reads; internal health fan-out is excluded |
| `dashboard-inbox` | `api/inbox/_lib/core.mjs` | inbox tRPC reads, including the Submissions V2 inbox broker source |
| `dashboard-activity` | `api/activity/_lib/paraform.mjs` | Activity CRM, thread, inbox, mention, and explicit comment operations |
| `submissions-v1` | `api/paraai/_lib/core.mjs` under V1 request context | V1 refresh, source, submission, and resume-source provider operations |
| `submissions-v2` | `api/paraai/_lib/core.mjs` under V2 worker request context | candidate/role indexes, curated reconciliation, proof reconciliation, and resume-source reads |
| `dashboard-applicants` | `api/applicants/_lib/paraform.mjs` | Applicants profile-view tRPC reads |
| `dashboard-manual` | explicit dashboard fetches | prep-document candidate search and roster-source CRM scans |

Each actual HTTP attempt is recorded at the transport fetch boundary. A retry is
a separate attempt. Logical operations, route entries, cached reads, internal
health fan-out, and telemetry delivery are not counted as Paraform requests.

## Protected and excluded paths

- The existing dashboard-reader pause remains before Activity and V1 background
  refreshes. A paused request has no provider-attempt event because no provider
  call occurs.
- Submissions V2 durable controls remain authoritative. Telemetry neither
  schedules work nor enables an ingestion, generation, inbox, or curated gate.
- Blob-storage downloads and uploads, telemetry collector calls, Raydar-internal
  calls, and non-Paraform hosts are excluded from Paraform request counts.
- A signed Paraform resume-URL request is provider traffic; the following signed
  blob download is not.
- Existing manual/browser callers outside these transport owners are uncovered
  unless separately wired. Absence of an event is not a claim that Paraform was
  quiet.

## Verification boundary

Run the focused pause, throttle, Inbox, booking, Submissions V2 worker, resume
collector, and release-manifest tests after wiring. The V2 release manifest must
be regenerated and checked for any sealed source change. A passing local test or
release seal does not prove collector ingestion or a deployed runtime revision.
