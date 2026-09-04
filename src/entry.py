"""Cloudflare entrypoints: ASGI API, scheduled warming, and container lifecycle."""

import asyncio
import time

from workers import DurableObject, Response, WorkerEntrypoint, asgi

from podr.app import app
from podr.cache import CircuitBreaker
from podr.runtime import CloudflareRuntime
from podr.services import Podcasts

# Circuit state is intentionally per isolate, as in the previous Worker.
circuit = CircuitBreaker()


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        runtime = CloudflareRuntime(self.env, self.ctx)
        service = Podcasts(runtime, circuit)
        cf = runtime.native(request.cf) if getattr(request, "cf", None) else {}

        async def application(scope, receive, send):
            if scope["type"] == "http":
                scope["podr_service"] = service
                scope["cf"] = cf
            await app(scope, receive, send)

        return await asgi.fetch(application, request, self.env, self.ctx)

    async def scheduled(self, event):
        runtime = CloudflareRuntime(self.env, self.ctx)
        await Podcasts(runtime, circuit).warm()


class ITunesProxy(DurableObject):
    """Python implementation of the existing container's port/readiness/idle policy.

    Retains the ITunesProxy class and namespace, including migration v1. The low-level
    container API avoids requiring the JavaScript @cloudflare/containers SDK.
    """

    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.active = 0
        self.start_lock = asyncio.Lock()

    async def fetch(self, request):
        self.active += 1
        runtime = CloudflareRuntime(self.env, self.ctx)
        try:
            async with self.start_lock:
                if not self.ctx.container.running:
                    self.ctx.container.start(runtime.options({"enableInternet": True}))
                port = self.ctx.container.getTcpPort(8080)
                # Probe readiness before issuing the upstream request; retries never
                # replay an Apple request that has already reached the proxy.
                for attempt in range(60):
                    try:
                        ready = await port.fetch("http://container/health")
                        if ready.status == 200:
                            break
                    except Exception:
                        pass
                    if attempt == 59:
                        return Response("iTunes proxy startup timed out", status=503)
                    await asyncio.sleep(0.25)
            return await port.fetch(getattr(request, "js_object", request))
        finally:
            self.active -= 1
            await self.ctx.storage.setAlarm(int(time.time() * 1000) + 300_000)

    async def alarm(self, info=None):
        async with self.start_lock:
            if self.active:
                await self.ctx.storage.setAlarm(int(time.time() * 1000) + 300_000)
            elif self.ctx.container.running:
                await self.ctx.container.destroy()
