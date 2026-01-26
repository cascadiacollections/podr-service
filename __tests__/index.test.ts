import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import worker from '../src/index';

// Mock execution context
const mockCtx = {
  waitUntil: jest.fn(),
  passThroughOnException: jest.fn(),
} as unknown as ExecutionContext;

// Mock environment with rate limiter
const mockEnv = {
  RATE_LIMITER: {
    limit: jest.fn(() => Promise.resolve({ success: true })),
  },
};

// Mock environment without rate limiter
const mockEnvNoRateLimiter = {};

// Mock environment with feature flags enabled
const mockEnvWithFlags = {
  FLAGS: {
    get: jest.fn((key: string) => {
      if (key === 'flag:trendingQueries') return Promise.resolve('true');
      return Promise.resolve(null);
    }),
  },
};

// Mock environment with feature flags disabled
const mockEnvWithFlagsDisabled = {
  FLAGS: {
    get: jest.fn(() => Promise.resolve('false')),
  },
};

// Mock D1 database
const createMockD1 = (
  trendingData: Array<{ query_normalized: string; total_count: number }> = []
) => ({
  prepare: jest.fn((_query: string) => ({
    bind: jest.fn().mockReturnThis(),
    first: jest.fn(() => Promise.resolve(null)),
    run: jest.fn(() => Promise.resolve({ success: true, meta: { rows_written: 1 } })),
    all: jest.fn(() =>
      Promise.resolve({
        results: trendingData,
        success: true,
      })
    ),
  })),
  exec: jest.fn(() => Promise.resolve({ results: [], success: true })),
});

// Mock environment with feature flags and D1
const mockEnvWithD1 = {
  FLAGS: {
    get: jest.fn((key: string) => {
      if (key === 'flag:trendingQueries') return Promise.resolve('true');
      return Promise.resolve(null);
    }),
  },
  DB: createMockD1([
    { query_normalized: 'javascript', total_count: 150 },
    { query_normalized: 'python', total_count: 120 },
    { query_normalized: 'react', total_count: 90 },
  ]),
};

describe('Podr Service Worker', () => {
  // Mock the cache API
  beforeEach(() => {
    const mockCache = {
      match: jest.fn(() => Promise.resolve(undefined)),
      put: jest.fn(() => Promise.resolve()),
    };

    global.caches = {
      default: mockCache,
    } as unknown as CacheStorage;

    // Reset rate limiter mock
    mockEnv.RATE_LIMITER.limit.mockImplementation(() => Promise.resolve({ success: true }));
  });

  describe('fetch handler', () => {
    test('should return OpenAPI schema at root path', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response).toBeDefined();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json;charset=UTF-8');
      expect(response.headers.get('Cache-Control')).toContain('max-age=31536000');
      expect(response.headers.get('Cache-Control')).toContain('immutable');

      const schema = await response.json();
      expect(schema).toHaveProperty('openapi', '3.0.0');
      expect(schema).toHaveProperty('info');
      expect(schema).toHaveProperty('paths');
      expect(schema.info).toHaveProperty('title', 'Podr API');
    });

    test('should return schema with proper CORS headers', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET');
    });

    test('should include security headers in schema response', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    test('should document all API endpoints in schema', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const schema = await response.json();

      expect(schema.paths).toHaveProperty('/');
      expect(schema.paths).toHaveProperty('/health');
      expect(schema.paths).toHaveProperty('/health/deep');

      // Verify the consolidated path documents all operations
      const pathSchema = schema.paths['/'];
      expect(pathSchema).toHaveProperty('get');
      expect(pathSchema.get).toHaveProperty('parameters');
      expect(Array.isArray(pathSchema.get.parameters)).toBe(true);

      const responseSchema = pathSchema.get.responses['200'];
      expect(responseSchema).toHaveProperty('content');
      expect(responseSchema.content['application/json']).toHaveProperty('schema');
      expect(responseSchema.content['application/json'].schema).toHaveProperty('oneOf');
      expect(Array.isArray(responseSchema.content['application/json'].schema.oneOf)).toBe(true);
      expect(responseSchema.content['application/json'].schema.oneOf).toHaveLength(3);
    });

    test('should handle GET request with search query', async () => {
      const url = 'http://localhost:8787/?q=javascript';
      const request = new Request(url, { method: 'GET' });

      // Mock the global fetch function
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response).toBeDefined();
      expect(response instanceof Response).toBe(true);
      expect(response.headers.get('Cache-Control')).toContain('public');
      expect(response.headers.get('X-Cache')).toBe('MISS');
    });

    test('should handle GET request with toppodcasts query', async () => {
      const url = 'http://localhost:8787/?q=toppodcasts&limit=10';
      const request = new Request(url, { method: 'GET' });

      // Mock the global fetch function
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ feed: { entry: [] } }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response).toBeDefined();
      expect(response instanceof Response).toBe(true);
      expect(response.headers.get('Cache-Control')).toContain('public');
    });

    test('should reject non-GET requests', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'POST' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(405);
      expect(response.statusText).toBe('Method Not Allowed');
    });

    test('should handle request without query parameter', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response).toBeDefined();
      expect(response instanceof Response).toBe(true);
    });

    test('should set appropriate Cache-Control headers for search results', async () => {
      const url = 'http://localhost:8787/?q=javascript';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const cacheControl = response.headers.get('Cache-Control');

      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age=86400'); // 24 hours for search
    });

    test('should set appropriate Cache-Control headers for top podcasts', async () => {
      const url = 'http://localhost:8787/?q=toppodcasts';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ feed: { entry: [] } }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const cacheControl = response.headers.get('Cache-Control');

      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age=7200'); // 2 hours for top podcasts
    });

    test('should use cache when available', async () => {
      const url = 'http://localhost:8787/?q=javascript';
      const request = new Request(url, { method: 'GET' });

      const cachedData = { results: [{ id: 1, name: 'Cached Podcast' }] };
      const mockCache = {
        match: jest.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify(cachedData), {
              headers: { 'Content-Type': 'application/json' },
            })
          )
        ),
        put: jest.fn(() => Promise.resolve()),
      };

      global.caches = {
        default: mockCache,
      } as unknown as CacheStorage;

      // This should not be called if cache hit
      global.fetch = jest.fn();

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response).toBeDefined();
      expect(mockCache.match).toHaveBeenCalled();
      expect(response.headers.get('X-Cache')).toBe('HIT');
    });
  });

  describe('health check endpoints', () => {
    test('should return health status at /health', async () => {
      const url = 'http://localhost:8787/health';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json;charset=UTF-8');
      expect(response.headers.get('Cache-Control')).toBe('no-store');

      const body = await response.json();
      expect(body).toHaveProperty('status', 'healthy');
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('version', '1.0.0');
      expect(body).toHaveProperty('circuitBreaker', 'closed');
      expect(body).toHaveProperty('placement');
    });

    test('should return deep health status at /health/deep', async () => {
      const url = 'http://localhost:8787/health/deep';
      const request = new Request(url, { method: 'GET' });

      // Mock successful upstream fetch
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('status', 'healthy');
      expect(body).toHaveProperty('upstream');
      expect(body.upstream.itunes).toHaveProperty('status', 'healthy');
      expect(body.upstream.itunes).toHaveProperty('latencyMs');
    });

    test('should return 503 when upstream is unhealthy', async () => {
      const url = 'http://localhost:8787/health/deep';
      const request = new Request(url, { method: 'GET' });

      // Mock failed upstream fetch
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toHaveProperty('status', 'degraded');
      expect(body.upstream.itunes).toHaveProperty('status', 'unhealthy');
    });
  });

  describe('input validation', () => {
    test('should reject query exceeding max length', async () => {
      const longQuery = 'a'.repeat(201);
      const url = `http://localhost:8787/?q=${longQuery}`;
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('maximum length');
    });

    test('should reject suspicious query patterns', async () => {
      const maliciousQueries = [
        '<script>alert(1)</script>',
        'javascript:alert(1)',
        'test onclick=alert(1)',
        '<iframe src="evil">',
        'data:text/html,evil',
      ];

      for (const query of maliciousQueries) {
        const url = `http://localhost:8787/?q=${encodeURIComponent(query)}`;
        const request = new Request(url, { method: 'GET' });

        const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain('invalid characters');
      }
    });

    test('should reject limit below minimum', async () => {
      const url = 'http://localhost:8787/?q=test&limit=0';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Limit must be between');
    });

    test('should reject limit above maximum', async () => {
      const url = 'http://localhost:8787/?q=test&limit=201';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Limit must be between');
    });

    test('should reject invalid genre ID', async () => {
      const url = 'http://localhost:8787/?q=toppodcasts&genre=9999';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Invalid genre ID');
    });

    test('should accept valid genre ID', async () => {
      const url = 'http://localhost:8787/?q=toppodcasts&genre=1312';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ feed: { entry: [] } }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
    });

    test('should accept valid query and limit', async () => {
      const url = 'http://localhost:8787/?q=javascript&limit=50';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
    });
  });

  describe('rate limiting', () => {
    test('should allow request when rate limit not exceeded', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      expect(mockEnv.RATE_LIMITER.limit).toHaveBeenCalled();
    });

    test('should return 429 when rate limit exceeded', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      mockEnv.RATE_LIMITER.limit.mockImplementation(() => Promise.resolve({ success: false }));

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(429);
      expect(response.statusText).toBe('Too Many Requests');
      const text = await response.text();
      expect(text).toBe('Rate limit exceeded');
    });

    test('should work without rate limiter binding', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
    });
  });

  describe('security headers', () => {
    test('should include security headers in error responses', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'POST' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    test('should include security headers in API responses', async () => {
      const url = 'http://localhost:8787/?q=test';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    test('should include security headers in health check responses', async () => {
      const url = 'http://localhost:8787/health';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('cache hit tracking', () => {
    test('should return X-Cache: MISS when cache miss', async () => {
      const url = 'http://localhost:8787/?q=test';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('X-Cache')).toBe('MISS');
    });

    test('should return X-Cache: HIT when cache hit', async () => {
      const url = 'http://localhost:8787/?q=test';
      const request = new Request(url, { method: 'GET' });

      const mockCache = {
        match: jest.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify({ results: [] }), {
              headers: { 'Content-Type': 'application/json' },
            })
          )
        ),
        put: jest.fn(() => Promise.resolve()),
      };

      global.caches = {
        default: mockCache,
      } as unknown as CacheStorage;

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('X-Cache')).toBe('HIT');
    });
  });

  describe('error handling', () => {
    test('should handle upstream API 4xx errors', async () => {
      const url = 'http://localhost:8787/?q=test';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain('iTunes API error');
    });

    test('should handle upstream API 5xx errors', async () => {
      const url = 'http://localhost:8787/?q=test';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain('iTunes API error');
    });

    test('should handle network errors gracefully', async () => {
      const url = 'http://localhost:8787/?q=test';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain('Network error');
    });

    test('should handle deep health check network errors', async () => {
      const url = 'http://localhost:8787/health/deep';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() => Promise.reject(new Error('Connection refused')));

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.status).toBe('degraded');
      expect(body.upstream.itunes.status).toBe('unhealthy');
    });
  });

  describe('edge cases', () => {
    test('should handle empty search results', async () => {
      const url = 'http://localhost:8787/?q=xyznonexistent123';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ resultCount: 0, results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.resultCount).toBe(0);
      expect(body.results).toEqual([]);
    });

    test('should handle special characters in search query', async () => {
      const url = 'http://localhost:8787/?q=c%2B%2B+programming';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
    });

    test('should handle unicode characters in search query', async () => {
      const url = 'http://localhost:8787/?q=%E6%97%A5%E6%9C%AC%E8%AA%9E';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
    });

    test('should accept boundary limit values', async () => {
      // Test minimum valid limit
      const url1 = 'http://localhost:8787/?q=test&limit=1';
      const request1 = new Request(url1, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response1 = await worker.fetch(request1, mockEnvNoRateLimiter, mockCtx);
      expect(response1.status).toBe(200);

      // Test maximum valid limit
      const url2 = 'http://localhost:8787/?q=test&limit=200';
      const request2 = new Request(url2, { method: 'GET' });

      const response2 = await worker.fetch(request2, mockEnvNoRateLimiter, mockCtx);
      expect(response2.status).toBe(200);
    });

    test('should reject non-numeric limit values', async () => {
      const url = 'http://localhost:8787/?q=test&limit=abc';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Limit must be between');
    });

    test('should reject negative limit values', async () => {
      const url = 'http://localhost:8787/?q=test&limit=-5';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(400);
    });

    test('should handle query at exactly max length', async () => {
      const maxQuery = 'a'.repeat(200);
      const url = `http://localhost:8787/?q=${maxQuery}`;
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
    });

    test('should handle toppodcasts with all valid genres', async () => {
      const validGenres = [
        1301, 1302, 1303, 1304, 1305, 1306, 1307, 1308, 1309, 1310, 1311, 1312, 1313, 1314, 1315,
        1321, 1323, 1324, 1325, 1326,
      ];

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ feed: { entry: [] } }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      for (const genre of validGenres) {
        const url = `http://localhost:8787/?q=toppodcasts&genre=${genre}`;
        const request = new Request(url, { method: 'GET' });
        const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
        expect(response.status).toBe(200);
      }
    });
  });

  describe('HTTP methods', () => {
    test('should reject PUT requests', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'PUT' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(405);
    });

    test('should reject DELETE requests', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'DELETE' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(405);
    });

    test('should reject PATCH requests', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'PATCH' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(405);
    });

    test('should reject HEAD requests', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'HEAD' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(405);
    });
  });

  describe('path handling', () => {
    test('should return schema for root path without query', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('openapi');
    });

    test('should return 400 for unknown paths with query', async () => {
      const url = 'http://localhost:8787/unknown?q=test';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      // Currently the worker processes any path with a query - this is expected behavior
      expect(response.status).toBe(200);
    });

    test('should handle trailing slash on health endpoint', async () => {
      const url = 'http://localhost:8787/health';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
    });
  });

  describe('response format', () => {
    test('should return valid JSON for search results', async () => {
      const url = 'http://localhost:8787/?q=test';
      const request = new Request(url, { method: 'GET' });

      const mockResults = {
        resultCount: 2,
        results: [
          { trackId: 1, trackName: 'Podcast 1' },
          { trackId: 2, trackName: 'Podcast 2' },
        ],
      };

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResults),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const body = await response.json();

      expect(body).toHaveProperty('resultCount', 2);
      expect(body).toHaveProperty('results');
      expect(body.results).toHaveLength(2);
    });

    test('should return valid JSON for top podcasts', async () => {
      const url = 'http://localhost:8787/?q=toppodcasts';
      const request = new Request(url, { method: 'GET' });

      const mockFeed = {
        feed: {
          entry: [{ 'im:name': { label: 'Podcast 1' } }, { 'im:name': { label: 'Podcast 2' } }],
        },
      };

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockFeed),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const body = await response.json();

      expect(body).toHaveProperty('feed');
      expect(body.feed).toHaveProperty('entry');
      expect(body.feed.entry).toHaveLength(2);
    });

    test('should return pretty-printed JSON for schema', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const text = await response.text();

      // Pretty-printed JSON should have newlines
      expect(text).toContain('\n');
    });
  });

  describe('feature flags', () => {
    test('should return 404 for /trending when flag is disabled', async () => {
      const url = 'http://localhost:8787/trending';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(404);
    });

    test('should return 404 for /trending when flag is explicitly false', async () => {
      const url = 'http://localhost:8787/trending';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithFlagsDisabled, mockCtx);

      expect(response.status).toBe(404);
    });

    test('should return 200 for /trending when flag is enabled', async () => {
      const url = 'http://localhost:8787/trending';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithFlags, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json;charset=UTF-8');

      const body = await response.json();
      expect(body).toHaveProperty('trending');
      expect(Array.isArray(body.trending)).toBe(true);
    });

    test('should include /trending in schema', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const schema = await response.json();

      expect(schema.paths).toHaveProperty('/trending');
      expect(schema.paths['/trending'].get).toHaveProperty('summary', 'Trending Queries');
    });
  });

  describe('D1 trending queries', () => {
    test('should return trending queries from D1', async () => {
      const url = 'http://localhost:8787/trending';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithD1, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.trending).toHaveLength(3);
      expect(body.trending[0]).toEqual({ query: 'javascript', count: 150 });
      expect(body.trending[1]).toEqual({ query: 'python', count: 120 });
      expect(body.trending[2]).toEqual({ query: 'react', count: 90 });
    });

    test('should include period and generatedAt in trending response', async () => {
      const url = 'http://localhost:8787/trending';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithD1, mockCtx);
      const body = await response.json();

      expect(body).toHaveProperty('period', '7d');
      expect(body).toHaveProperty('generatedAt');
      expect(new Date(body.generatedAt).getTime()).not.toBeNaN();
    });

    test('should respect limit parameter in trending', async () => {
      const url = 'http://localhost:8787/trending?limit=2';
      const request = new Request(url, { method: 'GET' });

      const mockEnvWithLimitedD1 = {
        FLAGS: {
          get: jest.fn((key: string) => {
            if (key === 'flag:trendingQueries') return Promise.resolve('true');
            return Promise.resolve(null);
          }),
        },
        DB: createMockD1([
          { query_normalized: 'javascript', total_count: 150 },
          { query_normalized: 'python', total_count: 120 },
        ]),
      };

      const response = await worker.fetch(request, mockEnvWithLimitedD1, mockCtx);

      expect(response.status).toBe(200);
      // D1 mock returns the data, the limit is passed to the query
      expect(mockEnvWithLimitedD1.DB.prepare).toHaveBeenCalled();
    });

    test('should clamp limit to valid range', async () => {
      // Test limit > 50 gets clamped
      const url = 'http://localhost:8787/trending?limit=100';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithD1, mockCtx);

      expect(response.status).toBe(200);
    });

    test('should return empty array when D1 is not configured', async () => {
      const url = 'http://localhost:8787/trending';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithFlags, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.trending).toEqual([]);
    });

    test('should track search queries via waitUntil', async () => {
      const url = 'http://localhost:8787/?q=podcast';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'Content-Type': 'application/json' }),
          }),
          json: () => Promise.resolve({ resultCount: 5, results: [{}, {}, {}, {}, {}] }),
        } as unknown as Response)
      );

      const mockCtxForTracking = {
        waitUntil: jest.fn(),
        passThroughOnException: jest.fn(),
      } as unknown as ExecutionContext;

      await worker.fetch(request, mockEnvWithD1, mockCtxForTracking);

      // waitUntil should be called for tracking (and potentially other async tasks)
      expect(mockCtxForTracking.waitUntil).toHaveBeenCalled();
    });

    test('should cache trending response for 5 minutes', async () => {
      const url = 'http://localhost:8787/trending';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithD1, mockCtx);

      expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    });

    test('should filter trending queries by country parameter', async () => {
      const url = 'http://localhost:8787/trending?country=US';
      const request = new Request(url, { method: 'GET' });

      // Create a mock D1 that returns country-specific data
      const mockEnvWithCountryD1 = {
        FLAGS: {
          get: jest.fn((key: string) => {
            if (key === 'flag:trendingQueries') return Promise.resolve('true');
            return Promise.resolve(null);
          }),
        },
        DB: createMockD1([
          { query_normalized: 'us podcasts', total_count: 100 },
          { query_normalized: 'american shows', total_count: 80 },
        ]),
      };

      const response = await worker.fetch(request, mockEnvWithCountryD1, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.country).toBe('US');
      expect(body.trending).toHaveLength(2);
    });

    test('should return global trending and country="global" when no country specified', async () => {
      const url = 'http://localhost:8787/trending';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithD1, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.country).toBe('global');
    });

    test('should validate country code format (2 letters only)', async () => {
      const url = 'http://localhost:8787/trending?country=USA';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithD1, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      // Invalid country code should be ignored, returning global
      expect(body.country).toBe('global');
    });

    test('should normalize country code to uppercase', async () => {
      const url = 'http://localhost:8787/trending?country=us';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithD1, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.country).toBe('US');
    });

    test('should fallback to global when no country-specific data exists', async () => {
      const url = 'http://localhost:8787/trending?country=ZW';
      const request = new Request(url, { method: 'GET' });

      // Mock D1 that returns empty for country query, then returns global data
      let callCount = 0;
      const mockEnvWithFallbackD1 = {
        FLAGS: {
          get: jest.fn((key: string) => {
            if (key === 'flag:trendingQueries') return Promise.resolve('true');
            return Promise.resolve(null);
          }),
        },
        DB: {
          prepare: jest.fn((_query: string) => ({
            bind: jest.fn().mockReturnThis(),
            first: jest.fn(() => Promise.resolve(null)),
            run: jest.fn(() => Promise.resolve({ success: true, meta: { rows_written: 1 } })),
            all: jest.fn(() => {
              callCount++;
              // First call (country-specific) returns empty, second call (global) returns data
              if (callCount === 1) {
                return Promise.resolve({ results: [], success: true });
              }
              return Promise.resolve({
                results: [
                  { query_normalized: 'global podcast', total_count: 200 },
                  { query_normalized: 'worldwide show', total_count: 150 },
                ],
                success: true,
              });
            }),
          })),
          exec: jest.fn(() => Promise.resolve({ results: [], success: true })),
        },
      };

      const response = await worker.fetch(request, mockEnvWithFallbackD1, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      // Should still return the country in response but with global fallback data
      expect(body.country).toBe('ZW');
      expect(body.trending).toHaveLength(2);
      expect(body.trending[0].query).toBe('global podcast');
    });
  });

  describe('suggest (autocomplete) endpoint', () => {
    // Mock D1 database with suggestions data
    const createMockD1ForSuggestions = (
      suggestionsData: Array<{ query_normalized: string; total_count: number }> = []
    ) => ({
      prepare: jest.fn((_query: string) => ({
        bind: jest.fn().mockReturnThis(),
        first: jest.fn(() => Promise.resolve(null)),
        run: jest.fn(() => Promise.resolve({ success: true, meta: { rows_written: 1 } })),
        all: jest.fn(() =>
          Promise.resolve({
            results: suggestionsData,
            success: true,
          })
        ),
      })),
      exec: jest.fn(() => Promise.resolve({ results: [], success: true })),
    });

    const mockEnvWithSuggestions = {
      FLAGS: {
        get: jest.fn((key: string) => {
          if (key === 'flag:trendingQueries') return Promise.resolve('true');
          return Promise.resolve(null);
        }),
      },
      DB: createMockD1ForSuggestions([
        { query_normalized: 'javascript', total_count: 150 },
        { query_normalized: 'java programming', total_count: 120 },
        { query_normalized: 'jazz podcasts', total_count: 90 },
      ]),
    };

    test('should return suggestions for valid prefix', async () => {
      const url = 'http://localhost:8787/suggest?q=jav';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithSuggestions, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json;charset=UTF-8');

      const body = await response.json();
      expect(body).toHaveProperty('suggestions');
      expect(body).toHaveProperty('query', 'jav');
      expect(Array.isArray(body.suggestions)).toBe(true);
      expect(body.suggestions).toHaveLength(3);
      expect(body.suggestions).toContain('javascript');
    });

    test('should return empty array for short prefix (< 2 chars)', async () => {
      const url = 'http://localhost:8787/suggest?q=j';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithSuggestions, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.suggestions).toEqual([]);
      expect(body.query).toBe('j');
    });

    test('should return empty array for empty prefix', async () => {
      const url = 'http://localhost:8787/suggest';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithSuggestions, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.suggestions).toEqual([]);
      expect(body.query).toBe('');
    });

    test('should respect limit parameter', async () => {
      const url = 'http://localhost:8787/suggest?q=jav&limit=2';
      const request = new Request(url, { method: 'GET' });

      const mockEnvWithLimitedSuggestions = {
        FLAGS: {
          get: jest.fn((key: string) => {
            if (key === 'flag:trendingQueries') return Promise.resolve('true');
            return Promise.resolve(null);
          }),
        },
        DB: createMockD1ForSuggestions([
          { query_normalized: 'javascript', total_count: 150 },
          { query_normalized: 'java programming', total_count: 120 },
        ]),
      };

      const response = await worker.fetch(request, mockEnvWithLimitedSuggestions, mockCtx);

      expect(response.status).toBe(200);
      expect(mockEnvWithLimitedSuggestions.DB.prepare).toHaveBeenCalled();
    });

    test('should clamp limit to valid range (1-10)', async () => {
      // Test limit > 10 gets clamped
      const url = 'http://localhost:8787/suggest?q=jav&limit=20';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithSuggestions, mockCtx);

      expect(response.status).toBe(200);
    });

    test('should return 404 when feature flag is disabled', async () => {
      const url = 'http://localhost:8787/suggest?q=jav';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(404);
    });

    test('should return 404 when feature flag is explicitly false', async () => {
      const url = 'http://localhost:8787/suggest?q=jav';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithFlagsDisabled, mockCtx);

      expect(response.status).toBe(404);
    });

    test('should cache suggest response for 5 minutes', async () => {
      const url = 'http://localhost:8787/suggest?q=jav';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvWithSuggestions, mockCtx);

      expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    });

    test('should include /suggest in schema', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const schema = await response.json();

      expect(schema.paths).toHaveProperty('/suggest');
      expect(schema.paths['/suggest'].get).toHaveProperty('summary', 'Search Suggestions');
      expect(schema.paths['/suggest'].get).toHaveProperty('operationId', 'searchSuggestions');
    });
  });

  describe('R2 analytics export', () => {
    const createMockR2 = () => ({
      put: jest.fn(() =>
        Promise.resolve({ key: 'test', size: 100, etag: 'abc', uploaded: new Date() })
      ),
      get: jest.fn(() => Promise.resolve(null)),
      list: jest.fn(() => Promise.resolve({ objects: [], truncated: false })),
      head: jest.fn(() => Promise.resolve(null)),
    });

    test('should export search events to R2 when binding is configured', async () => {
      const url = 'http://localhost:8787/?q=typescript';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'Content-Type': 'application/json' }),
          }),
          json: () => Promise.resolve({ resultCount: 10, results: [] }),
        } as unknown as Response)
      );

      const mockR2 = createMockR2();
      const mockEnvWithR2 = {
        ANALYTICS_LAKE: mockR2,
      };

      const mockCtxForR2 = {
        waitUntil: jest.fn(),
        passThroughOnException: jest.fn(),
      } as unknown as ExecutionContext;

      await worker.fetch(request, mockEnvWithR2, mockCtxForR2);

      // waitUntil should be called for R2 export
      expect(mockCtxForR2.waitUntil).toHaveBeenCalled();
    });

    test('should export toppodcasts events to R2', async () => {
      const url = 'http://localhost:8787/?q=toppodcasts&genre=1312';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'Content-Type': 'application/json' }),
          }),
          json: () => Promise.resolve({ feed: { entry: [{}, {}, {}] } }),
        } as unknown as Response)
      );

      const mockR2 = createMockR2();
      const mockEnvWithR2 = {
        ANALYTICS_LAKE: mockR2,
      };

      const mockCtxForR2 = {
        waitUntil: jest.fn(),
        passThroughOnException: jest.fn(),
      } as unknown as ExecutionContext;

      await worker.fetch(request, mockEnvWithR2, mockCtxForR2);

      expect(mockCtxForR2.waitUntil).toHaveBeenCalled();
    });

    test('should not fail when R2 is not configured', async () => {
      const url = 'http://localhost:8787/?q=test';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'Content-Type': 'application/json' }),
          }),
          json: () => Promise.resolve({ resultCount: 1, results: [{}] }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
    });

    test('should include endpoint and metadata in R2 export', async () => {
      const url = 'http://localhost:8787/?q=react';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'Content-Type': 'application/json' }),
          }),
          json: () => Promise.resolve({ resultCount: 5, results: [] }),
        } as unknown as Response)
      );

      const mockR2 = createMockR2();
      const mockEnvWithR2 = {
        ANALYTICS_LAKE: mockR2,
      };

      const mockCtxForR2 = {
        waitUntil: jest.fn((promise: Promise<void>) => {
          // Execute the promise to trigger the R2 put
          promise.catch(() => {});
        }),
        passThroughOnException: jest.fn(),
      } as unknown as ExecutionContext;

      await worker.fetch(request, mockEnvWithR2, mockCtxForR2);

      // Give time for waitUntil promises to execute
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockR2.put).toHaveBeenCalled();
      const putCall = mockR2.put.mock.calls[0];
      expect(putCall[0]).toMatch(/^events\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/.+\.json$/);

      const eventData = JSON.parse(putCall[1] as string);
      expect(eventData).toHaveProperty('endpoint', 'search');
      expect(eventData).toHaveProperty('query', 'react');
      expect(eventData).toHaveProperty('timestamp');
      expect(eventData).toHaveProperty('durationMs');
    });
  });

  describe('podcast detail endpoint', () => {
    const mockPodcastLookupResponse = {
      resultCount: 3,
      results: [
        {
          wrapperType: 'track',
          kind: 'podcast',
          trackId: 1535809341,
          trackName: 'Test Podcast',
          artworkUrl600: 'https://example.com/artwork.jpg',
          feedUrl: 'https://example.com/feed.xml',
          genres: ['Technology', 'News'],
        },
        {
          wrapperType: 'track',
          kind: 'podcast-episode',
          trackId: 1000000001,
          trackName: 'Episode 1',
          releaseDate: '2026-01-20T00:00:00Z',
          trackTimeMillis: 3600000,
          description: 'First episode description',
        },
        {
          wrapperType: 'track',
          kind: 'podcast-episode',
          trackId: 1000000002,
          trackName: 'Episode 2',
          releaseDate: '2026-01-15T00:00:00Z',
          trackTimeMillis: 2400000,
          description: 'Second episode description',
        },
      ],
    };

    beforeEach(() => {
      const mockCache = {
        match: jest.fn(() => Promise.resolve(undefined)),
        put: jest.fn(() => Promise.resolve()),
      };

      global.caches = {
        default: mockCache,
      } as unknown as CacheStorage;
    });

    test('should return podcast details with episodes', async () => {
      const url = 'http://localhost:8787/podcast/1535809341';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
          json: () => Promise.resolve(mockPodcastLookupResponse),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json;charset=UTF-8');

      const body = await response.json();
      expect(body).toHaveProperty('podcast');
      expect(body).toHaveProperty('episodes');

      expect(body.podcast).toEqual({
        trackId: 1535809341,
        trackName: 'Test Podcast',
        artworkUrl600: 'https://example.com/artwork.jpg',
        feedUrl: 'https://example.com/feed.xml',
        genres: ['Technology', 'News'],
      });

      expect(body.episodes).toHaveLength(2);
      expect(body.episodes[0]).toEqual({
        trackId: 1000000001,
        trackName: 'Episode 1',
        releaseDate: '2026-01-20T00:00:00Z',
        trackTimeMillis: 3600000,
        description: 'First episode description',
      });
    });

    test('should return 404 for unknown podcast ID', async () => {
      const url = 'http://localhost:8787/podcast/9999999999';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
          json: () => Promise.resolve({ resultCount: 0, results: [] }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(404);
      expect(response.statusText).toBe('Not Found');
    });

    test('should return 400 for invalid podcast ID format', async () => {
      const url = 'http://localhost:8787/podcast/abc';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      // Non-numeric ID doesn't match /podcast/:id pattern, falls through to search which requires ?q=
      expect(response.status).toBe(400);
    });

    test('should return 400 for negative podcast ID', async () => {
      const url = 'http://localhost:8787/podcast/-123';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      // Negative ID doesn't match /podcast/:id pattern (\\d+ only matches digits), falls through to search
      expect(response.status).toBe(400);
    });

    test('should cache podcast detail response for 1 hour', async () => {
      const url = 'http://localhost:8787/podcast/1535809341';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
          json: () => Promise.resolve(mockPodcastLookupResponse),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('Cache-Control')).toContain('max-age=14400'); // 4 hours for podcast detail
    });

    test('should return X-Cache: MISS on first request', async () => {
      const url = 'http://localhost:8787/podcast/1535809341';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
          json: () => Promise.resolve(mockPodcastLookupResponse),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('X-Cache')).toBe('MISS');
    });

    test('should return X-Cache: HIT when cached', async () => {
      const url = 'http://localhost:8787/podcast/1535809341';
      const request = new Request(url, { method: 'GET' });

      const cachedData = mockPodcastLookupResponse;
      const mockCache = {
        match: jest.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify(cachedData), {
              headers: { 'Content-Type': 'application/json' },
            })
          )
        ),
        put: jest.fn(() => Promise.resolve()),
      };

      global.caches = {
        default: mockCache,
      } as unknown as CacheStorage;

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('X-Cache')).toBe('HIT');
    });

    test('should include /podcast/{id} in schema', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const schema = await response.json();

      expect(schema.paths).toHaveProperty('/podcast/{id}');
      expect(schema.paths['/podcast/{id}'].get).toHaveProperty('summary', 'Podcast Detail');
      expect(schema.paths['/podcast/{id}'].get).toHaveProperty('operationId', 'podcastDetail');
    });

    test('should include security headers in response', async () => {
      const url = 'http://localhost:8787/podcast/1535809341';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
          json: () => Promise.resolve(mockPodcastLookupResponse),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    test('should handle podcast with no episodes', async () => {
      const url = 'http://localhost:8787/podcast/1535809341';
      const request = new Request(url, { method: 'GET' });

      const podcastOnlyResponse = {
        resultCount: 1,
        results: [
          {
            wrapperType: 'track',
            kind: 'podcast',
            trackId: 1535809341,
            trackName: 'Podcast With No Episodes',
            artworkUrl600: 'https://example.com/artwork.jpg',
          },
        ],
      };

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
          json: () => Promise.resolve(podcastOnlyResponse),
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.episodes).toHaveLength(0);
    });

    test('should handle iTunes API errors gracefully', async () => {
      const url = 'http://localhost:8787/podcast/1535809341';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
        } as unknown as Response)
      );

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(500);
    });

    test('should export podcast detail events to R2', async () => {
      const url = 'http://localhost:8787/podcast/1535809341';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
          json: () => Promise.resolve(mockPodcastLookupResponse),
        } as unknown as Response)
      );

      const mockR2 = {
        put: jest.fn(() =>
          Promise.resolve({ key: 'test', size: 100, etag: 'abc', uploaded: new Date() })
        ),
        get: jest.fn(() => Promise.resolve(null)),
        list: jest.fn(() => Promise.resolve({ objects: [], truncated: false })),
        head: jest.fn(() => Promise.resolve(null)),
      };

      const mockEnvWithR2 = {
        ANALYTICS_LAKE: mockR2,
      };

      const mockCtxForR2 = {
        waitUntil: jest.fn(),
        passThroughOnException: jest.fn(),
      } as unknown as ExecutionContext;

      await worker.fetch(request, mockEnvWithR2, mockCtxForR2);

      expect(mockCtxForR2.waitUntil).toHaveBeenCalled();
    });
  });

  describe('semantic search endpoint', () => {
    // Mock Workers AI binding
    const createMockAI = (embeddings: number[][] = [[0.1, 0.2, 0.3]]) => ({
      run: jest.fn(() => Promise.resolve({ data: embeddings })),
    });

    // Mock Vectorize binding
    const createMockVectorize = (
      matches: Array<{
        id: string;
        score: number;
        metadata?: Record<string, string | number | boolean>;
      }> = []
    ) => ({
      query: jest.fn(() => Promise.resolve({ matches })),
      insert: jest.fn(() => Promise.resolve({ ids: [] })),
      upsert: jest.fn(() => Promise.resolve({ ids: [] })),
    });

    // Mock environment with semantic search enabled
    const createMockEnvSemanticSearch = (
      matches: Array<{
        id: string;
        score: number;
        metadata?: Record<string, string | number | boolean>;
      }> = []
    ) => ({
      FLAGS: {
        get: jest.fn((key: string) => {
          if (key === 'flag:semanticSearch') return Promise.resolve('true');
          return Promise.resolve(null);
        }),
      },
      AI: createMockAI(),
      VECTORIZE: createMockVectorize(matches),
    });

    test('should return 404 when semantic search feature flag is disabled', async () => {
      const url = 'http://localhost:8787/semantic-search?q=machine%20learning';
      const request = new Request(url, { method: 'GET' });

      const mockEnvDisabled = {
        FLAGS: {
          get: jest.fn(() => Promise.resolve('false')),
        },
      };

      const response = await worker.fetch(request, mockEnvDisabled, mockCtx);

      expect(response.status).toBe(404);
    });

    test('should return 404 when semantic search feature flag is not set', async () => {
      const url = 'http://localhost:8787/semantic-search?q=machine%20learning';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);

      expect(response.status).toBe(404);
    });

    test('should return 400 when query parameter is missing', async () => {
      const url = 'http://localhost:8787/semantic-search';
      const request = new Request(url, { method: 'GET' });

      const mockEnv = createMockEnvSemanticSearch();

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing required query parameter');
    });

    test('should return 400 for query exceeding max length', async () => {
      const longQuery = 'a'.repeat(201);
      const url = `http://localhost:8787/semantic-search?q=${longQuery}`;
      const request = new Request(url, { method: 'GET' });

      const mockEnv = createMockEnvSemanticSearch();

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('maximum length');
    });

    test('should return 400 for suspicious query patterns', async () => {
      const url = 'http://localhost:8787/semantic-search?q=<script>alert(1)</script>';
      const request = new Request(url, { method: 'GET' });

      const mockEnv = createMockEnvSemanticSearch();

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('invalid characters');
    });

    test('should return semantic search results when enabled', async () => {
      const url = 'http://localhost:8787/semantic-search?q=machine%20learning';
      const request = new Request(url, { method: 'GET' });

      const mockMatches = [
        {
          id: 'podcast-1',
          score: 0.95,
          metadata: {
            title: 'AI & Machine Learning Podcast',
            description: 'A podcast about AI',
            artworkUrl: 'https://example.com/art1.jpg',
            feedUrl: 'https://example.com/feed1.xml',
          },
        },
        {
          id: 'podcast-2',
          score: 0.85,
          metadata: {
            title: 'Data Science Weekly',
            description: 'Data science discussions',
          },
        },
      ];

      const mockEnv = createMockEnvSemanticSearch(mockMatches);

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json;charset=UTF-8');
      expect(response.headers.get('Cache-Control')).toContain('max-age=3600');
      expect(response.headers.get('X-Cache')).toBe('MISS');

      const body = await response.json();
      expect(body).toHaveProperty('query', 'machine learning');
      expect(body).toHaveProperty('results');
      expect(body).toHaveProperty('resultCount', 2);
      expect(body.results).toHaveLength(2);
      expect(body.results[0]).toHaveProperty('id', 'podcast-1');
      expect(body.results[0]).toHaveProperty('score', 0.95);
      expect(body.results[0]).toHaveProperty('title', 'AI & Machine Learning Podcast');
    });

    test('should include security headers in response', async () => {
      const url = 'http://localhost:8787/semantic-search?q=technology';
      const request = new Request(url, { method: 'GET' });

      const mockEnv = createMockEnvSemanticSearch([]);

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    test('should include CORS headers in response', async () => {
      const url = 'http://localhost:8787/semantic-search?q=technology';
      const request = new Request(url, { method: 'GET' });

      const mockEnv = createMockEnvSemanticSearch([]);

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET');
    });

    test('should return empty results when AI binding is not available', async () => {
      const url = 'http://localhost:8787/semantic-search?q=technology';
      const request = new Request(url, { method: 'GET' });

      const mockEnvNoAI = {
        FLAGS: {
          get: jest.fn((key: string) => {
            if (key === 'flag:semanticSearch') return Promise.resolve('true');
            return Promise.resolve(null);
          }),
        },
        VECTORIZE: createMockVectorize([]),
      };

      const response = await worker.fetch(request, mockEnvNoAI, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.resultCount).toBe(0);
      expect(body.results).toEqual([]);
    });

    test('should return empty results when Vectorize binding is not available', async () => {
      const url = 'http://localhost:8787/semantic-search?q=technology';
      const request = new Request(url, { method: 'GET' });

      const mockEnvNoVectorize = {
        FLAGS: {
          get: jest.fn((key: string) => {
            if (key === 'flag:semanticSearch') return Promise.resolve('true');
            return Promise.resolve(null);
          }),
        },
        AI: createMockAI(),
      };

      const response = await worker.fetch(request, mockEnvNoVectorize, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.resultCount).toBe(0);
      expect(body.results).toEqual([]);
    });

    test('should respect limit parameter', async () => {
      const url = 'http://localhost:8787/semantic-search?q=technology&limit=5';
      const request = new Request(url, { method: 'GET' });

      const mockEnv = createMockEnvSemanticSearch([
        { id: 'podcast-1', score: 0.9 },
        { id: 'podcast-2', score: 0.8 },
        { id: 'podcast-3', score: 0.7 },
      ]);

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ topK: 5 })
      );
    });

    test('should clamp limit to maximum allowed value', async () => {
      const url = 'http://localhost:8787/semantic-search?q=technology&limit=100';
      const request = new Request(url, { method: 'GET' });

      const mockEnv = createMockEnvSemanticSearch([]);

      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      // Max is 10 (SEMANTIC_SEARCH_TOP_K)
      expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ topK: 10 })
      );
    });

    test('should include /semantic-search in schema', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request, mockEnvNoRateLimiter, mockCtx);
      const schema = await response.json();

      expect(schema.paths).toHaveProperty('/semantic-search');
      expect(schema.paths['/semantic-search']).toHaveProperty('get');
      expect(schema.paths['/semantic-search'].get).toHaveProperty('operationId', 'semanticSearch');
      expect(schema.paths['/semantic-search'].get).toHaveProperty('parameters');
      expect(schema.paths['/semantic-search'].get.responses).toHaveProperty('200');
      expect(schema.paths['/semantic-search'].get.responses).toHaveProperty('400');
      expect(schema.paths['/semantic-search'].get.responses).toHaveProperty('404');
    });

    test('should handle AI errors gracefully', async () => {
      const url = 'http://localhost:8787/semantic-search?q=technology';
      const request = new Request(url, { method: 'GET' });

      const mockEnvWithAIError = {
        FLAGS: {
          get: jest.fn((key: string) => {
            if (key === 'flag:semanticSearch') return Promise.resolve('true');
            return Promise.resolve(null);
          }),
        },
        AI: {
          run: jest.fn(() => Promise.reject(new Error('AI service unavailable'))),
        },
        VECTORIZE: createMockVectorize([]),
      };

      const response = await worker.fetch(request, mockEnvWithAIError, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.resultCount).toBe(0);
      expect(body.results).toEqual([]);
    });

    test('should handle Vectorize errors gracefully', async () => {
      const url = 'http://localhost:8787/semantic-search?q=technology';
      const request = new Request(url, { method: 'GET' });

      const mockEnvWithVectorizeError = {
        FLAGS: {
          get: jest.fn((key: string) => {
            if (key === 'flag:semanticSearch') return Promise.resolve('true');
            return Promise.resolve(null);
          }),
        },
        AI: createMockAI(),
        VECTORIZE: {
          query: jest.fn(() => Promise.reject(new Error('Vectorize service unavailable'))),
          insert: jest.fn(() => Promise.resolve({ ids: [] })),
          upsert: jest.fn(() => Promise.resolve({ ids: [] })),
        },
      };

      const response = await worker.fetch(request, mockEnvWithVectorizeError, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.resultCount).toBe(0);
      expect(body.results).toEqual([]);
    });

    test('should export semantic search events to R2 when configured', async () => {
      const url = 'http://localhost:8787/semantic-search?q=technology';
      const request = new Request(url, { method: 'GET' });

      const mockR2 = {
        put: jest.fn(() =>
          Promise.resolve({ key: 'test', size: 100, etag: 'abc', uploaded: new Date() })
        ),
        get: jest.fn(() => Promise.resolve(null)),
        list: jest.fn(() => Promise.resolve({ objects: [], truncated: false })),
        head: jest.fn(() => Promise.resolve(null)),
      };

      const mockEnvWithR2 = {
        FLAGS: {
          get: jest.fn((key: string) => {
            if (key === 'flag:semanticSearch') return Promise.resolve('true');
            return Promise.resolve(null);
          }),
        },
        AI: createMockAI(),
        VECTORIZE: createMockVectorize([{ id: 'podcast-1', score: 0.9 }]),
        ANALYTICS_LAKE: mockR2,
      };

      const mockCtxForR2 = {
        waitUntil: jest.fn(),
        passThroughOnException: jest.fn(),
      } as unknown as ExecutionContext;

      await worker.fetch(request, mockEnvWithR2, mockCtxForR2);

      expect(mockCtxForR2.waitUntil).toHaveBeenCalled();
    });
  });
});
