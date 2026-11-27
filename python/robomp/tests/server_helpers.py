"""Worker-pool isolation for tests of the real FastAPI app."""

from __future__ import annotations

from robomp.config import Settings
from robomp.db import Database
from robomp.github_backend import GitHubBackend
from robomp.proxy_client import ProxyGitTransport
from robomp.sandbox import SandboxManager


class _PausedPool:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False

    async def start(self) -> None:
        self.started = True

    async def stop(self, *, drain_timeout: float = 25.0, kill_timeout: float = 5.0) -> None:
        self.stopped = True

    def wake(self) -> None:
        pass

    async def cancel_event(self, delivery_id: str) -> bool:
        return False

    async def inflight_snapshot(self) -> list[str]:
        return []


class PausedPoolFactory:
    """Keep lifecycle tracking without startup reaping or background dispatch."""

    def __init__(self) -> None:
        self.pools: list[_PausedPool] = []

    def __call__(
        self,
        settings: Settings,
        db: Database,
        github: GitHubBackend,
        sandbox: SandboxManager,
        git_transport: ProxyGitTransport,
    ) -> _PausedPool:
        pool = _PausedPool()
        self.pools.append(pool)
        return pool
