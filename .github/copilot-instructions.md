# GitHub Copilot Instructions for Podr Service

## Project Overview

This is a Cloudflare Workers-based RESTful API service for https://www.podrapp.com/ that provides podcast search and discovery functionality through the iTunes API.

## Technology Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **Package Manager**: Yarn
- **Testing**: Jest with service-worker-mock
- **Linting**: ESLint with TypeScript support
- **Formatting**: Prettier

## Code Style Guidelines

### TypeScript

- Use strict TypeScript with explicit return types for functions
- Prefer interfaces for object shapes
- Use const for immutable values
- Follow the existing ESLint configuration

### Cloudflare Workers Patterns

- Use modern Module Worker pattern with `export default { fetch: ... }`
- Leverage the `Request`, `Response`, `env`, and `ctx` parameters
- Use `ctx.waitUntil()` for background tasks that shouldn't block responses
- Implement proper error handling with appropriate HTTP status codes

### Code Organization

- Keep API logic in the main worker file
- Use TypeScript interfaces for data structures
- Document functions with JSDoc comments
- Follow single responsibility principle

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

- RESTful endpoints using GET requests
- Return JSON responses with appropriate CORS headers
- Use query parameters for search criteria
- Implement proper error handling with descriptive messages
- Keep responses cacheable where appropriate

## Testing Guidelines

- Use Jest with service-worker-mock for testing Workers
- Test happy paths and error conditions
- Mock external API calls (iTunes API)
- Maintain test coverage for critical paths

## Security Considerations

- Sanitize and validate all user inputs
- Use CORS headers appropriately
- Follow Cloudflare Workers security best practices
- Keep dependencies up to date via Dependabot

## Performance Best Practices

- Minimize response sizes
- Leverage Cloudflare's edge caching
- Use efficient data structures
- Avoid blocking operations in the main request path

## Architecture Notes

### iTunes Proxy

All iTunes API calls are routed through a Cloudflare Workers Container (`ITunesProxy`) to avoid IP-based blocking from Apple. The proxy:

- Routes requests through: `http://container/?url=<encoded_url>`
- Falls back to direct fetch if container is unavailable
- Handles search, top podcasts, and podcast lookup endpoints

### Key Services

- **Circuit Breaker**: Fault tolerance pattern for upstream API failures
- **Response Caching**: Edge caching with configurable TTLs per endpoint type
- **Rate Limiting**: 100 requests per 60 seconds per client
- **Analytics**: R2 data lake for search query trends

## CI/CD

- GitHub Actions run on push and pull requests
- All code must pass linting and tests
- Build must succeed on Node.js 20, 22, and 24
- Security scans are performed automatically
