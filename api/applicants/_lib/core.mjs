// Shared Applicants tab adapter. Auth/CORS come from the Sequences core so the
// Google-session contract stays single-source (same convention as
// api/paraai/_lib/core.mjs); Paraform transport is deliberately local
// (paraform.mjs) and KV is local (kv.mjs).

import { cors, requireAuth } from "../../seq/_lib/core.mjs";

export { cors, requireAuth };
