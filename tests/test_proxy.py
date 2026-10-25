import httpx
import pytest

from container_src.main import app


async def test_proxy_streaming_and_errors():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            200, content=b'{"ok":true}', headers={"content-type": "application/json"}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        app.state.client = upstream
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://container"
        ) as client:
            assert (await client.get("/health")).status_code == 200
            assert (await client.get("/")).status_code == 400
            assert (await client.get("/", params={"url": "file:///etc/passwd"})).status_code == 400
            response = await client.get("/", params={"url": "https://itunes.apple.com/search"})
            assert response.json() == {"ok": True}
            assert requests[0].headers["user-agent"].startswith("Podr/")


async def test_feed_route_parses_and_reports_errors(monkeypatch):
    import container_src.main as container

    feeds = {
        "https://feeds/ok.xml": httpx.Response(
            200,
            content=b"<rss><channel><title>T</title><item><guid>1</guid></item></channel></rss>",
        ),
        "https://feeds/missing.xml": httpx.Response(404),
        "https://feeds/huge.xml": httpx.Response(200, content=b"<rss>" + b" " * 256),
    }
    seen = []

    def handler(request):
        seen.append(request)
        return feeds[str(request.url)]

    monkeypatch.setattr(container, "FEED_MAX_BYTES", 128)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        app.state.client = upstream
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://container"
        ) as client:
            ok = await client.get("/feed", params={"url": "https://feeds/ok.xml", "count": "1"})
            assert ok.status_code == 200
            assert ok.json()["items"][0]["guid"] == "1"
            assert "application/rss+xml" in seen[0].headers["accept"]

            missing = await client.get("/feed", params={"url": "https://feeds/missing.xml"})
            assert missing.status_code == 502
            assert missing.json() == {
                "status": "error",
                "message": "Feed host returned HTTP 404",
            }

            huge = await client.get("/feed", params={"url": "https://feeds/huge.xml"})
            assert huge.status_code == 502
            assert "larger than 25 MB" in huge.json()["message"]

            for bad in (None, "file:///etc/passwd", "http://"):
                params = {"url": bad} if bad else {}
                assert (await client.get("/feed", params=params)).status_code == 400


FEED_XML = b"<rss><channel><title>T</title><item><guid>1</guid></item></channel></rss>"


async def container_client(handler):
    upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)
    app.state.client = upstream
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://container")
    return upstream, client


async def test_feed_route_conditional_get_and_upstream_metadata():
    seen = []

    def handler(request):
        seen.append(request)
        headers = {
            "etag": '"v2"',
            "last-modified": "Wed, 15 Jan 2026 12:00:00 GMT",
            "cache-control": "public, max-age=7200, s-maxage=3600",
        }
        if request.headers.get("if-none-match") == '"v2"':
            return httpx.Response(304, headers=headers)
        return httpx.Response(200, content=FEED_XML, headers=headers)

    upstream, client = await container_client(handler)
    async with upstream, client:
        fresh = await client.get("/feed", params={"url": "https://feeds/x.xml"})
        assert fresh.status_code == 200
        assert fresh.headers["x-upstream-etag"] == '"v2"'
        assert fresh.headers["x-upstream-last-modified"] == "Wed, 15 Jan 2026 12:00:00 GMT"
        # s-maxage wins: the Worker is a shared cache.
        assert fresh.headers["x-upstream-max-age"] == "3600"
        assert "if-none-match" not in seen[0].headers

        same = await client.get(
            "/feed",
            params={"url": "https://feeds/x.xml"},
            headers={
                "If-None-Match": '"v2"',
                "If-Modified-Since": "Wed, 15 Jan 2026 12:00:00 GMT",
            },
        )
        assert same.status_code == 304
        assert same.content == b""
        assert same.headers["x-upstream-etag"] == '"v2"'
        assert seen[1].headers["if-none-match"] == '"v2"'
        assert seen[1].headers["if-modified-since"] == "Wed, 15 Jan 2026 12:00:00 GMT"


@pytest.mark.parametrize(
    ("hops", "redirected"),
    [
        ([301], "https://new/feed.xml"),
        ([301, 308], "https://new/feed.xml"),
        ([302], None),
        ([301, 307], None),
        ([], None),
    ],
)
async def test_feed_route_reports_only_permanent_redirects(hops, redirected):
    chain = ["https://old/feed.xml"] + [f"https://hop{n}/feed.xml" for n in range(len(hops) - 1)]
    chain += ["https://new/feed.xml"] if hops else []

    def handler(request):
        position = chain.index(str(request.url))
        if position < len(hops):
            return httpx.Response(hops[position], headers={"location": chain[position + 1]})
        return httpx.Response(
            200, content=b'<rss><channel><item><enclosure url="a.mp3"/></item></channel></rss>'
        )

    upstream, client = await container_client(handler)
    async with upstream, client:
        response = await client.get("/feed", params={"url": "https://old/feed.xml"})

    feed = response.json()["feed"]
    assert feed["url"] == "https://old/feed.xml"
    assert feed.get("redirectedUrl") == redirected
    assert ("redirectedUrl" in feed) == (redirected is not None)
    # Relative URLs resolve against wherever the feed was finally served from.
    assert response.json()["items"][0]["enclosure"]["link"] == chain[-1].replace(
        "feed.xml", "a.mp3"
    )


@pytest.mark.parametrize(
    ("cache_control", "expected"),
    [
        ("max-age=600", 600),
        ("public, s-maxage=60, max-age=600", 60),
        ('max-age="90"', 90),
        ("no-cache", None),
        ("", None),
    ],
)
def test_upstream_max_age(cache_control, expected):
    from container_src.main import upstream_max_age

    assert upstream_max_age(cache_control) == expected
