from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from podr.app import create_app
from podr.runtime import Runtime


@pytest.fixture
async def harness():
    payload = {"resultCount": 1, "results": [{"collectionId": 42, "collectionName": "Podr"}]}
    upstream = Mock(return_value=httpx.Response(200, json=payload))
    outbound = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    env = SimpleNamespace(
        FLAGS=SimpleNamespace(get=AsyncMock(return_value=None)),
        ANALYTICS=SimpleNamespace(writeDataPoint=Mock()),
        ANALYTICS_LAKE=SimpleNamespace(put=AsyncMock()),
    )
    runtime = Runtime(env, client=outbound)
    app = create_app(runtime)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://podr.test"
    ) as client:
        yield SimpleNamespace(
            client=client,
            upstream=upstream,
            env=env,
            runtime=runtime,
            service=app.state.service,
            app=app,
            payload=payload,
        )
        await runtime.drain()
    await outbound.aclose()
