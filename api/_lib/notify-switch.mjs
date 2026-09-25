// The #notify switch predicate, dependency-free so System Health's evaluators
// and alert transport can read it without pulling the Para AI / seq modules.
//
// The switch is ON only when BOTH hold:
//  - NOTIFY_SLACK_CHANNEL names the #notify channel, and
//  - HEALTH_ALERTS_ENABLED is exactly "true".
// The second condition matters because once the switch is on, senders drop
// the incidents a System Health tier-1 tile pages ("the tile owns it"). Tile
// pages only go out when HEALTH_ALERTS_ENABLED === "true" (api/health/tick.mjs),
// so a channel set without it would silence those incidents everywhere.
export function notifyChannel(env = process.env) {
  return String(env?.NOTIFY_SLACK_CHANNEL || "").trim();
}

export function notifySwitchOn(env = process.env) {
  return Boolean(notifyChannel(env)) && env?.HEALTH_ALERTS_ENABLED === "true";
}
