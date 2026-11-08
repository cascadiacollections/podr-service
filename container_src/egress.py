"""Keep the container's outbound requests on the public internet.

Feed URLs come from callers and from iTunes listings that anyone can publish, so
without this the container would fetch whatever they point at: its own loopback
listener, link-local metadata endpoints or private networks.

``PublicOnlyTransport`` wraps the real transport. httpx calls it once per request
and again for every redirect hop, so each hop is checked. It resolves the host,
rejects the request if any resolved address is not public, and then connects to
the address it checked (keeping the original Host header and TLS server name), so
a second DNS answer can't swap in a private address after validation.
"""

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable

import httpx

type IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
type Resolver = Callable[[str, int], Awaitable[list[str]]]

# NAT64's well-known prefix carries an IPv4 address in its last 32 bits.
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


class BlockedDestination(httpx.RequestError):
    """The request targets an address that isn't on the public internet."""


def is_public(address: IPAddress) -> bool:
    """Whether an address is publicly routable unicast.

    ``is_global`` excludes loopback, RFC 1918, CGNAT (100.64/10), link-local,
    unique-local (fc00::/7), unspecified, documentation and reserved ranges, but
    counts multicast as global, so that is checked separately. IPv6 forms that
    carry an IPv4 address are judged by that IPv4 address.
    """
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return is_public(address.ipv4_mapped)
        if address in _NAT64:
            return is_public(ipaddress.IPv4Address(int(address) & 0xFFFFFFFF))
    return address.is_global and not address.is_multicast


async def resolve(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(
        host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
    )
    return [str(info[4][0]) for info in infos]


async def public_address(host: str, port: int, resolver: Resolver = resolve) -> IPAddress:
    """The address to connect to for ``host``, or BlockedDestination.

    Every resolved address must be public, not just the one used, so a host can't
    mix a public and a private answer. IPv4 is preferred when both are available.
    """
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        try:
            found = await resolver(host, port)
        except OSError as exc:
            raise httpx.ConnectError(f"Could not resolve {host}") from exc
        # Drop any IPv6 zone index ("fe80::1%eth0") before parsing.
        addresses = [ipaddress.ip_address(a.split("%", 1)[0]) for a in found]
    else:
        addresses = [literal]
    if not addresses or not all(is_public(a) for a in addresses):
        raise BlockedDestination("Destination is not allowed")
    return min(addresses, key=lambda a: a.version)


class PublicOnlyTransport(httpx.AsyncBaseTransport):
    def __init__(self, inner: httpx.AsyncBaseTransport, resolver: Resolver = resolve):
        self.inner = inner
        self.resolver = resolver

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.scheme not in {"http", "https"} or not url.host:
            raise BlockedDestination("Destination is not allowed", request=request)
        port = url.port or (443 if url.scheme == "https" else 80)
        try:
            address = await public_address(url.host, port, self.resolver)
        except httpx.RequestError as exc:
            exc.request = request
            raise
        # The Host header was set from the original URL when the request was built,
        # and sni_hostname keeps TLS verifying the certificate against the hostname.
        # httpx reattaches the original request to the response, so response.url and
        # redirect resolution still see the hostname, not the address.
        pinned = httpx.Request(
            request.method,
            url.copy_with(host=str(address)),
            headers=request.headers,
            stream=request.stream,
            extensions={**request.extensions, "sni_hostname": url.host},
        )
        return await self.inner.handle_async_request(pinned)

    async def aclose(self) -> None:
        await self.inner.aclose()
