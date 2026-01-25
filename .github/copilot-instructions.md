# GitHub Copilot Instructions for Podr Service

## Project Overview

This is a Cloudflare Workers-based RESTful API service for https://www.podrapp.com/ that provides podcast search and discovery functionality through the iTunes API.

## Technology Stack

- **Runtime**: Cloudflare Workers with Containers
- **Language**: TypeScript (strict mode)
- **Package Manager**: Yarn 4
- **Testing**: Jest with service-worker-mock
- **Linting**: ESLint with TypeScript support
- **Formatting**: Prettier
- **Config**: wrangler.jsonc (JSONC format)

## Architecture

### iTunes Proxy (Cloudflare Containers)

All iTunes API calls are routed through a Cloudflare Workers Container (`ITunesProxy`) to avoid IP-based blocking from Apple. The container:

- Runs a Go-based HTTP proxy (`container_src/main.go`)
- Routes requests through: `http://container/?url=<encoded_url>`
- Falls back to direct fetch if container is unavailable
- Handles search, top podcasts, and podcast lookup endpoints
- Sleeps after 5 minutes of inactivity to reduce costs

### Bindings

| Binding          | Type             | Purpose                              |
| ---------------- | ---------------- | ------------------------------------ |
| `ITUNES_PROXY`   | Durable Object   | Container proxy for iTunes API       |
| `FLAGS`          | KV Namespace     | Feature flag storage                 |
| `ANALYTICS`      | Analytics Engine | Real-time metrics                    |
| `ANALYTICS_LAKE` | R2 Bucket        | Event data lake for batch processing |
| `RATE_LIMITER`   | Rate Limit       | 100 req/60s per client IP            |
| `DB`             | D1 Database      | Trending queries (when enabled)      |

### Feature Flags (KV)

Stored in KV with prefix `flag:`:

- `trendingQueries`: Enable /trending and /suggest endpoints
- `podcastIndex`: Use Podcast Index API instead of iTunes
- `analyticsExport`: Export events to R2

### Caching Strategy

- **Edge Cache**: Cloudflare Cache API with stale-while-revalidate
- **TTLs**: Schema (1yr), Search (24h), Top (2h), Detail (4h), Trending (5m)
- **Circuit Breaker**: Opens after 5 failures, recovers after 30s

### Analytics Pipeline

1. **Real-time**: Analytics Engine (blobs: endpoint, cache, status, colo; doubles: duration, resultCount)
2. **Batch**: R2 data lake with path `events/YYYY/MM/DD/HH/{requestId}.json`
3. **Trending**: D1 database tracking normalized search queries

## Code Style Guidelines

### TypeScript

- Use strict TypeScript with explicit return types for functions
- Prefer interfaces for object shapes
- Use const assertions for configuration constants
- Follow the existing ESLint configuration

### Cloudflare Workers Patterns

- Use modern Module Worker pattern with `export default { fetch: ... }`
- Leverage the `Request`, `Response`, `env`, and `ctx` parameters
- Use `ctx.waitUntil()` for background tasks (analytics, cache revalidation)
- Implement proper error handling with appropriate HTTP status codes
- Export Durable Object classes (e.g., `ITunesProxy extends Container`)

### Code Organization

- Single `src/index.ts` file (Cloudflare Workers convention)
- TypeScript interfaces at top of file
- Constants and configuration next
- Helper functions organized by domain
- Request handlers
- Main fetch handler at bottom
- Scheduled handler for cron tasks

## Development Workflow

### Before Making Changes

```bash
# Install dependencies
yarn install

# Run linter
yarn lint

# Run tests
yarn test

# Build project
yarn build
```

### Making Changes

1. Write tests first when adding new functionality
2. Ensure code passes linting: `yarn lint`
3. Format code with Prettier: `yarn format`
4. Verify tests pass: `yarn test`
5. Verify build succeeds: `yarn build`

### Common Commands

- `yarn dev` - Start local development server with Wrangler
- `yarn lint:fix` - Auto-fix linting issues
- `yarn test:watch` - Run tests in watch mode
- `yarn deploy` - Deploy to Cloudflare Workers

## API Design Principles

- RESTful endpoints using GET requests only
- Return JSON responses with appropriate CORS headers
- Use query parameters for search criteria
- Implement proper error handling with descriptive messages
- Keep responses cacheable where appropriate
- Include `X-Cache: HIT|MISS` header for cache status

## Testing Guidelines

- Use Jest with service-worker-mock for testing Workers
- Test happy paths and error conditions
- Mock external API calls (iTunes API, container proxy)
- Mock Cloudflare bindings (KV, R2, Analytics Engine)
- Maintain test coverage for critical paths

## Security Considerations

- Sanitize and validate all user inputs (max query length, suspicious patterns)
- Use CORS headers appropriately (`Access-Control-Allow-Origin: *`)
- Include security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`)
- Rate limit requests per client IP
- Follow Cloudflare Workers security best practices
- Keep dependencies up to date via Dependabot

## Performance Best Practices

- Minimize response sizes
- Leverage Cloudflare's edge caching with stale-while-revalidate
- Use circuit breaker for upstream resilience
- Pre-warm cache via scheduled tasks (every 6 hours)
- Use efficient data structures (Set for genre validation)
- Avoid blocking operations in the main request path
- Use `ctx.waitUntil()` for non-critical background work

## CI/CD

- GitHub Actions run on push and pull requests
- All code must pass linting and tests
- Build must succeed on Node.js 20, 22, and 24
- Security scans are performed automatically
- Automatic deployment to Cloudflare Workers on main branch push

## Key Files

| File                      | Purpose                          |
| ------------------------- | -------------------------------- |
| `src/index.ts`            | Main worker code, all endpoints  |
| `wrangler.jsonc`          | Cloudflare Workers configuration |
| `container_src/main.go`   | iTunes proxy container           |
| `Dockerfile`              | Container image definition       |
| `migrations/`             | D1 database migrations           |
| `__tests__/index.test.ts` | Jest test suite                  |
