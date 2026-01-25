import type { OpenAPIV3 } from 'openapi-types';

/**
 * Function type for API calls that return a Promise of unknown data
 */
type ApiCall = () => Promise<unknown>;

/**
 * Dictionary mapping iTunes genre IDs to their display names
 */
interface IGenresDictionary {
  [key: number]: string;
}

/**
 * Result from cachedFetch including cache hit information
 */
interface CachedFetchResult {
  response: Response;
  cacheHit: boolean;
}

/**
 * Log levels for structured logging
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured log context
 */
interface LogContext {
  requestId?: string;
  method?: string;
  path?: string;
  query?: string;
  duration?: number;
  cacheHit?: boolean;
  status?: number;
  error?: string;
  [key: string]: unknown;
}

/**
 * Analytics Engine data point
 */
interface AnalyticsDataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

/**
 * Analytics Engine binding
 */
interface AnalyticsEngine {
  writeDataPoint: (data: AnalyticsDataPoint) => void;
}

/**
 * KV namespace binding
 */
interface KVNamespace {
  get: (key: string, options?: { type?: 'text' | 'json' }) => Promise<string | null>;
  put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
}

/**
 * Feature flag configuration
 */
interface FeatureFlags {
  trendingQueries: boolean;
  semanticSearch: boolean;
  enhancedCaching: boolean;
}

/**
 * Default feature flags (used when KV unavailable or flag not set)
 */
const DEFAULT_FLAGS: FeatureFlags = {
  trendingQueries: false,
  semanticSearch: false,
  enhancedCaching: false,
};

/**
 * Environment bindings for the Worker
 */
interface Env {
  RATE_LIMITER?: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };
  ANALYTICS?: AnalyticsEngine;
  FLAGS?: KVNamespace;
}

/**
 * Circuit breaker state for upstream API
 */
interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
}

/**
 * API Configuration Constants
 */
const SEARCH_LIMIT = 15 as const;
const HOSTNAME = 'https://itunes.apple.com' as const;
const RESERVED_PARAM_TOPPODCASTS = 'toppodcasts' as const;

/**
 * Validation Constants
 */
const MAX_QUERY_LENGTH = 200 as const;
const MIN_LIMIT = 1 as const;
const MAX_LIMIT = 200 as const;

/**
 * Cache TTL Configuration (in seconds)
 */
const CACHE_TTL_SEARCH = 3600 as const; // 1 hour for search results
const CACHE_TTL_TOP = 1800 as const; // 30 minutes for top podcasts
const CACHE_TTL_SCHEMA = 31536000 as const; // 1 year - schema only changes on redeploy
const CACHE_STALE_TOLERANCE = 86400 as const; // 24 hours stale tolerance for SWR

/**
 * Circuit Breaker Configuration
 */
const CIRCUIT_BREAKER_THRESHOLD = 5 as const;
const CIRCUIT_BREAKER_RECOVERY_MS = 30000 as const; // 30 seconds

/**
 * In-memory circuit breaker state (resets on cold start)
 */
const circuitBreaker: CircuitBreakerState = {
  failures: 0,
  lastFailure: 0,
  state: 'closed',
};

/**
 * Suspicious patterns to reject (basic security)
 */
const SUSPICIOUS_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /on\w+=/i, // onclick=, onerror=, etc.
  /<iframe/i,
  /data:/i,
];

const ITUNES_API_GENRES: IGenresDictionary = {
  1301: 'Arts',
  1302: 'Comedy',
  1303: 'Education',
  1304: 'Kids·&·Family',
  1305: 'Health·&·Fitness',
  1306: 'TV·&·Film',
  1307: 'Music',
  1308: 'News',
  1309: 'Religion·&·Spirituality',
  1310: 'Science',
  1311: 'Sports',
  1312: 'Technology',
  1313: 'Business',
  1314: 'Society·&·Culture',
  1315: 'Government',
  1321: 'Fiction',
  1323: 'History',
  1324: 'True·Crime',
  1325: 'Leisure',
  1326: 'Documentary',
};

// Pre-compute genre list for schema documentation
const GENRES_LIST: string = Object.entries(ITUNES_API_GENRES)
  .map(([id, name]) => `${id} (${name.replace(/·/g, ' ')})`)
  .join(', ');

// Pre-compute valid genre IDs for validation
const VALID_GENRE_IDS = new Set(Object.keys(ITUNES_API_GENRES).map(Number));

/**
 * Generates a unique request ID for tracing
 */
function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Structured JSON logging for Workers Logs Query Builder support
 */
function log(level: LogLevel, message: string, context: LogContext = {}): void {
  console.log(JSON.stringify({ level, message, timestamp: Date.now(), ...context }));
}

/**
 * Gets a single feature flag value from KV
 *
 * @param env - Environment bindings
 * @param flag - Flag name
 * @returns Flag value or default
 */
async function getFlag<K extends keyof FeatureFlags>(env: Env, flag: K): Promise<FeatureFlags[K]> {
  if (!env.FLAGS) return DEFAULT_FLAGS[flag];

  try {
    const value = await env.FLAGS.get(`flag:${flag}`);
    if (value === null) return DEFAULT_FLAGS[flag];
    return value === 'true';
  } catch {
    return DEFAULT_FLAGS[flag];
  }
}

/**
 * Validates input query for security and constraints
 *
 * @param query - The search query to validate
 * @returns Error message if invalid, undefined if valid
 */
function validateQuery(query: string): string | undefined {
  if (query.length > MAX_QUERY_LENGTH) {
    return `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`;
  }

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(query)) {
      return 'Query contains invalid characters';
    }
  }

  return undefined;
}

/**
 * Validates the limit parameter
 *
 * @param limit - The limit string to validate
 * @returns Validated limit number or error response
 */
function validateLimit(limit: string | undefined): number | Response {
  if (!limit) return SEARCH_LIMIT;

  const parsed = parseInt(limit, 10);
  if (isNaN(parsed) || parsed < MIN_LIMIT || parsed > MAX_LIMIT) {
    return new Response(`Limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}`, {
      status: 400,
      statusText: 'Bad Request',
    });
  }
  return parsed;
}

/**
 * Validates the genre parameter
 *
 * @param genre - The genre ID to validate
 * @returns Error response if invalid, undefined if valid
 */
function validateGenre(genre: number): Response | undefined {
  if (genre !== -1 && !VALID_GENRE_IDS.has(genre)) {
    return new Response(`Invalid genre ID. Valid genres: ${GENRES_LIST}`, {
      status: 400,
      statusText: 'Bad Request',
    });
  }
  return undefined;
}

/**
 * Checks if the circuit breaker should allow requests
 */
function isCircuitOpen(): boolean {
  if (circuitBreaker.state === 'closed') return false;

  const now = Date.now();
  if (circuitBreaker.state === 'open') {
    if (now - circuitBreaker.lastFailure > CIRCUIT_BREAKER_RECOVERY_MS) {
      circuitBreaker.state = 'half-open';
      return false;
    }
    return true;
  }

  // half-open state: allow the request through
  return false;
}

/**
 * Records a successful request for circuit breaker
 */
function recordSuccess(): void {
  circuitBreaker.failures = 0;
  circuitBreaker.state = 'closed';
}

/**
 * Records a failed request for circuit breaker
 */
function recordFailure(): void {
  circuitBreaker.failures++;
  circuitBreaker.lastFailure = Date.now();

  if (circuitBreaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreaker.state = 'open';
  }
}

/**
 * Fetches data with Cloudflare Cache API support.
 * Uses cache-first strategy to minimize external API calls.
 * Returns cache hit information for observability.
 *
 * @param url - URL to fetch
 * @param cacheTtl - Time to live for cache in seconds
 * @param ctx - Execution context for waitUntil (optional)
 * @returns Response from cache or fetch with cache hit info
 * @throws Error if fetch fails
 */
async function cachedFetch(
  url: string,
  cacheTtl: number,
  ctx?: ExecutionContext
): Promise<CachedFetchResult> {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: 'GET' });

  // Check circuit breaker
  if (isCircuitOpen()) {
    // Try to serve from cache even if stale
    const staleResponse = await cache.match(cacheKey);
    if (staleResponse) {
      log('warn', 'Circuit open, serving stale cache', { url });
      return { response: staleResponse, cacheHit: true };
    }
    throw new Error('Service temporarily unavailable');
  }

  // Try to get from cache first
  const cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    // Check if we should revalidate in background (SWR)
    const age = cachedResponse.headers.get('age');
    const ageSeconds = age ? parseInt(age, 10) : 0;

    if (ageSeconds > cacheTtl && ageSeconds < CACHE_STALE_TOLERANCE && ctx) {
      // Serve stale, revalidate in background
      ctx.waitUntil(revalidateCache(url, cacheTtl, cache, cacheKey));
      log('info', 'Serving stale, revalidating in background', { url, ageSeconds });
    }

    return { response: cachedResponse, cacheHit: true };
  }

  // Not in cache, fetch from origin
  try {
    const response = await fetch(url);

    if (response.ok) {
      recordSuccess();

      // Clone response before caching (responses can only be read once)
      const responseToCache = response.clone();

      // Create a new response with cache headers
      const cachedResponseToStore = new Response(responseToCache.body, {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers: {
          ...Object.fromEntries(responseToCache.headers),
          'Cache-Control': `public, max-age=${cacheTtl}`,
        },
      });

      // Cache the response asynchronously (don't await to avoid blocking)
      void cache.put(cacheKey, cachedResponseToStore);
    } else {
      recordFailure();
    }

    return { response, cacheHit: false };
  } catch (error) {
    recordFailure();
    throw error;
  }
}

/**
 * Revalidates cache entry in background
 */
async function revalidateCache(
  url: string,
  cacheTtl: number,
  cache: Cache,
  cacheKey: Request
): Promise<void> {
  try {
    const response = await fetch(url);
    if (response.ok) {
      recordSuccess();
      const cachedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          ...Object.fromEntries(response.headers),
          'Cache-Control': `public, max-age=${cacheTtl}`,
        },
      });
      await cache.put(cacheKey, cachedResponse);
      log('info', 'Cache revalidated', { url });
    } else {
      recordFailure();
      log('warn', 'Cache revalidation failed', { url, status: response.status });
    }
  } catch (error) {
    recordFailure();
    log('error', 'Cache revalidation error', {
      url,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Security headers for all responses
 */
const SECURITY_HEADERS: HeadersInit = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * Creates standard response headers for API responses
 *
 * @param cacheTtl - Time to live for cache in seconds
 * @param cacheHit - Whether response was served from cache
 * @returns Headers object
 */
function createResponseHeaders(cacheTtl: number, cacheHit = false): HeadersInit {
  return {
    'content-type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Cache-Control': `public, max-age=${cacheTtl}`,
    'X-Cache': cacheHit ? 'HIT' : 'MISS',
    ...SECURITY_HEADERS,
  };
}

/**
 * Invokes API call and returns the response as JSON with caching support.
 *
 * @param apiCall - API request to call
 * @param cacheTtl - Time to live for cache in seconds
 * @param cacheHit - Whether the response was from cache
 * @returns JSON response
 */
async function handleRequest(
  apiCall: ApiCall,
  cacheTtl: number,
  cacheHit = false
): Promise<Response> {
  const data = await apiCall();
  return new Response(JSON.stringify(data), {
    headers: createResponseHeaders(cacheTtl, cacheHit),
  });
}

/**
 * iTunes search API.
 *
 * @param query - The search query term
 * @param limit - The number of results to return (default: 15)
 * @param ctx - Execution context for background tasks
 * @returns Promise containing the search results and cache info
 * @throws Response with 400 status if query is empty
 */
async function searchRequest(
  query: string | undefined,
  limit: number,
  ctx?: ExecutionContext
): Promise<{ data: unknown; cacheHit: boolean }> {
  if (!query) {
    throw new Response('Missing required query parameter: q', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  const route = 'search';
  const mediaType = 'podcast';
  const searchUrl = `${HOSTNAME}/${route}?media=${mediaType}&term=${encodeURIComponent(query)}&limit=${limit}`;
  const { response, cacheHit } = await cachedFetch(searchUrl, CACHE_TTL_SEARCH, ctx);

  // Check if response indicates an error
  if (response.status >= 400) {
    throw new Error(`iTunes API error: ${response.status} ${response.statusText}`);
  }

  return { data: await response.json(), cacheHit };
}

/**
 * iTunes top podcasts API.
 *
 * @param limit - The number of results to return (default: 15)
 * @param genre - The genre ID filter to apply (optional)
 * @param ctx - Execution context for background tasks
 * @returns Promise containing the top podcasts feed and cache info
 */
async function topRequest(
  limit: number,
  genre: number,
  ctx?: ExecutionContext
): Promise<{ data: unknown; cacheHit: boolean }> {
  const genreSegment = ITUNES_API_GENRES[genre] ? `/genre=${genre}` : '';
  const topPodcastsUrl = `${HOSTNAME}/us/rss/${RESERVED_PARAM_TOPPODCASTS}/limit=${limit}${genreSegment}/json`;
  const { response, cacheHit } = await cachedFetch(topPodcastsUrl, CACHE_TTL_TOP, ctx);

  // Check if response indicates an error
  if (response.status >= 400) {
    throw new Error(`iTunes API error: ${response.status} ${response.statusText}`);
  }

  return { data: await response.json(), cacheHit };
}

/**
 * Health check response - basic liveness
 */
function handleHealthCheck(request: Request): Response {
  const info = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    circuitBreaker: circuitBreaker.state,
    placement: {
      colo: request.cf?.colo ?? 'unknown',
      country: request.cf?.country ?? 'unknown',
    },
  };

  return new Response(JSON.stringify(info), {
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Deep health check - tests upstream connectivity
 */
async function handleDeepHealthCheck(request: Request): Promise<Response> {
  const startTime = Date.now();
  let upstreamOk = false;
  let upstreamLatency = 0;

  try {
    const testUrl = `${HOSTNAME}/search?media=podcast&term=test&limit=1`;
    const response = await fetch(testUrl);
    upstreamLatency = Date.now() - startTime;
    upstreamOk = response.ok;
  } catch {
    upstreamLatency = Date.now() - startTime;
  }

  const info = {
    status: upstreamOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    circuitBreaker: circuitBreaker.state,
    placement: {
      colo: request.cf?.colo ?? 'unknown',
      country: request.cf?.country ?? 'unknown',
    },
    upstream: {
      itunes: {
        status: upstreamOk ? 'healthy' : 'unhealthy',
        latencyMs: upstreamLatency,
      },
    },
  };

  return new Response(JSON.stringify(info), {
    status: upstreamOk ? 200 : 503,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Returns OpenAPI 3.0 schema documentation for the API.
 * Cached indefinitely (1 year) as schema only changes on code deployment.
 *
 * @returns OpenAPI schema as JSON
 */
function getApiSchema(): OpenAPIV3.Document {
  return {
    openapi: '3.0.0',
    info: {
      title: 'Podr API',
      version: '1.0.0',
      description: 'RESTful API for podcast search and discovery powered by iTunes API',
      contact: {
        name: 'Podr',
        url: 'https://www.podrapp.com/',
      },
      license: {
        name: 'MIT',
        url: 'https://github.com/cascadiacollections/podr-service/blob/main/LICENSE',
      },
    },
    servers: [
      {
        url: 'https://podr-service.cascadiacollections.workers.dev',
        description: 'Production server',
      },
    ],
    paths: {
      '/': {
        get: {
          summary: 'Podcast API Endpoint',
          description:
            'Multi-purpose endpoint that serves API schema (no query params), searches podcasts (with q parameter), or returns top podcasts (with q=toppodcasts)',
          operationId: 'podcastApi',
          parameters: [
            {
              name: 'q',
              in: 'query',
              description:
                'Query parameter that determines the operation. Omit to get API schema. Set to search term to search podcasts. Set to "toppodcasts" to get top podcasts.',
              required: false,
              schema: {
                type: 'string',
                maxLength: MAX_QUERY_LENGTH,
                example: 'javascript',
              },
            },
            {
              name: 'limit',
              in: 'query',
              description: 'Number of results to return (applies to search and top podcasts)',
              required: false,
              schema: {
                type: 'integer',
                default: SEARCH_LIMIT,
                minimum: MIN_LIMIT,
                maximum: MAX_LIMIT,
                example: 15,
              },
            },
            {
              name: 'genre',
              in: 'query',
              description: `Genre ID to filter by (applies only to top podcasts). Available genres: ${GENRES_LIST}`,
              required: false,
              schema: {
                type: 'integer',
                enum: Object.keys(ITUNES_API_GENRES).map(Number),
                example: 1312,
              },
            },
          ],
          responses: {
            '200': {
              description: 'Successful response - format depends on query parameters',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      {
                        type: 'object',
                        description: 'OpenAPI schema (when no q parameter)',
                        properties: {
                          openapi: { type: 'string' },
                          info: { type: 'object' },
                          paths: { type: 'object' },
                        },
                      },
                      {
                        type: 'object',
                        description: 'Search results (when q is a search term)',
                        properties: {
                          resultCount: { type: 'integer' },
                          results: { type: 'array', items: { type: 'object' } },
                        },
                      },
                      {
                        type: 'object',
                        description: 'Top podcasts feed (when q=toppodcasts)',
                        properties: {
                          feed: {
                            type: 'object',
                            properties: {
                              entry: { type: 'array', items: { type: 'object' } },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
              headers: {
                'Cache-Control': {
                  description:
                    'Cache duration: indefinitely (immutable) for schema, 1 hour for search, 30 minutes for top podcasts',
                  schema: {
                    type: 'string',
                    examples: [
                      'public, max-age=31536000, immutable',
                      'public, max-age=3600',
                      'public, max-age=1800',
                    ],
                  },
                },
                'X-Cache': {
                  description: 'Cache hit indicator',
                  schema: {
                    type: 'string',
                    enum: ['HIT', 'MISS'],
                  },
                },
              },
            },
            '400': {
              description: 'Bad request - missing or invalid query parameter',
            },
            '405': {
              description: 'Method not allowed - only GET is supported',
            },
            '429': {
              description: 'Rate limit exceeded',
            },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Health Check',
          description: 'Basic liveness check returning service status and placement info',
          operationId: 'healthCheck',
          responses: {
            '200': {
              description: 'Service is healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['healthy'] },
                      timestamp: { type: 'string', format: 'date-time' },
                      version: { type: 'string' },
                      circuitBreaker: { type: 'string', enum: ['closed', 'open', 'half-open'] },
                      placement: {
                        type: 'object',
                        properties: {
                          colo: { type: 'string' },
                          country: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/health/deep': {
        get: {
          summary: 'Deep Health Check',
          description: 'Tests upstream iTunes API connectivity',
          operationId: 'deepHealthCheck',
          responses: {
            '200': {
              description: 'All systems healthy',
            },
            '503': {
              description: 'Upstream service degraded',
            },
          },
        },
      },
      '/trending': {
        get: {
          summary: 'Trending Queries',
          description:
            'Returns trending podcast search queries. Feature-flagged endpoint - returns 404 when disabled.',
          operationId: 'trendingQueries',
          responses: {
            '200': {
              description: 'Trending queries list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      trending: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            query: { type: 'string' },
                            count: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '404': {
              description: 'Feature not enabled',
            },
          },
        },
      },
    },
  };
}

/**
 * Creates an error response with appropriate headers
 *
 * @param message - Error message
 * @param status - HTTP status code
 * @param statusText - HTTP status text
 * @returns Response object
 */
function createErrorResponse(message: string, status: number, statusText: string): Response {
  return new Response(message, {
    status,
    statusText,
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Tracks request metrics via Analytics Engine
 *
 * Blobs (dimensions): endpoint, cacheStatus, statusCode, colo
 * Doubles (metrics): duration, resultCount
 * Indexes: date-based for sampling
 */
function trackMetrics(
  env: Env,
  endpoint: string,
  cacheHit: boolean,
  status: number,
  duration: number,
  colo: string,
  resultCount = 0
): void {
  if (!env.ANALYTICS) return;

  env.ANALYTICS.writeDataPoint({
    blobs: [endpoint, cacheHit ? 'HIT' : 'MISS', String(status), colo],
    doubles: [duration, resultCount],
    indexes: [new Date().toISOString().slice(0, 10)], // YYYY-MM-DD for daily sampling
  });
}

/**
 * Gets client IP from request for rate limiting
 */
function getClientIP(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'unknown'
  );
}

/**
 * Modern Module Worker export with fetch handler.
 * Handles podcast search and discovery requests.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    const requestId = generateRequestId();
    const { searchParams, pathname } = new URL(request.url);
    const colo = (request.cf?.colo as string) ?? 'unknown';

    try {
      // Only allow GET requests
      if (request.method !== 'GET') {
        log('warn', 'Method not allowed', { requestId, method: request.method });
        return createErrorResponse('Unsupported', 405, 'Method Not Allowed');
      }

      // Health check endpoints
      if (pathname === '/health') {
        return handleHealthCheck(request);
      }
      if (pathname === '/health/deep') {
        return await handleDeepHealthCheck(request);
      }

      // Trending queries endpoint (feature flagged)
      if (pathname === '/trending') {
        const trendingEnabled = await getFlag(env, 'trendingQueries');
        if (!trendingEnabled) {
          return createErrorResponse('Not Found', 404, 'Not Found');
        }
        // TODO: Implement D1 trending queries
        const duration = Date.now() - startTime;
        trackMetrics(env, 'trending', false, 200, duration, colo);
        return new Response(
          JSON.stringify({
            trending: [],
            message: 'Trending queries coming soon - D1 integration pending',
          }),
          {
            headers: {
              'content-type': 'application/json;charset=UTF-8',
              'Cache-Control': 'public, max-age=300',
              ...SECURITY_HEADERS,
            },
          }
        );
      }

      // Rate limiting (if binding available)
      if (env.RATE_LIMITER) {
        const clientIP = getClientIP(request);
        const { success } = await env.RATE_LIMITER.limit({ key: clientIP });
        if (!success) {
          log('warn', 'Rate limit exceeded', { requestId, clientIP });
          return createErrorResponse('Rate limit exceeded', 429, 'Too Many Requests');
        }
      }

      // Serve API schema at root path when no query params
      if (pathname === '/' && !searchParams.has('q')) {
        const duration = Date.now() - startTime;
        log('info', 'Schema request', { requestId, path: pathname, duration });
        trackMetrics(env, 'schema', true, 200, duration, colo);
        return new Response(JSON.stringify(getApiSchema(), null, 2), {
          headers: {
            'content-type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET',
            'Cache-Control': `public, max-age=${CACHE_TTL_SCHEMA}, immutable`,
            ...SECURITY_HEADERS,
          },
        });
      }

      const query = searchParams.get('q') ?? undefined;
      const limitParam = searchParams.get('limit') ?? undefined;
      const genre = parseInt(searchParams.get('genre') ?? '-1', 10);

      // Validate query
      if (query) {
        const queryError = validateQuery(query);
        if (queryError) {
          log('warn', 'Query validation failed', { requestId, query, error: queryError });
          return createErrorResponse(queryError, 400, 'Bad Request');
        }
      }

      // Validate limit
      const limitResult = validateLimit(limitParam);
      if (limitResult instanceof Response) {
        log('warn', 'Limit validation failed', { requestId, limit: limitParam });
        return limitResult;
      }
      const limit = limitResult;

      // Validate genre
      const genreError = validateGenre(genre);
      if (genreError) {
        log('warn', 'Genre validation failed', { requestId, genre });
        return genreError;
      }

      // Handle top podcasts request
      if (query === RESERVED_PARAM_TOPPODCASTS) {
        const { data, cacheHit } = await topRequest(limit, genre, ctx);
        const duration = Date.now() - startTime;
        const feed = data as { feed?: { entry?: unknown[] } };
        const resultCount = feed?.feed?.entry?.length ?? 0;
        log('info', 'Top podcasts request', {
          requestId,
          path: pathname,
          query,
          limit,
          genre,
          duration,
          cacheHit,
          status: 200,
        });
        trackMetrics(env, 'toppodcasts', cacheHit, 200, duration, colo, resultCount);
        return handleRequest(() => Promise.resolve(data), CACHE_TTL_TOP, cacheHit);
      }

      // Handle search request
      const { data, cacheHit } = await searchRequest(query, limit, ctx);
      const duration = Date.now() - startTime;
      const results = data as { resultCount?: number };
      const resultCount = results?.resultCount ?? 0;
      log('info', 'Search request', {
        requestId,
        path: pathname,
        query,
        limit,
        duration,
        cacheHit,
        status: 200,
      });
      trackMetrics(env, 'search', cacheHit, 200, duration, colo, resultCount);
      return handleRequest(() => Promise.resolve(data), CACHE_TTL_SEARCH, cacheHit);
    } catch (error) {
      const duration = Date.now() - startTime;

      // Handle thrown Response objects (e.g., from searchRequest validation)
      if (error instanceof Response) {
        log('warn', 'Request validation error', {
          requestId,
          path: pathname,
          status: error.status,
          duration,
        });
        trackMetrics(env, 'error', false, error.status, duration, colo);
        return error;
      }

      // Handle other errors
      const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
      log('error', 'Request error', {
        requestId,
        path: pathname,
        error: errorMessage,
        duration,
        status: 500,
      });
      trackMetrics(env, 'error', false, 500, duration, colo);
      return createErrorResponse(errorMessage, 500, 'Internal Server Error');
    }
  },
};
