"""The container only fetches public addresses, on every redirect hop."""

import asyncio
import ipaddress

import httpx
import pytest

import container_src.main as container
from container_src.egress import BlockedDestination, PublicOnlyTransport, is_public
from container_src.main import app

FEED_XML = b"<rss><channel><title>T</title><item><guid>1</guid></item></channel></rss>"
PUBLIC = "93.184.215.14"

BLOCKED = {
    "loopback v4": "127.0.0.1",
    "loopback v4 range": "127.8.9.10",
    "loopback v6": "::1",
    "rfc1918 10/8": "10.1.2.3",
    "rfc1918 172.16/12": "172.20.0.1",
    "rfc1918 192.168/16": "192.168.1.1",
    "unique local fc00::/7": "fd12:3456::1",
    "link-local metadata": "169.254.169.254",
    "link-local v6": "fe80::1",
    "cgnat 100.64/10": "100.64.0.1",
    "multicast v4": "224.0.0.1",
    "multicast v4 global scope": "239.1.1.1",
    "multicast v6": "ff02::1",
    "unspecified v4": "0.0.0.0",
    "unspecified v6": "::",
    "reserved 240/4": "240.0.0.1",
    "broadcast": "255.255.255.255",
    "documentation": "192.0.2.1",
    "ipv4-mapped loopback": "::ffff:127.0.0.1",
    "ipv4-mapped metadata": "::ffff:169.254.169.254",
    "nat64 loopback": "64:ff9b::7f00:1",
}


@pytest.mark.parametrize("address", BLOCKED.values(), ids=BLOCKED.keys())
def test_non_public_addresses_are_rejected(address):
    assert not is_public(ipaddress.ip_address(address))


@pytest.mark.parametrize("address", [PUBLIC, "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
def test_public_addresses_are_allowed(address):
    assert is_public(ipaddress.ip_address(address))


def guarded_client(handler, dns):
    async def resolver(host, port):
        if host not in dns:
            raise OSError("no such host")
        return dns[host]

    transport = PublicOnlyTransport(httpx.MockTransport(handler), resolver)
    upstream = httpx.AsyncClient(transport=transport, follow_redirects=True)
    app.state.client = upstream
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://container")
    return upstream, client


def feed_host(request):
    return httpx.Response(200, content=FEED_XML)


async def test_public_feed_is_fetched_from_the_address_that_was_checked():
    seen = []

    def handler(request):
        seen.append(request)
        return feed_host(request)

    upstream, client = guarded_client(handler, {"feeds.example.com": ["2606:4700::1", PUBLIC]})
    async with upstream, client:
        response = await client.get("/feed", params={"url": "https://feeds.example.com/x.xml"})

    assert response.status_code == 200
    assert response.json()["items"][0]["guid"] == "1"
    assert response.json()["feed"]["url"] == "https://feeds.example.com/x.xml"
    (request,) = seen
    # Pinned to the validated address (IPv4 preferred), still addressed to the host.
    assert request.url.host == PUBLIC
    assert request.headers["host"] == "feeds.example.com"
    assert request.extensions["sni_hostname"] == "feeds.example.com"


@pytest.mark.parametrize("address", BLOCKED.values(), ids=BLOCKED.keys())
async def test_feed_to_a_host_resolving_to_a_blocked_address_is_400(address):
    handler_calls = []
    upstream, client = guarded_client(handler_calls.append, {"evil.example": [address]})
    async with upstream, client:
        response = await client.get("/feed", params={"url": "http://evil.example/feed"})

    assert response.status_code == 400
    assert response.json() == {"status": "error", "message": "URL is not allowed"}
    assert handler_calls == []


@pytest.mark.parametrize(
    "url", ["http://127.0.0.1:8080/", "http://[::1]/", "http://169.254.169.254/"]
)
async def test_ip_literals_are_checked_without_dns(url):
    upstream, client = guarded_client(feed_host, {})
    async with upstream, client:
        response = await client.get("/feed", params={"url": url})
    assert response.status_code == 400


async def test_one_private_answer_among_public_ones_is_rejected():
    upstream, client = guarded_client(feed_host, {"mixed.example": [PUBLIC, "10.0.0.5"]})
    async with upstream, client:
        response = await client.get("/feed", params={"url": "https://mixed.example/feed"})
    assert response.status_code == 400


@pytest.mark.parametrize("status", [301, 302, 307, 308])
async def test_redirect_to_a_private_address_is_rejected(status):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(status, headers={"location": "http://internal.example/admin"})

    dns = {"feeds.example.com": [PUBLIC], "internal.example": ["192.168.0.10"]}
    upstream, client = guarded_client(handler, dns)
    async with upstream, client:
        response = await client.get("/feed", params={"url": "https://feeds.example.com/x.xml"})

    assert response.status_code == 400
    assert response.json()["message"] == "URL is not allowed"
    assert [r.headers["host"] for r in seen] == ["feeds.example.com"]


async def test_redirect_to_a_private_ip_literal_is_rejected():
    def handler(request):
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/"})

    upstream, client = guarded_client(handler, {"feeds.example.com": [PUBLIC]})
    async with upstream, client:
        response = await client.get("/feed", params={"url": "https://feeds.example.com/x.xml"})
    assert response.status_code == 400


async def test_public_redirect_still_works_and_keeps_hostnames():
    def handler(request):
        if request.headers["host"] == "old.example":
            return httpx.Response(301, headers={"location": "https://new.example/feed.xml"})
        return feed_host(request)

    dns = {"old.example": [PUBLIC], "new.example": ["8.8.8.8"]}
    upstream, client = guarded_client(handler, dns)
    async with upstream, client:
        response = await client.get("/feed", params={"url": "https://old.example/feed.xml"})

    assert response.status_code == 200
    assert response.json()["feed"]["redirectedUrl"] == "https://new.example/feed.xml"


async def test_unresolvable_host_is_a_502_not_a_400():
    upstream, client = guarded_client(feed_host, {})
    async with upstream, client:
        response = await client.get("/feed", params={"url": "https://nowhere.example/feed"})
    assert response.status_code == 502


async def test_proxy_route_rejects_private_destinations():
    upstream, client = guarded_client(feed_host, {"internal.example": ["10.0.0.1"]})
    async with upstream, client:
        response = await client.get("/", params={"url": "http://internal.example/"})
        assert response.status_code == 400
        assert response.text == "URL is not allowed"
        response = await client.get("/", params={"url": "http://[::ffff:127.0.0.1]:8080/"})
        assert response.status_code == 400


async def test_feed_download_has_a_total_deadline(monkeypatch):
    monkeypatch.setattr(container, "FEED_DEADLINE", 0.05)

    async def hang(request):
        await asyncio.sleep(5)
        return feed_host(request)

    upstream, client = guarded_client(hang, {"slow.example": [PUBLIC]})
    async with upstream, client:
        response = await client.get("/feed", params={"url": "https://slow.example/feed"})
    assert response.status_code == 502
    assert response.json()["message"] == "Could not download the feed"


async def test_transport_rejects_non_http_schemes():
    transport = PublicOnlyTransport(httpx.MockTransport(feed_host))
    with pytest.raises(BlockedDestination):
        await transport.handle_async_request(httpx.Request("GET", "ftp://example.com/"))
