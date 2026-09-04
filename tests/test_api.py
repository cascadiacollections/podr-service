import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from podr.config import GENRES


async def test_openapi_and_docs(harness):
    response = await harness.client.get("/")
    assert response.status_code == 200
    schema = response.json()
    assert schema["openapi"].startswith("3.")
    assert {
        "/",
        "/health",
        "/health/deep",
        "/podcast/{id}",
        "/related",
        "/trending",
        "/suggest",
        "/semantic-search",
    } <= schema["paths"].keys()
    assert "PodcastDetail" in schema["components"]["schemas"]
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert (await harness.client.get("/docs")).status_code == 200
    assert (await harness.client.get("/openapi.json")).json() == schema


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def test_methods(harness, method):
    response = await harness.client.request(method, "/")
    assert response.status_code == 405
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize(
    "query,error",
    [
        ({"q": "x" * 201}, "Query exceeds"),
        ({"q": "😀" * 101}, "Query exceeds"),
        ({"q": "<script>"}, "invalid characters"),
        ({"q": "javascript:alert(1)"}, "invalid characters"),
        ({"q": "onload=foo"}, "invalid characters"),
        ({"q": "x", "limit": "0"}, "Limit must"),
        ({"q": "x", "limit": "201"}, "Limit must"),
        ({"q": "x", "limit": "no"}, "Limit must"),
        ({"q": "x", "genre": "9999"}, "Invalid genre"),
        ({"q": ""}, "Missing required"),
    ],
)
async def test_validation(harness, query, error):
    response = await harness.client.get("/", params=query)
    assert response.status_code == 400
    assert error in response.text
    harness.upstream.assert_not_called()


@pytest.mark.parametrize("query", ["café & technology", "日本語", "x" * 200])
@pytest.mark.parametrize("limit", ["1", "200", "15px"])
async def test_search_contract(harness, query, limit):
    response = await harness.client.get("/", params={"q": query, "limit": limit})
    assert response.json() == harness.payload
    assert response.headers["cache-control"] == "public, max-age=86400"
    assert response.headers["x-cache"] == "MISS"
    assert response.headers["access-control-allow-origin"] == "*"
    sent = harness.upstream.call_args.args[0]
    assert sent.url.params["term"] == query
    assert sent.url.params["limit"] == ("15" if limit == "15px" else limit)
    await harness.runtime.drain()
    response = await harness.client.get("/", params={"q": query, "limit": limit})
    assert response.headers["x-cache"] == "HIT"
    assert harness.upstream.call_count == 1


@pytest.mark.parametrize("genre", list(GENRES))
async def test_top_genres(harness, genre):
    payload = {"feed": {"entry": [{"id": "42"}]}}
    harness.upstream.return_value = httpx.Response(200, json=payload)
    response = await harness.client.get("/", params={"q": "toppodcasts", "genre": genre})
    assert response.json() == payload
    assert response.headers["cache-control"] == "public, max-age=7200"
    assert f"/genre={genre}/json" in str(harness.upstream.call_args.args[0].url)


@pytest.mark.parametrize("blank_genre", ["", "   "])
async def test_top_empty_genre(harness, blank_genre):
    payload = {"feed": {"entry": [{"id": "42"}]}}
    harness.upstream.return_value = httpx.Response(200, json=payload)
    response = await harness.client.get("/", params={"q": "toppodcasts", "genre": blank_genre})
    assert response.json() == payload
    assert response.headers["cache-control"] == "public, max-age=7200"
    assert "/genre=" not in str(harness.upstream.call_args.args[0].url)


async def test_rate_limit_and_health_exemption(harness):
    harness.env.RATE_LIMITER = SimpleNamespace(limit=AsyncMock(return_value={"success": False}))
    for path in ["/", "/?q=test", "/podcast/42", "/related?id=42", "/trending"]:
        response = await harness.client.get(path, headers={"CF-Connecting-IP": "192.0.2.1"})
        assert response.status_code == 429
    harness.env.RATE_LIMITER.limit.assert_called_with({"key": "192.0.2.1"})
    health = await harness.client.get("/health")
    assert health.json()["status"] == "healthy"
    assert health.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("status", [200, 403, 503])
async def test_deep_health(harness, status):
    harness.upstream.return_value = httpx.Response(status, json={})
    response = await harness.client.get("/health/deep")
    assert response.status_code == (200 if status == 200 else 503)
    assert "latencyMs" in response.json()["upstream"]["itunes"]


async def test_network_error(harness):
    harness.upstream.side_effect = httpx.ConnectError("Connection failed")
    assert (await harness.client.get("/?q=test")).status_code == 500
    assert (await harness.client.get("/health/deep")).status_code == 503


@pytest.mark.parametrize("status", [403, 500, 503])
async def test_upstream_errors(harness, status):
    harness.upstream.return_value = httpx.Response(status)
    response = await harness.client.get("/?q=test")
    assert response.status_code == 500
    assert f"iTunes API error: {status}" in response.text
    assert harness.service.circuit.failures == 1


async def test_detail_summary_and_related(harness):
    harness.env.FLAGS.get.return_value = "true"
    podcast = {
        "wrapperType": "track",
        "kind": "podcast",
        "trackId": 42,
        "trackName": "Podr",
        "genres": ["Technology"],
        "feedUrl": "https://feed.test/rss",
    }
    episode = {"kind": "podcast-episode", "trackId": 3, "trackName": "Episode"}

    def upstream(request):
        if request.url.host == "feed.test":
            return httpx.Response(
                200,
                text="<channel><itunes:summary><![CDATA[Hello]]>"
                "</itunes:summary><item><description>Wrong</description></item>",
            )
        if request.url.path == "/lookup":
            return httpx.Response(200, json={"resultCount": 2, "results": [podcast, episode]})
        return httpx.Response(
            200,
            json={
                "resultCount": 2,
                "results": [
                    {"collectionId": 42, "collectionName": "Podr"},
                    {"collectionId": 43, "collectionName": "Other"},
                ],
            },
        )

    harness.upstream.side_effect = upstream
    response = await harness.client.get("/podcast/42?summary=true")
    assert response.json()["summary"] == "Hello"
    assert response.json()["episodes"] == [{"trackId": 3, "trackName": "Episode"}]
    assert response.json()["podcast"]["trackName"] == "Podr"
    assert "summary" not in (await harness.client.get("/podcast/42")).json()
    related = await harness.client.get("/related?id=42&limit=1")
    assert related.json() == {
        "related": [{"trackId": 43, "trackName": "Other", "genre": "Technology"}],
        "sourceId": 42,
        "matchedBy": "genre",
    }


@pytest.mark.parametrize(
    "path",
    ["/podcast/0", "/podcast/-1", "/podcast/no", "/related", "/related?id=-1", "/related?id=no"],
)
async def test_invalid_ids(harness, path):
    assert (await harness.client.get(path)).status_code == 400


async def test_missing_podcast(harness):
    harness.upstream.return_value = httpx.Response(200, json={"resultCount": 0, "results": []})
    response = await harness.client.get("/podcast/42")
    assert response.status_code == 404
    assert response.text == "Podcast not found"
    assert (await harness.client.get("/related?id=42")).json()["related"] == []


@pytest.mark.parametrize("path", ["/trending", "/suggest?q=py", "/semantic-search?q=python"])
async def test_feature_flags(harness, path):
    assert (await harness.client.get(path)).status_code == 404
    harness.env.FLAGS.get.return_value = "true"
    assert (await harness.client.get(path)).status_code == 200
    harness.env.FLAGS.get.side_effect = RuntimeError("KV unavailable")
    assert (await harness.client.get(path)).status_code == 404


async def test_semantic(harness):
    harness.env.FLAGS.get.return_value = "true"
    harness.env.AI = SimpleNamespace(run=AsyncMock(return_value={"data": [[0.1, 0.2]]}))
    harness.env.VECTORIZE = SimpleNamespace(
        query=AsyncMock(
            return_value={
                "matches": [
                    {"id": "42", "score": 0.9, "metadata": {"title": "Podr", "description": 123}}
                ]
            }
        )
    )
    response = await harness.client.get("/semantic-search?q=python&limit=99")
    assert response.json()["results"] == [{"id": "42", "score": 0.9, "title": "Podr"}]
    harness.env.VECTORIZE.query.assert_called_with(
        [0.1, 0.2], {"topK": 10, "returnMetadata": "all"}
    )
    harness.env.AI.run.side_effect = RuntimeError("AI failed")
    assert (await harness.client.get("/semantic-search?q=x")).json()["results"] == []


async def test_analytics_export(harness):
    await harness.client.get("/?q=python")
    await harness.runtime.drain()
    key, body, metadata = harness.env.ANALYTICS_LAKE.put.call_args.args
    event = json.loads(body)
    assert event["endpoint"] == "search"
    assert event["query"] == "python"
    assert event["resultCount"] == 1
    assert key.startswith("events/") and key.endswith(f"/{event['requestId']}.json")
    assert metadata["customMetadata"]["endpoint"] == "search"
    harness.env.ANALYTICS_LAKE.put.side_effect = RuntimeError("R2 failed")
    assert (await harness.client.get("/?q=other")).status_code == 200
    await harness.runtime.drain()


async def test_podcast_index(harness):
    harness.env.FLAGS.get.return_value = "true"
    harness.env.PODCAST_INDEX_KEY, harness.env.PODCAST_INDEX_SECRET = "key", "secret"
    harness.upstream.return_value = httpx.Response(
        200,
        json={
            "count": 1,
            "feeds": [
                {"id": 42, "title": "Podr", "url": "https://feed.test", "categories": {"1": "Tech"}}
            ],
        },
    )
    response = await harness.client.get("/?q=python")
    assert response.json()["results"][0]["collectionName"] == "Podr"
    request = harness.upstream.call_args.args[0]
    assert request.url.host == "api.podcastindex.org"
    assert request.headers["x-auth-key"] == "key"
    assert len(request.headers["authorization"]) == 40
