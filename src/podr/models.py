"""Response contracts used to generate OpenAPI; upstream search fields remain extensible."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class SearchResponse(BaseModel):
    resultCount: int
    results: list[dict[str, Any]]
    model_config = ConfigDict(extra="allow")


class TopResponse(BaseModel):
    feed: dict[str, Any]
    model_config = ConfigDict(extra="allow")


class Podcast(BaseModel):
    trackId: int
    trackName: str
    artworkUrl600: str | None = None
    feedUrl: str | None = None
    genres: list[str] | None = None


class Episode(BaseModel):
    trackId: int | None = None
    trackName: str | None = None
    releaseDate: str | None = None
    trackTimeMillis: int | None = None
    description: str | None = None


class PodcastDetail(BaseModel):
    podcast: Podcast
    episodes: list[Episode]
    summary: str | None = None


class RelatedPodcast(BaseModel):
    trackId: int | None = None
    trackName: str | None = None
    genre: str
    artworkUrl600: str | None = None
    artistName: str | None = None


class RelatedResponse(BaseModel):
    related: list[RelatedPodcast]
    sourceId: int
    matchedBy: Literal["genre"] = "genre"


class SemanticResult(BaseModel):
    id: str
    score: float
    title: str | None = None
    description: str | None = None
    artworkUrl: str | None = None
    feedUrl: str | None = None


class SemanticResponse(BaseModel):
    query: str
    results: list[SemanticResult]
    resultCount: int


class TrendingQuery(BaseModel):
    query: str
    count: int


class TrendingResponse(BaseModel):
    trending: list[TrendingQuery]
    period: Literal["7d"] = "7d"
    country: str
    generatedAt: str


class SuggestResponse(BaseModel):
    suggestions: list[str]
    query: str


class Placement(BaseModel):
    colo: str
    country: str


class HealthResponse(BaseModel):
    status: Literal["healthy", "degraded"]
    timestamp: str
    version: str
    circuitBreaker: Literal["closed", "open", "half-open"]
    placement: Placement
    upstream: dict[str, Any] | None = None
