"""Upstream resilience and timestamp-based stale-while-revalidate caching."""

import asyncio
import logging
import time
from dataclasses import dataclass

from podr.config import STALE_SECONDS
from podr.runtime import CacheEntry, Runtime

logger = logging.getLogger("podr")


class UpstreamError(RuntimeError):
    """A podcast provider failed or is being rested; the message is safe to show the caller."""


class _CircuitRejected(UpstreamError):
    """This attempt must not contact upstream.

    A probe is already in flight, or the rest window has not elapsed.
    """

    def __init__(self):
        super().__init__("Service temporarily unavailable")


@dataclass
class CircuitBreaker:
    failures: int = 0
    last_failure: float = 0
    state: str = "closed"

    def is_open(self):
        """True when this caller must not contact upstream.

        Open rests for 30 seconds. Checking does not admit a probe: a cache hit
        must not consume the one recovery request. The fetch path calls
        ``admit``, which is synchronous. A Worker isolate runs one event loop,
        so a second caller cannot pass ``admit`` before the first has moved
        the state to half-open.
        """
        if self.state == "half-open":
            return True
        if self.state == "open":
            return time.time() - self.last_failure < 30
        return False

    def admit(self):
        """Reserve one upstream attempt. Half-open keeps the rest waiting."""
        if self.state == "closed":
            return True
        if self.state == "open" and time.time() - self.last_failure >= 30:
            self.state = "half-open"
            return True
        return False

    def success(self):
        self.failures = 0
        self.state = "closed"

    def failure(self):
        self.failures += 1
        self.last_failure = time.time()
        # A failed probe rests again immediately, even before the count matters.
        if self.state == "half-open" or self.failures >= 5:
            self.state = "open"

    def cancel_probe(self):
        """The probe ended without a result. Leave the rest window where it was."""
        if self.state == "half-open":
            self.state = "open"


class CachedUpstream:
    def __init__(self, runtime: Runtime, circuit: CircuitBreaker):
        self.runtime = runtime
        self.circuit = circuit
        self.refreshing: set[str] = set()

    async def get(
        self, url: str, ttl: int, *, proxy=True, headers=None, header_only=False, breaker=True
    ):
        """Fetch through the cache.

        ``breaker`` is for iTunes and Podcast Index. Publisher URLs pass
        False so they neither rest those APIs nor clear a real outage, and a
        bad status is not labelled as one of them.
        """
        entry = await self.runtime.cache_get(url)
        age = max(0, time.time() - entry.stored_at) if entry else float("inf")
        available = entry is not None and age < ttl + STALE_SECONDS
        if breaker and self.circuit.is_open():
            if available:
                return entry.response, True
            raise UpstreamError("Service temporarily unavailable")
        if available:
            if age >= ttl and url not in self.refreshing:
                self.refreshing.add(url)
                self.runtime.defer(
                    self._refresh(
                        url,
                        ttl,
                        proxy=proxy,
                        headers=headers,
                        header_only=header_only,
                        breaker=breaker,
                    )
                )
            return entry.response, True
        return await self._fetch(
            url, ttl, proxy=proxy, headers=headers, header_only=header_only, breaker=breaker
        ), False

    async def _fetch(self, url, ttl, *, proxy, headers, header_only, breaker):
        probe = False
        if breaker:
            previous = self.circuit.state
            if not self.circuit.admit():
                raise _CircuitRejected()
            probe = previous == "open"
        try:
            response = await self.runtime.fetch(
                url, proxy=proxy, headers=headers, header_only=header_only
            )
            if response.status >= 400:
                if breaker:
                    provider = "iTunes" if proxy else "Podcast Index"
                    label = f"{provider} API error"
                else:
                    label = "Feed error"
                raise UpstreamError(f"{label}: {response.status} {response.reason}")
        except asyncio.CancelledError:
            if probe:
                self.circuit.cancel_probe()
            raise
        except Exception:
            if breaker:
                self.circuit.failure()
            raise
        if breaker:
            self.circuit.success()
        entry = CacheEntry(response, time.time(), ttl)
        # Cache failures must not convert a successful upstream request into an error.
        self.runtime.defer(self.runtime.cache_put(url, entry, ttl + STALE_SECONDS))
        return response

    async def _refresh(self, url, ttl, **kwargs):
        try:
            await self._fetch(url, ttl, **kwargs)
        except _CircuitRejected:
            pass
        except Exception:
            logger.warning("Cache revalidation failed", exc_info=True)
        finally:
            self.refreshing.discard(url)
