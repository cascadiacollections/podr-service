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
 * API Configuration Constants
 */
const SEARCH_LIMIT = 15 as const;
const HOSTNAME = 'https://itunes.apple.com' as const;
const RESERVED_PARAM_TOPPODCASTS = 'toppodcasts' as const;

/**
 * Cache TTL Configuration (in seconds)
 */
const CACHE_TTL_SEARCH = 3600 as const; // 1 hour for search results
const CACHE_TTL_TOP = 1800 as const; // 30 minutes for top podcasts
const CACHE_TTL_SCHEMA = 31536000 as const; // 1 year - schema only changes on redeploy

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

/**
 * Fetches data with Cloudflare Cache API support.
 * Uses cache-first strategy to minimize external API calls.
 *
 * @param url - URL to fetch
 * @param cacheTtl - Time to live for cache in seconds
 * @returns Response from cache or fetch
 * @throws Error if fetch fails
 */
async function cachedFetch(url: string, cacheTtl: number): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: 'GET' });

  // Try to get from cache first
  let response = await cache.match(cacheKey);

  if (!response) {
    // Not in cache, fetch from origin
    response = await fetch(url);

    // Only cache successful responses
    if (response.ok) {
      // Clone response before caching (responses can only be read once)
      const responseToCache = response.clone();

      // Create a new response with cache headers
      const cachedResponse = new Response(responseToCache.body, {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers: {
          ...Object.fromEntries(responseToCache.headers),
          'Cache-Control': `public, max-age=${cacheTtl}`,
        },
      });

      // Cache the response asynchronously (don't await to avoid blocking)
      void cache.put(cacheKey, cachedResponse);
    }
  }

  return response;
}

/**
 * Creates standard response headers for API responses
 *
 * @param cacheTtl - Time to live for cache in seconds
 * @returns Headers object
 */
function createResponseHeaders(cacheTtl: number): HeadersInit {
  return {
    'content-type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Cache-Control': `public, max-age=${cacheTtl}`,
  };
}

/**
 * Invokes API call and returns the response as JSON with caching support.
 *
 * @param apiCall - API request to call
 * @param cacheTtl - Time to live for cache in seconds
 * @returns JSON response
 */
async function handleRequest(apiCall: ApiCall, cacheTtl: number): Promise<Response> {
  const data = await apiCall();
  return new Response(JSON.stringify(data), {
    headers: createResponseHeaders(cacheTtl),
  });
}

/**
 * iTunes search API.
 *
 * @param query - The search query term
 * @param limit - The number of results to return (default: 15)
 * @returns Promise containing the search results as JSON
 * @throws Response with 400 status if query is empty
 */
async function searchRequest(query?: string, limit = `${SEARCH_LIMIT}`): Promise<unknown> {
  if (!query) {
    throw new Response('Empty query', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  const route = 'search';
  const mediaType = 'podcast';
  const searchUrl = `${HOSTNAME}/${route}?media=${mediaType}&term=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await cachedFetch(searchUrl, CACHE_TTL_SEARCH);

  // Check if response indicates an error
  if (response.status && response.status >= 400) {
    throw new Error(`iTunes API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * iTunes top podcasts API.
 *
 * @param limit - The number of results to return (default: 15)
 * @param genre - The genre ID filter to apply (optional)
 * @returns Promise containing the top podcasts feed as JSON
 */
async function topRequest(limit = `${SEARCH_LIMIT}`, genre = -1): Promise<unknown> {
  const genreLookupValue = ITUNES_API_GENRES[genre] ? genre : undefined;
  const topPodcastsUrl = `${HOSTNAME}/us/rss/${RESERVED_PARAM_TOPPODCASTS}/limit=${limit}/genre=${genreLookupValue}/json`;
  const response = await cachedFetch(topPodcastsUrl, CACHE_TTL_TOP);

  // Check if response indicates an error
  if (response.status && response.status >= 400) {
    throw new Error(`iTunes API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
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
                minimum: 1,
                maximum: 200,
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
              },
            },
            '400': {
              description: 'Bad request - missing or invalid query parameter',
            },
            '405': {
              description: 'Method not allowed - only GET is supported',
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
    },
  });
}

/**
 * Modern Module Worker export with fetch handler.
 * Handles podcast search and discovery requests.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      // Only allow GET requests
      if (request.method !== 'GET') {
        return createErrorResponse('Unsupported', 405, 'Method Not Allowed');
      }

      const { searchParams, pathname } = new URL(request.url);

      // Serve API schema at root path when no query params
      if (pathname === '/' && !searchParams.has('q')) {
        return new Response(JSON.stringify(getApiSchema(), null, 2), {
          headers: {
            'content-type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET',
            'Cache-Control': `public, max-age=${CACHE_TTL_SCHEMA}, immutable`,
          },
        });
      }

      const query = searchParams.get('q') ?? undefined;
      const limit = searchParams.get('limit') ?? undefined;
      const genre = parseInt(searchParams.get('genre') ?? '-1', 10);

      // Handle top podcasts request
      if (query === RESERVED_PARAM_TOPPODCASTS) {
        return handleRequest(() => topRequest(limit, genre), CACHE_TTL_TOP);
      }

      // Handle search request
      return handleRequest(() => searchRequest(query, limit), CACHE_TTL_SEARCH);
    } catch (error) {
      // Handle thrown Response objects (e.g., from searchRequest validation)
      if (error instanceof Response) {
        return error;
      }

      // Handle other errors
      const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
      return createErrorResponse(errorMessage, 500, 'Internal Server Error');
    }
  },
};
