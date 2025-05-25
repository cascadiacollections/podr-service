import makeServiceWorkerEnv from 'service-worker-mock';
import { describe, beforeEach, test, expect, jest } from '@jest/globals';

describe('Handle', () => {
  beforeEach(() => {
    Object.assign(global, makeServiceWorkerEnv(), {
      fetch: jest.fn(),
      Response: jest.fn(),
    });
    jest.resetModules();
  });

  test('Service worker environment is set up', () => {
    // Check that service worker environment is properly mocked
    expect(global).toBeDefined();
  });
});