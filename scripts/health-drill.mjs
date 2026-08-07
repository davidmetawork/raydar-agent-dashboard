#!/usr/bin/env node
// Run the health tick against an in-memory KV so a drill never writes to the
// live hlth:* namespace. Probes still hit the real endpoints, read-only.
//
//   vercel env pull .env.drill --environment production --yes
//   node --env-file=.env.drill scripts/health-drill.mjs
//   node --env-file=.env.drill scripts/health-drill.mjs --break calls-api --ticks 4
//
// --break <id> points a check at a 404 path so you can watch the two-tick
// debounce, the incident open, and the recovery round trip. This is how PRD
// §8.5 Drill 1 was run; Drills 2-4 use the same harness.
//
// It never sets HEALTH_ALERTS_ENABLED, so a drill cannot page anyone.
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

// ---- in-memory Upstash REST stand-in -------------------------------------
const store = new Map([
  ["seqguard:n8nwatch", JSON.stringify({ at: new Date().toISOString(), streaks: [] })],
]);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let cmd = [];
    try { cmd = JSON.parse(body); } catch { /* ignore */ }
    const [op, ...a] = cmd;
    let result = null;
    switch (String(op).toUpperCase()) {
      case "GET": result = store.get(a[0]) ?? null; break;
      case "MGET": result = a.map((k) => store.get(k) ?? null); break;
      case "SET": {
        const nx = a.slice(2).some((x) => String(x).toUpperCase() === "NX");
        if (nx && store.has(a[0])) { result = null; break; }
        store.set(a[0], a[1]); result = "OK"; break;
      }
      case "DEL": result = store.delete(a[0]) ? 1 : 0; break;
      default: result = null;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.KV_REST_API_URL = `http://127.0.0.1:${server.address().port}`;
process.env.KV_REST_API_TOKEN = "drill";
delete process.env.HEALTH_ALERTS_ENABLED; // a drill must never page

const { runTick } = await import("../api/health/_lib/engine.mjs");
const { CATALOG, byId } = await import("../api/health/_lib/catalog.mjs");

const broken = flag("break", null);
const ticks = Number(flag("ticks", broken ? 4 : 1));
if (broken && !byId.has(broken)) {
  console.error(`unknown check "${broken}". ids: ${CATALOG.map((c) => c.id).join(", ")}`);
  process.exit(1);
}
const target = broken ? byId.get(broken) : null;
const goodUrl = target?.probe?.url;

for (let i = 1; i <= ticks; i += 1) {
  // Break after the first tick (so there is a baseline), heal before the last.
  if (target) {
    if (i === 2) target.probe.url = `${String(goodUrl).replace(/\/+$/, "")}-drill-404`;
    if (i === ticks) target.probe.url = goodUrl;
  }
  const { state, transitions, incidents } = await runTick({});
  console.log(`\n── tick ${i}/${ticks}  overall=${state.overall} ${JSON.stringify(state.counts)}`);
  for (const t of transitions) console.log(`   ${t.id}: ${t.from} → ${t.to}  ${t.reason || ""}`);
  for (const inc of incidents) {
    console.log(`   incident ${inc.closedAt ? "CLOSED" : "OPEN"} ${inc.id} worst=${inc.worst} ${inc.reason || ""}`);
  }
  if (target) {
    const t = state.tiles[broken];
    console.log(`   [${broken}] ${t.state}${t.pending ? ` (pending ${t.pending})` : ""} — ${t.reason || ""}`);
  }
}

if (!broken) {
  const state = JSON.parse(store.get("hlth:state"));
  for (const g of [...new Set(CATALOG.map((c) => c.group))]) {
    console.log(`\n[${g}]`);
    for (const c of CATALOG.filter((x) => x.group === g)) {
      const t = state.tiles[c.id] || {};
      console.log(`  ${String(t.state).padEnd(9)} ${c.id.padEnd(30)} ${t.reason || ""}`);
    }
  }
}

server.close();
