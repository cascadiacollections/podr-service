"""D1 discovery queries and best-effort Analytics Engine/R2 recording."""

import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta

from podr.runtime import Runtime

logger = logging.getLogger("podr")


def now_iso():
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Analytics:
    def __init__(self, runtime: Runtime):
        self.runtime = runtime

    async def trending(self, limit=10, country=None):
        db = self.runtime.binding("DB")
        if db is None:
            return []
        date = (datetime.now(UTC) - timedelta(days=7)).date().isoformat()
        base = "SELECT query_normalized, SUM(search_count) AS total_count FROM search_queries"
        tail = " GROUP BY query_hash ORDER BY total_count DESC LIMIT ?"
        try:
            if country:
                result = self.runtime.native(
                    await db.prepare(base + " WHERE date >= ? AND country = ?" + tail)
                    .bind(date, country.upper(), limit)
                    .all()
                )
                if result["results"]:
                    return result["results"]
            result = self.runtime.native(
                await db.prepare(base + " WHERE date >= ?" + tail).bind(date, limit).all()
            )
            return result["results"]
        except Exception:
            logger.exception("Trending lookup failed")
            return []

    async def suggestions(self, prefix, limit):
        db = self.runtime.binding("DB")
        if db is None or len(prefix) < 2:
            return []
        date = (datetime.now(UTC) - timedelta(days=30)).date().isoformat()
        try:
            result = self.runtime.native(
                await db.prepare(
                    "SELECT query_normalized, SUM(search_count) AS total_count FROM search_queries "
                    "WHERE query_normalized LIKE ? || '%' AND date >= ? "
                    "GROUP BY query_normalized ORDER BY total_count DESC LIMIT ?"
                )
                .bind(prefix.lower(), date, limit)
                .all()
            )
            return [row["query_normalized"] for row in result["results"]]
        except Exception:
            logger.exception("Suggestions lookup failed")
            return []

    async def track_query(self, query, country=None):
        db = self.runtime.binding("DB")
        normalized = " ".join(query.lower().split())
        if db is None or not 2 <= len(normalized) <= 100:
            return
        digest = hashlib.sha256(normalized.encode()).hexdigest()
        try:
            # Migration 0003 makes the country dimension unique and this upsert atomic.
            await (
                db.prepare(
                    "INSERT INTO search_queries (query_hash, query_normalized, date, country) "
                    "VALUES (?, ?, ?, ?) ON CONFLICT(query_hash, date, country) DO UPDATE SET "
                    "search_count = search_count + 1, updated_at = datetime('now')"
                )
                .bind(digest, normalized, now_iso()[:10], (country or "").upper())
                .run()
            )
        except Exception:
            logger.exception("Search tracking failed")

    async def record(self, endpoint, hit, status, duration, colo, request_id, **options):
        timestamp = now_iso()
        metrics = self.runtime.binding("ANALYTICS")
        if metrics is not None:
            try:
                metrics.writeDataPoint(
                    self.runtime.options(
                        {
                            "blobs": [endpoint, "HIT" if hit else "MISS", str(status), colo],
                            "doubles": [duration, options.get("resultCount", 0)],
                            "indexes": [timestamp[:10]],
                        }
                    )
                )
            except Exception:
                logger.exception("Metrics recording failed")
        # Preserve current production export behavior: the R2 binding enables export.
        bucket = self.runtime.binding("ANALYTICS_LAKE")
        if bucket is None or endpoint not in {
            "search",
            "toppodcasts",
            "podcastDetail",
            "related",
            "semanticSearch",
        }:
            return
        event = {
            "timestamp": timestamp,
            "date": timestamp[:10],
            "hour": int(timestamp[11:13]),
            "requestId": request_id,
            "endpoint": endpoint,
            "cacheHit": hit,
            "status": status,
            "durationMs": duration,
            "colo": colo,
            "resultCount": 0,
            **{k: v for k, v in options.items() if v is not None},
        }
        key = f"events/{timestamp[:10].replace('-', '/')}/{timestamp[11:13]}/{request_id}.json"
        try:
            await bucket.put(
                key,
                json.dumps(event),
                self.runtime.options(
                    {
                        "httpMetadata": {"contentType": "application/json"},
                        "customMetadata": {
                            "endpoint": endpoint,
                            "colo": colo,
                            "date": timestamp[:10],
                        },
                    }
                ),
            )
        except Exception:
            logger.exception("Analytics export failed")
