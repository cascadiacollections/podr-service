import type { Database } from 'bun:sqlite';
import type { MediaItem } from './types.ts';

export const RADIO_BROWSER_BASE =
  process.env.RADIO_BROWSER_BASE ?? 'https://de1.api.radio-browser.info';

export const STATIONS_TTL_SECONDS = Number(process.env.STATIONS_TTL_SECONDS ?? 3600);

const USER_AGENT = 'podr-service/1.0 (+https://github.com/cascadiacollections/podr-service)';

/**
 * radio-browser.info station shape (subset we consume).
 * See https://api.radio-browser.info/
 */
interface RadioBrowserStation {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
}

/**
 * Convert a radio-browser station record to the canonical MediaItem shape.
 */
export function stationToMediaItem(s: RadioBrowserStation): MediaItem {
  const uri = (s.url_resolved && s.url_resolved.length > 0 ? s.url_resolved : s.url) ?? '';
  return {
    uri,
    title: s.name || undefined,
    artist: s.name || undefined,
    artwork_url: s.favicon && s.favicon.length > 0 ? s.favicon : undefined,
    media_type: 'Stream',
  };
}

/**
 * Build a cache key for /stations/search queries.
 */
export function stationsCacheKey(q: string, genre: string, country: string): string {
  return JSON.stringify({ q, genre, country });
}

/**
 * /stations/search — proxy radio-browser.info with 1h cache.
 *
 * Returns MediaItem[] normalized from station results.
 */
export async function handleStationsSearch(
  db: Database,
  url: URL,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const genre = (url.searchParams.get('genre') ?? '').trim();
  const country = (url.searchParams.get('country') ?? '').trim();

  const key = stationsCacheKey(q, genre, country);
  const now = Math.floor(Date.now() / 1000);

  const cached = db
    .query<
      { results: string; cached_at: number },
      [string]
    >('SELECT results, cached_at FROM stations_cache WHERE query = ?')
    .get(key);

  if (cached && now - cached.cached_at < STATIONS_TTL_SECONDS) {
    return json(JSON.parse(cached.results) as MediaItem[], { 'X-Cache': 'HIT' });
  }

  const params = new URLSearchParams({
    limit: '50',
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
  });
  if (q) params.set('name', q);
  if (genre) params.set('tag', genre);
  if (country) params.set('country', country);

  const upstream = `${RADIO_BROWSER_BASE}/json/stations/search?${params.toString()}`;

  let stations: RadioBrowserStation[];
  try {
    const res = await fetchImpl(upstream, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      return errorResponse(502, `radio-browser upstream returned ${res.status}`);
    }
    stations = (await res.json()) as RadioBrowserStation[];
  } catch (err) {
    return errorResponse(502, `radio-browser fetch failed: ${(err as Error).message}`);
  }

  const items = stations.map(stationToMediaItem).filter((m) => m.uri.length > 0);

  db.query(
    'INSERT INTO stations_cache (query, results, cached_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(query) DO UPDATE SET results = excluded.results, cached_at = excluded.cached_at'
  ).run(key, JSON.stringify(items), now);

  return json(items, { 'X-Cache': 'MISS' });
}

/**
 * /stations/:id — resolve the final stream URL for a station UUID.
 *
 * Strategy:
 *   1. Look up the station via radio-browser by UUID to get its current URL.
 *   2. Issue a HEAD request following redirects to obtain the post-redirect URL.
 *   3. Strip any query string — ICY tracking params (e.g. `?aw_0_1st.collectionid=`)
 *      are not part of the audio URL the on-device decoder needs.
 *
 * We never read the audio body; the Android client (Symphonia + Oboe) does that.
 */
export async function handleStationDetail(
  _db: Database,
  uuid: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (!/^[0-9a-fA-F-]{10,64}$/.test(uuid)) {
    return errorResponse(400, 'invalid station uuid');
  }

  let stations: RadioBrowserStation[];
  try {
    const res = await fetchImpl(
      `${RADIO_BROWSER_BASE}/json/stations/byuuid/${encodeURIComponent(uuid)}`,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }
    );
    if (!res.ok) {
      return errorResponse(502, `radio-browser upstream returned ${res.status}`);
    }
    stations = (await res.json()) as RadioBrowserStation[];
  } catch (err) {
    return errorResponse(502, `radio-browser fetch failed: ${(err as Error).message}`);
  }

  const station = stations[0];
  if (!station) {
    return errorResponse(404, 'station not found');
  }

  const base = stationToMediaItem(station);
  let finalUri = base.uri;

  if (finalUri) {
    try {
      const head = await fetchImpl(finalUri, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
      });
      if (head.url) {
        finalUri = stripIcyParams(head.url);
      }
    } catch {
      // Leave finalUri as-is; the client can still try the unresolved URL.
    }
  }

  return json({ ...base, uri: finalUri });
}

/**
 * Drop the query string from a stream URL. Many radio-browser entries embed
 * ICY/tracking params we do not need; the Android client computes ICY on
 * its own connection.
 */
export function stripIcyParams(streamUrl: string): string {
  try {
    const u = new URL(streamUrl);
    u.search = '';
    return u.toString();
  } catch {
    return streamUrl;
  }
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
