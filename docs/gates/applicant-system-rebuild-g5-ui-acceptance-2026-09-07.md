# Applicant System Rebuild G5 — UI acceptance evidence

Date: 2026-09-07
Candidate branch: `codex/applicants-ui-rebuild`
Candidate base: `da866190b3a45120d595ef3ce0f503c98ff1b8e7`
Main merge base: `10318ec98dcf079345719d45c4605c894497676a`

## Scope verified

The candidate adds the graph-backed Applicant V2 projection to the existing
Applicants surface: exact applied job and hiring company, fact provenance and
safe history display, a read-only Problems view, typed `waiting` interview
requests, and versioned same-record Rule selection. The close path restores
keyboard focus to a current matching row link by application key (or the active
view control for a URL-restored profile) without moving virtual-list scroll.

## Automated evidence

- `node --test test/applicants*.test.mjs`: 482 tests; 480 passed; 0 failed;
  2 skipped. Both skips are optional atomic-Lua checks because `lupa` is not
  installed in this local test runtime.
- `node /Users/davidphillips/Documents/Claude/Projects/Raydar/webview/scripts/dashboard-contract-check.mjs`:
  `CONTRACT INTACT` for `/api/status`, `/api/actions`, and `/api/history`.
- `git diff --check`: clean.

This is local source and automated-test evidence only. It does not claim a
production deployment, provider delivery, or a live Rules run.

## Candidate source manifest

The following SHA-256 manifest covers every changed or new source/test artifact
in this candidate before this evidence file was added. Manifest SHA-256:
`bc238b2f78dfeb6864d41b02d1350c9fa50edebb96b8587137e66ec4a8ed58a9`.

```text
d6f2e47aedde5ac809d69e49c91a79a3706b1d2ef86b71512f45f595f44c25ca  api/applicants/_lib/generation.mjs
e5c8771a92320717ff749e07a0cd458f47ad2ef08a86d72289e7327070a3ed54  api/applicants/_lib/kv.mjs
c877e6b6bf46c642c4319b8c878ceacdf9e609417d9f548e229dab873d17b895  api/applicants/_lib/profile-v2-rule-seed.mjs
474d5570a7c5c263295a79e29bfb445bd1792c7eef318ecff5619a850312bb90  api/applicants/_lib/profile-v2.mjs
9af803b850028b3997e6586e5b89ccac51c6ef01982e6dfb7b6092550d3a26d8  api/applicants/_lib/rule-run-v2.mjs
498e72f1dbd40f4c13a6e328ab82b31ef684e1e5d99b6a72c5369e0058334619  api/applicants/decision.mjs
c755581a14793e74770b556126c9737d0174ff78550b44b22f2495c83a67c72a  api/applicants/feed.mjs
0e18fe5017b2ddf9a575732d464a33f667fecc06a45a6d47ebef01e6af09528c  api/applicants/problems.mjs
0c090754017fcee36987343a8b61077067841c346dc5bd9fec51ecf45bb4ec1e  api/applicants/profile.mjs
095b73ff7b56c50e997b59ee14c7b6ef1d30ffabed6d3c4b5c86fb35fc12b483  api/applicants/rules-tick.mjs
29a6b762948ab4ffe8b9d906a3b0adc7d1fc54cf730a43306f70b2d4018f3803  api/applicants/rules.mjs
52353e41d12eedd312ac1620daf70d79b60ea112c0c9830862c17aac29292e46  api/applicants/sync.mjs
50369881c1c77f246814cdd8fa7c6b6b21eb9566968b9593a6d6eeac64902ef5  applicants-rule-facts.js
bc560f386f47c14d25c76d24b3166b5c2e17aa9b5b34cf4f368001cd7bac8d3f  applicants-rules.js
7f3974bf516f0cf24158a4c889652ef6fabdc7a55e12aa87a80bbb09af1cb780  applicants.html
03fd49e42c1296ad81e688cc6afcc92827b820d0b53b2dfa44fac5cd6eee171c  test/applicants-bulk-index-ui.test.mjs
fae4a80ba5c1f0ea257a54a75140cb21f2b0dc32b1fa419e89bc6cec70c27db7  test/applicants-count-banner-ui.test.mjs
f4797c7fe2f2fa6fef2807f9ca8f2c94dd3125612481669eb594dd273f5aad76  test/applicants-date-timezone.test.mjs
5407ec8f6f6ebd197eecceeb72f6fec5c3aeae47aa5364ce7b0ed8af6f4f10ee  test/applicants-decision-v2.test.mjs
925b22854c20b288571dd15ae699ce5d96db61b06382edda9ba40fb3280d96af  test/applicants-honest-interview-pill.test.mjs
86cb0dbac5ef4aaf3b6d721219f3eb7359bb4f429ff5b3e92b2e9af01990e63f  test/applicants-modal-focus.test.mjs
928cc59771db1ea7188cec4b4343ccf7f4e3683684fafb7685ecb242e1a5d194  test/applicants-profile-v2.test.mjs
28b66033bd3ef613b758f89555fbda66b2b50f2c4640459d5f74c678c35d4111  test/applicants-refresh.test.mjs
fee9aefab6715a5341d9c81bd7c2f7e4ea97022af2c0b738fefefa476dac9688  test/applicants-rule-facts.test.mjs
017a9703bdfd3b4849a10a5068c8c705c259f8fb809dbbcbaa870f92aef34301  test/applicants-rule-run-command.test.mjs
c2e9fb824d05ab793c240a779a4118780212257352ad221e1947cd7fcfd2b5cb  test/applicants-rules-editor.test.mjs
90f743067c4cfc8707d12204a2ac3393fe485b2c246f158f8b30e3004c6da98a  test/applicants-rules-tick.test.mjs
e9e40af9318ac55adc47188b94bddce487c75d8e3c56a86c66599ba46320e9af  test/applicants-virtual-pitch.test.mjs
87b54ba88bbd118b5e6eb121636388c588b9565af0e4edbbe05c4c3d7a88a7a2  test/applicants.test.mjs
```
