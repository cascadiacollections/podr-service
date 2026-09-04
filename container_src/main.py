"""Python HTTP proxy providing container egress for Apple and podcast RSS feeds."""

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse, StreamingResponse
from starlette.background import BackgroundTask

USER_AGENT = "Podr/1.0 (+https://www.podrapp.com) podcast-search"


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        app.state.client = client
        yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health():
    return {"status": "healthy"}


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
