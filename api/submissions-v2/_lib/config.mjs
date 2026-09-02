export const boolEnv = (name, fallback = false, env = process.env) => {
  const value = String(env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
};

export function environmentControls(env = process.env) {
  return Object.freeze({
    ui: boolEnv("SUBMISSIONS_V2_UI_ENABLED", false, env),
    ingestion: boolEnv("SUBMISSIONS_V2_INGESTION_ENABLED", false, env),
    generation: boolEnv("SUBMISSIONS_V2_GENERATION_ENABLED", false, env),
    master_inbox: boolEnv("SUBMISSIONS_V2_MASTER_INBOX_ENABLED", false, env),
    curated: boolEnv("SUBMISSIONS_V2_CURATED_ENABLED", false, env),
  });
}

export function effectiveControls(environment, durable) {
  if (!durable || !Number.isInteger(Number(durable.control_epoch))) {
    return { ui: false, ingestion: false, generation: false, master_inbox: false, curated: false, control_epoch: null, readable: false };
  }
  return Object.freeze({
    ui: Boolean(environment?.ui && durable.ui_enabled),
    ingestion: Boolean(environment?.ingestion && durable.ingestion_enabled),
    generation: Boolean(environment?.generation && durable.generation_enabled),
    master_inbox: Boolean(environment?.master_inbox && durable.master_inbox_enabled),
    curated: Boolean(environment?.curated && durable.curated_enabled),
    control_epoch: Number(durable.control_epoch),
    readable: true,
  });
}

export function serviceConfig(env = process.env) {
  const databaseUrl = String(env.SUBMISSIONS_V2_DATABASE_URL || "").trim();
  const blobToken = String(env.SUBMISSIONS_V2_BLOB_READ_WRITE_TOKEN || "").trim();
  const strongSecret = (value) => Buffer.byteLength(String(value || "").trim(), "utf8") >= 32;
  return {
    controls: environmentControls(env),
    databaseConfigured: /^postgres(?:ql)?:\/\//i.test(databaseUrl),
    blobConfigured: Boolean(blobToken),
    workerConfigured: strongSecret(env.SUBMISSIONS_V2_WORKER_KEY),
    inboxConfigured: strongSecret(env.SUBMISSIONS_V2_INGEST_KEY),
    openaiConfigured: Boolean(env.SUBMISSIONS_V2_OPENAI_API_KEY),
    anthropicConfigured: Boolean(env.SUBMISSIONS_V2_ANTHROPIC_API_KEY),
    slackConfigured: Boolean(env.SUBMISSIONS_V2_SLACK_CHANNEL_ID && (env.SUBMISSIONS_V2_SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN || (env.SUBMISSIONS_V2_NOTIFICATION_BROKER_URL && env.SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY))),
  };
}
