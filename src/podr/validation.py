"""Compatibility rules for the existing query-string API."""

import re

from podr.config import GENRES


class APIError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def parse_integer(value: str | None, default: int | None = None) -> int | None:
    # Preserve JavaScript parseInt(..., 10), including inputs such as '15px'.
    match = re.match(r"^\s*([+-]?[0-9]+)", value or "")
    return int(match[1]) if match else default


def query_text(value: str | None) -> str:
    if not value:
        raise APIError("Missing required query parameter: q")
    # JavaScript measures UTF-16 code units, including surrogate pairs.
    if len(value.encode("utf-16-le")) // 2 > 200:
        raise APIError("Query exceeds maximum length of 200 characters")
    if re.search(r"<script|javascript:|on\w+=|<iframe|data:", value, re.I):
        raise APIError("Query contains invalid characters")
    return value


def search_limit(value: str | None) -> int:
    result = parse_integer(value) if value else 15
    if result is None or not 1 <= result <= 200:
        raise APIError("Limit must be between 1 and 200")
    return result


def genre_id(value: str | None) -> int:
    if not value or not value.strip():
        return -1
    result = parse_integer(value)
    if result != -1 and result not in GENRES:
        genres = ", ".join(f"{key} ({name})" for key, name in GENRES.items())
        raise APIError(f"Invalid genre ID. Valid genres: {genres}")
    return result


def podcast_id(value: str | None) -> int:
    if not value:
        raise APIError("Missing required parameter: id")
    result = parse_integer(value)
    if result is None or result <= 0:
        raise APIError("Invalid podcast ID")
    return result


def clamped_limit(value: str | None, default: int, maximum: int) -> int:
    return min(max(parse_integer(value, default) or default, 1), maximum)
