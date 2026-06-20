import type { Database } from 'bun:sqlite';
import { XMLParser } from 'fast-xml-parser';
import type { FeedResponse, MediaItem } from './types.ts';

export const FEED_TTL_SECONDS = Number(process.env.FEED_TTL_SECONDS ?? 3600);

const USER_AGENT = 'podr-service/1.0 (+https://github.com/cascadiacollections/podr-service)';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: true,
  // Always treat <item> as an array even when there is only one entry.
  isArray: (name) => name === 'item',
});

interface RawRssEnclosure {
  '@_url'?: string;
  '@_type'?: string;
  '@_length'?: string;
}

interface RawRssItem {
  title?: string | { '#text'?: string };
  guid?: string | { '#text'?: string; '@_isPermaLink'?: string };
  link?: string;
  enclosure?: RawRssEnclosure | RawRssEnclosure[];
  'itunes:image'?: { '@_href'?: string };
  'media:thumbnail'?: { '@_url'?: string };
}

interface RawRssChannel {
  title?: string | { '#text'?: string };
  link?: string;
  image?: { url?: string };
  'itunes:image'?: { '@_href'?: string };
  item?: RawRssItem[];
}

interface RawRss {
  rss?: { channel?: RawRssChannel };
}

function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length ? v : undefined;
  if (v && typeof v === 'object' && '#text' in v) {
    const t = (v as { '#text'?: unknown })['#text'];
    if (typeof t === 'string') return t.length ? t : undefined;
    if (typeof t === 'number') return String(t);
  }
  return undefined;
}

function firstEnclosure(
  e: RawRssEnclosure | RawRssEnclosure[] | undefined
): RawRssEnclosure | undefined {
  if (!e) return undefined;
  return Array.isArray(e) ? e[0] : e;
}

/**
 * Stable string GUID for an RSS item. Falls back to enclosure URL or link.
 */
export function guidOf(item: RawRssItem): string | undefined {
  const g = item.guid;
  if (typeof g === 'string') return g || undefined;
  if (g && typeof g === 'object') {
    const t = g['#text'];
    if (typeof t === 'string' && t.length > 0) return t;
  }
  const enc = firstEnclosure(item.enclosure)?.['@_url'];
  if (enc) return enc;
  if (typeof item.link === 'string' && item.link.length > 0) return item.link;
  return undefined;
}

interface ParsedFeed extends FeedResponse {
  episodes: (MediaItem & { guid?: string })[];
}

/**
 * Parse an RSS XML document into the canonical feed response shape.
 *
 * The channel artwork falls back through `<itunes:image href>` and `<image><url>`.
 * Each `<item>` becomes a Podcast MediaItem whose uri is the enclosure URL
 * (the actual audio file) — never the `<link>` to a webpage.
 */
export function parseRss(xml: string, podcastTitle?: string): ParsedFeed {
  const doc = parser.parse(xml) as RawRss;
  const channel = doc.rss?.channel;
  if (!channel) {
    return { title: podcastTitle, artwork_url: undefined, episodes: [] };
  }

  const title = textOf(channel.title) ?? podcastTitle;
  const artwork_url = channel['itunes:image']?.['@_href'] || channel.image?.url || undefined;

  const items = channel.item ?? [];
  const episodes: (MediaItem & { guid?: string })[] = [];
  for (const item of items) {
    const enc = firstEnclosure(item.enclosure);
    const uri = enc?.['@_url'];
    if (!uri) continue;
    const epArtwork =
      item['itunes:image']?.['@_href'] || item['media:thumbnail']?.['@_url'] || artwork_url;
    episodes.push({
      uri,
      title: textOf(item.title),
      artist: title,
      artwork_url: epArtwork,
      media_type: 'Podcast',
      guid: guidOf(item),
    });
  }

  return { title, artwork_url, episodes };
}

/**
 * Strip transient `guid` field before returning to clients — `guid` is not
 * part of the `MediaItem` shape (it's reachable via the dedicated episode
 * endpoint).
 */
function stripGuids(feed: ParsedFeed): FeedResponse {
  return {
    title: feed.title,
    artwork_url: feed.artwork_url,
    episodes: feed.episodes.map(({ guid: _guid, ...rest }) => rest),
  };
}

/**
 * Fetch + parse + cache an RSS feed. Returns the parsed feed including
 * per-episode guids; the public response strips guids.
 */
export async function loadFeed(
  db: Database,
  feedUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ feed: ParsedFeed; cacheStatus: 'HIT' | 'MISS' } | { error: Response }> {
  const now = Math.floor(Date.now() / 1000);

  const cached = db
    .query<
      { data: string; cached_at: number },
      [string]
    >('SELECT data, cached_at FROM feed_cache WHERE url = ?')
    .get(feedUrl);

  if (cached && now - cached.cached_at < FEED_TTL_SECONDS) {
    return { feed: JSON.parse(cached.data) as ParsedFeed, cacheStatus: 'HIT' };
  }

  let xml: string;
  try {
    const res = await fetchImpl(feedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      return { error: errorResponse(502, `feed upstream returned ${res.status}`) };
    }
    xml = await res.text();
  } catch (err) {
    return { error: errorResponse(502, `feed fetch failed: ${(err as Error).message}`) };
  }

  const feed = parseRss(xml);

  db.query(
    'INSERT INTO feed_cache (url, data, cached_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(url) DO UPDATE SET data = excluded.data, cached_at = excluded.cached_at'
  ).run(feedUrl, JSON.stringify(feed), now);

  return { feed, cacheStatus: 'MISS' };
}

/**
 * GET /feed/:url — return parsed feed (title, artwork, episodes[]).
 */
export async function handleFeed(
  db: Database,
  feedUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const result = await loadFeed(db, feedUrl, fetchImpl);
  if ('error' in result) return result.error;
  return json(stripGuids(result.feed), { 'X-Cache': result.cacheStatus });
}

/**
 * GET /feed/:url/episodes/:guid — return a single Podcast MediaItem.
 */
export async function handleFeedEpisode(
  db: Database,
  feedUrl: string,
  guid: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const result = await loadFeed(db, feedUrl, fetchImpl);
  if ('error' in result) return result.error;
  const ep = result.feed.episodes.find((e) => e.guid === guid);
  if (!ep) return errorResponse(404, 'episode not found');
  const { guid: _g, ...item } = ep;
  return json(item, { 'X-Cache': result.cacheStatus });
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
