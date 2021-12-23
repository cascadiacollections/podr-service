import { ApiCall, rssRequest, searchRequest } from './handlers';

async function handleRequest(apiCall: ApiCall) {
  const init = {
    headers: {
      "content-type": "application/json;charset=UTF-8",
    },
  }

  const response = await apiCall();
  const data = JSON.stringify(response)
  return new Response(data, init);
}

/**
 * 
 */
addEventListener('fetch', event => { 
  if (event.request.method === 'GET') {
    switch (event.request.url) {
      case 'search':
        return event.respondWith(handleRequest(searchRequest));
      case 'rss':
        return event.respondWith(handleRequest(rssRequest));
      default:
        return event.respondWith(new Response("Unsupported method", {
          status: 500,
        }));
    }
  }
  return event.respondWith(new Response("Unsupported method", {
    status: 500,
  }));
})