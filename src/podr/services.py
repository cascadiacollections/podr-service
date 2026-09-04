"""Podcast providers and discovery operations independent of HTTP and Workers."""

import asyncio
import hashlib
import logging
import re
import time
from datetime import UTC, datetime
from urllib.parse import quote

from podr.analytics import Analytics, now_iso
from podr.cache import CachedUpstream, CircuitBreaker
from podr.config import (
    EMBEDDING_MODEL,
    GENRES,
    ITUNES,
    PODCAST_INDEX,
    TTL_DETAIL,
    TTL_SEARCH,
    TTL_TOP,
    WARM_QUERIES,
)
from podr.runtime import Runtime
from podr.validation import APIError

logger = logging.getLogger("podr")


def pick(data, keys):
    return {key: data[key] for key in keys if key in data}


class Podcasts:
    def __init__(self, runtime: Runtime, circuit: CircuitBreaker | None = None):
        self.runtime = runtime
        self.circuit = circuit or CircuitBreaker()
        self.upstream = CachedUpstream(runtime, self.circuit)
        self.analytics = Analytics(runtime)

    async def search(self, query, limit):
        key = self.runtime.binding("PODCAST_INDEX_KEY")
        secret = self.runtime.binding("PODCAST_INDEX_SECRET")
        if await self.runtime.flag("podcastIndex") and key and secret:
            timestamp = str(int(time.time()))
            headers = {
                "X-Auth-Key": key,
                "X-Auth-Date": timestamp,
                "Authorization": hashlib.sha1(f"{key}{secret}{timestamp}".encode()).hexdigest(),
            }
            url = f"{PODCAST_INDEX}/api/1.0/search/byterm?q={quote(query, safe='')}&max={limit}"
            response, hit = await self.upstream.get(url, TTL_SEARCH, proxy=False, headers=headers)
            data = response.json()
            results = [self.index_feed(feed) for feed in data.get("feeds", [])]
            return {"resultCount": data.get("count", len(results)), "results": results}, hit
        url = f"{ITUNES}/search?media=podcast&term={quote(query, safe='')}&limit={limit}"
        response, hit = await self.upstream.get(url, TTL_SEARCH)
        return response.json(), hit

    @staticmethod
    def index_feed(feed):
        updated = feed.get("lastUpdateTime")
        try:
            release = (
                datetime.fromtimestamp(updated, UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
                if updated
                else now_iso()
            )
        except (ValueError, TypeError, OverflowError):
            release = now_iso()
        return {
            "collectionId": feed["id"],
            "collectionName": feed["title"],
            "feedUrl": feed.get("url") or feed.get("originalUrl", ""),
            "artworkUrl600": feed.get("artwork") or feed.get("image", ""),
            "artistName": feed.get("author") or feed.get("ownerName", ""),
            "collectionViewUrl": feed.get("link", ""),
            "trackCount": 0,
            "genres": list((feed.get("categories") or {}).values()),
            "releaseDate": release,
        }

    async def top(self, limit, genre):
        segment = f"/genre={genre}" if genre in GENRES else ""
        response, hit = await self.upstream.get(
            f"{ITUNES}/us/rss/toppodcasts/limit={limit}{segment}/json", TTL_TOP
        )
        return response.json(), hit

    async def detail(self, podcast_id, summary=False):
        response, hit = await self.upstream.get(
            f"{ITUNES}/lookup?id={podcast_id}&entity=podcastEpisode&limit=20", TTL_DETAIL
        )
        results = response.json().get("results", [])
        podcast = next(
            (p for p in results if p.get("wrapperType") == "track" and p.get("kind") == "podcast"),
            None,
        )
        if podcast is None:
            raise APIError("Podcast not found", 404)
        if not podcast.get("trackId") or not podcast.get("trackName"):
            raise APIError("Invalid podcast data", 404)
        data = {
            "podcast": pick(
                podcast, ["trackId", "trackName", "artworkUrl600", "feedUrl", "genres"]
            ),
            "episodes": [
                pick(ep, ["trackId", "trackName", "releaseDate", "trackTimeMillis", "description"])
                for ep in results
                if ep.get("kind") == "podcast-episode"
            ],
        }
        if summary and podcast.get("feedUrl") and await self.runtime.flag("podcastSummaries"):
            description = await self.rss_description(podcast["feedUrl"])
            if description:
                data["summary"] = description
        return data, hit

    async def rss_description(self, url):
        try:
            response, _ = await self.upstream.get(url, TTL_DETAIL, header_only=True)
            channel = response.body.split("<item>", 1)[0]
            for tag in ("itunes:summary", "description"):
                match = re.search(rf"<{tag}>(.*?)</{tag}>", channel, re.S)
                if match:
                    value = match[1]
                    if value.startswith("<![CDATA[") and value.endswith("]]>"):
                        value = value[9:-3]
                    if value.strip():
                        return value.strip()[:500]
        except Exception:
            logger.warning("RSS description unavailable", exc_info=True)
        return None

    async def related(self, podcast_id, limit):
        response, hit = await self.upstream.get(f"{ITUNES}/lookup?id={podcast_id}", TTL_DETAIL)
        source = next(
            (
                p
                for p in response.json().get("results", [])
                if p.get("wrapperType") == "track" and p.get("kind") == "podcast"
            ),
            None,
        )
        data = {"related": [], "sourceId": podcast_id, "matchedBy": "genre"}
        if not source or not source.get("genres"):
            return data, hit
        genre = source["genres"][0]
        response, search_hit = await self.upstream.get(
            f"{ITUNES}/search?media=podcast&term={quote(genre, safe='')}&limit={limit + 1}",
            TTL_DETAIL,
        )
        results = [
            r for r in response.json().get("results", []) if r.get("collectionId") != podcast_id
        ][:limit]
        data["related"] = [
            {
                **pick(r, ["artworkUrl600", "artistName"]),
                "genre": genre,
                **({"trackId": r["collectionId"]} if "collectionId" in r else {}),
                **({"trackName": r["collectionName"]} if "collectionName" in r else {}),
            }
            for r in results
        ]
        return data, hit and search_hit

    async def semantic(self, query, limit):
        data = {"query": query, "results": [], "resultCount": 0}
        ai, index = self.runtime.binding("AI"), self.runtime.binding("VECTORIZE")
        if ai is None or index is None:
            return data
        try:
            embedding = self.runtime.native(
                await ai.run(EMBEDDING_MODEL, self.runtime.options({"text": [query]}))
            )
            if not embedding.get("data"):
                return data
            result = self.runtime.native(
                await index.query(
                    self.runtime.options(embedding["data"][0]),
                    self.runtime.options({"topK": min(limit, 10), "returnMetadata": "all"}),
                )
            )
            data["results"] = [
                {
                    "id": match["id"],
                    "score": match["score"],
                    **{
                        key: value
                        for key, value in (match.get("metadata") or {}).items()
                        if key in {"title", "description", "artworkUrl", "feedUrl"}
                        and isinstance(value, str)
                    },
                }
                for match in result.get("matches", [])
            ]
            data["resultCount"] = len(data["results"])
        except Exception:
            logger.exception("Semantic search unavailable")
        return data

    async def warm(self):
        trending = await self.analytics.trending(10)
        queries = [row["query_normalized"] for row in trending] or WARM_QUERIES
        results = []
        for offset in range(0, len(queries), 5):
            results.extend(
                await asyncio.gather(
                    *(self.search(query, 25) for query in queries[offset : offset + 5]),
                    return_exceptions=True,
                )
            )
            if offset + 5 < len(queries):
                await asyncio.sleep(0.5)
        failed = sum(isinstance(result, Exception) for result in results)
        logger.info(
            "Cache warming completed: %s succeeded, %s failed", len(results) - failed, failed
        )
        return {
            "totalQueries": len(results),
            "successCount": len(results) - failed,
            "failureCount": failed,
        }
