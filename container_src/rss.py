"""Podcast feed parsing: RSS 2.0 or Atom XML to the JSON envelope the Podr client reads.

The envelope keeps the shape rss2json used, which the client already accepts:
``{"status": "ok", "feed": {...}, "items": [...]}``, where each item carries
``title``, ``pubDate``, ``guid``, ``link`` and ``enclosure {link, type, length,
duration}``. Items come back newest first, because the client shows them in the
order it receives them.

This runs in the container rather than the Worker: a big feed (Radiolab is about
5 MB) takes far longer to parse than the Worker's CPU budget allows.
"""

import html
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

DESCRIPTION_LIMIT = 500

ATOM = "{http://www.w3.org/2005/Atom}"
ITUNES = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}"
MEDIA = "{http://search.yahoo.com/mrss/}"

_TAGS = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")


class FeedError(ValueError):
    """The document is not a feed we can read."""


def parse_feed(xml: bytes, count: int, url: str = "") -> dict:
    """Parse feed bytes into the client's envelope, keeping the newest ``count`` items."""
    _reject_entity_declarations(xml)
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise FeedError(f"Feed is not valid XML: {exc}") from None

    if root.tag == f"{ATOM}feed":
        feed, items = _atom_feed(root), [_atom_entry(e) for e in root.iter(f"{ATOM}entry")]
    else:
        channel = root.find("channel") if root.tag == "rss" else None
        if channel is None:
            raise FeedError("Feed has no RSS channel or Atom feed element")
        feed, items = _rss_channel(channel), [_rss_item(i) for i in channel.iter("item")]

    feed["url"] = url
    return {"status": "ok", "feed": feed, "items": _newest_first(items)[:count]}


def _reject_entity_declarations(xml: bytes) -> None:
    # Podcast feeds never need a DTD. expat already caps entity expansion, but
    # refusing declared entities outright keeps a hostile feed from costing
    # anything at all to parse.
    root_start = re.search(rb"<(?![?!])", xml)
    prolog = xml[: root_start.start()] if root_start else xml
    if b"<!ENTITY" in prolog:
        raise FeedError("Feed declares XML entities, which are not supported")


def _text(element, path: str) -> str:
    found = element.find(path) if element is not None else None
    return (found.text or "").strip() if found is not None else ""


def _plain(value: str) -> str:
    """Strip markup and collapse whitespace, capped for the payload's sake."""
    text = _SPACE.sub(" ", html.unescape(_TAGS.sub(" ", value))).strip()
    return text[:DESCRIPTION_LIMIT]


def _date(value: str) -> tuple[str, datetime | None]:
    """Return an ISO 8601 UTC string and the parsed datetime, or the raw value."""
    if not value:
        return "", None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value, None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    parsed = parsed.astimezone(UTC)
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ"), parsed


def _duration(value: str) -> int | str:
    value = value.strip()
    if value.isdigit():
        return int(value)
    try:
        return int(float(value))
    except (ValueError, OverflowError):
        return value


def _rss_channel(channel) -> dict:
    image = channel.find(f"{ITUNES}image")
    return {
        "title": _text(channel, "title"),
        "link": _text(channel, "link"),
        "author": _text(channel, f"{ITUNES}author"),
        "description": _plain(_text(channel, "description") or _text(channel, f"{ITUNES}summary")),
        "image": (image.get("href", "") if image is not None else "")
        or _text(channel, "image/url"),
    }


def _rss_item(item) -> dict:
    enclosure = item.find("enclosure")
    media = item.find(f"{MEDIA}content")
    source = enclosure if enclosure is not None else media
    audio = source.get("url", "").strip() if source is not None else ""
    image = item.find(f"{ITUNES}image")
    published, when = _date(_text(item, "pubDate"))
    link = _text(item, "link")
    return {
        "title": _text(item, "title") or _text(item, f"{ITUNES}title"),
        "pubDate": published,
        "link": link,
        "guid": _text(item, "guid") or audio or link,
        "author": _text(item, f"{ITUNES}author") or _text(item, "author"),
        "thumbnail": image.get("href", "") if image is not None else "",
        "description": _plain(
            _text(item, "description")
            or _text(item, f"{ITUNES}summary")
            or _text(item, f"{CONTENT}encoded")
        ),
        "enclosure": {
            "link": audio,
            "type": source.get("type", "") if source is not None else "",
            "length": source.get("length", "") if source is not None else "",
            "duration": _duration(_text(item, f"{ITUNES}duration")),
        },
        "_when": when,
    }


def _atom_link(element, rel: str) -> dict:
    for link in element.findall(f"{ATOM}link"):
        if link.get("rel", "alternate") == rel:
            return link.attrib
    return {}


def _atom_feed(root) -> dict:
    return {
        "title": _text(root, f"{ATOM}title"),
        "link": _atom_link(root, "alternate").get("href", ""),
        "author": _text(root, f"{ATOM}author/{ATOM}name"),
        "description": _plain(_text(root, f"{ATOM}subtitle")),
        "image": _text(root, f"{ATOM}logo") or _text(root, f"{ATOM}icon"),
    }


def _atom_entry(entry) -> dict:
    enclosure = _atom_link(entry, "enclosure")
    published, when = _date(_text(entry, f"{ATOM}published") or _text(entry, f"{ATOM}updated"))
    link = _atom_link(entry, "alternate").get("href", "")
    audio = enclosure.get("href", "")
    return {
        "title": _text(entry, f"{ATOM}title"),
        "pubDate": published,
        "link": link,
        "guid": _text(entry, f"{ATOM}id") or audio or link,
        "author": _text(entry, f"{ATOM}author/{ATOM}name"),
        "thumbnail": "",
        "description": _plain(_text(entry, f"{ATOM}summary") or _text(entry, f"{ATOM}content")),
        "enclosure": {
            "link": audio,
            "type": enclosure.get("type", ""),
            "length": enclosure.get("length", ""),
            "duration": _duration(_text(entry, f"{ITUNES}duration")),
        },
        "_when": when,
    }


def _newest_first(items: list[dict]) -> list[dict]:
    # sorted() is stable, so equal dates keep feed order, and undated items keep
    # their relative order after every dated one.
    ordered = sorted(
        items,
        key=lambda item: (item["_when"] is None, -(item["_when"] or _EPOCH).timestamp()),
    )
    for item in ordered:
        del item["_when"]
    return ordered


_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
