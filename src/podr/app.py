"""FastAPI routes preserving Podr's existing wire format and query semantics."""

import json
import logging
import re
import time
import uuid
from typing import Annotated

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from podr.analytics import now_iso
from podr.config import (
    CORS_HEADERS,
    ITUNES,
    SECURITY_HEADERS,
    TTL_DETAIL,
    TTL_SCHEMA,
    TTL_SEARCH,
    TTL_TOP,
)
from podr.models import (
    HealthResponse,
    PodcastDetail,
    RelatedResponse,
    SearchResponse,
    SemanticResponse,
    SuggestResponse,
    TopResponse,
    TrendingResponse,
)
from podr.runtime import Runtime
from podr.services import Podcasts
from podr.validation import (
    APIError,
    clamped_limit,
    genre_id,
    parse_integer,
    podcast_id,
    query_text,
    search_limit,
)

logger = logging.getLogger("podr")
# Query parameters stay strings to retain the legacy parsing policy.
Limit = Annotated[str | None, Query(description="Result limit; legacy integer-prefix parsing")]


def api_response(data, ttl, hit=None, status=200):
    headers = {"Cache-Control": f"public, max-age={ttl}" if ttl else "no-store"}
    if hit is not None:
        headers["X-Cache"] = "HIT" if hit else "MISS"
    return JSONResponse(
        data, status_code=status, headers=headers, media_type="application/json;charset=UTF-8"
    )


def create_app(runtime: Runtime | None = None) -> FastAPI:
    app = FastAPI(
        title="Podr's RESTful API",
        version="1.0.0",
        redirect_slashes=False,
        description="Podcast search and discovery. The root serves OpenAPI when q is absent.",
    )
    app.state.service = Podcasts(runtime or Runtime())

    def service(request):
        return request.scope.get("podr_service", app.state.service)

    def record(request, endpoint, hit=False, count=0, **options):
        request.state.endpoint = endpoint
        request.state.hit = hit
        request.state.options = {"resultCount": count, **options}

    @app.middleware("http")
    async def request_policy(request, call_next):
        started = time.monotonic()
        request_id = str(uuid.uuid4())
        svc = service(request)
        cf = request.scope.get("cf", {})
        try:
            if request.method != "GET":
                raise APIError("Unsupported", 405)
            if request.url.path not in {"/health", "/health/deep"}:
                ip = request.headers.get("cf-connecting-ip") or request.headers.get(
                    "x-forwarded-for", "unknown"
                )
                if not await svc.runtime.rate_allowed(ip):
                    raise APIError("Rate limit exceeded", 429)
            response = await call_next(request)
        except APIError as exc:
            response = PlainTextResponse(str(exc), status_code=exc.status)
        except Exception as exc:
            logger.exception("Request failed: %s", request_id)
            response = PlainTextResponse(str(exc) or "Internal Server Error", status_code=500)
        response.headers.update({**SECURITY_HEADERS, **CORS_HEADERS})
        duration = (time.monotonic() - started) * 1000
        endpoint = getattr(request.state, "endpoint", "error")
        if request.url.path not in {"/health", "/health/deep"}:
            svc.runtime.defer(
                svc.analytics.record(
                    endpoint,
                    getattr(request.state, "hit", False),
                    response.status_code,
                    duration,
                    cf.get("colo", "unknown"),
                    request_id,
                    country=cf.get("country"),
                    **getattr(request.state, "options", {}),
                )
            )
        logger.info(
            json.dumps(
                {
                    "requestId": request_id,
                    "path": request.url.path,
                    "status": response.status_code,
                    "durationMs": duration,
                }
            )
        )
        return response

    @app.exception_handler(APIError)
    async def api_error(request, exc):
        return PlainTextResponse(str(exc), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return PlainTextResponse("Invalid request parameters", status_code=400)

    @app.get(
        "/",
        response_model=SearchResponse | TopResponse | dict,
        responses={400: {"description": "Invalid query, limit or genre"}},
        operation_id="podcastAPI",
    )
    async def root(
        request: Request, q: str | None = None, limit: Limit = None, genre: str | None = None
    ):
        if q is None:
            record(request, "schema", True)
            return Response(
                json.dumps(app.openapi(), indent=2),
                media_type="application/json",
                headers={"Cache-Control": f"public, max-age={TTL_SCHEMA}, immutable"},
            )
        query = query_text(q)
        size, category = search_limit(limit), genre_id(genre)
        svc = service(request)
        if query == "toppodcasts":
            data, hit = await svc.top(size, category)
            record(
                request,
                "toppodcasts",
                hit,
                len(data.get("feed", {}).get("entry", [])),
                limit=size,
                genre=category if category != -1 else None,
            )
            return api_response(data, TTL_TOP, hit)
        data, hit = await svc.search(query, size)
        count = data.get("resultCount", 0)
        record(request, "search", hit, count, query=query, limit=size)
        if count:
            svc.runtime.defer(
                svc.analytics.track_query(query, request.scope.get("cf", {}).get("country"))
            )
        return api_response(data, TTL_SEARCH, hit)

    async def health_data(request, deep=False):
        svc = service(request)
        cf = request.scope.get("cf", {})
        data = {
            "status": "healthy",
            "timestamp": now_iso(),
            "version": "1.0.0",
            "circuitBreaker": svc.circuit.state,
            "placement": {
                "colo": cf.get("colo", "unknown"),
                "country": cf.get("country", "unknown"),
            },
        }
        status = 200
        if deep:
            started = time.monotonic()
            try:
                response = await svc.runtime.fetch(
                    f"{ITUNES}/search?media=podcast&term=test&limit=1"
                )
                healthy = response.status < 400
            except Exception:
                healthy = False
            data["upstream"] = {
                "itunes": {
                    "status": "healthy" if healthy else "unhealthy",
                    "latencyMs": (time.monotonic() - started) * 1000,
                }
            }
            if not healthy:
                data["status"], status = "degraded", 503
        return api_response(data, 0, status=status)

    @app.get("/health", response_model=HealthResponse)
    async def health(request: Request):
        return await health_data(request)

    @app.get(
        "/health/deep", response_model=HealthResponse, responses={503: {"model": HealthResponse}}
    )
    async def deep_health(request: Request):
        return await health_data(request, True)

    @app.get("/podcast/{id}", response_model=PodcastDetail)
    async def detail(request: Request, id: str, summary: str = "false"):
        if not re.fullmatch(r"[0-9]+", id):
            raise APIError("Invalid podcast ID")
        data, hit = await service(request).detail(podcast_id(id), summary == "true")
        record(request, "podcastDetail", hit, len(data["episodes"]))
        return api_response(data, TTL_DETAIL, hit)

    @app.get("/related", response_model=RelatedResponse)
    async def related(request: Request, id: str | None = None, limit: Limit = None):
        data, hit = await service(request).related(podcast_id(id), clamped_limit(limit, 10, 20))
        record(request, "related", hit, len(data["related"]))
        return api_response(data, TTL_DETAIL, hit)

    async def require_flag(request, flag):
        if not await service(request).runtime.flag(flag):
            raise APIError("Not Found", 404)

    @app.get("/trending", response_model=TrendingResponse)
    async def trending(request: Request, limit: Limit = None, country: str | None = None):
        await require_flag(request, "trendingQueries")
        country = country.upper() if country and re.fullmatch(r"[a-zA-Z]{2}", country) else None
        rows = await service(request).analytics.trending(clamped_limit(limit, 10, 50), country)
        record(request, "trending", count=len(rows))
        return api_response(
            {
                "trending": [
                    {"query": row["query_normalized"], "count": row["total_count"]} for row in rows
                ],
                "period": "7d",
                "country": country or "global",
                "generatedAt": now_iso(),
            },
            300,
        )

    @app.get("/suggest", response_model=SuggestResponse)
    async def suggest(request: Request, q: str = "", limit: Limit = None):
        await require_flag(request, "trendingQueries")
        rows = await service(request).analytics.suggestions(q, clamped_limit(limit, 5, 10))
        record(request, "suggest", count=len(rows))
        return api_response({"suggestions": rows, "query": q}, 300)

    @app.get("/semantic-search", response_model=SemanticResponse)
    async def semantic(request: Request, q: str | None = None, limit: Limit = None):
        await require_flag(request, "semanticSearch")
        query = query_text(q)
        size = parse_integer(limit, 10)
        size = min(size, 10) if size >= 1 else 10
        data = await service(request).semantic(query, size)
        record(request, "semanticSearch", count=data["resultCount"], query=query, limit=size)
        return api_response(data, 3600, False)

    @app.get("/{path:path}", include_in_schema=False)
    async def legacy_fallback(request: Request, path: str):
        # The original worker falls through to search on unmatched paths.
        return (
            await root(
                request,
                request.query_params.get("q"),
                request.query_params.get("limit"),
                request.query_params.get("genre"),
            )
            if "q" in request.query_params
            else _missing_query()
        )

    return app


def _missing_query():
    raise APIError("Missing required query parameter: q")


app = create_app()
