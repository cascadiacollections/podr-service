import type { OpenAPIV3 } from 'openapi-types';
import { Container } from '@cloudflare/containers';

/**
 * Durable Object namespace binding for containers
 */
interface DurableObjectNamespace {
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId) => DurableObjectStub;
}

interface DurableObjectId {
  toString: () => string;
}

interface DurableObjectStub {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

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
 * D1 database result types
 */
interface D1Result<T> {
  results: T[];
  success: boolean;
  meta?: {
    duration?: number;
    rows_read?: number;
    rows_written?: number;
  };
}

/**
 * D1 prepared statement
 */
interface D1PreparedStatement {
  bind: (...values: unknown[]) => D1PreparedStatement;
  first: <T = unknown>() => Promise<T | null>;
  run: () => Promise<D1Result<unknown>>;
  all: <T = unknown>() => Promise<D1Result<T>>;
}

/**
 * D1 database binding
 */
interface D1Database {
  prepare: (query: string) => D1PreparedStatement;
  exec: (query: string) => Promise<D1Result<unknown>>;
}

/**
 * R2 bucket binding for analytics data lake
 */
interface R2Bucket {
  put: (
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ) => Promise<R2Object | null>;
  get: (key: string) => Promise<R2ObjectBody | null>;
  list: (options?: { prefix?: string; limit?: number; cursor?: string }) => Promise<R2Objects>;
  head: (key: string) => Promise<R2Object | null>;
}

interface R2Object {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  text: () => Promise<string>;
  json: <T>() => Promise<T>;
}

interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

/**
 * Analytics event for R2 export (data lake)
 */
interface AnalyticsEvent {
  timestamp: string;
  date: string;
  hour: number;
  requestId: string;
  endpoint: string;
  query?: string;
  queryHash?: string;
  limit?: number;
  genre?: number;
  resultCount: number;
  cacheHit: boolean;
  status: number;
  durationMs: number;
  colo: string;
  country?: string;
}

/**
 * Feature flag configuration
 */
interface FeatureFlags {
  trendingQueries: boolean;
  semanticSearch: boolean;
  enhancedCaching: boolean;
  analyticsExport: boolean;
  podcastIndex: boolean;
}

/**
 * Default feature flags (used when KV unavailable or flag not set)
 */
const DEFAULT_FLAGS: FeatureFlags = {
  trendingQueries: false,
  semanticSearch: false,
  enhancedCaching: false,
  analyticsExport: false,
  podcastIndex: false,
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
  DB?: D1Database;
  ANALYTICS_LAKE?: R2Bucket;
  ITUNES_PROXY?: DurableObjectNamespace;
  PODCAST_INDEX_KEY?: string;
  PODCAST_INDEX_SECRET?: string;
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
const PODCAST_INDEX_HOSTNAME = 'https://api.podcastindex.org' as const;
const RESERVED_PARAM_TOPPODCASTS = 'toppodcasts' as const;

/**
 * Podcast Index API types
 */
interface PodcastIndexFeed {
  id: number;
  title: string;
  url: string;
  originalUrl: string;
  link: string;
  description: string;
  author: string;
  ownerName: string;
  image: string;
  artwork: string;
  lastUpdateTime: number;
  language: string;
  categories: Record<string, string>;
}

interface PodcastIndexSearchResponse {
  status: string;
  feeds: PodcastIndexFeed[];
  count: number;
  query: string;
  description: string;
}

interface ITunesSearchResult {
  collectionId: number;
  collectionName: string;
  feedUrl: string;
  artworkUrl600: string;
  artistName: string;
  collectionViewUrl: string;
  trackCount: number;
  genres: string[];
  releaseDate: string;
}

interface ITunesSearchResponse {
  resultCount: number;
  results: ITunesSearchResult[];
}

/**
 * Validation Constants
 */
const MAX_QUERY_LENGTH = 200 as const;
const MIN_LIMIT = 1 as const;
const MAX_LIMIT = 200 as const;

/**
 * Cache TTL Configuration (in seconds)
 */
const CACHE_TTL_SEARCH = 86400 as const; // 24 hours for search results
const CACHE_TTL_TOP = 7200 as const; // 2 hours for top podcasts (RSS updates slowly)
const CACHE_TTL_PODCAST_DETAIL = 14400 as const; // 4 hours for podcast details (metadata rarely changes)
const CACHE_TTL_SCHEMA = 31536000 as const; // 1 year - schema only changes on redeploy
const CACHE_STALE_TOLERANCE = 86400 as const; // 24 hours stale tolerance for SWR

/**
 * Episode limit for podcast detail response
 */
const PODCAST_EPISODE_LIMIT = 20 as const;

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
 * Normalizes a search query for trending aggregation
 * - Lowercase
 * - Trim whitespace
 * - Collapse multiple spaces
 */
function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Creates a SHA-256 hash of the query for privacy-preserving storage
 */
async function hashQuery(query: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(query);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generates Podcast Index API authentication headers
 */
async function generatePodcastIndexAuth(
  apiKey: string,
  apiSecret: string
): Promise<{ 'X-Auth-Key': string; 'X-Auth-Date': string; Authorization: string }> {
  const unixTime = Math.floor(Date.now() / 1000);
  const authString = `${apiKey}${apiSecret}${unixTime}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(authString);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const authHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    'X-Auth-Key': apiKey,
    'X-Auth-Date': String(unixTime),
    Authorization: authHash,
  };
}

/**
 * Transforms a Podcast Index feed to iTunes-compatible format
 */
function transformPodcastIndexFeed(feed: PodcastIndexFeed): ITunesSearchResult {
  const genres = feed.categories ? Object.values(feed.categories) : [];
  const releaseDate =
    feed.lastUpdateTime && !isNaN(feed.lastUpdateTime)
      ? new Date(feed.lastUpdateTime * 1000).toISOString()
      : new Date().toISOString();
  return {
    collectionId: feed.id,
    collectionName: feed.title,
    feedUrl: feed.url || feed.originalUrl,
    artworkUrl600: feed.artwork || feed.image,
    artistName: feed.author || feed.ownerName,
    collectionViewUrl: feed.link,
    trackCount: 0,
    genres,
    releaseDate,
  };
}

/**
 * Searches podcasts using the Podcast Index API
 */
async function podcastIndexSearch(
  query: string,
  limit: number,
  env: Env,
  _ctx?: ExecutionContext
): Promise<{ data: ITunesSearchResponse; cacheHit: boolean }> {
  if (!env.PODCAST_INDEX_KEY || !env.PODCAST_INDEX_SECRET) {
    throw new Error('Podcast Index API credentials not configured');
  }

  const searchUrl = `${PODCAST_INDEX_HOSTNAME}/api/1.0/search/byterm?q=${encodeURIComponent(query)}&max=${limit}`;
  const cache = caches.default;
  const cacheKey = new Request(searchUrl, { method: 'GET' });

  if (isCircuitOpen()) {
    const staleResponse = await cache.match(cacheKey);
    if (staleResponse) {
      log('warn', 'Circuit open, serving stale cache', { url: searchUrl });
      const data = (await staleResponse.json()) as ITunesSearchResponse;
      return { data, cacheHit: true };
    }
    throw new Error('Service temporarily unavailable');
  }

  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    const data = (await cachedResponse.json()) as ITunesSearchResponse;
    return { data, cacheHit: true };
  }

  try {
    const authHeaders = await generatePodcastIndexAuth(
      env.PODCAST_INDEX_KEY,
      env.PODCAST_INDEX_SECRET
    );

    const response = await fetch(searchUrl, {
      headers: { ...authHeaders, 'User-Agent': 'Podr/1.0' },
    });

    if (!response.ok) {
      recordFailure();
      throw new Error(`Podcast Index API error: ${response.status} ${response.statusText}`);
    }

    recordSuccess();
    const podcastIndexData = (await response.json()) as PodcastIndexSearchResponse;

    const itunesData: ITunesSearchResponse = {
      resultCount: podcastIndexData.count,
      results: podcastIndexData.feeds.map(transformPodcastIndexFeed),
    };

    const cachedResponseToStore = new Response(JSON.stringify(itunesData), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL_SEARCH}`,
      },
    });
    void cache.put(cacheKey, cachedResponseToStore);

    return { data: itunesData, cacheHit: false };
  } catch (error) {
    recordFailure();
    throw error;
  }
}

/**
 * Tracks a search query in D1 for trending analysis
 * Uses upsert pattern: increment count if exists, insert if new
 *
 * @param env - Environment bindings
 * @param query - The search query to track
 * @param country - ISO 3166-1 alpha-2 country code (e.g., 'US', 'GB')
 */
async function trackSearchQuery(env: Env, query: string, country?: string): Promise<void> {
  if (!env.DB) return;

  try {
    const normalized = normalizeQuery(query);
    // Skip very short or very long queries
    if (normalized.length < 2 || normalized.length > 100) return;

    const queryHash = await hashQuery(normalized);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    // Normalize country to uppercase, null if not provided
    const normalizedCountry = country?.toUpperCase() ?? null;

    // Upsert: try to update first, insert if no rows affected
    // Using 'IS' instead of '=' to properly handle NULL comparison in SQLite
    const updateResult = await env.DB.prepare(
      `UPDATE search_queries
       SET search_count = search_count + 1, updated_at = datetime('now')
       WHERE query_hash = ? AND date = ? AND country IS ?`
    )
      .bind(queryHash, today, normalizedCountry)
      .run();

    // If no rows were updated, insert new row
    if (updateResult.meta?.rows_written === 0) {
      await env.DB.prepare(
        `INSERT INTO search_queries (query_hash, query_normalized, date, country)
         VALUES (?, ?, ?, ?)`
      )
        .bind(queryHash, normalized, today, normalizedCountry)
        .run();
    }
  } catch (error) {
    // Don't fail the request if tracking fails
    log('error', 'Failed to track search query', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Trending query result from D1
 */
interface TrendingQuery {
  query_normalized: string;
  total_count: number;
}

/**
 * Gets autocomplete suggestions from D1 based on query prefix
 * Returns matching queries from the last 30 days
 *
 * @param env - Environment bindings
 * @param prefix - The search prefix to match
 * @param limit - Number of suggestions to return (default: 5)
 * @returns Array of matching query strings
 */
async function getSuggestions(env: Env, prefix: string, limit = 5): Promise<string[]> {
  if (!env.DB || prefix.length < 2) return [];

  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

    const result = await env.DB.prepare(
      `SELECT query_normalized, SUM(search_count) as total_count
       FROM search_queries
       WHERE query_normalized LIKE ? || '%'
       AND date >= ?
       GROUP BY query_normalized
       ORDER BY total_count DESC
       LIMIT ?`
    )
      .bind(prefix.toLowerCase(), thirtyDaysAgoStr, limit)
      .all<TrendingQuery>();

    return result.results.map((r) => r.query_normalized);
  } catch (error) {
    log('error', 'Failed to get suggestions', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return [];
  }
}

/**
 * Gets trending search queries from D1
 * Returns top queries from the last 7 days
 * If country is specified, returns country-specific trending queries with fallback to global
 *
 * @param env - Environment bindings
 * @param limit - Number of trending queries to return (default: 10)
 * @param country - ISO 3166-1 alpha-2 country code to filter by (optional)
 * @returns Array of trending queries with counts
 */
async function getTrendingQueries(
  env: Env,
  limit = 10,
  country?: string
): Promise<TrendingQuery[]> {
  if (!env.DB) return [];

  try {
    // Get date 7 days ago
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().slice(0, 10);

    // Normalize country to uppercase
    const normalizedCountry = country?.toUpperCase();

    let result: D1Result<TrendingQuery>;

    if (normalizedCountry) {
      // Try country-specific trending first
      result = await env.DB.prepare(
        `SELECT query_normalized, SUM(search_count) as total_count
         FROM search_queries
         WHERE date >= ? AND country = ?
         GROUP BY query_hash
         ORDER BY total_count DESC
         LIMIT ?`
      )
        .bind(weekAgoStr, normalizedCountry, limit)
        .all<TrendingQuery>();

      // Fallback to global trending if no country-specific data
      if (result.results.length === 0) {
        result = await env.DB.prepare(
          `SELECT query_normalized, SUM(search_count) as total_count
           FROM search_queries
           WHERE date >= ?
           GROUP BY query_hash
           ORDER BY total_count DESC
           LIMIT ?`
        )
          .bind(weekAgoStr, limit)
          .all<TrendingQuery>();
      }
    } else {
      // Global trending (no country filter)
      result = await env.DB.prepare(
        `SELECT query_normalized, SUM(search_count) as total_count
         FROM search_queries
         WHERE date >= ?
         GROUP BY query_hash
         ORDER BY total_count DESC
         LIMIT ?`
      )
        .bind(weekAgoStr, limit)
        .all<TrendingQuery>();
    }

    return result.results;
  } catch (error) {
    log('error', 'Failed to get trending queries', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return [];
  }
}

/**
 * Exports an analytics event to R2 for data lake / batch processing
 * Events are stored as NDJSON files partitioned by date and hour
 *
 * Path format: events/YYYY/MM/DD/HH/{requestId}.json
 *
 * @param env - Environment bindings
 * @param event - Analytics event to export
 */
async function exportAnalyticsEvent(env: Env, event: AnalyticsEvent): Promise<void> {
  if (!env.ANALYTICS_LAKE) return;

  try {
    const date = new Date(event.timestamp);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');

    // Path: events/2026/01/24/12/{requestId}.json
    const key = `events/${year}/${month}/${day}/${hour}/${event.requestId}.json`;

    await env.ANALYTICS_LAKE.put(key, JSON.stringify(event), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        endpoint: event.endpoint,
        colo: event.colo,
        date: event.date,
      },
    });
  } catch (error) {
    // Don't fail the request if export fails
    log('error', 'Failed to export analytics event', {
      error: error instanceof Error ? error.message : 'Unknown error',
      requestId: event.requestId,
    });
  }
}

/**
 * Creates an analytics event from request context
 */
function createAnalyticsEvent(
  requestId: string,
  endpoint: string,
  cacheHit: boolean,
  status: number,
  durationMs: number,
  colo: string,
  options: {
    query?: string;
    queryHash?: string;
    limit?: number;
    genre?: number;
    resultCount?: number;
    country?: string;
  } = {}
): AnalyticsEvent {
  const now = new Date();
  return {
    timestamp: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    hour: now.getUTCHours(),
    requestId,
    endpoint,
    query: options.query,
    queryHash: options.queryHash,
    limit: options.limit,
    genre: options.genre,
    resultCount: options.resultCount ?? 0,
    cacheHit,
    status,
    durationMs,
    colo,
    country: options.country,
  };
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
 * Cached fetch that routes through the container proxy to avoid Apple IP blocking.
 * Falls back to direct fetch if proxy is unavailable.
 *
 * @param url - iTunes API URL to fetch
 * @param cacheTtl - Time to live for cache in seconds
 * @param env - Worker environment bindings
 * @param ctx - Execution context for waitUntil (optional)
 * @returns Response from cache or fetch with cache hit info
 */
async function cachedFetchViaProxy(
  url: string,
  cacheTtl: number,
  env: Env,
  ctx?: ExecutionContext
): Promise<CachedFetchResult> {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: 'GET' });

  // Check circuit breaker
  if (isCircuitOpen()) {
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
    const age = cachedResponse.headers.get('age');
    const ageSeconds = age ? parseInt(age, 10) : 0;

    if (ageSeconds > cacheTtl && ageSeconds < CACHE_STALE_TOLERANCE && ctx) {
      ctx.waitUntil(revalidateCacheViaProxy(url, cacheTtl, cache, cacheKey, env));
      log('info', 'Serving stale, revalidating in background', { url, ageSeconds });
    }

    return { response: cachedResponse, cacheHit: true };
  }

  // Not in cache, fetch via proxy
  try {
    let response: Response;

    if (env.ITUNES_PROXY) {
      const containerId = env.ITUNES_PROXY.idFromName('itunes-proxy');
      const container = env.ITUNES_PROXY.get(containerId);
      const proxyUrl = `http://container/?url=${encodeURIComponent(url)}`;
      response = await container.fetch(proxyUrl);
    } else {
      log('warn', 'ITUNES_PROXY not available, using direct fetch', { url });
      response = await fetch(url);
    }

    if (response.ok) {
      recordSuccess();

      const responseToCache = response.clone();
      const cachedResponseToStore = new Response(responseToCache.body, {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers: {
          ...Object.fromEntries(responseToCache.headers),
          'Cache-Control': `public, max-age=${cacheTtl}`,
        },
      });

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
 * Revalidates cache entry in background using container proxy
 */
async function revalidateCacheViaProxy(
  url: string,
  cacheTtl: number,
  cache: Cache,
  cacheKey: Request,
  env: Env
): Promise<void> {
  try {
    let response: Response;

    if (env.ITUNES_PROXY) {
      const containerId = env.ITUNES_PROXY.idFromName('itunes-proxy');
      const container = env.ITUNES_PROXY.get(containerId);
      const proxyUrl = `http://container/?url=${encodeURIComponent(url)}`;
      response = await container.fetch(proxyUrl);
    } else {
      response = await fetch(url);
    }

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
      log('info', 'Cache revalidated via proxy', { url });
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
 * Search podcasts using Podcast Index (when feature flagged) or iTunes API.
 *
 * @param query - The search query term
 * @param limit - The number of results to return (default: 15)
 * @param env - Environment bindings
 * @param ctx - Execution context for background tasks
 * @returns Promise containing the search results and cache info
 * @throws Response with 400 status if query is empty
 */
async function searchRequest(
  query: string | undefined,
  limit: number,
  env: Env,
  ctx?: ExecutionContext
): Promise<{ data: unknown; cacheHit: boolean }> {
  if (!query) {
    throw new Response('Missing required query parameter: q', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  // Check feature flag for Podcast Index
  const usePodcastIndex = await getFlag(env, 'podcastIndex');

  if (usePodcastIndex && env.PODCAST_INDEX_KEY && env.PODCAST_INDEX_SECRET) {
    return podcastIndexSearch(query, limit, env, ctx);
  }

  // Fallback to iTunes API (via container proxy to avoid 403)
  const route = 'search';
  const mediaType = 'podcast';
  const searchUrl = `${HOSTNAME}/${route}?media=${mediaType}&term=${encodeURIComponent(query)}&limit=${limit}`;

  // Check cache first
  const cache = caches.default;
  const cacheKey = new Request(searchUrl, { method: 'GET' });

  if (isCircuitOpen()) {
    const staleResponse = await cache.match(cacheKey);
    if (staleResponse) {
      log('warn', 'Circuit open, serving stale cache', { url: searchUrl });
      const data = await staleResponse.json();
      return { data, cacheHit: true };
    }
    throw new Error('Service temporarily unavailable');
  }

  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    const data = await cachedResponse.json();
    return { data, cacheHit: true };
  }

  // Fetch via container proxy (or direct fetch as fallback)
  let response: Response;

  if (env.ITUNES_PROXY) {
    const containerId = env.ITUNES_PROXY.idFromName('itunes-proxy');
    const container = env.ITUNES_PROXY.get(containerId);
    const proxyUrl = `http://container/?url=${encodeURIComponent(searchUrl)}`;
    response = await container.fetch(proxyUrl);
  } else {
    log('warn', 'ITUNES_PROXY not available, using direct fetch', { url: searchUrl });
    response = await fetch(searchUrl);
  }

  if (!response.ok) {
    recordFailure();
    throw new Error(`iTunes API error: ${response.status} ${response.statusText}`);
  }

  recordSuccess();
  const data = await response.json();

  // Cache the response
  const responseToCache = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SEARCH}`,
    },
  });
  void cache.put(cacheKey, responseToCache);

  return { data, cacheHit: false };
}

/**
 * iTunes top podcasts API.
 * Uses Cloudflare Workers Container to proxy requests, avoiding 403 from Apple.
 *
 * @param limit - The number of results to return (default: 15)
 * @param genre - The genre ID filter to apply (optional)
 * @param env - Environment bindings containing container reference
 * @param ctx - Execution context for background tasks
 * @returns Promise containing the top podcasts feed and cache info
 */
async function topRequest(
  limit: number,
  genre: number,
  env: Env,
  ctx?: ExecutionContext
): Promise<{ data: unknown; cacheHit: boolean }> {
  const genreSegment = ITUNES_API_GENRES[genre] ? `/genre=${genre}` : '';
  const topPodcastsUrl = `${HOSTNAME}/us/rss/${RESERVED_PARAM_TOPPODCASTS}/limit=${limit}${genreSegment}/json`;

  // Check cache first
  const cache = caches.default;
  const cacheKey = new Request(topPodcastsUrl, { method: 'GET' });

  // Check circuit breaker
  if (isCircuitOpen()) {
    const staleResponse = await cache.match(cacheKey);
    if (staleResponse) {
      log('warn', 'Circuit open, serving stale cache', { url: topPodcastsUrl });
      const data = await staleResponse.json();
      return { data, cacheHit: true };
    }
    throw new Error('Service temporarily unavailable');
  }

  // Try cache
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    const age = cachedResponse.headers.get('age');
    const ageSeconds = age ? parseInt(age, 10) : 0;

    if (ageSeconds > CACHE_TTL_TOP && ageSeconds < CACHE_STALE_TOLERANCE && ctx) {
      ctx.waitUntil(revalidateTopPodcastsCache(topPodcastsUrl, env, cache, cacheKey));
      log('info', 'Serving stale, revalidating in background', { url: topPodcastsUrl, ageSeconds });
    }

    const data = await cachedResponse.json();
    return { data, cacheHit: true };
  }

  // Fetch via container proxy (or direct fetch as fallback)
  let response: Response;

  if (env.ITUNES_PROXY) {
    // Use container to fetch from iTunes (avoids 403)
    const containerId = env.ITUNES_PROXY.idFromName('itunes-proxy');
    const container = env.ITUNES_PROXY.get(containerId);
    // Container fetch requires absolute URL - hostname is ignored, only path matters
    const proxyUrl = `http://container/?url=${encodeURIComponent(topPodcastsUrl)}`;
    response = await container.fetch(proxyUrl);
  } else {
    // Fallback to direct fetch (may get 403)
    log('warn', 'ITUNES_PROXY not available, using direct fetch', { url: topPodcastsUrl });
    response = await fetch(topPodcastsUrl);
  }

  if (!response.ok) {
    recordFailure();
    throw new Error(`iTunes API error: ${response.status} ${response.statusText}`);
  }

  recordSuccess();

  const data = await response.json();

  // Cache the response
  const responseToCache = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_TOP}`,
    },
  });
  void cache.put(cacheKey, responseToCache);

  return { data, cacheHit: false };
}

/**
 * Revalidates top podcasts cache entry in background via container proxy
 */
async function revalidateTopPodcastsCache(
  url: string,
  env: Env,
  cache: Cache,
  cacheKey: Request
): Promise<void> {
  try {
    let response: Response;

    if (env.ITUNES_PROXY) {
      const containerId = env.ITUNES_PROXY.idFromName('itunes-proxy');
      const container = env.ITUNES_PROXY.get(containerId);
      // Container fetch requires absolute URL - hostname is ignored, only path matters
      const proxyUrl = `http://container/?url=${encodeURIComponent(url)}`;
      response = await container.fetch(proxyUrl);
    } else {
      response = await fetch(url);
    }

    if (response.ok) {
      recordSuccess();
      const data = await response.json();
      const cachedResponse = new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL_TOP}`,
        },
      });
      await cache.put(cacheKey, cachedResponse);
      log('info', 'Top podcasts cache revalidated', { url });
    } else {
      recordFailure();
      log('warn', 'Top podcasts cache revalidation failed', { url, status: response.status });
    }
  } catch (error) {
    recordFailure();
    log('error', 'Top podcasts cache revalidation error', {
      url,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * iTunes podcast lookup API result
 */
interface ITunesLookupResult {
  resultCount: number;
  results: Array<{
    wrapperType?: string;
    kind?: string;
    trackId?: number;
    trackName?: string;
    artworkUrl600?: string;
    feedUrl?: string;
    genres?: string[];
    trackTimeMillis?: number;
    releaseDate?: string;
    description?: string;
    [key: string]: unknown;
  }>;
}

/**
 * Podcast detail response
 */
interface PodcastDetailResponse {
  podcast: {
    trackId: number;
    trackName: string;
    artworkUrl600?: string;
    feedUrl?: string;
    genres?: string[];
  } | null;
  episodes: Array<{
    trackId?: number;
    trackName?: string;
    releaseDate?: string;
    trackTimeMillis?: number;
    description?: string;
  }>;
}

/**
 * iTunes podcast detail API.
 * Fetches podcast metadata and recent episodes using the lookup API.
 *
 * @param podcastId - The iTunes podcast ID
 * @param ctx - Execution context for background tasks
 * @returns Promise containing the podcast details and episodes with cache info
 * @throws Response with 404 status if podcast not found
 */
async function podcastDetailRequest(
  podcastId: number,
  env: Env,
  ctx?: ExecutionContext
): Promise<{ data: PodcastDetailResponse; cacheHit: boolean }> {
  // Fetch podcast with episodes using lookup API via container proxy
  const lookupUrl = `${HOSTNAME}/lookup?id=${podcastId}&entity=podcastEpisode&limit=${PODCAST_EPISODE_LIMIT}`;
  const { response, cacheHit } = await cachedFetchViaProxy(
    lookupUrl,
    CACHE_TTL_PODCAST_DETAIL,
    env,
    ctx
  );

  // Check if response indicates an error
  if (response.status >= 400) {
    throw new Error(`iTunes API error: ${response.status} ${response.statusText}`);
  }

  const lookupResult = (await response.json()) as ITunesLookupResult;

  // Check if podcast exists (first result should be the podcast itself)
  if (lookupResult.resultCount === 0 || lookupResult.results.length === 0) {
    throw new Response('Podcast not found', {
      status: 404,
      statusText: 'Not Found',
    });
  }

  // First result is the podcast, rest are episodes
  const podcastData = lookupResult.results.find(
    (r) => r.wrapperType === 'track' && r.kind === 'podcast'
  );

  if (!podcastData) {
    throw new Response('Podcast not found', {
      status: 404,
      statusText: 'Not Found',
    });
  }

  // Validate required fields exist
  if (!podcastData.trackId || !podcastData.trackName) {
    throw new Response('Invalid podcast data', {
      status: 404,
      statusText: 'Not Found',
    });
  }

  const episodes = lookupResult.results
    .filter((r) => r.wrapperType === 'track' && r.kind === 'podcast-episode')
    .map((ep) => ({
      trackId: ep.trackId,
      trackName: ep.trackName,
      releaseDate: ep.releaseDate,
      trackTimeMillis: ep.trackTimeMillis,
      description: ep.description,
    }));

  const podcastResponse: PodcastDetailResponse = {
    podcast: {
      trackId: podcastData.trackId,
      trackName: podcastData.trackName,
      artworkUrl600: podcastData.artworkUrl600,
      feedUrl: podcastData.feedUrl,
      genres: podcastData.genres,
    },
    episodes,
  };

  return { data: podcastResponse, cacheHit };
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
async function handleDeepHealthCheck(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();
  let upstreamOk = false;
  let upstreamLatency = 0;

  try {
    const testUrl = `${HOSTNAME}/search?media=podcast&term=test&limit=1`;
    let response: Response;

    // Use container proxy to test the actual production path
    if (env.ITUNES_PROXY) {
      const containerId = env.ITUNES_PROXY.idFromName('itunes-proxy');
      const container = env.ITUNES_PROXY.get(containerId);
      const proxyUrl = `http://container/?url=${encodeURIComponent(testUrl)}`;
      response = await container.fetch(proxyUrl);
    } else {
      response = await fetch(testUrl);
    }

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
            'Returns trending podcast search queries from the last 7 days. Feature-flagged endpoint - returns 404 when disabled. Supports geographic filtering with fallback to global trending.',
          operationId: 'trendingQueries',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              description: 'Number of trending queries to return',
              required: false,
              schema: {
                type: 'integer',
                default: 10,
                minimum: 1,
                maximum: 50,
              },
            },
            {
              name: 'country',
              in: 'query',
              description:
                'ISO 3166-1 alpha-2 country code to filter trending queries (e.g., US, GB, JP). Falls back to global trending if no country-specific data available.',
              required: false,
              schema: {
                type: 'string',
                pattern: '^[A-Za-z]{2}$',
                example: 'US',
              },
            },
          ],
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
                            query: { type: 'string', description: 'The search query' },
                            count: {
                              type: 'integer',
                              description: 'Number of searches in the period',
                            },
                          },
                        },
                      },
                      period: {
                        type: 'string',
                        description: 'Time period for trending data',
                        example: '7d',
                      },
                      country: {
                        type: 'string',
                        description:
                          'Requested country code for the trending data (or "global" if no valid country was provided). Data may fall back to global results when no country-specific data exists.',
                        example: 'US',
                      },
                      generatedAt: {
                        type: 'string',
                        format: 'date-time',
                        description: 'When this data was generated',
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
      '/suggest': {
        get: {
          summary: 'Search Suggestions',
          description:
            'Returns autocomplete suggestions based on popular search queries. Feature-flagged endpoint (uses trendingQueries flag) - returns 404 when disabled.',
          operationId: 'searchSuggestions',
          parameters: [
            {
              name: 'q',
              in: 'query',
              description: 'Search prefix to get suggestions for (minimum 2 characters)',
              required: true,
              schema: {
                type: 'string',
                minLength: 2,
                example: 'jav',
              },
            },
            {
              name: 'limit',
              in: 'query',
              description: 'Number of suggestions to return',
              required: false,
              schema: {
                type: 'integer',
                default: 5,
                minimum: 1,
                maximum: 10,
              },
            },
          ],
          responses: {
            '200': {
              description: 'Search suggestions list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      suggestions: {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                        description: 'List of suggested search queries',
                        example: ['javascript', 'java programming', 'jazz podcasts'],
                      },
                      query: {
                        type: 'string',
                        description: 'The original query prefix',
                        example: 'jav',
                      },
                    },
                  },
                },
              },
              headers: {
                'Cache-Control': {
                  description: 'Cache duration: 5 minutes',
                  schema: {
                    type: 'string',
                    example: 'public, max-age=300',
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
      '/podcast/{id}': {
        get: {
          summary: 'Podcast Detail',
          description:
            'Returns detailed information about a specific podcast including recent episodes.',
          operationId: 'podcastDetail',
          parameters: [
            {
              name: 'id',
              in: 'path',
              description: 'The iTunes podcast ID',
              required: true,
              schema: {
                type: 'integer',
                example: 1535809341,
              },
            },
          ],
          responses: {
            '200': {
              description: 'Podcast details with episodes',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      podcast: {
                        type: 'object',
                        properties: {
                          trackId: { type: 'integer', description: 'iTunes podcast ID' },
                          trackName: { type: 'string', description: 'Podcast name' },
                          artworkUrl600: { type: 'string', description: 'Podcast artwork URL' },
                          feedUrl: { type: 'string', description: 'RSS feed URL' },
                          genres: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Podcast genres',
                          },
                        },
                      },
                      episodes: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            trackId: { type: 'integer', description: 'Episode ID' },
                            trackName: { type: 'string', description: 'Episode title' },
                            releaseDate: {
                              type: 'string',
                              format: 'date-time',
                              description: 'Episode release date',
                            },
                            trackTimeMillis: {
                              type: 'integer',
                              description: 'Episode duration in milliseconds',
                            },
                            description: { type: 'string', description: 'Episode description' },
                          },
                        },
                        description: 'List of recent episodes (up to 20)',
                      },
                    },
                  },
                },
              },
              headers: {
                'Cache-Control': {
                  description: 'Cache duration: 1 hour',
                  schema: {
                    type: 'string',
                    example: 'public, max-age=3600',
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
              description: 'Invalid podcast ID',
            },
            '404': {
              description: 'Podcast not found',
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
 * iTunes proxy container class.
 * Uses Cloudflare Workers Containers to proxy iTunes API calls,
 * avoiding 403 errors from Apple blocking Worker IPs.
 */
export class ITunesProxy extends Container {
  defaultPort = 8080;
  sleepAfter = '5m'; // Sleep after 5 min of inactivity
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
        return await handleDeepHealthCheck(request, env);
      }

      // Trending queries endpoint (feature flagged)
      if (pathname === '/trending') {
        const trendingEnabled = await getFlag(env, 'trendingQueries');
        if (!trendingEnabled) {
          return createErrorResponse('Not Found', 404, 'Not Found');
        }

        const limitParam = searchParams.get('limit');
        const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 10, 1), 50) : 10;
        const countryParam = searchParams.get('country');
        // Validate country code format (2 uppercase letters)
        const country =
          countryParam && /^[A-Za-z]{2}$/.test(countryParam)
            ? countryParam.toUpperCase()
            : undefined;
        const trending = await getTrendingQueries(env, limit, country);

        const duration = Date.now() - startTime;
        log('info', 'Trending queries request', {
          requestId,
          limit,
          country,
          resultCount: trending.length,
          duration,
        });
        trackMetrics(env, 'trending', false, 200, duration, colo, trending.length);

        return new Response(
          JSON.stringify({
            trending: trending.map((t) => ({
              query: t.query_normalized,
              count: t.total_count,
            })),
            period: '7d',
            country: country ?? 'global',
            generatedAt: new Date().toISOString(),
          }),
          {
            headers: {
              'content-type': 'application/json;charset=UTF-8',
              'Cache-Control': 'public, max-age=300', // 5 minute cache
              ...SECURITY_HEADERS,
            },
          }
        );
      }

      // Suggest (autocomplete) endpoint (reuses trendingQueries feature flag)
      if (pathname === '/suggest') {
        const trendingEnabled = await getFlag(env, 'trendingQueries');
        if (!trendingEnabled) {
          return createErrorResponse('Not Found', 404, 'Not Found');
        }

        const prefix = searchParams.get('q') ?? '';
        if (prefix.length < 2) {
          return new Response(
            JSON.stringify({
              suggestions: [],
              query: prefix,
            }),
            {
              headers: {
                'content-type': 'application/json;charset=UTF-8',
                'Cache-Control': 'public, max-age=300', // 5 minute cache
                ...SECURITY_HEADERS,
              },
            }
          );
        }

        const limitParam = searchParams.get('limit');
        const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 5, 1), 10) : 5;
        const suggestions = await getSuggestions(env, prefix, limit);

        const duration = Date.now() - startTime;
        log('info', 'Suggest request', {
          requestId,
          prefix,
          limit,
          resultCount: suggestions.length,
          duration,
        });
        trackMetrics(env, 'suggest', false, 200, duration, colo, suggestions.length);

        return new Response(
          JSON.stringify({
            suggestions,
            query: prefix,
          }),
          {
            headers: {
              'content-type': 'application/json;charset=UTF-8',
              'Cache-Control': 'public, max-age=300', // 5 minute cache
              ...SECURITY_HEADERS,
            },
          }
        );
      }

      // Podcast detail endpoint: /podcast/:id
      const podcastMatch = pathname.match(/^\/podcast\/(\d+)$/);
      if (podcastMatch) {
        const podcastId = parseInt(podcastMatch[1], 10);

        // Validate podcast ID
        if (isNaN(podcastId) || podcastId <= 0) {
          log('warn', 'Invalid podcast ID', { requestId, podcastId: podcastMatch[1] });
          return createErrorResponse('Invalid podcast ID', 400, 'Bad Request');
        }

        const { data, cacheHit } = await podcastDetailRequest(podcastId, env, ctx);
        const duration = Date.now() - startTime;

        log('info', 'Podcast detail request', {
          requestId,
          path: pathname,
          podcastId,
          episodeCount: data.episodes.length,
          duration,
          cacheHit,
          status: 200,
        });
        trackMetrics(env, 'podcastDetail', cacheHit, 200, duration, colo, data.episodes.length);

        // Export to R2 data lake (non-blocking)
        if (env.ANALYTICS_LAKE) {
          const analyticsEvent = createAnalyticsEvent(
            requestId,
            'podcastDetail',
            cacheHit,
            200,
            duration,
            colo,
            {
              resultCount: data.episodes.length,
              country: (request.cf?.country as string) ?? undefined,
            }
          );
          ctx.waitUntil(exportAnalyticsEvent(env, analyticsEvent));
        }

        return handleRequest(() => Promise.resolve(data), CACHE_TTL_PODCAST_DETAIL, cacheHit);
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
        const { data, cacheHit } = await topRequest(limit, genre, env, ctx);
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

        // Export to R2 data lake (non-blocking)
        if (env.ANALYTICS_LAKE) {
          const analyticsEvent = createAnalyticsEvent(
            requestId,
            'toppodcasts',
            cacheHit,
            200,
            duration,
            colo,
            {
              limit,
              genre: genre !== -1 ? genre : undefined,
              resultCount,
              country: (request.cf?.country as string) ?? undefined,
            }
          );
          ctx.waitUntil(exportAnalyticsEvent(env, analyticsEvent));
        }

        return handleRequest(() => Promise.resolve(data), CACHE_TTL_TOP, cacheHit);
      }

      // Handle search request
      const { data, cacheHit } = await searchRequest(query, limit, env, ctx);
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

      // Track search query for trending (non-blocking)
      if (query && resultCount > 0) {
        const requestCountry = (request.cf?.country as string) ?? undefined;
        ctx.waitUntil(trackSearchQuery(env, query, requestCountry));
      }

      // Export to R2 data lake (non-blocking, feature-flagged)
      if (env.ANALYTICS_LAKE) {
        const analyticsEvent = createAnalyticsEvent(
          requestId,
          'search',
          cacheHit,
          200,
          duration,
          colo,
          {
            query,
            limit,
            resultCount,
            country: (request.cf?.country as string) ?? undefined,
          }
        );
        ctx.waitUntil(exportAnalyticsEvent(env, analyticsEvent));
      }

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

  /**
   * Scheduled handler for cache pre-warming.
   * Runs on cron schedule defined in wrangler.toml to pre-warm cache with popular queries.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const popularQueries = [
      'news',
      'comedy',
      'true crime',
      'technology',
      'business',
      'health',
      'sports',
      'music',
      'science',
      'history',
    ];

    log('info', 'Cache pre-warming started', { queryCount: popularQueries.length });

    const warmupPromises = popularQueries.map(async (query) => {
      try {
        await searchRequest(query, 25, env, ctx);
        log('info', 'Cache warmed', { query });
      } catch (error) {
        log('warn', 'Cache warming failed', {
          query,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    ctx.waitUntil(Promise.allSettled(warmupPromises));
  },
};
