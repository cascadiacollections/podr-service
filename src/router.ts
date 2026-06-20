import type { Database } from 'bun:sqlite';
import { decodeBase64UrlToUrl } from './encoding.ts';
import { handleStationsSearch, handleStationDetail } from './stations.ts';
import { handleFeed, handleFeedEpisode } from './feed.ts';
import {
  handleHistoryGet,
  handleHistoryPost,
  handleSubscriptionsGet,
  handleSubscriptionsPost,
  handleSubscriptionDelete,
} from './library.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Main HTTP entrypoint. Stateless apart from the injected SQLite handle,
 * which makes the router trivially testable.
 */
export async function handleRequest(
  db: Database,
  request: Request,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  let response: Response;
  try {
    response = await route(db, request, url, path, fetchImpl);
  } catch (err) {
    response = new Response(
      JSON.stringify({ error: 'internal server error', detail: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Augment with CORS + security headers without overriding existing ones.
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...SECURITY_HEADERS })) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function route(
  db: Database,
  request: Request,
  url: URL,
  path: string,
  fetchImpl: typeof fetch
): Promise<Response> {
  const method = request.method;

  if (path === '/health' && method === 'GET') {
    return json({ status: 'ok' });
  }

  // /stations/search
  if (path === '/stations/search' && method === 'GET') {
    return handleStationsSearch(db, url, fetchImpl);
  }

  // /stations/:id
  const stationMatch = path.match(/^\/stations\/([^/]+)$/);
  if (stationMatch && method === 'GET') {
    return handleStationDetail(db, stationMatch[1]!, fetchImpl);
  }

  // /feed/:url/episodes/:guid
  const epMatch = path.match(/^\/feed\/([^/]+)\/episodes\/([^/]+)$/);
  if (epMatch && method === 'GET') {
    const decoded = decodeBase64UrlToUrl(epMatch[1]!);
    if (!decoded) return errorResponse(400, 'invalid feed url encoding');
    const guid = decodeURIComponent(epMatch[2]!);
    return handleFeedEpisode(db, decoded, guid, fetchImpl);
  }

  // /feed/:url
  const feedMatch = path.match(/^\/feed\/([^/]+)$/);
  if (feedMatch && method === 'GET') {
    const decoded = decodeBase64UrlToUrl(feedMatch[1]!);
    if (!decoded) return errorResponse(400, 'invalid feed url encoding');
    return handleFeed(db, decoded, fetchImpl);
  }

  // /history
  if (path === '/history') {
    if (method === 'GET') return handleHistoryGet(db);
    if (method === 'POST') return handleHistoryPost(db, request);
    return methodNotAllowed(['GET', 'POST']);
  }

  // /subscriptions
  if (path === '/subscriptions') {
    if (method === 'GET') return handleSubscriptionsGet(db);
    if (method === 'POST') return handleSubscriptionsPost(db, request);
    return methodNotAllowed(['GET', 'POST']);
  }

  // /subscriptions/:uri
  const subDel = path.match(/^\/subscriptions\/([^/]+)$/);
  if (subDel) {
    if (method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const decoded = decodeBase64UrlToUrl(subDel[1]!);
    if (!decoded) return errorResponse(400, 'invalid subscription uri encoding');
    return handleSubscriptionDelete(db, decoded);
  }

  return errorResponse(404, 'not found');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function methodNotAllowed(allow: string[]): Response {
  return new Response(JSON.stringify({ error: 'method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: allow.join(', ') },
  });
}
