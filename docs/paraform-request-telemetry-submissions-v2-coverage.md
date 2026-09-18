# Submissions V2 Paraform telemetry coverage

This record covers the exact Fly V2 source artifact only. Telemetry records
bounded request metadata; it does not authorize work admission, a provider
probe, a replay, a candidate change, or any pause/control transition.

## Done

- The shared Paraform core runs under the fixed `submissions-v2` source context,
  and the direct signed-resume-URL request uses the same registered source. Each
  actual Paraform HTTP attempt remains authoritative and separate; blob download
  traffic, collector traffic, Raydar-internal calls, and non-Paraform hosts are
  excluded.
- The vendored emitter matches SHA-256
  `fcebf8c7ad24bbe2077dc76f7a5f2755250849a9909f24dce15252d04aaf0949`.
  Collector delivery has a 2.5-second send deadline, at most one metadata retry,
  and a five-second whole-flush budget. Regression coverage proves two failed
  collector sends still make exactly one provider attempt and preserve the
  provider response or thrown error.
- Warm runtimes retain one bounded reporter per fetch identity, resolved source,
  and deployment telemetry configuration. The production-default explicit
  `process.env` path is cached; injected environments or collector transports
  remain isolated and uncached. Cached state is limited to the emitter's bounded
  method/endpoint/timing/outcome queue and counters—never request bodies,
  candidate identifiers, full URLs, response objects, credentials in events, or
  raw errors.
- Source commit `ff792e625d25a1137c9f161b0a06e18e03fa2a3f` passes the
  focused emitter, context, and release suite 32/32. Full and deployment seal
  checks match digest
  `33949bf51b37ae52630948a09f6c693f8fb045b475f6b014f306cd8ecefa9aee`.

## Next

- Root builds and deploys only this exact sealed Fly V2 artifact, installs the
  registered `submissions-v2` collector values, and reads back deployment
  identity, collector receipt, source freshness, and existing pause/control
  state. Dashboard promotion remains a separate artifact and decision.

## Blocked / not live

- No Fly deployment or environment mutation occurred in this branch. Until
  Root completes deployment and receipt readback, the seal proves source bytes
  only—not collector ingestion, complete account coverage, Paraform quota, or
  provider-wide health. Existing durable gates and pause controls remain the
  sole work authority.
