import type { Database } from 'bun:sqlite';
import type { HistoryRow, SubscriptionRow } from './types.ts';

/**
 * GET /history — returns history rows ordered by most recently played first.
 */
export function handleHistoryGet(db: Database): Response {
  const rows = db
    .query<
      HistoryRow,
      []
    >('SELECT uri, title, last_played, count FROM history ORDER BY last_played DESC LIMIT 500')
    .all();
  return json(rows);
}

/**
 * POST /history — upsert on uri. Increments count and updates last_played.
 *
 * Body: { uri: string, title?: string }
 */
export async function handleHistoryPost(db: Database, request: Request): Promise<Response> {
  const body = (await safeJson(request)) as { uri?: unknown; title?: unknown };
  if (!body || typeof body.uri !== 'string' || body.uri.length === 0) {
    return errorResponse(400, 'uri is required');
  }
  const title = typeof body.title === 'string' ? body.title : null;
  const now = Math.floor(Date.now() / 1000);

  db.query(
    `INSERT INTO history (uri, title, last_played, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(uri) DO UPDATE SET
       title = COALESCE(excluded.title, history.title),
       last_played = excluded.last_played,
       count = history.count + 1`
  ).run(body.uri, title, now);

  const row = db
    .query<HistoryRow, [string]>('SELECT uri, title, last_played, count FROM history WHERE uri = ?')
    .get(body.uri);
  return json(row, {}, 200);
}

/**
 * GET /subscriptions — returns subscriptions ordered by most recently added.
 */
export function handleSubscriptionsGet(db: Database): Response {
  const rows = db
    .query<
      SubscriptionRow,
      []
    >('SELECT uri, title, artwork_url, added_at FROM subscriptions ORDER BY added_at DESC')
    .all();
  return json(rows);
}

/**
 * POST /subscriptions — upsert.
 *
 * Body: { uri: string, title?: string, artwork_url?: string }
 */
export async function handleSubscriptionsPost(db: Database, request: Request): Promise<Response> {
  const body = (await safeJson(request)) as {
    uri?: unknown;
    title?: unknown;
    artwork_url?: unknown;
  };
  if (!body || typeof body.uri !== 'string' || body.uri.length === 0) {
    return errorResponse(400, 'uri is required');
  }
  const title = typeof body.title === 'string' ? body.title : null;
  const artwork = typeof body.artwork_url === 'string' ? body.artwork_url : null;
  const now = Math.floor(Date.now() / 1000);

  db.query(
    `INSERT INTO subscriptions (uri, title, artwork_url, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       title = COALESCE(excluded.title, subscriptions.title),
       artwork_url = COALESCE(excluded.artwork_url, subscriptions.artwork_url)`
  ).run(body.uri, title, artwork, now);

  const row = db
    .query<
      SubscriptionRow,
      [string]
    >('SELECT uri, title, artwork_url, added_at FROM subscriptions WHERE uri = ?')
    .get(body.uri);
  return json(row, {}, 201);
}

/**
 * DELETE /subscriptions/:uri — uri is base64url-encoded in the path.
 */
export function handleSubscriptionDelete(db: Database, uri: string): Response {
  const info = db.query('DELETE FROM subscriptions WHERE uri = ?').run(uri);
  if (info.changes === 0) {
    return errorResponse(404, 'subscription not found');
  }
  return new Response(null, { status: 204 });
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
