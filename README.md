# podr-service

Bun-based metadata, discovery, and feed-indexing API for the
[cascadiacollections](https://github.com/cascadiacollections) Rust-native
Android podcast/radio app.

The Android client owns audio: the on-device engine (Symphonia + Oboe) does
all decoding, ICY parsing, and playback. This service handles only the
non-audio control plane — search, RSS parsing, history, and subscriptions.

## What this service does **not** do

- It does **not** proxy audio streams.
- It does **not** parse ICY in-stream metadata. The Rust audio engine does that on-device.
- It does **not** transcode or re-encode audio.
- It does **not** manage playback state.

## Canonical response shape — `MediaItem`

Every endpoint that returns playable content emits this exact shape (consumed
by the Android client via UniFFI → Kotlin):

```ts
{
  uri:         string                              // direct stream or episode URL
  title?:      string
  artist?:     string                              // podcast name or station name
  artwork_url?: string
  media_type:  "Stream" | "Podcast" | "LocalFile"
}
```

See [`src/types.ts`](./src/types.ts) for the source of truth.

## Endpoints

| Method | Path                                  | Returns                                                    |
| ------ | ------------------------------------- | ---------------------------------------------------------- |
| GET    | `/health`                             | `{ "status": "ok" }`                                       |
| GET    | `/stations/search?q=&genre=&country=` | `MediaItem[]` (proxied from radio-browser.info)            |
| GET    | `/stations/:uuid`                     | Single `MediaItem` with resolved, ICY-param-stripped URI   |
| GET    | `/feed/:url`                          | `{ title, artwork_url, episodes: MediaItem[] }`            |
| GET    | `/feed/:url/episodes/:guid`           | Single Podcast `MediaItem`                                 |
| GET    | `/history`                            | `HistoryRow[]`                                             |
| POST   | `/history`                            | upsert on `uri`; increments `count`, updates `last_played` |
| GET    | `/subscriptions`                      | `SubscriptionRow[]`                                        |
| POST   | `/subscriptions`                      | upsert subscription                                        |
| DELETE | `/subscriptions/:uri`                 | remove subscription                                        |

`:url` and the `DELETE /subscriptions/:uri` path param are **base64url-encoded**
(`+→-`, `/→_`, no padding). `:guid` is `encodeURIComponent`-escaped.

`POST /history` body: `{ "uri": string, "title"?: string }`
`POST /subscriptions` body: `{ "uri": string, "title"?: string, "artwork_url"?: string }`

## Storage

A single `bun:sqlite` database (default `./data/podr.db`, override with `DB_PATH`).
Schema lives in [`migrations/0001_init.sql`](./migrations/0001_init.sql) and is
applied automatically on boot by `src/db.ts`:

- `stations_cache(query TEXT PK, results JSON, cached_at INTEGER)` — 1h TTL
- `feed_cache(url TEXT PK, data JSON, cached_at INTEGER)` — TTL via `FEED_TTL_SECONDS`
- `history(uri TEXT PK, title TEXT, last_played INTEGER, count INTEGER)`
- `subscriptions(uri TEXT PK, title TEXT, artwork_url TEXT, added_at INTEGER)`

No external DB. No Redis. In-process only.

## Configuration

See [`.env.example`](./.env.example):

| Variable               | Default                              | Purpose                      |
| ---------------------- | ------------------------------------ | ---------------------------- |
| `PORT`                 | `3000`                               | HTTP listen port             |
| `DB_PATH`              | `./data/podr.db`                     | SQLite file location         |
| `STATIONS_TTL_SECONDS` | `3600`                               | `/stations/search` cache TTL |
| `FEED_TTL_SECONDS`     | `3600`                               | `/feed/:url` cache TTL       |
| `RADIO_BROWSER_BASE`   | `https://de1.api.radio-browser.info` | radio-browser server         |

## Development

Requires [Bun](https://bun.sh/) ≥ 1.3.

```bash
bun install
bun run dev      # hot-reload server on $PORT (default 3000)
bun test
bun run lint
bun run format
bun run build    # bundles to ./dist
```

## Deploy

The service is containerized — it runs as a long-lived process alongside the
Android build pipeline, not serverlessly.

```bash
docker build -t podr-service .
docker run --rm -p 3000:3000 -v $(pwd)/data:/app/data podr-service
```

The Dockerfile uses `oven/bun:1` and copies `src/`, `migrations/`, and
production `node_modules` only. A `/health` HEALTHCHECK is wired up.

## License

MIT — see [LICENSE](./LICENSE).
