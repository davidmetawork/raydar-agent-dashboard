import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = resolve(here, "../migrations/submissions-v2");

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

export async function runMigrations({
  databaseUrl = argument("database-url") || process.env.SUBMISSIONS_V2_DATABASE_URL,
  migrationsDir = defaultMigrationsDir,
  logger = console,
} = {}) {
  if (!/^postgres(?:ql)?:\/\//i.test(String(databaseUrl || "").trim())) {
    throw new Error("SUBMISSIONS_V2_DATABASE_URL or --database-url is required");
  }
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 10,
    onnotice: () => {},
  });
  const applied = [];
  const skipped = [];
  try {
    await sql.unsafe(`
      create schema if not exists submissions_v2;
      create table if not exists submissions_v2.schema_migrations (
        version text primary key,
        digest_sha256 text not null check (digest_sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz not null default clock_timestamp()
      );
    `);
    await sql`select pg_advisory_lock(hashtext('submissions_v2:migrations'))`;
    const files = (await readdir(migrationsDir))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
      .sort((left, right) => left.localeCompare(right));
    if (!files.length) throw new Error(`No migrations found in ${migrationsDir}`);

    for (const version of files) {
      const source = await readFile(resolve(migrationsDir, version), "utf8");
      const digestSha256 = digest(source);
      const rows = await sql`
        select digest_sha256 from submissions_v2.schema_migrations where version = ${version}
      `;
      if (rows.length) {
        if (rows[0].digest_sha256 !== digestSha256) {
          throw new Error(`Migration digest mismatch for ${version}`);
        }
        skipped.push(version);
        continue;
      }
      await sql.begin(async (transaction) => {
        await transaction.unsafe(source);
        await transaction`
          insert into submissions_v2.schema_migrations (version, digest_sha256)
          values (${version}, ${digestSha256})
        `;
      });
      applied.push(version);
      logger.info?.(`Applied ${version}`);
    }
    return { applied, skipped };
  } finally {
    try { await sql`select pg_advisory_unlock(hashtext('submissions_v2:migrations'))`; } catch {}
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then((result) => {
      console.log(JSON.stringify({ ok: true, ...result }));
    })
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    });
}
