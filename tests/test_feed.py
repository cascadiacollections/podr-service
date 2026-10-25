"""The /feed route end to end: the worker, the in-process container, and the parser."""

import time

import httpx
import pytest

FEED = "https://feeds.example.com/show.xml"
RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Show</title>
    <item>
      <title>Episode 1</title>
      <guid>ep-1</guid>
      <pubDate>Mon, 13 Jan 2026 12:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg" length="100"/>
      <itunes:duration>1800</itunes:duration>
    </item>
    <item>
      <title>Episode 2</title>
      <guid>ep-2</guid>
      <pubDate>Wed, 15 Jan 2026 12:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/2.mp3" type="audio/mpeg" length="200"/>
    </item>
  </channel>
</rss>"""


def serve_feed(harness, body=RSS, status=200):
    harness.upstream.return_value = httpx.Response(
        status, content=body, headers={"content-type": "application/rss+xml"}
    )


async def test_feed_returns_the_parsed_envelope(harness):
    serve_feed(harness)

    response = await harness.client.get("/feed", params={"rss_url": FEED, "count": "50"})

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["feed"]["title"] == "Show"
    assert [item["guid"] for item in data["items"]] == ["ep-2", "ep-1"]
    assert data["items"][1]["pubDate"] == "2026-01-13T12:00:00Z"
    assert data["items"][1]["enclosure"] == {
        "link": "https://cdn.example.com/1.mp3",
        "type": "audio/mpeg",
        "length": "100",
        "duration": 1800,
    }
    assert response.headers["x-cache"] == "MISS"
    assert response.headers["cache-control"] == "public, max-age=1800"
    assert response.headers["access-control-allow-origin"] == "*"
    # The feed itself is what gets fetched; no third-party converter is involved.
    request = harness.upstream.call_args.args[0]
    assert str(request.url) == FEED
    assert "rss" in request.headers["accept"]


async def test_feed_count_truncates_and_is_clamped(harness):
    serve_feed(harness)

    one = await harness.client.get("/feed", params={"rss_url": FEED, "count": "1"})
    assert [item["guid"] for item in one.json()["items"]] == ["ep-2"]

    many = await harness.client.get("/feed", params={"rss_url": FEED, "count": "5000"})
    assert len(many.json()["items"]) == 2


async def test_feed_is_cached(harness):
    serve_feed(harness)

    await harness.client.get("/feed", params={"rss_url": FEED})
    await harness.runtime.drain()
    again = await harness.client.get("/feed", params={"rss_url": FEED})

    assert again.headers["x-cache"] == "HIT"
    assert again.json()["items"][0]["guid"] == "ep-2"
    assert harness.upstream.call_count == 1


@pytest.mark.parametrize(
    "params",
    [{}, {"rss_url": ""}, {"rss_url": "ftp://x/feed"}, {"rss_url": "/relative.xml"}],
)
async def test_feed_rejects_bad_urls(harness, params):
    response = await harness.client.get("/feed", params=params)
    assert response.status_code == 400
    harness.upstream.assert_not_called()


@pytest.mark.parametrize(
    ("body", "status", "message"),
    [
        (b"not found", 404, "Feed host returned HTTP 404"),
        (b"<html><body>Not a feed</body></html>", 200, "no RSS channel"),
        (b"<rss><channel><item>", 200, "not valid XML"),
    ],
)
async def test_feed_errors_are_passed_through_without_tripping_the_circuit(
    harness, body, status, message
):
    serve_feed(harness, body, status)

    for _ in range(6):
        response = await harness.client.get("/feed", params={"rss_url": FEED})
        assert response.status_code == 502
        assert message in response.text

    assert harness.service.circuit.state == "closed"
    assert harness.service.circuit.failures == 0


async def test_feed_serves_stale_copy_when_the_feed_breaks(harness):
    serve_feed(harness)
    await harness.client.get("/feed", params={"rss_url": FEED})
    await harness.runtime.drain()
    for entry in harness.runtime.cache.values():
        entry.stored_at -= 3600

    harness.upstream.side_effect = httpx.ConnectError("down")
    response = await harness.client.get("/feed", params={"rss_url": FEED})

    assert response.status_code == 200
    assert response.json()["items"][0]["guid"] == "ep-2"
    assert response.headers["x-cache"] == "HIT"


async def test_feed_unreachable_without_cache_is_502(harness):
    harness.upstream.side_effect = httpx.ConnectError("down")
    response = await harness.client.get("/feed", params={"rss_url": FEED})
    assert response.status_code == 502
    assert "Could not download the feed" in response.text


VALIDATORS = {"etag": '"rev-1"', "last-modified": "Wed, 15 Jan 2026 12:00:00 GMT"}


def cached_entry(harness):
    (entry,) = harness.runtime.cache.values()
    return entry


async def test_feed_refetch_is_conditional_and_304_keeps_the_cached_copy(harness):
    def handler(request):
        if request.headers.get("if-none-match") == '"rev-1"':
            return httpx.Response(304, headers={"etag": '"rev-1"'})
        return httpx.Response(200, content=RSS, headers=VALIDATORS)

    harness.upstream.side_effect = handler
    first = await harness.client.get("/feed", params={"rss_url": FEED})
    await harness.runtime.drain()
    entry = cached_entry(harness)
    assert (entry.etag, entry.last_modified) == (VALIDATORS["etag"], VALIDATORS["last-modified"])

    entry.stored_at -= 3600
    again = await harness.client.get("/feed", params={"rss_url": FEED})
    await harness.runtime.drain()

    assert again.status_code == 200
    assert again.content == first.content
    assert again.headers["x-cache"] == "HIT"
    conditional = harness.upstream.call_args.args[0].headers
    assert conditional["if-none-match"] == '"rev-1"'
    assert conditional["if-modified-since"] == VALIDATORS["last-modified"]
    # The 304 restarted the copy's freshness and kept the validators it omitted.
    refreshed = cached_entry(harness)
    assert time.time() - refreshed.stored_at < 5
    assert refreshed.last_modified == VALIDATORS["last-modified"]
    assert harness.upstream.call_count == 2


async def test_feed_changed_upstream_replaces_the_cached_copy(harness):
    serve_feed(harness)
    await harness.client.get("/feed", params={"rss_url": FEED})
    await harness.runtime.drain()
    cached_entry(harness).stored_at -= 3600

    harness.upstream.return_value = httpx.Response(
        200, content=RSS.replace(b"Episode 2", b"Episode Two"), headers={"etag": '"rev-2"'}
    )
    again = await harness.client.get("/feed", params={"rss_url": FEED})
    await harness.runtime.drain()

    assert again.headers["x-cache"] == "MISS"
    assert again.json()["items"][0]["title"] == "Episode Two"
    assert cached_entry(harness).etag == '"rev-2"'


@pytest.mark.parametrize(
    ("cache_control", "ttl"),
    [(None, 1800), ("max-age=60", 1800), ("max-age=7200", 7200), ("max-age=999999", 86400)],
)
async def test_feed_ttl_honors_upstream_max_age_within_bounds(harness, cache_control, ttl):
    headers = {"cache-control": cache_control} if cache_control else {}
    harness.upstream.return_value = httpx.Response(200, content=RSS, headers=headers)

    await harness.client.get("/feed", params={"rss_url": FEED})
    await harness.runtime.drain()
    entry = cached_entry(harness)
    assert entry.ttl == ttl

    # Fresh for the whole lifetime: no refetch until it has passed.
    entry.stored_at = time.time() - ttl + 60
    assert (await harness.client.get("/feed", params={"rss_url": FEED})).headers["x-cache"] == "HIT"
    assert harness.upstream.call_count == 1


async def test_feed_reports_a_permanent_redirect(harness):
    moved = "https://new.example.com/show.xml"

    def handler(request):
        if str(request.url) == FEED:
            return httpx.Response(301, headers={"location": moved})
        return httpx.Response(200, content=RSS)

    harness.upstream.side_effect = handler
    # The harness's outbound client doesn't follow redirects; production's does.
    harness.runtime.client.follow_redirects = True

    data = (await harness.client.get("/feed", params={"rss_url": FEED})).json()

    assert data["feed"]["url"] == FEED
    assert data["feed"]["redirectedUrl"] == moved


async def test_feed_etag_answers_if_none_match_with_304(harness):
    serve_feed(harness)
    first = await harness.client.get("/feed", params={"rss_url": FEED})
    etag = first.headers["etag"]
    assert etag.startswith('W/"')

    for header in (etag, etag.removeprefix("W/"), f'"other", {etag}', "*"):
        again = await harness.client.get(
            "/feed", params={"rss_url": FEED}, headers={"If-None-Match": header}
        )
        assert again.status_code == 304, header
        assert again.content == b""
        assert again.headers["etag"] == etag
        assert again.headers["cache-control"] == "public, max-age=1800"

    stale = await harness.client.get(
        "/feed", params={"rss_url": FEED}, headers={"If-None-Match": 'W/"old"'}
    )
    assert stale.status_code == 200
    assert stale.content == first.content
    # A different count is a different body, so a different ETag.
    other = await harness.client.get("/feed", params={"rss_url": FEED, "count": "1"})
    assert other.headers["etag"] != etag
