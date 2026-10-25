"""Python HTTP proxy providing container egress for Apple and podcast RSS feeds.

It also converts podcast feeds to JSON (``/feed``), because parsing a large feed
takes far more CPU than the Worker's budget allows.
"""

import asyncio
import re
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
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
PERMANENT_REDIRECTS = {301, 308}
_MAX_AGE = re.compile(r"(?:^|,)\s*(s-maxage|max-age)\s*=\s*\"?(\d+)", re.I)


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


def upstream_max_age(cache_control: str) -> int | None:
    """The feed host's freshness lifetime: s-maxage (we are a shared cache), else max-age."""
    found = dict((name.lower(), int(value)) for name, value in _MAX_AGE.findall(cache_control))
    return found.get("s-maxage", found.get("max-age"))


def upstream_headers(upstream: httpx.Response) -> dict[str, str]:
    """The feed host's validators and lifetime, for the Worker to cache and send back.

    They are X-Upstream-* rather than ETag or Cache-Control because they describe
    the XML, not the JSON this route returns.
    """
    headers = {}
    for name in ("etag", "last-modified"):
        if value := upstream.headers.get(name):
            headers[f"X-Upstream-{name.title()}"] = value
    max_age = upstream_max_age(upstream.headers.get("cache-control", ""))
    if max_age is not None:
        headers["X-Upstream-Max-Age"] = str(max_age)
    return headers


def permanent_redirect(upstream: httpx.Response, requested: httpx.URL) -> str | None:
    """The final URL when every hop was a permanent redirect, so the client can
    update its subscription; temporary hops mean the old URL must stay in use."""
    hops = upstream.history
    if hops and all(hop.status_code in PERMANENT_REDIRECTS for hop in hops):
        if upstream.url != requested:
            return str(upstream.url)
    return None


@app.get("/feed")
async def feed(request: Request, url: str | None = None, count: str | None = None):
    """Download and parse a feed.

    The Worker forwards its cached copy's validators as If-None-Match and
    If-Modified-Since; they go to the feed host, and its 304 comes back as a bodiless
    304 so the Worker can keep serving the copy it already has.
    """
    if not url:
        return feed_error("Missing url parameter", 400)
    try:
        target = httpx.URL(url)
    except httpx.InvalidURL:
        return feed_error("Invalid feed URL", 400)
    if target.scheme not in {"http", "https"} or not target.host:
        return feed_error("Invalid feed URL", 400)

    client = request.app.state.client
    headers = {"User-Agent": USER_AGENT, "Accept": FEED_ACCEPT}
    for name in ("if-none-match", "if-modified-since"):
        if value := request.headers.get(name):
            headers[name] = value
    try:
        async with client.stream("GET", target, headers=headers) as upstream:
            if upstream.status_code == 304:
                return Response(status_code=304, headers=upstream_headers(upstream))
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
        envelope = await asyncio.to_thread(
            parse_feed, bytes(body), feed_count(count), url, str(upstream.url)
        )
    except FeedError as exc:
        return feed_error(str(exc), 502)
    if redirected := permanent_redirect(upstream, target):
        envelope["feed"]["redirectedUrl"] = redirected
    return JSONResponse(envelope, headers=upstream_headers(upstream))


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
