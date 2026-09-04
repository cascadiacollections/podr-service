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
