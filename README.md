# Podr's RESTful API

[![CI](https://github.com/cascadiacollections/podr-service/actions/workflows/python.yml/badge.svg)](https://github.com/cascadiacollections/podr-service/actions/workflows/python.yml)

Python 3.13 and FastAPI power the API for https://www.podrapp.com/. The application
runs on Cloudflare Python Workers; a Python container supplies upstream egress for
iTunes and podcast RSS feeds.

## Development

Install Python 3.13, [uv](https://docs.astral.sh/uv/), Node.js 24 (used internally by
pywrangler), and Docker (for the upstream proxy). Then:

```sh
uv sync --frozen
uv run pywrangler dev
```

For a standalone ASGI server without Cloudflare bindings or Docker:

```sh
uv run uvicorn podr.app:app --app-dir src --reload
```

Local ASGI mode uses bounded in-memory caching and direct upstream HTTP. Optional
cloud features are disabled without bindings; Apple may reject direct requests.
Use Wrangler to exercise production bindings and container egress.

The included devcontainer installs Python, uv, Node.js, GitHub CLI, and Docker client
support. It reuses the host Docker daemon and persistent uv/npm cache volumes, so
container rebuilds avoid reinstalling the toolchain and redownloading dependencies.

```sh
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run pywrangler deploy --dry-run --outdir=dist --containers-rollout=none
docker build -t podr-proxy .
```

The same commands are available as `mise run check`, `mise run dev`, `mise run local`,
and `mise run container`.

## API

Base URL: `https://podr-service.cascadiacollections.workers.dev`

| Endpoint | Behavior |
| --- | --- |
| `GET /` | Generated OpenAPI schema when `q` is absent |
| `GET /?q=python&limit=15` | Podcast search, limit 1–200 |
| `GET /?q=toppodcasts&limit=15&genre=1312` | Top podcasts, optional genre |
| `GET /podcast/42?summary=true` | Metadata and recent episodes; optional RSS description |
| `GET /related?id=42&limit=10` | Genre-related podcasts, limit 1–20 |
| `GET /trending?limit=10&country=US` | Seven-day trending queries, limit 1–50 |
| `GET /suggest?q=py&limit=5` | Prefix suggestions, limit 1–10 |
| `GET /semantic-search?q=python&limit=10` | Workers AI and Vectorize discovery |
| `GET /health` | Liveness and circuit-breaker state |
| `GET /health/deep` | Upstream probe through the container; 503 if unhealthy |
| `GET /openapi.json` | Generated OpenAPI schema |
| `GET /docs`, `GET /redoc` | Interactive API documentation |

Requests retain legacy integer-prefix parsing, clamping, plain-text errors, and
GET-only behavior. Search responses retain provider fields. Health probes bypass
rate limiting; other endpoints use 100 requests per minute per client IP when the
binding is configured. Security and CORS headers are included on all responses.

## Architecture

- `src/podr/app.py`: FastAPI routes, HTTP policy, generated documentation.
- `src/podr/models.py`: Pydantic response contracts.
- `src/podr/validation.py`: compatibility rules for query parameters.
- `src/podr/services.py`: iTunes, Podcast Index, RSS, related and semantic discovery.
- `src/podr/cache.py`: cache freshness, background revalidation, circuit breaker.
- `src/podr/analytics.py`: D1 aggregation, Analytics Engine metrics, R2 events.
- `src/podr/runtime.py`: native Python and Cloudflare binding adapters.
- `src/entry.py`: Workers ASGI entrypoint, daily cron and `ITunesProxy` Durable Object.
- `container_src/main.py`: streaming FastAPI/httpx upstream proxy.

The Durable Object uses Cloudflare's low-level container API to manage readiness,
port 8080, and five-minute idle shutdown in Python. Its class name, instance name,
Worker name and migration history are preserved. No JavaScript application or Go
proxy is required.

## Cache and resilience

| Response | Fresh TTL |
| --- | --- |
| Search | 24 hours |
| Top podcasts | 2 hours |
| Podcast details and related | 4 hours |
| Semantic response | 1 hour |
| Trending and suggestions | 5 minutes |
| Root schema | 1 year, immutable |

Upstream cache entries retain an additional 24-hour stale window. Explicit storage
timestamps determine freshness; stale responses trigger background refresh. Five
upstream failures open the per-isolate circuit for 30 seconds. Stale entries can be
served while the circuit is open. Analytics and cache writes use background work.

The daily 02:00 UTC cron warms the top ten D1 queries, or a fixed fallback list,
using batches of five with 500 ms between batches.

## Bindings and flags

`wrangler.jsonc` preserves the existing KV, R2, Analytics Engine, rate limiter,
Workers AI, and container bindings. D1 and Vectorize remain commented out until
provisioned. Set KV keys named `flag:<name>` to the literal string `true`:

| Flag | Behavior | Default |
| --- | --- | --- |
| `trendingQueries` | Enables trending and suggestions | false |
| `semanticSearch` | Enables semantic search | false |
| `podcastSummaries` | Enables requested RSS descriptions | false |
| `podcastIndex` | Uses Podcast Index if both credentials exist | false |

`enhancedCaching` and `analyticsExport` were unused flags in the previous code.
R2 export continues whenever `ANALYTICS_LAKE` is configured, preserving actual
production behavior. R2 events contain query text; SHA-256 query hashes support D1
aggregation but do not anonymize its stored normalized queries.

Podcast Index credentials are Worker secrets:

```sh
uv run pywrangler secret put PODCAST_INDEX_KEY
uv run pywrangler secret put PODCAST_INDEX_SECRET
```

For D1, apply **all** migrations before enabling `DB`. Migration 0003 preserves old
rows and makes `(query_hash, date, country)` unique so country counts and atomic
upserts work. Empty country denotes global/unknown origin. Existing installations
must apply 0003 before deploying this Python version with DB enabled.

## Deployment

CI runs lint, formatting, tests, Worker dry-run packaging and a container build.
Successful CI for a push to main triggers deployment of that exact commit. Configure
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in GitHub secrets.

```sh
uv run pywrangler deploy
```

Before the first production rollout, verify the Python Worker and container together
in Wrangler/staging and measure CPU usage against the preserved 10 ms CPU budget.
CPython contract tests do not validate Cloudflare's JavaScript FFI or actual Apple
connectivity. For rollback, deploy the previous Git revision with its original
Bun/TypeScript build and Go container.
