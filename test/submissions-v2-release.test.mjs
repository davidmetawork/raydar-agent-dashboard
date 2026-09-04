import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildSubmissionsReleaseManifest,
  checkSubmissionsReleaseDeploymentManifest,
  checkSubmissionsReleaseManifest,
  writeSubmissionsReleaseManifest,
} from "../scripts/submissions-release.mjs";

async function seed(root, path, value = path) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "raydar-submissions-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    seed(root, "package.json"), seed(root, "package-lock.json"), seed(root, ".vercelignore"), seed(root, "scripts/submissions-release.mjs"),
    seed(root, "api/inbox/_lib/core.mjs"), seed(root, "api/paraai/_lib/core.mjs"), seed(root, "api/auth/_lib/session.mjs"),
    seed(root, "api/seq/_lib/core.mjs"), seed(root, "api/seq/_lib/scheduling-links.mjs"), seed(root, "api/sourcing/_lib/store.mjs"), seed(root, "api/roster/_lib/outcome-sequences.mjs"),
    seed(root, "submissions-v2.html"), seed(root, "submissions-v2.css"), seed(root, "submissions-v2.js"), seed(root, "submissions-v2-ui-state.mjs"),
    seed(root, "api/submissions-v2-dispatch.mjs"), seed(root, "scripts/migrate-submissions-v2.mjs"), seed(root, "vercel.json"),
    seed(root, "api/submissions-v2/_lib/service.mjs"), seed(root, "submissions-v2-worker/server.mjs"), seed(root, "submissions-v2-worker/Dockerfile"), seed(root, "submissions-v2-worker/fly.toml"),
    seed(root, "resume-renderer-v2/app.py"), seed(root, "resume-renderer-v2/requirements.txt"), seed(root, "resume-renderer-v2/assets/raydar-lockup.svg"), seed(root, "resume-renderer-v2/Dockerfile"), seed(root, "resume-renderer-v2/fly.toml"),
    seed(root, "migrations/submissions-v2/001_foundation.sql"),
  ]);
  return root;
}

test("release seal is deterministic and check accepts the exact written source set", async (t) => {
  const root = await fixture(t);
  const first = await buildSubmissionsReleaseManifest({ root });
  const written = await writeSubmissionsReleaseManifest({ root });
  const checked = await checkSubmissionsReleaseManifest({ root });
  assert.deepEqual(written, first);
  assert.deepEqual(checked, first);
  assert.equal(first.files.some((file) => file.path.includes("release-manifest")), false);
});

test("release check rejects tampered, added, and missing permitted source files", async (t) => {
  const root = await fixture(t);
  await writeSubmissionsReleaseManifest({ root });

  await seed(root, "submissions-v2.js", "changed");
  await assert.rejects(checkSubmissionsReleaseManifest({ root }), /stale/);

  await writeSubmissionsReleaseManifest({ root });
  await seed(root, "api/submissions-v2/_lib/new-route.mjs", "export default null;");
  await assert.rejects(checkSubmissionsReleaseManifest({ root }), /stale/);

  await writeSubmissionsReleaseManifest({ root });
  await rm(join(root, "migrations/submissions-v2/001_foundation.sql"));
  await assert.rejects(checkSubmissionsReleaseManifest({ root }), /stale/);
});

test("environment files are excluded from a release digest and never make it into the manifest", async (t) => {
  const root = await fixture(t);
  await seed(root, "submissions-v2-worker/.env.production", "DATABASE_URL=private");
  const manifest = await writeSubmissionsReleaseManifest({ root });
  await checkSubmissionsReleaseManifest({ root });
  assert.equal(manifest.files.some((file) => file.path.includes(".env")), false);
});

test("release check fails closed when the static manifest is missing", async (t) => {
  const root = await fixture(t);
  await writeSubmissionsReleaseManifest({ root });
  await rm(join(root, "submissions-v2-release.json"));
  await assert.rejects(checkSubmissionsReleaseManifest({ root }), /missing or invalid/);
});

test("the generated manifest module must match the sealed static manifest", async (t) => {
  const root = await fixture(t);
  await writeSubmissionsReleaseManifest({ root });
  await seed(root, "api/submissions-v2/_lib/release-manifest.mjs", "export const changed = true;\n");
  await assert.rejects(checkSubmissionsReleaseManifest({ root }), /module is stale/);
});

test("deployment check accepts only Vercel's intentional Submissions omissions", async (t) => {
  const root = await fixture(t);
  await writeSubmissionsReleaseManifest({ root });
  await Promise.all([
    rm(join(root, "migrations/submissions-v2"), { recursive: true }),
    rm(join(root, "resume-renderer-v2"), { recursive: true }),
    rm(join(root, "submissions-v2-worker"), { recursive: true }),
    rm(join(root, "scripts/migrate-submissions-v2.mjs")),
  ]);
  const checked = await checkSubmissionsReleaseDeploymentManifest({ root });
  assert.ok(checked.deployed_file_count < checked.file_count);
});

test("deployment check rejects changed or missing API files and unexpected deployed additions", async (t) => {
  const root = await fixture(t);
  await writeSubmissionsReleaseManifest({ root });
  await seed(root, "api/submissions-v2/_lib/service.mjs", "changed");
  await assert.rejects(checkSubmissionsReleaseDeploymentManifest({ root }), /stale: api\/submissions-v2\/_lib\/service\.mjs/);

  await writeSubmissionsReleaseManifest({ root });
  await rm(join(root, "api/submissions-v2/_lib/service.mjs"));
  await assert.rejects(checkSubmissionsReleaseDeploymentManifest({ root }), /required file: api\/submissions-v2\/_lib\/service\.mjs/);

  await seed(root, "api/submissions-v2/_lib/service.mjs");
  await writeSubmissionsReleaseManifest({ root });
  await seed(root, "api/submissions-v2/_lib/unexpected.mjs", "export default null;");
  await assert.rejects(checkSubmissionsReleaseDeploymentManifest({ root }), /stale: api\/submissions-v2\/_lib\/unexpected\.mjs/);
});
