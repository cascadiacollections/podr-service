type ApiCall = () => Promise<Response>;

interface IGenresDictionary {
  [key: number]: string;
}

const SEARCH_LIMIT: number = 15;
const HOSTNAME: string = 'https://itunes.apple.com';
const RESERVED_PARAM_TOPPODCASTS: string = 'toppodcasts';
// @todo - use Set?
const ITUNES_API_GENRES: IGenresDictionary = {
  1301: "Arts",
  1302: "Comedy",
  1303: "Education",
  1304: "Kids & Family",
  1305: "Health & Fitness",
  1306: "TV & Film",
  1307: "Music",
  1308: "News",
  1309: "Religion & Spirituality",
  1310: "Science",
  1311: "Sports",
  1312: "Technology",
  1313: "Business",
  1314: "Society & Culture",
  1315: "Government",
  1321: "Fiction",
  1323: "History",
  1324: "True Crime",
  1325: "Leisure",
  1326: "Documentary"
};

/**
 * Invokes API call and returns the response as JSON.
 * 
 * @param apiCall API request to call.
 * @returns JSON response
 */
async function handleRequest(apiCall: ApiCall) {
  const init: RequestInit = {
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET'
    },
  }

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
      statusText: 'Bad Request'
    });
  }

  const route = 'search';
  const mediaType = 'podcast';
  const SEARCH_URL = `${HOSTNAME}/${route}?media=${mediaType}&term=${query}&limit=${limit}`;
  const response: Response = await fetch(SEARCH_URL);

  return response.json();
}

/**
 * 
 * @returns 
 */
async function topRequest(limit = `${SEARCH_LIMIT}`, genre: number = -1): Promise<Response> {
  const genreLookupValue: number | undefined = ITUNES_API_GENRES[genre] ? genre : undefined;
  // @todo - Use URLSearchParams and stringify.
  const TOP_PODCASTS_URL: string = `${HOSTNAME}/us/rss/${RESERVED_PARAM_TOPPODCASTS}/limit=${limit}/genre=${genreLookupValue}/json`;
  const response: Response = await fetch(TOP_PODCASTS_URL);

  return response.json();
}

/**
 * Podcast search API endpoint.
 */
addEventListener('fetch', (event: FetchEvent): void => { 
  if (event.request.method === 'GET') {
    const { searchParams } = new URL(event.request.url);
    const query = searchParams.get('q') ?? undefined;
    const limit = searchParams.get('limit') ?? undefined;
    const genre = parseInt(searchParams.get('genre') ?? '-1', 10); // @todo - improve default.

    // Reserved search query terms.
    if (query === RESERVED_PARAM_TOPPODCASTS) {
      const response = handleRequest(() => topRequest(limit, genre));
      return event.respondWith(response);
    }

    const response = handleRequest(() => searchRequest(query, limit));

    return event.respondWith(response);
  }

  return event.respondWith(new Response('Unsupported', {
    status: 500,
  }));
});