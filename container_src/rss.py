"""Podcast feed parsing: RSS 2.0 or Atom XML to the JSON envelope the Podr client reads.

The envelope keeps the shape rss2json used, which the client already accepts:
``{"status": "ok", "feed": {...}, "items": [...]}``, where each item carries
``title``, ``pubDate``, ``guid``, ``link`` and ``enclosure {link, type, length,
duration}``. Items come back newest first, because the client shows them in the
order it receives them.

Links, enclosures and artwork are resolved against the URL the feed was fetched
from (after redirects) and any Atom ``xml:base``, so relative URLs work. Future
dates sort as the fetch time: they can't be trusted, so future-dated items keep
the publisher's order among themselves instead of ranking by how far ahead they
claim to be. Their ``pubDate`` is still reported as written, because a stateless
parser has no first-seen time to report instead.

This runs in the container rather than the Worker: a big feed (Radiolab is about
5 MB) takes far longer to parse than the Worker's CPU budget allows.
"""

import html
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin

DESCRIPTION_LIMIT = 500

ATOM = "{http://www.w3.org/2005/Atom}"
ITUNES = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}"
MEDIA = "{http://search.yahoo.com/mrss/}"
XML_BASE = "{http://www.w3.org/XML/1998/namespace}base"

_TAGS = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")


class FeedError(ValueError):
    """The document is not a feed we can read."""


def parse_feed(xml: bytes, count: int, url: str = "", base: str | None = None) -> dict:
    """Parse feed bytes into the client's envelope, keeping the newest ``count`` items.

    ``url`` is the requested feed URL, reported as ``feed.url``. ``base``, the URL
    the feed was actually served from, resolves relative URLs; it defaults to ``url``.
    """
    _reject_entity_declarations(xml)
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise FeedError(f"Feed is not valid XML: {exc}") from None

    root_base = _base(root, url if base is None else base)
    if root.tag == f"{ATOM}feed":
        feed = _atom_feed(root, root_base)
        items = [_atom_entry(e, _base(e, root_base)) for e in root.iter(f"{ATOM}entry")]
    else:
        channel = root.find("channel") if root.tag == "rss" else None
        if channel is None:
            raise FeedError("Feed has no RSS channel or Atom feed element")
        channel_base = _base(channel, root_base)
        feed = _rss_channel(channel, channel_base)
        items = [_rss_item(i, _base(i, channel_base)) for i in channel.iter("item")]

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


def _base(element, inherited: str) -> str:
    """The base URL in effect inside ``element``: its own xml:base, if any, resolved
    against the base it inherits."""
    own = element.get(XML_BASE) if element is not None else None
    return urljoin(inherited, own.strip()) if own else inherited


def _resolve(value: str, base: str, element=None) -> str:
    """Resolve a possibly relative URL taken from ``element`` (text or attribute)."""
    base = _base(element, base)
    return urljoin(base, value) if value and base else value


def _url_text(element, path: str, base: str) -> str:
    found = element.find(path) if element is not None else None
    if found is None:
        return ""
    return _resolve((found.text or "").strip(), base, found)


def _url_attr(element, attribute: str, base: str) -> str:
    if element is None:
        return ""
    return _resolve(element.get(attribute, "").strip(), base, element)


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


def _rss_channel(channel, base: str) -> dict:
    return {
        "title": _text(channel, "title"),
        "link": _url_text(channel, "link", base),
        "author": _text(channel, f"{ITUNES}author"),
        "description": _plain(_text(channel, "description") or _text(channel, f"{ITUNES}summary")),
        "image": _url_attr(channel.find(f"{ITUNES}image"), "href", base)
        or _url_text(channel, "image/url", base),
    }


def _rss_item(item, base: str) -> dict:
    enclosure = item.find("enclosure")
    media = item.find(f"{MEDIA}content")
    source = enclosure if enclosure is not None else media
    audio = _url_attr(source, "url", base)
    published, when = _date(_text(item, "pubDate"))
    link = _url_text(item, "link", base)
    return {
        "title": _text(item, "title") or _text(item, f"{ITUNES}title"),
        "pubDate": published,
        "link": link,
        "guid": _text(item, "guid") or audio or link,
        "author": _text(item, f"{ITUNES}author") or _text(item, "author"),
        "thumbnail": _url_attr(item.find(f"{ITUNES}image"), "href", base),
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


def _atom_link(element, rel: str, base: str) -> dict:
    """The first link with ``rel``, its ``href`` resolved against the in-scope base."""
    for link in element.findall(f"{ATOM}link"):
        if link.get("rel", "alternate") == rel:
            return {**link.attrib, "href": _url_attr(link, "href", base)}
    return {}


def _atom_feed(root, base: str) -> dict:
    return {
        "title": _text(root, f"{ATOM}title"),
        "link": _atom_link(root, "alternate", base).get("href", ""),
        "author": _text(root, f"{ATOM}author/{ATOM}name"),
        "description": _plain(_text(root, f"{ATOM}subtitle")),
        "image": _url_text(root, f"{ATOM}logo", base) or _url_text(root, f"{ATOM}icon", base),
    }


def _atom_entry(entry, base: str) -> dict:
    enclosure = _atom_link(entry, "enclosure", base)
    published, when = _date(_text(entry, f"{ATOM}published") or _text(entry, f"{ATOM}updated"))
    link = _atom_link(entry, "alternate", base).get("href", "")
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
    # their relative order after every dated one. Future dates sort as now: only
    # the order is clamped, so pubDate still shows what the publisher wrote.
    now = datetime.now(UTC)
    ordered = sorted(
        items,
        key=lambda item: (
            item["_when"] is None,
            -min(item["_when"] or _EPOCH, now).timestamp(),
        ),
    )
    for item in ordered:
        del item["_when"]
    return ordered


_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
