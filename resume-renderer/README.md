# Raydar resume renderer

This is the isolated, authenticated Fly service behind Monitor's Submissions
Resume action. It accepts source-grounded structured facts and an optional
candidate PDF, then returns a branded PDF, ATS text, the editable document and
a fact manifest. It never stores request bodies or artifacts.

Required Fly secrets:

- `RESUME_RENDERER_KEY` — shared only with the Monitor deployment.
- `ANTHROPIC_API_KEY` — selects and orders supplied fact IDs; it cannot author
  resume prose.

Deploy from the dashboard repository root with that repository as the explicit
build context so Docker can include the shared `fonts/` directory:

```sh
flyctl deploy . --config resume-renderer/fly.toml
```

Monitor requires `RESUME_RENDERER_URL`, `RESUME_RENDERER_KEY`, and the private
Vercel Blob `BLOB_READ_WRITE_TOKEN`. `/healthz` is public and contains no
candidate data; `/render` requires the bearer key.
