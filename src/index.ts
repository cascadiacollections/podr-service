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

    const { searchParams } = new URL(request.url);
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
