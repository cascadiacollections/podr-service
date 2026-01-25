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
      expect(cacheControl).toContain('max-age=3600'); // 1 hour for search
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
      expect(cacheControl).toContain('max-age=1800'); // 30 minutes for top podcasts
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
});
