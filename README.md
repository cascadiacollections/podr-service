# Podr's RESTful API

[![Node.js CI](https://github.com/cascadiacollections/podr-service/actions/workflows/node.js.yml/badge.svg)](https://github.com/cascadiacollections/podr-service/actions/workflows/node.js.yml)

This project contains the RESTful API implementation for https://www.podrapp.com/.

## Architecture

```
                                    +------------------+
                                    |   Cloudflare     |
                                    |   Edge Cache     |
                                    +--------+---------+
                                             |
+----------+    +-------------------+        |        +------------------+
|  Client  +--->|  Cloudflare Worker|--------+------->|  iTunes API      |
+----------+    |  (podr-service)   |                 |  (via Container) |
                +--------+----------+                 +------------------+
                         |
         +---------------+---------------+
         |               |               |
+--------v----+  +-------v------+  +-----v--------+
|  KV Flags   |  |  R2 Data Lake|  | Analytics    |
| (features)  |  | (events)     |  | Engine       |
+-------------+  +--------------+  +--------------+
```

### Key Components

- **Cloudflare Workers Container**: Proxies all iTunes API calls to avoid Apple IP blocking
- **Edge Caching**: Stale-while-revalidate pattern with configurable TTLs
- **Circuit Breaker**: Fault tolerance with automatic recovery
- **Rate Limiting**: 100 requests per 60 seconds per client IP
- **R2 Data Lake**: Event streaming for batch analytics
- **KV Feature Flags**: Runtime feature toggles
- **Analytics Engine**: Real-time metrics and observability

## API Endpoints

Base URL: `https://podr-service.cascadiacollections.workers.dev`

### Podcast Search

```
GET /?q=<search_term>&limit=<optional>
```

- `q` (required): Search term (max 200 characters)
- `limit` (optional): Number of results, 1-200, default 15

Example: `/?q=javascript&limit=20`

### Top Podcasts

```
GET /?q=toppodcasts&limit=<optional>&genre=<optional>
```

- `q=toppodcasts` (required): Reserved parameter for top podcasts
- `limit` (optional): Number of results, 1-200, default 15
- `genre` (optional): iTunes genre ID (e.g., 1312 for Technology)

Example: `/?q=toppodcasts&limit=25&genre=1312`

**Genre IDs**: 1301 (Arts), 1302 (Comedy), 1303 (Education), 1304 (Kids & Family), 1305 (Health & Fitness), 1306 (TV & Film), 1307 (Music), 1308 (News), 1309 (Religion & Spirituality), 1310 (Science), 1311 (Sports), 1312 (Technology), 1313 (Business), 1314 (Society & Culture), 1315 (Government), 1321 (Fiction), 1323 (History), 1324 (True Crime), 1325 (Leisure), 1326 (Documentary)

### Podcast Detail

```
GET /podcast/<podcast_id>
```

- `podcast_id` (required): iTunes podcast ID

Example: `/podcast/1535809341`

Returns podcast metadata and up to 20 recent episodes.

### Health Checks

```
GET /health       # Basic health check (circuit breaker state, colo)
GET /health/deep  # Deep health check with upstream connectivity test
```

### Trending & Suggestions (Feature-Flagged)

```
GET /trending?limit=<optional>              # Trending search queries (7d)
GET /suggest?q=<prefix>&limit=<optional>    # Autocomplete suggestions
```

Requires `trendingQueries` feature flag to be enabled in KV.

### OpenAPI Schema

```
GET /    # Returns OpenAPI 3.0 schema (when no query params)
```

## Cache Configuration

| Endpoint         | TTL                | Stale Tolerance |
| ---------------- | ------------------ | --------------- |
| Schema           | 1 year (immutable) | N/A             |
| Search           | 24 hours           | 24 hours        |
| Top Podcasts     | 2 hours            | 24 hours        |
| Podcast Detail   | 4 hours            | 24 hours        |
| Trending/Suggest | 5 minutes          | N/A             |

## Feature Flags

Controlled via KV namespace `FLAGS`:

| Flag              | Description                             | Default |
| ----------------- | --------------------------------------- | ------- |
| `trendingQueries` | Enable /trending and /suggest endpoints | false   |
| `podcastIndex`    | Use Podcast Index API instead of iTunes | false   |
| `analyticsExport` | Export events to R2 data lake           | false   |

Set flags: `wrangler kv:key put --binding FLAGS "flag:trendingQueries" "true"`

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (see package.json for supported versions)
- [Yarn](https://yarnpkg.com/)

### Setup

```bash
# Install dependencies
yarn install

# Run development server
yarn dev

# Build for production
yarn build
```

### Testing and Linting

```bash
# Run tests
yarn test

# Watch mode for tests
yarn test:watch

# Lint code
yarn lint

# Fix linting issues
yarn lint:fix

# Format code
yarn format
```

### Dev Container

This repository includes a dev container configuration for VS Code. To use it:

1. Install the [Remote - Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension
2. Open the repository in VS Code
3. Click on the green icon in the bottom-left corner of VS Code
4. Select "Reopen in Container"

The dev container comes with all necessary dependencies pre-installed.

### Deployment

The project uses automated deployments via GitHub Actions. Pushes to the `main` branch automatically trigger deployment to Cloudflare Workers after all CI checks pass.

#### Automated Deployment

Deployments are automatically triggered on:

- Pushes to the `main` branch
- Manual workflow dispatch via GitHub UI

The deployment workflow requires the following GitHub secrets to be configured:

- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token with Workers deployment permissions
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID

#### Manual Deployment

You can also deploy manually from your local machine:

```bash
# Deploy to Cloudflare Workers
yarn deploy
```

Note: Manual deployment requires Wrangler authentication via `wrangler login` or environment variables.

### Secrets Configuration

For Podcast Index API integration (optional):

```bash
wrangler secret put PODCAST_INDEX_KEY
wrangler secret put PODCAST_INDEX_SECRET
```

Register at https://api.podcastindex.org/signup

## Scheduled Tasks

Cache pre-warming runs every 6 hours via cron trigger, warming cache for popular search terms: news, comedy, true crime, technology, business, health, sports, music, science, history.
