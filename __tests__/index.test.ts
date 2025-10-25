import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import worker from '../src/index';

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
  });

  describe('fetch handler', () => {
    test('should handle GET request with search query', async () => {
      const url = 'http://localhost:8787/?q=javascript';
      const request = new Request(url, { method: 'GET' });

      // Mock the global fetch function
      global.fetch = jest.fn(() =>
        Promise.resolve({
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request);

      expect(response).toBeDefined();
      expect(response instanceof Response).toBe(true);
      expect(response.headers.get('Cache-Control')).toContain('public');
    });

    test('should handle GET request with toppodcasts query', async () => {
      const url = 'http://localhost:8787/?q=toppodcasts&limit=10';
      const request = new Request(url, { method: 'GET' });

      // Mock the global fetch function
      global.fetch = jest.fn(() =>
        Promise.resolve({
          json: () => Promise.resolve({ feed: { entry: [] } }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request);

      expect(response).toBeDefined();
      expect(response instanceof Response).toBe(true);
      expect(response.headers.get('Cache-Control')).toContain('public');
    });

    test('should reject non-GET requests', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'POST' });

      const response = await worker.fetch(request);

      expect(response.status).toBe(405);
      expect(response.statusText).toBe('Method Not Allowed');
    });

    test('should handle request without query parameter', async () => {
      const url = 'http://localhost:8787/';
      const request = new Request(url, { method: 'GET' });

      const response = await worker.fetch(request);

      expect(response).toBeDefined();
      expect(response instanceof Response).toBe(true);
    });

    test('should set appropriate Cache-Control headers for search results', async () => {
      const url = 'http://localhost:8787/?q=javascript';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          json: () => Promise.resolve({ results: [] }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request);
      const cacheControl = response.headers.get('Cache-Control');

      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age=3600'); // 1 hour for search
    });

    test('should set appropriate Cache-Control headers for top podcasts', async () => {
      const url = 'http://localhost:8787/?q=toppodcasts';
      const request = new Request(url, { method: 'GET' });

      global.fetch = jest.fn(() =>
        Promise.resolve({
          json: () => Promise.resolve({ feed: { entry: [] } }),
          clone: () => ({
            body: null,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
          }),
        } as unknown as Response)
      );

      const response = await worker.fetch(request);
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

      const response = await worker.fetch(request);

      expect(response).toBeDefined();
      expect(mockCache.match).toHaveBeenCalled();
    });
  });
});
