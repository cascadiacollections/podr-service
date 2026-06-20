import { describe, test, expect, beforeEach } from 'bun:test';
import { openDatabase } from '../src/db.ts';
import { handleRequest } from '../src/router.ts';
import { encodeUrlToBase64Url, decodeBase64UrlToUrl } from '../src/encoding.ts';
import { parseRss, guidOf } from '../src/feed.ts';
import { stationToMediaItem, stripIcyParams } from '../src/stations.ts';
import type { Database } from 'bun:sqlite';

function makeDb(): Database {
  return openDatabase(':memory:');
}

// Mock fetch builder: returns a function that responds based on URL prefix.
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(routes: Route[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const r of routes) {
      const out = await r(url, init);
      if (out) return out;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('encoding', () => {
  test('round-trips https URLs through base64url', () => {
    const url = 'https://example.com/feed.xml?x=1&y=2';
    const enc = encodeUrlToBase64Url(url);
    expect(enc).not.toContain('+');
    expect(enc).not.toContain('/');
    expect(enc).not.toContain('=');
    expect(decodeBase64UrlToUrl(enc)).toBe(url);
  });

  test('rejects non-http URLs', () => {
    expect(decodeBase64UrlToUrl(encodeUrlToBase64Url('file:///etc/passwd'))).toBeNull();
  });

  test('rejects malformed base64', () => {
    expect(decodeBase64UrlToUrl('!!!not base64!!!')).toBeNull();
  });
});

describe('stripIcyParams', () => {
  test('removes query string', () => {
    expect(stripIcyParams('http://stream.example.com/live?aw_0_1st.collectionid=123')).toBe(
      'http://stream.example.com/live'
    );
  });
  test('passes through urls without query', () => {
    expect(stripIcyParams('http://stream.example.com/live')).toBe('http://stream.example.com/live');
  });
});

describe('stationToMediaItem', () => {
  test('prefers url_resolved over url and maps to Stream', () => {
    const item = stationToMediaItem({
      stationuuid: 'abc',
      name: 'KEXP',
      url: 'http://kexp.example/old',
      url_resolved: 'http://kexp.example/resolved',
      favicon: 'http://kexp.example/icon.png',
    });
    expect(item).toEqual({
      uri: 'http://kexp.example/resolved',
      title: 'KEXP',
      artist: 'KEXP',
      artwork_url: 'http://kexp.example/icon.png',
      media_type: 'Stream',
    });
  });
});

describe('parseRss', () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>My Show</title>
    <itunes:image href="http://show.example/art.png" />
    <item>
      <title>Episode 1</title>
      <guid>ep-1</guid>
      <enclosure url="http://show.example/ep1.mp3" length="123" type="audio/mpeg" />
    </item>
    <item>
      <title>Episode 2</title>
      <guid isPermaLink="false">ep-2</guid>
      <enclosure url="http://show.example/ep2.mp3" length="456" type="audio/mpeg" />
    </item>
    <item>
      <title>No enclosure</title>
      <guid>ep-3</guid>
    </item>
  </channel>
</rss>`;

  test('extracts title, artwork, and episodes as MediaItem[]', () => {
    const feed = parseRss(xml);
    expect(feed.title).toBe('My Show');
    expect(feed.artwork_url).toBe('http://show.example/art.png');
    expect(feed.episodes.length).toBe(2); // item without enclosure is skipped
    expect(feed.episodes[0]).toEqual({
      uri: 'http://show.example/ep1.mp3',
      title: 'Episode 1',
      artist: 'My Show',
      artwork_url: 'http://show.example/art.png',
      media_type: 'Podcast',
      guid: 'ep-1',
    });
    expect(feed.episodes[1]!.guid).toBe('ep-2');
  });

  test('guidOf falls back to enclosure url', () => {
    expect(guidOf({ enclosure: { '@_url': 'http://x/y.mp3' } })).toBe('http://x/y.mp3');
  });

  test('handles single-item feeds (item arrayification)', () => {
    const single = `<?xml version="1.0"?><rss><channel><title>Solo</title>
      <item><title>Only</title><guid>g</guid>
        <enclosure url="http://x/only.mp3" type="audio/mpeg" length="1"/>
      </item></channel></rss>`;
    const feed = parseRss(single);
    expect(feed.episodes.length).toBe(1);
    expect(feed.episodes[0]!.uri).toBe('http://x/only.mp3');
  });
});

describe('/health', () => {
  test('returns ok', async () => {
    const db = makeDb();
    const res = await handleRequest(db, new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('/stations/search', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  test('proxies radio-browser and normalizes to MediaItem[]', async () => {
    const f = mockFetch([
      (url) => {
        if (url.includes('/json/stations/search')) {
          return jsonResponse([
            {
              stationuuid: 's1',
              name: 'KEXP',
              url: 'http://kexp/stream',
              url_resolved: 'http://kexp/resolved',
              favicon: 'http://kexp/icon.png',
            },
            {
              stationuuid: 's2',
              name: 'NoUri',
              url: '',
            },
          ]);
        }
        return new Response('not found', { status: 404 });
      },
    ]);
    const res = await handleRequest(db, new Request('http://localhost/stations/search?q=kexp'), f);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('MISS');
    const body = (await res.json()) as Array<{ uri: string; media_type: string }>;
    expect(body.length).toBe(1); // empty-uri entry filtered
    expect(body[0]!.media_type).toBe('Stream');
    expect(body[0]!.uri).toBe('http://kexp/resolved');
  });

  test('second call hits the SQLite cache', async () => {
    let calls = 0;
    const f = mockFetch([
      (url) => {
        if (url.includes('/json/stations/search')) {
          calls++;
          return jsonResponse([{ stationuuid: 's1', name: 'KEXP', url: 'http://kexp/stream' }]);
        }
        return new Response('', { status: 404 });
      },
    ]);
    await handleRequest(db, new Request('http://localhost/stations/search?q=kexp'), f);
    const second = await handleRequest(
      db,
      new Request('http://localhost/stations/search?q=kexp'),
      f
    );
    expect(calls).toBe(1);
    expect(second.headers.get('X-Cache')).toBe('HIT');
  });

  test('502 on upstream failure', async () => {
    const f = mockFetch([() => new Response('boom', { status: 500 })]);
    const res = await handleRequest(db, new Request('http://localhost/stations/search?q=x'), f);
    expect(res.status).toBe(502);
  });
});

describe('/stations/:id', () => {
  test('resolves stream and strips ICY query params', async () => {
    const db = makeDb();
    const uuid = '11111111-2222-3333-4444-555555555555';
    const f = mockFetch([
      (url, init) => {
        if (url.includes('/json/stations/byuuid/')) {
          return jsonResponse([
            {
              stationuuid: uuid,
              name: 'KEXP',
              url: 'http://kexp.example/stream',
              url_resolved: 'http://kexp.example/stream',
            },
          ]);
        }
        if (url.startsWith('http://kexp.example/') && init?.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { Location: 'http://kexp.example/final?aw_0_1st.collectionid=123' },
            // Bun fetch with redirect:'follow' will surface final URL in res.url
          });
        }
        return new Response('', { status: 404 });
      },
    ]);
    // Bun's Response doesn't expose a settable `url`, so HEAD's res.url will be the requested url;
    // ensure handler at minimum strips query from whatever url is returned.
    const res = await handleRequest(db, new Request(`http://localhost/stations/${uuid}`), f);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uri: string; media_type: string };
    expect(body.media_type).toBe('Stream');
    // No query string regardless of redirect behavior in the mock.
    expect(body.uri.includes('?')).toBe(false);
  });

  test('404 for unknown uuid', async () => {
    const db = makeDb();
    const f = mockFetch([() => jsonResponse([])]);
    const res = await handleRequest(
      db,
      new Request('http://localhost/stations/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      f
    );
    expect(res.status).toBe(404);
  });

  test('400 for invalid uuid format', async () => {
    const db = makeDb();
    const res = await handleRequest(
      db,
      new Request('http://localhost/stations/not-a-uuid!'),
      mockFetch([])
    );
    expect(res.status).toBe(400);
  });
});

describe('/feed/:url', () => {
  const feedUrl = 'http://show.example/feed.xml';
  const feedXml = `<?xml version="1.0"?>
    <rss><channel><title>Show</title>
      <itunes:image href="http://show.example/art.png" xmlns:itunes="http://x"/>
      <item><title>E1</title><guid>ep-1</guid>
        <enclosure url="http://show.example/ep1.mp3" type="audio/mpeg" length="1"/>
      </item>
    </channel></rss>`;

  test('parses and caches feed; returns MediaItem-shaped episodes', async () => {
    const db = makeDb();
    let calls = 0;
    const f = mockFetch([
      (url) => {
        if (url === feedUrl) {
          calls++;
          return new Response(feedXml, {
            status: 200,
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }
        return new Response('', { status: 404 });
      },
    ]);
    const enc = encodeUrlToBase64Url(feedUrl);
    const res1 = await handleRequest(db, new Request(`http://localhost/feed/${enc}`), f);
    expect(res1.status).toBe(200);
    expect(res1.headers.get('X-Cache')).toBe('MISS');
    const body1 = (await res1.json()) as {
      title: string;
      artwork_url: string;
      episodes: Array<{ uri: string; media_type: string; guid?: string }>;
    };
    expect(body1.title).toBe('Show');
    expect(body1.episodes[0]!.media_type).toBe('Podcast');
    expect(body1.episodes[0]!.uri).toBe('http://show.example/ep1.mp3');
    // public response strips guids
    expect('guid' in body1.episodes[0]!).toBe(false);

    const res2 = await handleRequest(db, new Request(`http://localhost/feed/${enc}`), f);
    expect(res2.headers.get('X-Cache')).toBe('HIT');
    expect(calls).toBe(1);
  });

  test('400 on bad base64', async () => {
    const db = makeDb();
    const res = await handleRequest(
      db,
      new Request('http://localhost/feed/not-base64!'),
      mockFetch([])
    );
    expect(res.status).toBe(400);
  });

  test('episode lookup by guid returns a single MediaItem', async () => {
    const db = makeDb();
    const f = mockFetch([
      (url) => (url === feedUrl ? new Response(feedXml) : new Response('', { status: 404 })),
    ]);
    const enc = encodeUrlToBase64Url(feedUrl);
    const res = await handleRequest(
      db,
      new Request(`http://localhost/feed/${enc}/episodes/ep-1`),
      f
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uri: string; media_type: string };
    expect(body.uri).toBe('http://show.example/ep1.mp3');
    expect(body.media_type).toBe('Podcast');
    expect('guid' in body).toBe(false);
  });

  test('episode lookup with unknown guid returns 404', async () => {
    const db = makeDb();
    const f = mockFetch([
      (url) => (url === feedUrl ? new Response(feedXml) : new Response('', { status: 404 })),
    ]);
    const enc = encodeUrlToBase64Url(feedUrl);
    const res = await handleRequest(
      db,
      new Request(`http://localhost/feed/${enc}/episodes/nope`),
      f
    );
    expect(res.status).toBe(404);
  });
});

describe('/history', () => {
  test('POST upserts and increments count on repeat', async () => {
    const db = makeDb();
    const post1 = await handleRequest(
      db,
      new Request('http://localhost/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: 'http://x/y.mp3', title: 'A' }),
      })
    );
    expect(post1.status).toBe(200);
    const row1 = (await post1.json()) as { count: number; title: string; last_played: number };
    expect(row1.count).toBe(1);
    expect(row1.title).toBe('A');

    const post2 = await handleRequest(
      db,
      new Request('http://localhost/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: 'http://x/y.mp3' }),
      })
    );
    const row2 = (await post2.json()) as { count: number; title: string };
    expect(row2.count).toBe(2);
    expect(row2.title).toBe('A'); // preserved

    const get = await handleRequest(db, new Request('http://localhost/history'));
    const list = (await get.json()) as Array<{ uri: string; count: number }>;
    expect(list.length).toBe(1);
    expect(list[0]!.count).toBe(2);
  });

  test('400 when uri missing', async () => {
    const db = makeDb();
    const res = await handleRequest(
      db,
      new Request('http://localhost/history', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(400);
  });

  test('405 on PUT', async () => {
    const db = makeDb();
    const res = await handleRequest(db, new Request('http://localhost/history', { method: 'PUT' }));
    expect(res.status).toBe(405);
  });
});

describe('/subscriptions', () => {
  test('POST then GET then DELETE flow', async () => {
    const db = makeDb();
    const uri = 'http://show.example/feed.xml';

    const post = await handleRequest(
      db,
      new Request('http://localhost/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri, title: 'Show', artwork_url: 'http://art' }),
      })
    );
    expect(post.status).toBe(201);

    const get = await handleRequest(db, new Request('http://localhost/subscriptions'));
    const list = (await get.json()) as Array<{ uri: string }>;
    expect(list.length).toBe(1);
    expect(list[0]!.uri).toBe(uri);

    const enc = encodeUrlToBase64Url(uri);
    const del = await handleRequest(
      db,
      new Request(`http://localhost/subscriptions/${enc}`, { method: 'DELETE' })
    );
    expect(del.status).toBe(204);

    const get2 = await handleRequest(db, new Request('http://localhost/subscriptions'));
    expect(((await get2.json()) as unknown[]).length).toBe(0);
  });

  test('DELETE on unknown subscription returns 404', async () => {
    const db = makeDb();
    const enc = encodeUrlToBase64Url('http://nope/feed.xml');
    const res = await handleRequest(
      db,
      new Request(`http://localhost/subscriptions/${enc}`, { method: 'DELETE' })
    );
    expect(res.status).toBe(404);
  });
});

describe('routing fallback', () => {
  test('unknown route → 404', async () => {
    const db = makeDb();
    const res = await handleRequest(db, new Request('http://localhost/nope'));
    expect(res.status).toBe(404);
  });

  test('CORS preflight returns 204 with allow headers', async () => {
    const db = makeDb();
    const res = await handleRequest(
      db,
      new Request('http://localhost/history', { method: 'OPTIONS' })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('MediaItem shape conformance', () => {
  test('every Stream and Podcast response carries the required fields', async () => {
    const db = makeDb();
    const f = mockFetch([
      (url) => {
        if (url.includes('/json/stations/search')) {
          return jsonResponse([{ stationuuid: 's', name: 'X', url: 'http://x/s' }]);
        }
        return new Response('', { status: 404 });
      },
    ]);
    const res = await handleRequest(db, new Request('http://localhost/stations/search?q=x'), f);
    const items = (await res.json()) as Array<Record<string, unknown>>;
    for (const item of items) {
      expect(typeof item.uri).toBe('string');
      expect(typeof item.media_type).toBe('string');
      expect(['Stream', 'Podcast', 'LocalFile']).toContain(item.media_type as string);
    }
  });
});
