import { describe, test, expect, jest } from '@jest/globals';
import worker from '../src/index';

describe('Podr Service Worker', () => {
  describe('fetch handler', () => {
    test('should handle GET request with search query', async () => {
      const url = 'http://localhost:8787/?q=javascript';
      const request = new Request(url, { method: 'GET' });

      // Mock the global fetch function
      global.fetch = jest.fn(() =>
        Promise.resolve({
          json: () => Promise.resolve({ results: [] }),
        } as Response)
      );

      const response = await worker.fetch(request);

      expect(response).toBeDefined();
      expect(response instanceof Response).toBe(true);
    });

    test('should handle GET request with toppodcasts query', async () => {
      const url = 'http://localhost:8787/?q=toppodcasts&limit=10';
      const request = new Request(url, { method: 'GET' });

      // Mock the global fetch function
      global.fetch = jest.fn(() =>
        Promise.resolve({
          json: () => Promise.resolve({ feed: { entry: [] } }),
        } as Response)
      );

      const response = await worker.fetch(request);

      expect(response).toBeDefined();
      expect(response instanceof Response).toBe(true);
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
  });
});
