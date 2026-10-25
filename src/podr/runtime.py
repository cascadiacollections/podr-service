"""Runtime boundary: native Python locally, Workers bindings in production."""

import asyncio
import codecs
import json
import logging
import time
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from podr.config import UPSTREAM_HEADERS

logger = logging.getLogger("podr")
# The container's /feed route reports the feed host's validators and lifetime in
# these (container_src/main.py); container_get keeps them, lowercased.
UPSTREAM_META = ("x-upstream-etag", "x-upstream-last-modified", "x-upstream-max-age")


@dataclass
class FetchResult:
    body: str
    status: int = 200
    reason: str = "OK"
    content_type: str = "application/json"
    headers: dict[str, str] = field(default_factory=dict)

    def json(self) -> Any:
        return json.loads(self.body)


@dataclass
class CacheEntry:
    response: FetchResult
    stored_at: float
    ttl: int
    # The upstream feed's validators, for a conditional refetch.
    etag: str = ""
    last_modified: str = ""


class Runtime:
    """Local runtime. Optional cloud features are disabled unless bindings are supplied."""

    def __init__(self, env=None, *, client: httpx.AsyncClient | None = None):
        self.env = env
        self.client = client
        self.cache: dict[str, CacheEntry] = {}
        self.tasks: set[asyncio.Task] = set()

    def binding(self, name: str):
        if isinstance(self.env, dict):
            return self.env.get(name)
        return getattr(self.env, name, None) if self.env is not None else None

    def options(self, value):
        return value

    def native(self, value):
        return value

    async def fetch(self, url: str, *, proxy=True, headers=None, header_only=False) -> FetchResult:
        request_headers = {**UPSTREAM_HEADERS, **(headers or {})}

        async def consume(client):
            async with client.stream("GET", url, headers=request_headers) as response:
                chunks = []
                length = 0
                async for chunk in response.aiter_text():
                    chunks.append(chunk)
                    length += len(chunk)
                    if header_only and ("<item>" in "".join(chunks[-2:]) or length >= 1_048_576):
                        break
                body = "".join(chunks)
                if header_only:
                    body = body.split("<item>", 1)[0][:1_048_576]
                return FetchResult(
                    body,
                    response.status_code,
                    response.reason_phrase,
                    response.headers.get("content-type", "application/json"),
                )

        if self.client is not None:
            return await consume(self.client)
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            return await consume(client)

    async def container_get(self, path: str, params: dict, headers=None) -> FetchResult:
        """GET a route on the container app (container_src/main.py).

        Locally the app runs in-process, so development and tests exercise the same
        code the container deploys. The import is deferred because the Workers
        bundle doesn't include container_src.
        """
        from container_src.main import app

        async def call(upstream):
            app.state.client = upstream
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://container"
            ) as container:
                response = await container.get(path, params=params, headers=headers)
            return FetchResult(
                response.text,
                response.status_code,
                response.reason_phrase,
                response.headers.get("content-type", "application/json"),
                {name: value for name in UPSTREAM_META if (value := response.headers.get(name))},
            )

        if self.client is not None:
            return await call(self.client)
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as upstream:
            return await call(upstream)

    async def cache_get(self, key: str) -> CacheEntry | None:
        return self.cache.get(key)

    async def cache_put(self, key: str, entry: CacheEntry, retention: int):
        # Bound local-development memory; production uses the Workers Cache API.
        if len(self.cache) >= 512 and key not in self.cache:
            del self.cache[next(iter(self.cache))]
        self.cache[key] = entry

    def defer(self, work: Awaitable):
        task = asyncio.create_task(self._guard(work))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _guard(self, work):
        try:
            await work
        except Exception:
            logger.exception("Background operation failed")

    async def drain(self):
        while self.tasks:
            await asyncio.gather(*list(self.tasks))

    async def flag(self, name: str) -> bool:
        flags = self.binding("FLAGS")
        if flags is None:
            return False
        try:
            return await flags.get(f"flag:{name}") == "true"
        except Exception:
            logger.warning("Feature flag unavailable: %s", name)
            return False

    async def rate_allowed(self, ip: str) -> bool:
        limiter = self.binding("RATE_LIMITER")
        if limiter is None:
            return True
        result = self.native(await limiter.limit(self.options({"key": ip})))
        return bool(result["success"])


class CloudflareRuntime(Runtime):
    """Keep all JavaScript interoperability out of application and service modules."""

    def __init__(self, env, ctx):
        super().__init__(env)
        self.ctx = ctx

    def options(self, value):
        from js import JSON

        return JSON.parse(json.dumps(value))

    def native(self, value):
        if isinstance(value, (dict, list, str, int, float, bool)) or value is None:
            return value
        from js import JSON

        return json.loads(JSON.stringify(value))

    async def fetch(self, url: str, *, proxy=True, headers=None, header_only=False) -> FetchResult:
        from js import AbortSignal
        from workers import fetch

        stub = self._proxy_stub() if proxy else None
        headers = {**UPSTREAM_HEADERS, **(headers or {})}
        signal = AbortSignal.timeout(30_000)
        if stub is not None:
            response = await stub.fetch(
                f"http://container/?url={quote(url, safe='')}", headers=headers, signal=signal
            )
        else:
            response = await fetch(url, headers=headers, signal=signal)
        if header_only and response.body:
            reader = response.body.getReader()
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            body = ""
            try:
                while len(body) < 1_048_576:
                    chunk = await reader.read()
                    if chunk.done:
                        body += decoder.decode(b"", final=True)
                        break
                    body += decoder.decode(bytes(chunk.value.to_py()))
                    if "<item>" in body:
                        break
            finally:
                await reader.cancel()
            body = body.split("<item>", 1)[0][:1_048_576]
        else:
            body = await response.text()
        return FetchResult(
            body,
            response.status,
            response.status_text,
            response.headers.get("content-type") or "application/json",
        )

    def _proxy_stub(self):
        binding = self.binding("ITUNES_PROXY")
        return binding.get(binding.idFromName("itunes-proxy")) if binding is not None else None

    async def container_get(self, path: str, params: dict, headers=None) -> FetchResult:
        from js import AbortSignal

        stub = self._proxy_stub()
        if stub is None:
            raise RuntimeError("The ITUNES_PROXY container binding is not configured")
        # Longer than fetch()'s timeout: this covers a possible container cold start
        # (up to about 15 s), the upstream download, and parsing.
        response = await stub.fetch(
            f"http://container{path}?{urlencode(params)}",
            headers={**UPSTREAM_HEADERS, **(headers or {})},
            signal=AbortSignal.timeout(60_000),
        )
        return FetchResult(
            await response.text(),
            response.status,
            response.status_text,
            response.headers.get("content-type") or "application/json",
            {name: value for name in UPSTREAM_META if (value := response.headers.get(name))},
        )

    async def cache_get(self, key: str) -> CacheEntry | None:
        from js import caches

        response = await caches.default.match(key)
        if not response:
            return None
        stored = response.headers.get("x-podr-stored-at")
        # Old TS cache entries have no timestamp; use their remaining runtime TTL.
        stored_at = float(stored) if stored else time.time()
        ttl = int(response.headers.get("x-podr-ttl") or "0")
        return CacheEntry(
            FetchResult(
                await response.text(),
                response.status,
                response.statusText,
                response.headers.get("content-type") or "application/json",
            ),
            stored_at,
            ttl,
            response.headers.get("x-podr-etag") or "",
            response.headers.get("x-podr-last-modified") or "",
        )

    async def cache_put(self, key: str, entry: CacheEntry, retention: int):
        from js import Response, caches

        response = Response.new(
            entry.response.body,
            self.options(
                {
                    "status": entry.response.status,
                    "headers": {
                        "Content-Type": entry.response.content_type,
                        "Cache-Control": f"public, max-age={retention}",
                        "X-Podr-Stored-At": str(entry.stored_at),
                        "X-Podr-TTL": str(entry.ttl),
                        **({"X-Podr-ETag": entry.etag} if entry.etag else {}),
                        **(
                            {"X-Podr-Last-Modified": entry.last_modified}
                            if entry.last_modified
                            else {}
                        ),
                    },
                }
            ),
        )
        await caches.default.put(key, response)

    def defer(self, work: Awaitable):
        from workers import wait_until

        wait_until(asyncio.ensure_future(self._guard(work)))
