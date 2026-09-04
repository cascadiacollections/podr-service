"""SDK-shape tests; actual workerd interoperability still requires a Wrangler smoke test."""

import importlib
import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qs, urlparse

import pytest

from podr.runtime import CloudflareRuntime


@pytest.fixture
def workers_stub(monkeypatch):
    class Base:
        def __init__(self, ctx, env):
            self.ctx, self.env = ctx, env

    class Response:
        def __init__(self, body, status=200):
            self.body, self.status = body, status

    module = SimpleNamespace(
        DurableObject=Base,
        WorkerEntrypoint=Base,
        Response=Response,
        asgi=SimpleNamespace(fetch=AsyncMock()),
        fetch=AsyncMock(),
        wait_until=Mock(),
    )
    monkeypatch.setitem(sys.modules, "workers", module)
    monkeypatch.setitem(
        sys.modules,
        "js",
        SimpleNamespace(
            AbortSignal=SimpleNamespace(timeout=Mock(return_value="signal")),
            JSON=SimpleNamespace(parse=json.loads, stringify=json.dumps),
        ),
    )
    return module


async def test_sdk_fetch_uses_keywords_and_python_response(workers_stub):
    response = SimpleNamespace(
        text=AsyncMock(return_value='{"resultCount":0}'), status=200, status_text="OK", headers={}
    )

    async def fetch(url, **options):
        assert options["signal"] == "signal"
        assert options["headers"]["User-Agent"].startswith("Podr/")
        assert parse_qs(urlparse(url).query)["url"] == ["https://itunes.apple.com/search"]
        return response

    namespace = SimpleNamespace(
        idFromName=Mock(return_value="id"), get=Mock(return_value=SimpleNamespace(fetch=fetch))
    )
    runtime = CloudflareRuntime(SimpleNamespace(ITUNES_PROXY=namespace), None)
    result = await runtime.fetch("https://itunes.apple.com/search")
    assert result.json() == {"resultCount": 0}
    namespace.idFromName.assert_called_once_with("itunes-proxy")
    workers_stub.fetch.return_value = response
    await runtime.fetch("https://api.podcastindex.org/", proxy=False)
    assert workers_stub.fetch.call_count == 1


async def test_native_binding_values_and_background(workers_stub):
    runtime = CloudflareRuntime(SimpleNamespace(), None)
    assert runtime.native({"success": True}) == {"success": True}
    work = AsyncMock()
    runtime.defer(work())
    task = workers_stub.wait_until.call_args.args[0]
    await task
    work.assert_awaited_once()


@pytest.fixture
def entry(workers_stub):
    sys.modules.pop("entry", None)
    module = importlib.import_module("entry")
    yield module
    sys.modules.pop("entry", None)


async def test_container_readiness_and_idle_shutdown(entry):
    ready = SimpleNamespace(status=200)
    port = SimpleNamespace(fetch=AsyncMock(side_effect=[OSError("starting"), ready, ready]))
    container = SimpleNamespace(
        running=False, start=Mock(), getTcpPort=Mock(return_value=port), destroy=AsyncMock()
    )
    ctx = SimpleNamespace(container=container, storage=SimpleNamespace(setAlarm=AsyncMock()))
    proxy = entry.ITunesProxy(ctx, SimpleNamespace())
    result = await proxy.fetch("http://container/?url=https://itunes.apple.com")
    assert result.status == 200
    container.start.assert_called_once_with({"enableInternet": True})
    assert port.fetch.call_count == 3
    assert proxy.active == 0
    ctx.storage.setAlarm.assert_awaited_once()
    container.running = True
    await proxy.alarm()
    container.destroy.assert_awaited_once()
    proxy.active = 1
    await proxy.alarm()
    assert container.destroy.await_count == 1


async def test_scheduled_entrypoint(entry, monkeypatch):
    service = SimpleNamespace(warm=AsyncMock())
    monkeypatch.setattr(entry, "Podcasts", Mock(return_value=service))
    worker = entry.Default(SimpleNamespace(), SimpleNamespace())
    await worker.scheduled(SimpleNamespace())
    service.warm.assert_awaited_once()
