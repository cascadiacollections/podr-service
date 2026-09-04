"""Upstream resilience and timestamp-based stale-while-revalidate caching."""

import logging
import time
from dataclasses import dataclass

from podr.config import STALE_SECONDS
from podr.runtime import CacheEntry, Runtime

logger = logging.getLogger("podr")


@dataclass
class CircuitBreaker:
    failures: int = 0
    last_failure: float = 0
    state: str = "closed"

    def is_open(self):
        if self.state == "open" and time.time() - self.last_failure >= 30:
            self.state = "half-open"
        return self.state == "open"

    def success(self):
        self.failures = 0
        self.state = "closed"

    def failure(self):
        self.failures += 1
        self.last_failure = time.time()
        if self.failures >= 5:
            self.state = "open"


class CachedUpstream:
    def __init__(self, runtime: Runtime, circuit: CircuitBreaker):
        self.runtime = runtime
        self.circuit = circuit
        self.refreshing: set[str] = set()

    async def get(self, url: str, ttl: int, *, proxy=True, headers=None, header_only=False):
        entry = await self.runtime.cache_get(url)
        age = max(0, time.time() - entry.stored_at) if entry else float("inf")
        available = entry is not None and age < ttl + STALE_SECONDS
        if self.circuit.is_open():
            if available:
                return entry.response, True
            raise RuntimeError("Service temporarily unavailable")
        if available:
            if age >= ttl and url not in self.refreshing:
                self.refreshing.add(url)
                self.runtime.defer(
                    self._refresh(url, ttl, proxy=proxy, headers=headers, header_only=header_only)
                )
            return entry.response, True
        return await self._fetch(
            url, ttl, proxy=proxy, headers=headers, header_only=header_only
        ), False

    async def _fetch(self, url, ttl, *, proxy, headers, header_only):
        try:
            response = await self.runtime.fetch(
                url, proxy=proxy, headers=headers, header_only=header_only
            )
            if response.status >= 400:
                provider = "iTunes" if proxy else "Podcast Index"
                raise RuntimeError(f"{provider} API error: {response.status} {response.reason}")
        except Exception:
            self.circuit.failure()
            raise
        self.circuit.success()
        entry = CacheEntry(response, time.time(), ttl)
        # Cache failures must not convert a successful upstream request into an error.
        self.runtime.defer(self.runtime.cache_put(url, entry, ttl + STALE_SECONDS))
        return response

    async def _refresh(self, url, ttl, **kwargs):
        try:
            await self._fetch(url, ttl, **kwargs)
        except Exception:
            logger.warning("Cache revalidation failed", exc_info=True)
        finally:
            self.refreshing.discard(url)
