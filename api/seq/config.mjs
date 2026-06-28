import { cors, authConfig } from "./_lib/core.mjs";

// Public config for the page: which Google client id to use + whether auth is enforced.
export default function handler(req, res) {
  if (cors(req, res)) return;
  res.status(200).json(authConfig());
}
