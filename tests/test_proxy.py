import httpx

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
