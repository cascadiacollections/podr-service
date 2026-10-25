import time
from datetime import UTC, datetime, timedelta

import pytest

from container_src.rss import DESCRIPTION_LIMIT, FeedError, parse_feed

RFC_822 = "%a, %d %b %Y %H:%M:%S GMT"
ITUNES_NS = 'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"'


def rss(items: str, channel: str = "<title>Show</title>") -> bytes:
    return (
        f'<?xml version="1.0"?><rss version="2.0" {ITUNES_NS}><channel>{channel}{items}'
        "</channel></rss>"
    ).encode()


def item(guid: str, date: str = "", extra: str = "") -> str:
    pub = f"<pubDate>{date}</pubDate>" if date else ""
    return f"<item><title>{guid}</title><guid>{guid}</guid>{pub}{extra}</item>"


def test_rss_with_itunes_tags():
    xml = rss(
        item(
            "ep",
            "Wed, 15 Jan 2026 12:00:00 -0500",
            '<enclosure url=" https://cdn/ep.mp3 " type="audio/mpeg" length="42"/>'
            "<itunes:duration>01:02:03</itunes:duration>"
            '<itunes:image href="https://cdn/ep.jpg"/>'
            "<itunes:author>Host</itunes:author>",
        ),
        "<title>Show</title><link>https://show</link>"
        '<itunes:image href="https://cdn/show.jpg"/><itunes:author>Network</itunes:author>',
    )

    data = parse_feed(xml, 10, "https://feed")

    assert data["status"] == "ok"
    assert data["feed"] == {
        "title": "Show",
        "link": "https://show",
        "author": "Network",
        "description": "",
        "image": "https://cdn/show.jpg",
        "url": "https://feed",
    }
    assert data["items"] == [
        {
            "title": "ep",
            "pubDate": "2026-01-15T17:00:00Z",
            "link": "",
            "guid": "ep",
            "author": "Host",
            "thumbnail": "https://cdn/ep.jpg",
            "description": "",
            "enclosure": {
                "link": "https://cdn/ep.mp3",
                "type": "audio/mpeg",
                "length": "42",
                "duration": "01:02:03",
            },
        }
    ]


def test_atom_feed():
    xml = b"""<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Show</title><link href="https://show"/>
      <entry><title>A</title><id>urn:a</id><published>2026-01-01T00:00:00Z</published>
        <link rel="enclosure" href="https://cdn/a.mp3" type="audio/mpeg"/></entry>
      <entry><title>B</title><id>urn:b</id><updated>2026-02-01T08:30:00+01:00</updated></entry>
    </feed>"""

    data = parse_feed(xml, 10)

    assert data["feed"]["title"] == "Atom Show"
    assert data["feed"]["link"] == "https://show"
    assert [(i["guid"], i["pubDate"]) for i in data["items"]] == [
        ("urn:b", "2026-02-01T07:30:00Z"),
        ("urn:a", "2026-01-01T00:00:00Z"),
    ]
    assert data["items"][1]["enclosure"]["link"] == "https://cdn/a.mp3"


def test_cdata_and_html_descriptions_become_capped_plain_text():
    body = "<p>Hello &amp; <b>welcome</b></p>" + "x" * 1000
    xml = rss(item("ep", extra=f"<description><![CDATA[{body}]]></description>"))

    description = parse_feed(xml, 10)["items"][0]["description"]

    assert description.startswith("Hello & welcome xxx")
    assert len(description) == DESCRIPTION_LIMIT


def test_unparseable_date_is_kept_raw_and_sorted_last():
    xml = rss(
        item("undated")
        + item("weird", "sometime last week")
        + item("old", "Mon, 01 Jan 2024 00:00:00 GMT")
        + item("new", "Mon, 01 Jan 2026 00:00:00 GMT")
    )

    items = parse_feed(xml, 10)["items"]

    assert [i["guid"] for i in items] == ["new", "old", "undated", "weird"]
    assert items[3]["pubDate"] == "sometime last week"


def test_count_keeps_the_newest():
    xml = rss("".join(item(f"ep{n}", f"Mon, {n:02d} Jan 2026 00:00:00 GMT") for n in range(1, 10)))
    assert [i["guid"] for i in parse_feed(xml, 3)["items"]] == ["ep9", "ep8", "ep7"]


def test_guid_falls_back_to_audio_then_link():
    xml = rss(
        '<item><title>a</title><enclosure url="https://cdn/a.mp3"/></item>'
        "<item><title>b</title><link>https://show/b</link></item>"
    )
    assert [i["guid"] for i in parse_feed(xml, 10)["items"]] == [
        "https://cdn/a.mp3",
        "https://show/b",
    ]


def test_numeric_durations_become_seconds():
    xml = rss(
        item("a", extra="<itunes:duration>1929</itunes:duration>")
        + item("b", extra="<itunes:duration>61.5</itunes:duration>")
        + item("c", extra="<itunes:duration>inf</itunes:duration>")
    )
    durations = [i["enclosure"]["duration"] for i in parse_feed(xml, 10)["items"]]
    assert durations == [1929, 61, "inf"]


def test_entity_declarations_are_rejected():
    xml = b"""<?xml version="1.0"?>
    <!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>
    <rss><channel><title>&b;</title></channel></rss>"""
    with pytest.raises(FeedError, match="entities"):
        parse_feed(xml, 10)


@pytest.mark.parametrize(
    ("xml", "message"),
    [
        (b"<rss><channel>", "not valid XML"),
        (b"<html><body/></html>", "no RSS channel"),
        (b"<rss version='2.0'/>", "no RSS channel"),
    ],
)
def test_non_feeds_raise(xml, message):
    with pytest.raises(FeedError, match=message):
        parse_feed(xml, 10)


def test_large_feed_parses_quickly():
    episode = (
        "<item><title>Episode {n}</title><guid>{n}</guid>"
        "<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>"
        '<enclosure url="https://cdn/{n}.mp3" type="audio/mpeg" length="1"/>'
        "<description>" + "words " * 200 + "</description></item>"
    )
    xml = rss("".join(episode.format(n=n) for n in range(700)))

    started = time.perf_counter()
    data = parse_feed(xml, 300)

    assert len(data["items"]) == 300
    assert time.perf_counter() - started < 2


def test_relative_urls_resolve_against_the_fetched_url():
    xml = rss(
        item(
            "ep",
            extra='<enclosure url="audio/ep.mp3" type="audio/mpeg"/>'
            "<link>/episodes/ep</link>"
            '<itunes:image href="../art/ep.jpg"/>',
        )
        + '<item><title>abs</title><enclosure url="https://cdn/abs.mp3"/></item>',
        "<title>Show</title><link>/</link><image><url>art/show.png</url></image>",
    )

    data = parse_feed(xml, 10, "https://old.example/show.xml", "https://new.example/feeds/show")

    assert data["feed"]["url"] == "https://old.example/show.xml"
    assert data["feed"]["link"] == "https://new.example/"
    assert data["feed"]["image"] == "https://new.example/feeds/art/show.png"
    ep, absolute = data["items"]
    assert ep["enclosure"]["link"] == "https://new.example/feeds/audio/ep.mp3"
    assert ep["link"] == "https://new.example/episodes/ep"
    assert ep["thumbnail"] == "https://new.example/art/ep.jpg"
    assert absolute["enclosure"]["link"] == "https://cdn/abs.mp3"
    # The guid fallback uses the resolved enclosure, so it is a usable URL too.
    assert absolute["guid"] == "https://cdn/abs.mp3"


def test_relative_urls_default_to_the_requested_url():
    xml = rss('<item><title>a</title><enclosure url="a.mp3"/></item>')
    data = parse_feed(xml, 10, "https://feeds.example/show/rss")
    assert data["items"][0]["enclosure"]["link"] == "https://feeds.example/show/a.mp3"
    assert parse_feed(xml, 10)["items"][0]["enclosure"]["link"] == "a.mp3"


def test_atom_xml_base_is_inherited_and_nested():
    xml = b"""<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://site.example/podcast/">
      <title>Atom Show</title><link href="home"/><logo>img/logo.png</logo>
      <entry xml:base="episodes/1/"><title>A</title><id>urn:a</id>
        <link href="page"/>
        <link rel="enclosure" href="a.mp3" type="audio/mpeg"/></entry>
      <entry><title>B</title><id>urn:b</id>
        <link rel="enclosure" xml:base="https://cdn.example/b/" href="b.mp3"/></entry>
    </feed>"""

    data = parse_feed(xml, 10, "https://feeds.example/atom.xml")

    assert data["feed"]["link"] == "https://site.example/podcast/home"
    assert data["feed"]["image"] == "https://site.example/podcast/img/logo.png"
    links = {i["guid"]: (i["link"], i["enclosure"]["link"]) for i in data["items"]}
    assert links["urn:a"] == (
        "https://site.example/podcast/episodes/1/page",
        "https://site.example/podcast/episodes/1/a.mp3",
    )
    assert links["urn:b"] == ("", "https://cdn.example/b/b.mp3")


def test_relative_xml_base_resolves_against_the_fetched_url():
    xml = b"""<feed xmlns="http://www.w3.org/2005/Atom" xml:base="media/">
      <entry><id>urn:a</id><link rel="enclosure" href="a.mp3"/></entry></feed>"""
    data = parse_feed(xml, 10, "https://feeds.example/show/atom.xml")
    assert data["items"][0]["enclosure"]["link"] == "https://feeds.example/show/media/a.mp3"


def test_future_dates_sort_as_now_but_keep_their_pubdate():
    recent = (datetime.now(UTC) - timedelta(minutes=5)).strftime(RFC_822)
    xml = rss(
        item("older", "Mon, 01 Jan 2024 00:00:00 GMT")
        + item("typo", "Sat, 01 Jan 2099 00:00:00 GMT")
        + item("far-typo", "Fri, 01 Jan 2100 00:00:00 GMT")
        + item("recent", recent)
    )

    items = parse_feed(xml, 10)["items"]

    # Both future dates count as "now", so they tie and keep the publisher's order
    # instead of ranking by how far ahead they claim to be.
    assert [i["guid"] for i in items] == ["typo", "far-typo", "recent", "older"]
    assert items[1]["pubDate"] == "2100-01-01T00:00:00Z"
