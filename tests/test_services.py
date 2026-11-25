import asyncio
import json
import logging
import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from podr.analytics import Analytics
from podr.config import TTL_SEARCH
from podr.runtime import CacheEntry, FetchResult, Runtime


async def test_stale_revalidation_and_circuit_recovery(harness):
    url = "https://itunes.apple.com/search?media=podcast&term=python&limit=15"
    old = {"resultCount": 0, "results": []}
    harness.runtime.cache[url] = CacheEntry(
        FetchResult(json.dumps(old)), time.time() - TTL_SEARCH - 10, TTL_SEARCH
    )
    response = await harness.client.get("/?q=python")
    assert response.json() == old
    assert response.headers["x-cache"] == "HIT"
    await harness.runtime.drain()
    assert (await harness.client.get("/?q=python")).json() == harness.payload
    harness.service.circuit.state = "open"
    harness.service.circuit.last_failure = time.time()
    assert (await harness.client.get("/?q=python")).status_code == 200
    assert (await harness.client.get("/?q=uncached")).status_code == 500
    harness.service.circuit.last_failure -= 31
    assert (await harness.client.get("/?q=uncached")).status_code == 200
    assert harness.service.circuit.state == "closed"


async def test_five_failures_open_circuit(harness):
    harness.upstream.return_value = httpx.Response(503)
    for _ in range(6):
        assert (await harness.client.get("/?q=python")).status_code == 500
    assert harness.upstream.call_count == 5
    assert harness.service.circuit.state == "open"


async def test_rss_description_failures_leave_search_working(harness, caplog):
    """Broken publisher feeds must not rest iTunes or be labelled as its outage."""
    harness.env.FLAGS.get.return_value = "true"
    podcast = {
        "wrapperType": "track",
        "kind": "podcast",
        "trackId": 42,
        "trackName": "Podr",
        "feedUrl": "https://feed.test/rss",
    }
    feed_failures = [
        httpx.Response(404, text="missing"),
        httpx.Response(500, text="down"),
        httpx.Response(503, text="down"),
        httpx.ConnectError("timed out"),
        httpx.ReadTimeout("timed out"),
        httpx.Response(502, text="bad gateway"),
    ]

    def upstream(request):
        if request.url.host == "feed.test":
            outcome = feed_failures.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        if request.url.path == "/lookup":
            return httpx.Response(200, json={"results": [podcast]})
        return httpx.Response(200, json=harness.payload)

    harness.upstream.side_effect = upstream
    with caplog.at_level(logging.WARNING):
        for _ in range(6):
            response = await harness.client.get("/podcast/42?summary=true")
            assert response.status_code == 200
            assert "summary" not in response.json()

    assert feed_failures == []
    assert harness.service.circuit.state == "closed"
    assert harness.service.circuit.failures == 0
    assert "iTunes API error" not in caplog.text
    assert "Podcast Index" not in caplog.text
    assert "Feed error: 404" in caplog.text

    search = await harness.client.get("/?q=python")
    assert search.status_code == 200
    assert search.json() == harness.payload
    assert harness.service.circuit.state == "closed"


async def test_rss_description_does_not_clear_or_close_the_breaker(harness):
    circuit = harness.service.circuit
    circuit.failures = 4
    harness.upstream.return_value = httpx.Response(
        200, text="<channel><description>Hi there</description></channel>"
    )
    assert await harness.service.rss_description("https://feed.test/rss") == "Hi there"
    assert circuit.failures == 4
    assert circuit.state == "closed"

    circuit.state = "open"
    circuit.last_failure = time.time()
    assert await harness.service.rss_description("https://feed.test/other") == "Hi there"
    assert circuit.state == "open"
    assert circuit.failures == 4
    assert (await harness.client.get("/?q=python")).status_code == 500


async def test_half_open_admits_one_probe(harness):
    circuit = harness.service.circuit
    circuit.failures = 5
    circuit.state = "open"
    circuit.last_failure = time.time() - 31

    started = asyncio.Event()
    release = asyncio.Event()
    fetches = 0
    original = harness.runtime.fetch

    async def fetch(url, **kwargs):
        nonlocal fetches
        fetches += 1
        started.set()
        await release.wait()
        return await original(url, **kwargs)

    harness.runtime.fetch = fetch
    probe = asyncio.create_task(harness.client.get("/?q=probe"))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        assert circuit.state == "half-open"
        blocked = asyncio.create_task(harness.client.get("/?q=other"))
        blocked_response = await asyncio.wait_for(blocked, timeout=2)
        assert fetches == 1
        assert blocked_response.status_code == 500
        assert blocked_response.text == "Service temporarily unavailable"
    finally:
        release.set()
    probe_response = await asyncio.wait_for(probe, timeout=2)
    assert probe_response.status_code == 200
    assert circuit.state == "closed"
    assert (await harness.client.get("/?q=later")).status_code == 200
    assert fetches == 2


async def test_failed_probe_reopens_the_breaker(harness):
    circuit = harness.service.circuit
    circuit.failures = 5
    circuit.state = "open"
    circuit.last_failure = time.time() - 31
    harness.upstream.return_value = httpx.Response(503)

    probe = await harness.client.get("/?q=probe")
    assert probe.status_code == 500
    assert "iTunes API error: 503" in probe.text
    assert circuit.state == "open"
    assert harness.upstream.call_count == 1

    blocked = await harness.client.get("/?q=other")
    assert blocked.status_code == 500
    assert blocked.text == "Service temporarily unavailable"
    assert harness.upstream.call_count == 1


async def test_fresh_cache_hit_does_not_consume_the_probe(harness):
    url = "https://itunes.apple.com/search?media=podcast&term=python&limit=15"
    harness.runtime.cache[url] = CacheEntry(
        FetchResult(json.dumps(harness.payload)), time.time(), TTL_SEARCH
    )
    circuit = harness.service.circuit
    circuit.failures = 5
    circuit.state = "open"
    circuit.last_failure = time.time() - 31

    hit = await harness.client.get("/?q=python")
    assert hit.status_code == 200
    assert hit.headers["x-cache"] == "HIT"
    assert circuit.state == "open"
    harness.upstream.assert_not_called()

    recovered = await harness.client.get("/?q=other")
    assert recovered.status_code == 200
    assert circuit.state == "closed"
    harness.upstream.assert_called_once()


async def test_cancelled_probe_does_not_stick_half_open(harness):
    circuit = harness.service.circuit
    circuit.failures = 5
    circuit.state = "open"
    circuit.last_failure = time.time() - 31
    started = asyncio.Event()

    async def hang(url, **kwargs):
        started.set()
        await asyncio.Event().wait()

    harness.runtime.fetch = hang
    task = asyncio.create_task(
        harness.service.upstream.get("https://itunes.apple.com/search?q=1", 10)
    )
    await asyncio.wait_for(started.wait(), timeout=2)
    assert circuit.state == "half-open"
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert circuit.state == "open"

    harness.runtime.fetch = AsyncMock(return_value=FetchResult('{"resultCount":0,"results":[]}'))
    response, hit = await harness.service.upstream.get("https://itunes.apple.com/search?q=2", 10)
    assert hit is False
    assert response.json()["resultCount"] == 0
    assert circuit.state == "closed"


async def test_expired_stale_entry_is_not_served(harness):
    url = "https://itunes.apple.com/search?media=podcast&term=python&limit=15"
    harness.runtime.cache[url] = CacheEntry(FetchResult('{"results":[]}'), 0, TTL_SEARCH)
    response = await harness.client.get("/?q=python")
    assert response.json() == harness.payload
    assert response.headers["x-cache"] == "MISS"


async def test_scheduled_warming(harness):
    harness.service.analytics.trending = AsyncMock(
        return_value=[{"query_normalized": "python", "total_count": 5}]
    )
    result = await harness.service.warm()
    assert result == {"totalQueries": 1, "successCount": 1, "failureCount": 0}
    assert harness.upstream.call_args.args[0].url.params["limit"] == "25"
    harness.service.analytics.trending.return_value = []
    result = await harness.service.warm()
    assert result["totalQueries"] == 10
    harness.upstream.side_effect = httpx.ConnectError("offline")
    harness.service.analytics.trending.return_value = [{"query_normalized": "new"}]
    assert (await harness.service.warm())["failureCount"] == 1


class Database:
    def __init__(self, connection):
        self.connection = connection

    def prepare(self, sql):
        return Statement(self.connection, sql)


class Statement:
    def __init__(self, connection, sql):
        self.connection, self.sql, self.params = connection, sql, ()

    def bind(self, *params):
        self.params = params
        return self

    async def all(self):
        return {"results": [dict(row) for row in self.connection.execute(self.sql, self.params)]}

    async def run(self):
        self.connection.execute(self.sql, self.params)
        return {"success": True}


async def test_real_sql_migrations_tracking_and_geo_fallback(harness):
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    migrations = sorted(Path("migrations").glob("*.sql"))
    for migration in migrations[:2]:
        connection.executescript(migration.read_text())
    connection.execute(
        "INSERT INTO search_queries (query_hash,query_normalized,date) "
        "VALUES ('old', 'old query', '2020-01-01')"
    )
    connection.executescript(migrations[2].read_text())
    assert connection.execute("SELECT country FROM search_queries").fetchone()[0] == ""
    harness.env.DB = Database(connection)
    analytics = harness.service.analytics
    await analytics.track_query("  Python   podcasts ", "us")
    await analytics.track_query("python podcasts", "us")
    await analytics.track_query("python podcasts", "gb")
    await analytics.track_query("python podcasts")
    await analytics.track_query("py tools", "us")
    assert (await analytics.trending(10, "US"))[0]["total_count"] == 2
    assert (await analytics.trending(10, "ZZ"))[0]["total_count"] == 4
    assert await analytics.suggestions("PY", 1) == ["python podcasts"]
    harness.env.FLAGS.get.return_value = "true"
    response = await harness.client.get("/trending?country=us&limit=1")
    assert response.json()["country"] == "US"
    assert response.json()["trending"] == [{"query": "python podcasts", "count": 2}]
    assert (await harness.client.get("/trending?country=USA")).json()["country"] == "global"
    assert (await harness.client.get("/suggest?q=py&limit=1")).json()["suggestions"] == [
        "python podcasts"
    ]
    assert (await harness.client.get("/suggest?q=p")).json()["suggestions"] == []
    connection.close()


async def test_binding_failures_are_best_effort():
    db = SimpleNamespace(prepare=lambda _: (_ for _ in ()).throw(RuntimeError("offline")))
    analytics = Analytics(Runtime(SimpleNamespace(DB=db)))
    assert await analytics.trending() == []
    assert await analytics.suggestions("py", 5) == []
    await analytics.track_query("python")


async def test_rss_stops_reading_at_first_episode(harness):
    class Feed(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"<channel><description>Channel summary</description><it"
            yield b"em>"
            raise AssertionError("Episode payload must not be consumed")

    harness.upstream.return_value = httpx.Response(200, stream=Feed())
    assert await harness.service.rss_description("https://feed.test/rss") == "Channel summary"
