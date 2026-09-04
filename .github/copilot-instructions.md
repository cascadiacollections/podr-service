# Podr service

Python 3.13 FastAPI API deployed on Cloudflare Python Workers. Keep application code in
`src/podr`, Workers entrypoints in `src/entry.py`, and container egress in
`container_src/main.py`. Maintain existing HTTP contracts, feature-flag defaults,
provider response fields, and the ITunesProxy Durable Object identity.

Use `uv sync --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, and
`uv run pytest`. Verify Workers packaging with `uv run pywrangler deploy --dry-run
--outdir=dist --containers-rollout=none`. Test cloud interoperability in Wrangler;
CPython tests cannot prove JavaScript FFI compatibility.

Keep binding access in the runtime adapter. Background analytics must not fail API
requests. The daily 02:00 UTC cron warms queries in batches of five. D1 and Vectorize
remain optional until provisioned. Apply all D1 migrations before enabling its binding.
