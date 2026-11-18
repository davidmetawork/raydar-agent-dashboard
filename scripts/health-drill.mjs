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
// --unreachable <id> is the OFFLINE drill for a site nobody can connect to
// (the 2026-11-18 parked-domain outage). It needs no env file and no network:
//
//   node scripts/health-drill.mjs --unreachable booking-door
//
// The check is pointed at a stand-in on this machine that answers like a
// healthy booking site, then at a local port with nothing listening (a real
// refused connection, not a mock), then back. Every request that would leave
// this machine is refused before it is sent and counted, so the real booking
// site is never touched and every other tile reads UNKNOWN. Hold probes only.
//
// It never sets HEALTH_ALERTS_ENABLED and never loads the pager, so a drill
// cannot page anyone.
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

const offline = flag("unreachable", null);
const broken = offline || flag("break", null);
const ticks = Number(flag("ticks", broken ? 4 : 1));
if (offline && args.includes("--break")) {
  console.error("use --break or --unreachable, not both");
  process.exit(1);
}
if (broken && !byId.has(broken)) {
  console.error(`unknown check "${broken}". ids: ${CATALOG.map((c) => c.id).join(", ")}`);
  process.exit(1);
}
const target = broken ? byId.get(broken) : null;
if (offline && target.probe?.kind !== "holdProbe") {
  console.error(`--unreachable has a stand-in for hold probes only; "${offline}" is not one`);
  process.exit(1);
}
if (offline && ticks < 4) {
  console.error("--unreachable needs --ticks 4 or more: a baseline, two failed checks, a recovery");
  process.exit(1);
}
const goodUrl = target?.probe?.url;
const goodHealthUrl = target?.probe?.healthUrl;

// ---- offline mode: a stand-in door, a dead port, and a closed network ------
let door = null;
let deadOrigin = null;
let blocked = 0;
let passed = 0;
if (offline) {
  door = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const hold = req.url === "/api/hold";
      res.writeHead(hold ? 409 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(hold
        ? { error: "slot_taken" }
        : { ok: true, agentAdmission: true, checks: {} }));
    });
  });
  await new Promise((r) => door.listen(0, "127.0.0.1", r));
  // A port that was just free and is now closed: connecting to it is refused.
  const spare = http.createServer();
  await new Promise((r) => spare.listen(0, "127.0.0.1", r));
  deadOrigin = `http://127.0.0.1:${spare.address().port}`;
  await new Promise((r) => spare.close(r));

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    let host = "";
    try { host = new URL(String(input?.url || input)).hostname; } catch { /* refused below */ }
    if (host !== "127.0.0.1") {
      blocked += 1;
      return Promise.reject(new TypeError("drill: network closed"));
    }
    passed += 1;
    return realFetch(input, init);
  };
}
const otherPulls = CATALOG.filter((c) => c.kind === "pull" && !c.paused && c.id !== broken);
const otherPullsDown = new Set();
const pointDoorAt = (origin) => {
  target.probe.url = `${origin}/api/hold`;
  target.probe.healthUrl = `${origin}/api/health`;
};

for (let i = 1; i <= ticks; i += 1) {
  // Break after the first tick (so there is a baseline), heal before the last.
  if (target && offline) {
    if (i === 1 || i === ticks) pointDoorAt(`http://127.0.0.1:${door.address().port}`);
    else if (i === 2) pointDoorAt(deadOrigin);
  } else if (target) {
    if (i === 2) target.probe.url = `${String(goodUrl).replace(/\/+$/, "")}-drill-404`;
    if (i === ticks) target.probe.url = goodUrl;
  }
  const { state, transitions, incidents } = await runTick({});
  console.log(`\n── tick ${i}/${ticks}  overall=${state.overall} ${JSON.stringify(state.counts)}`);
  // Offline, every other tile is UNKNOWN by construction: print the target only.
  const shown = (row) => !offline || row.id === broken;
  for (const t of transitions.filter(shown)) console.log(`   ${t.id}: ${t.from} → ${t.to}  ${t.reason || ""}`);
  for (const inc of incidents.filter(shown)) {
    console.log(`   incident ${inc.closedAt ? "CLOSED" : "OPEN"} ${inc.id} worst=${inc.worst} ${inc.reason || ""}`);
  }
  if (target) {
    const t = state.tiles[broken];
    console.log(`   [${broken}] ${t.state}${t.pending ? ` (pending ${t.pending})` : ""} — ${t.reason || ""}`);
  }
  if (offline) {
    for (const c of otherPulls) if (state.tiles[c.id]?.state === "DOWN") otherPullsDown.add(c.id);
  }
}

if (offline) {
  target.probe.url = goodUrl;
  target.probe.healthUrl = goodHealthUrl;
  door.close();
  console.log(`\n   the ${otherPulls.length} other pulled checks, network closed for all ${ticks} ticks: `
    + `${otherPullsDown.size} went DOWN${otherPullsDown.size ? ` (${[...otherPullsDown].join(", ")})` : ""}`);
  console.log(`   network: ${passed} requests to 127.0.0.1, ${blocked} outside requests refused before sending`);
  console.log("   pager: not loaded, HEALTH_ALERTS_ENABLED unset — nothing was posted");
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
