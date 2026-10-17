"""Python HTTP proxy providing container egress for Apple and podcast RSS feeds.

It also converts podcast feeds to JSON (``/feed``), because parsing a large feed
takes far more CPU than the Worker's budget allows.
"""

import asyncio
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from starlette.background import BackgroundTask

try:
    from rss import FeedError, parse_feed
except ImportError:  # Imported as container_src.main by tests and local development.
    from container_src.rss import FeedError, parse_feed

USER_AGENT = "Podr/1.0 (+https://www.podrapp.com) podcast-search"
FEED_ACCEPT = (
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5"
)
# Radiolab, one of the largest feeds in the directory, is about 5 MB.
FEED_MAX_BYTES = 25 * 1024 * 1024
FEED_MAX_COUNT = 300


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        app.state.client = client
        yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health():
    return {"status": "healthy"}


def feed_error(message: str, status: int) -> JSONResponse:
    return JSONResponse({"status": "error", "message": message}, status_code=status)


def feed_count(value: str | None) -> int:
    try:
        return min(max(int(value), 1), FEED_MAX_COUNT) if value else FEED_MAX_COUNT
    except ValueError:
        return FEED_MAX_COUNT


@app.get("/feed")
async def feed(request: Request, url: str | None = None, count: str | None = None):
    if not url:
        return feed_error("Missing url parameter", 400)
    try:
        target = httpx.URL(url)
    except httpx.InvalidURL:
        return feed_error("Invalid feed URL", 400)
    if target.scheme not in {"http", "https"} or not target.host:
        return feed_error("Invalid feed URL", 400)

    client = request.app.state.client
    try:
        async with client.stream(
            "GET", target, headers={"User-Agent": USER_AGENT, "Accept": FEED_ACCEPT}
        ) as upstream:
            if upstream.status_code >= 400:
                return feed_error(f"Feed host returned HTTP {upstream.status_code}", 502)
            body = bytearray()
            async for chunk in upstream.aiter_bytes():
                body.extend(chunk)
                if len(body) > FEED_MAX_BYTES:
                    return feed_error("Feed is larger than 25 MB", 502)
    except (httpx.HTTPError, httpx.InvalidURL):
        return feed_error("Could not download the feed", 502)

    try:
        # A thread, so parsing a big feed doesn't stall the iTunes proxy requests
        # sharing this event loop.
        envelope = await asyncio.to_thread(parse_feed, bytes(body), feed_count(count), url)
    except FeedError as exc:
        return feed_error(str(exc), 502)
    return JSONResponse(envelope)


@app.get("/")
async def proxy(request: Request, url: str | None = None):
    if not url:
        return PlainTextResponse("Missing url parameter", status_code=400)
    try:
        target = httpx.URL(url)
        if target.scheme not in {"http", "https"} or not target.host:
            return PlainTextResponse("Invalid upstream URL", status_code=400)
        client = request.app.state.client
        upstream = await client.send(
            client.build_request(
                "GET", target, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
            ),
            stream=True,
        )
    except (httpx.HTTPError, httpx.InvalidURL):
        return PlainTextResponse("Upstream request failed", status_code=502)
    return StreamingResponse(
        upstream.aiter_bytes(),
        status_code=upstream.status_code,
        headers={"Content-Type": upstream.headers.get("content-type", "application/octet-stream")},
        background=BackgroundTask(upstream.aclose),
    )
