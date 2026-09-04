# Python migration validation

The TypeScript API and Go proxy have been replaced by Python. The Worker name,
`ITunesProxy` class/namespace, migration tag `v1`, and existing resource bindings
are retained. Existing HTTP endpoints, integer-prefix parsing, and provider payloads
remain compatible; `/docs`, `/redoc`, and `/openapi.json` are new.

Intentional corrections:

- Upstream cache entries retain a real stale window and use explicit timestamps.
- Circuit failures count once for each failed upstream attempt.
- D1 tracking uses an atomic upsert with country-aware uniqueness (migration 0003).
- Security and CORS headers cover all responses consistently.
- CI gates production deployment; deployment checks out the tested commit.
- RSS header reads stop before episode payloads and are bounded to 1 MiB.

## Checks performed locally

- Ruff lint and formatting pass.
- `uv lock --check --offline` passes.
- Wrangler's direct dry run packages the Python application modules and accepts the
  configured bindings/container. This does **not** establish third-party dependency
  vendoring or execution in workerd.
- 80 pytest cases cover HTTP contracts, providers, validation, feature flags, caching,
  circuit recovery, D1 migrations/queries, analytics, scheduled warming, the Python
  proxy, and the expected Workers SDK method signatures.

The machine's connection to `files.pythonhosted.org` fails during TLS negotiation,
including from Docker. Consequently, normal `uv sync`, the full pywrangler dependency
build, the final container build, and runtime integration smoke tests could not be
completed here.

To execute tests despite that outage, an isolated temporary environment used the
matching upstream Git tags for Python dependencies, the bundled Pydantic 2.13.5 /
pydantic-core 2.46.5, and CPython 3.12.14. Production targets Python 3.13. This is
useful contract coverage, not a replacement for the standard locked Python 3.13 CI.
The lockfile was resolved using official PyPI JSON metadata; artifact URLs and hashes
remain the official PyPI values. No alternate registry is configured in the project.

## Before production rollout

1. Run `uv sync --frozen`, `uv run pytest`, and the lint/format commands on Python 3.13.
2. Run `uv run pywrangler deploy --dry-run --outdir=dist --containers-rollout=none`.
3. Build the container and exercise `uv run pywrangler dev`, including `/health/deep`,
   a search miss/hit, optional feature bindings, container idle/restart, and cron warming.
4. Apply D1 migration 0003 before deploying if an existing DB binding is enabled.
   The checked-in DB binding remains disabled.
5. Measure Workers CPU and latency with representative queries. The existing 10 ms
   CPU limit is preserved and has not been shown sufficient for the Python runtime.

No production resources were deployed or changed during this migration. The previous
Git revision retains the old deployment toolchain for rollback.
