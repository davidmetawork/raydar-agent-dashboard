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

## September 18 implementation state

### Done

- The reviewed shared emitter is vendored byte-for-byte at SHA-256
  `fcebf8c7ad24bbe2077dc76f7a5f2755250849a9909f24dce15252d04aaf0949`,
  and the listed transport owners call it at the actual Paraform fetch boundary.
  Booking sweep, booking membership refresh, sequence health, and mailbox health
  bind their fixed source contexts. ParaAI remains its own default source; all
  V1 HTTP routes and the V2 router bind explicit versioned source contexts.
- Warm Node runtimes now retain one bounded reporter per fetch identity, source,
  and deployment telemetry configuration. The production-default explicit
  `process.env` form reuses the same reporter; injected environments or collector
  implementations remain uncached. The cache retains only the existing bounded
  metadata reporter and never provider inputs, bodies, candidate identifiers,
  URLs, response objects, or raw errors. Collector delivery may retry once, but
  the provider attempt is never replayed.
- Source commit `08b7d4f70632aeddeeb900310e9bd6bf332c8d97` includes the
  corrected release fixture and seal. Focused context plus release tests pass
  14/14; full and deployment seal checks match digest
  `bb16e7443265f30cbbc18a51742f5711acb4ae9ad9cc117d18343db0ba5c5554`.
- Booking-adjacent webhook and canary endpoints that perform no provider read
  retain `dashboard-sequences`; this is an explicit source classification, not
  a pause or behavior change. Existing production pause controls are unchanged.

### Next

- The production owner installs the collector values, deploys the reviewed
  dashboard artifact, and independently reads back collector receipt and source
  freshness without issuing a provider probe. The exact Fly V2 artifact remains
  a separate root-owned deployment from its own sealed branch.

### Blocked / not live

- This commit and passing seal are source evidence only. They do not prove a
  deployed dashboard revision, collector acceptance, reporting completeness, or
  provider-wide health. No deploy, environment change, pause change, queue
  replay, candidate mutation, or provider request was performed here.
