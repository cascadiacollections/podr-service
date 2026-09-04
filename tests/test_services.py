import json
import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx

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
