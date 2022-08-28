type ApiCall = () => Promise<Response>;

const SEARCH_LIMIT = 15;

/**
 * Invokes API call and returns the response as JSON.
 * 
 * @param apiCall API request to call.
 * @returns JSON response
 */
async function handleRequest(apiCall: ApiCall) {
  const init = {
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET'
    },
  }

  const response = await apiCall();
  const data = JSON.stringify(response)
  return new Response(data, init);
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

  const SEARCH_URL = `https://itunes.apple.com/search?media=podcast&term=${query}&limit=${limit}`;
  const response = await fetch(SEARCH_URL);

  return response.json();
}

/**
 * Podcast search API endpoint.
 */
addEventListener('fetch', event => { 
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