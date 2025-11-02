import type { OpenAPIV3 } from 'openapi-types';

type ApiCall = () => Promise<Response>;

interface IGenresDictionary {
  [key: number]: string;
}

const SEARCH_LIMIT: number = 15;
const HOSTNAME: string = 'https://itunes.apple.com';
const RESERVED_PARAM_TOPPODCASTS: string = 'toppodcasts';

// Cache TTL in seconds
const CACHE_TTL_SEARCH: number = 3600; // 1 hour for search results
const CACHE_TTL_TOP: number = 1800; // 30 minutes for top podcasts
const CACHE_TTL_SCHEMA: number = 31536000; // 1 year - schema only changes on redeploy

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
 * @param url URL to fetch.
 * @param cacheTtl Time to live for cache in seconds.
 * @returns Response from cache or fetch
 */
async function cachedFetch(url: string, cacheTtl: number): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: 'GET' });

  // Try to get from cache first
  let response = await cache.match(cacheKey);

  if (!response) {
    // Not in cache, fetch from origin
    response = await fetch(url);

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

    // Cache the response asynchronously
    cache.put(cacheKey, cachedResponse);
  }

  return response;
}

/**
 * Invokes API call and returns the response as JSON with caching support.
 *
 * @param apiCall API request to call.
 * @param cacheTtl Time to live for cache in seconds.
 * @returns JSON response
 */
async function handleRequest(apiCall: ApiCall, cacheTtl: number): Promise<Response> {
  const init: ResponseInit = {
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Cache-Control': `public, max-age=${cacheTtl}`,
    },
  };

  const response: Response = await apiCall();

  return new Response(JSON.stringify(response), init);
}

/**
 * iTunes search API.
 *
 * @param query the query to issue.
 * @param limit the number of results to return.
 * @returns the response as JSON
 */
async function searchRequest(query?: string, limit = `${SEARCH_LIMIT}`): Promise<Response> {
  if (!query) {
    return new Response('Empty query', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  const route = 'search';
  const mediaType = 'podcast';
  const SEARCH_URL = `${HOSTNAME}/${route}?media=${mediaType}&term=${query}&limit=${limit}`;
  const response: Response = await cachedFetch(SEARCH_URL, CACHE_TTL_SEARCH);

  return response.json();
}

/**
 * iTunes top podcasts API.
 *
 * @param limit the number of results to return.
 * @param genre the genre filter to apply.
 * @returns the response as JSON
 */
async function topRequest(limit = `${SEARCH_LIMIT}`, genre: number = -1): Promise<Response> {
  const genreLookupValue: number | undefined = ITUNES_API_GENRES[genre] ? genre : undefined;
  const TOP_PODCASTS_URL: string = `${HOSTNAME}/us/rss/${RESERVED_PARAM_TOPPODCASTS}/limit=${limit}/genre=${genreLookupValue}/json`;
  const response: Response = await cachedFetch(TOP_PODCASTS_URL, CACHE_TTL_TOP);

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
 * Modern Module Worker export with fetch handler.
 * Handles podcast search and discovery requests.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET') {
      return new Response('Unsupported', {
        status: 405,
        statusText: 'Method Not Allowed',
      });
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

    // Reserved search query terms.
    if (query === RESERVED_PARAM_TOPPODCASTS) {
      return handleRequest(() => topRequest(limit, genre), CACHE_TTL_TOP);
    }

    return handleRequest(() => searchRequest(query, limit), CACHE_TTL_SEARCH);
  },
};
