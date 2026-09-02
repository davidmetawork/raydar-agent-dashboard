import http from "node:http";
import { runPurgeCycle } from "./purge.mjs";

const port = Number(process.env.PORT || 8080);
const intervalMs = Math.max(60_000, Math.min(24 * 60 * 60_000, Number(process.env.SUBMISSIONS_V2_PURGE_INTERVAL_MS) || 6 * 60 * 60_000));
let last = { at: null, ok: null, summary: null, error: null };
let running = false;

async function cycle() {
  if (running) return;
  running = true;
  try {
    const summary = await runPurgeCycle();
    last = { at: new Date().toISOString(), ok: summary.failed === 0, summary, error: summary.failed === 0 ? null : "purge_items_failed" };
  } catch (error) {
    last = { at: new Date().toISOString(), ok: false, summary: null, error: String(error?.code || "purge_cycle_failed") };
  } finally {
    running = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url !== "/health") { res.writeHead(404).end(); return; }
  res.writeHead(last.ok === false ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ service: "submissions-v2-purge", running, ...last }));
});
server.listen(port, "0.0.0.0", () => cycle());
const timer = setInterval(cycle, intervalMs);
timer.unref?.();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  });
}
