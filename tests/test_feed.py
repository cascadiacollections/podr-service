from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

FEED = "https://feeds.example.com/show.xml"
ENVELOPE = {"status": "ok", "feed": {"title": "Show"}, "items": [{"title": "Episode 1"}]}


def upstream_query(harness, call=-1):
    request = harness.upstream.call_args_list[call].args[0]
    assert f"{request.url.scheme}://{request.url.host}{request.url.path}" == (
        "https://api.rss2json.com/v1/api.json"
    )
    return parse_qs(urlsplit(str(request.url)).query)


async def test_feed_passes_key_and_count_and_returns_envelope(harness):
    harness.env.RSS2JSON_API_KEY = "secret-key"
    harness.upstream.return_value = httpx.Response(200, json=ENVELOPE)

    response = await harness.client.get("/feed", params={"rss_url": FEED, "count": "50"})

    assert response.status_code == 200
    assert response.json() == ENVELOPE
    assert response.headers["x-cache"] == "MISS"
    assert response.headers["cache-control"] == "public, max-age=1800"
    assert response.headers["access-control-allow-origin"] == "*"
    assert upstream_query(harness) == {
        "rss_url": [FEED],
        "count": ["50"],
        "api_key": ["secret-key"],
    }


async def test_feed_cache_key_omits_the_api_key(harness):
    harness.env.RSS2JSON_API_KEY = "secret-key"
    harness.upstream.return_value = httpx.Response(200, json=ENVELOPE)

    await harness.client.get("/feed", params={"rss_url": FEED})
    await harness.runtime.drain()

    assert harness.runtime.cache
    assert all("secret-key" not in key for key in harness.runtime.cache)

    again = await harness.client.get("/feed", params={"rss_url": FEED})
    assert again.headers["x-cache"] == "HIT"
    assert harness.upstream.call_count == 1


async def test_feed_without_key_omits_count(harness):
    harness.upstream.return_value = httpx.Response(200, json=ENVELOPE)

    response = await harness.client.get("/feed", params={"rss_url": FEED, "count": "50"})

    assert response.status_code == 200
    assert upstream_query(harness) == {"rss_url": [FEED]}


async def test_feed_count_defaults_and_clamps(harness):
    harness.env.RSS2JSON_API_KEY = "k"
    harness.upstream.return_value = httpx.Response(200, json=ENVELOPE)

    await harness.client.get("/feed", params={"rss_url": FEED})
    assert upstream_query(harness)["count"] == ["300"]
    await harness.client.get("/feed", params={"rss_url": FEED + "?b", "count": "5000"})
    assert upstream_query(harness)["count"] == ["300"]


@pytest.mark.parametrize(
    "params",
    [{}, {"rss_url": ""}, {"rss_url": "ftp://x/feed"}, {"rss_url": "/relative.xml"}],
)
async def test_feed_rejects_bad_urls(harness, params):
    response = await harness.client.get("/feed", params=params)
    assert response.status_code == 400
    harness.upstream.assert_not_called()


@pytest.mark.parametrize("status", [422, 500])
async def test_feed_upstream_error_is_passed_through_without_tripping_the_circuit(harness, status):
    harness.upstream.return_value = httpx.Response(
        status, json={"status": "error", "message": "Cannot download this RSS feed"}
    )

    for _ in range(6):
        response = await harness.client.get("/feed", params={"rss_url": FEED})
        assert response.status_code == 502
        assert "Cannot download this RSS feed" in response.text

    assert harness.service.circuit.state == "closed"
    assert harness.service.circuit.failures == 0


async def test_feed_serves_stale_copy_when_upstream_fails(harness):
    harness.upstream.return_value = httpx.Response(200, json=ENVELOPE)
    await harness.client.get("/feed", params={"rss_url": FEED})
    await harness.runtime.drain()
    for entry in harness.runtime.cache.values():
        entry.stored_at -= 3600

    harness.upstream.side_effect = httpx.ConnectError("down")
    response = await harness.client.get("/feed", params={"rss_url": FEED})

    assert response.status_code == 200
    assert response.json() == ENVELOPE
    assert response.headers["x-cache"] == "HIT"


async def test_feed_unreachable_without_cache_is_502(harness):
    harness.upstream.side_effect = httpx.ConnectError("down")
    response = await harness.client.get("/feed", params={"rss_url": FEED})
    assert response.status_code == 502
