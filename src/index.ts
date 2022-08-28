type ApiCall = () => Promise<Response>;

const SEARCH_LIMIT = 15;
const HOSTNAME = 'https://itunes.apple.com';

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
 * Podcast search API endpoint.
 */
addEventListener('fetch', (event: FetchEvent): void => { 
  if (event.request.method === 'GET') {
    const { searchParams } = new URL(event.request.url);
    const query = searchParams.get('q') ?? undefined;
    const limit = searchParams.get('limit') ?? undefined;
    const response = handleRequest(() => searchRequest(query, limit));

    return event.respondWith(response);
  }

  return event.respondWith(new Response('Unsupported', {
    status: 500,
  }));
});