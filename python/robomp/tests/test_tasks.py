import asyncio
import logging
import threading
from types import SimpleNamespace

import pytest

from robomp import tasks
from robomp.github_client import GitHubError, IssueInfo, RepoInfo


async def test_triage_issue_keeps_event_loop_live_while_workspace_setup_blocks(db, settings, monkeypatch, tmp_path):
    async def _resolve_repo_and_issue(_github, _payload):
        repo = RepoInfo(
            full_name="octo/widget",
            default_branch="main",
            clone_url="https://x/octo/widget.git",
            private=False,
        )
        issue = IssueInfo(
            repo="octo/widget",
            number=1,
            title="bug",
            body="b",
            state="open",
            author="alice",
            labels=(),
            is_pull_request=False,
        )
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve_repo_and_issue)

    async def _no_closing(*a, **k):
        return ()

    github = SimpleNamespace(list_closing_pull_requests=_no_closing)

    entered = threading.Event()
    release = threading.Event()
    captured: dict[str, object] = {}

    def _blocking_ensure(**_kwargs):
        entered.set()
        # True ONLY if a concurrent coroutine set `release` while we blocked here.
        # Blocks a WORKER THREAD (via to_thread) in the fixed code; blocks the
        # LOOP itself in the broken code.
        captured["release_seen_in_time"] = release.wait(1.0)
        return SimpleNamespace(branch="farm/x/y", session_dir=str(tmp_path / "sess"))

    sandbox = SimpleNamespace(natives_cache=None, ensure_workspace=_blocking_ensure)

    async def _noop_run_task(**_kwargs):
        return None

    monkeypatch.setattr(tasks, "run_task", _noop_run_task)

    async def _releaser():
        # Waits (off-loop) until ensure_workspace has actually started, then
        # releases it. This coroutine can ONLY make progress if the event loop
        # is live while ensure_workspace is blocking.
        await asyncio.to_thread(entered.wait, 1.0)
        assert entered.is_set(), "ensure_workspace never started"
        release.set()

    triage_task = asyncio.create_task(
        tasks.triage_issue(
            settings=settings,
            db=db,
            github=github,
            sandbox=sandbox,
            git_transport=SimpleNamespace(),
            payload={},
            delivery_id="d1",
        )
    )
    releaser_task = asyncio.create_task(_releaser())

    await asyncio.wait_for(triage_task, timeout=3.0)
    await asyncio.wait_for(releaser_task, timeout=1.0)

    assert captured.get("release_seen_in_time") is True, (
        "event loop was frozen during ensure_workspace: the concurrent releaser "
        "could not run, so release.wait timed out (this is the pre-fix hang)"
    )


async def test_run_workspace_op_drains_thread_before_propagating_cancel():
    started = threading.Event()
    proceed = threading.Event()
    finished = threading.Event()

    def slow_op(**_kwargs):
        started.set()
        # Block on the worker thread until the test releases us.
        assert proceed.wait(2.0), "proceed was never set — test bug"
        finished.set()
        return "done"

    task = asyncio.create_task(tasks._run_workspace_op(slow_op))
    # Wait (off-loop) until the worker thread is actually running.
    await asyncio.to_thread(started.wait, 1.0)
    assert started.is_set()

    async def pump(turns: int = 20) -> None:
        # Deterministically advance the loop without a wall-clock sleep: each
        # sleep(0) drains the ready queue, so a DETACHING (pre-fix) helper would
        # resolve `task` within these turns. A draining helper keeps it pending
        # while the worker thread is still blocked on `proceed`.
        for _ in range(turns):
            await asyncio.sleep(0)

    # Cancel the AWAITING coroutine while the thread is mid-flight, then a SECOND
    # time while it is still blocked. The repeated cancel must land on the drain
    # loop's re-`await` and be swallowed by its `continue` branch, NOT abandon
    # the thread. The whole sequence runs under try/finally so any failed assert
    # still releases the worker and cannot leak a blocked thread into later tests.
    try:
        task.cancel()
        await pump()
        assert not task.done(), "helper propagated the first cancel before the thread completed (thread abandoned)"
        task.cancel()
        await pump()
        # The thread is still blocked on `proceed`, so it has not finished and
        # the task has not resolved despite two cancels.
        assert not finished.is_set(), "thread finished before we released it — impossible unless abandoned"
        assert not task.done(), "helper abandoned the thread after a repeated cancel"
    finally:
        proceed.set()

    # The helper must now let the thread finish, THEN raise CancelledError.
    with pytest.raises(asyncio.CancelledError):
        await task
    # Deterministic in the fixed helper: the thread completed before the cancel propagated.
    assert finished.is_set(), "thread did not complete before cancellation propagated"


async def test_run_workspace_op_logs_worker_exception_on_concurrent_cancel(caplog):
    started = threading.Event()
    proceed = threading.Event()
    boom = RuntimeError("git exploded")

    def failing_op(**_kwargs):
        started.set()
        assert proceed.wait(2.0), "proceed was never set — test bug"
        raise boom

    task = asyncio.create_task(tasks._run_workspace_op(failing_op))
    await asyncio.to_thread(started.wait, 1.0)
    assert started.is_set()

    # Cancel the caller while the worker is still blocked (mid-flight), so the
    # helper enters its cancel-drain loop and is awaiting the shielded inner.
    task.cancel()
    await asyncio.sleep(0.05)

    with caplog.at_level(logging.WARNING, logger="robomp.tasks"):
        # Release the worker so inner completes WITH an exception while the
        # helper is draining -> the drain's `await shield(inner)` re-raises boom,
        # breaks the loop, and the guarded log.warning must fire.
        proceed.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings, "worker exception during cancel was not logged"
    assert any(r.exc_info and r.exc_info[1] is boom for r in warnings), (
        "the worker's exception was not attached to the warning"
    )


async def test_triage_issue_reopen_tears_down_finalized_workspace(db, settings, monkeypatch, tmp_path):
    """Re-triage of a finalized (reopened) issue must clear the stale workspace first.

    The prior branch was merged/deleted when the issue finalized, so a reopen has
    to branch afresh — mirroring the maintainer directive-reopen teardown.
    """

    async def _resolve_repo_and_issue(_github, _payload):
        repo = RepoInfo(
            full_name="octo/widget",
            default_branch="main",
            clone_url="https://x/octo/widget.git",
            private=False,
        )
        issue = IssueInfo(
            repo="octo/widget",
            number=1,
            title="bug",
            body="b",
            state="open",
            author="alice",
            labels=(),
            is_pull_request=False,
        )
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve_repo_and_issue)

    # The bot previously finalized this issue: a stale row + workspace exist.
    db.upsert_issue(key="octo/widget#1", repo="octo/widget", number=1, state="closed")

    calls: list[str] = []

    def _remove(**_kwargs):
        calls.append("remove")

    def _ensure(**_kwargs):
        calls.append("ensure")
        return SimpleNamespace(branch="farm/x/y", session_dir=str(tmp_path / "sess"))

    async def _fail_closing(*_a, **_k):
        raise AssertionError("closing-PR guard must not run when a DB row already exists")

    github = SimpleNamespace(list_closing_pull_requests=_fail_closing)
    sandbox = SimpleNamespace(natives_cache=None, ensure_workspace=_ensure, remove_workspace=_remove)

    async def _noop_run_task(**_kwargs):
        return None

    monkeypatch.setattr(tasks, "run_task", _noop_run_task)

    await tasks.triage_issue(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload={},
        delivery_id="d1",
    )

    # Teardown must precede re-provisioning, and the row resets to a live state.
    assert calls == ["remove", "ensure"]
    row = db.get_issue("octo/widget#1")
    assert row is not None
    assert row.state == "reproducing"


@pytest.mark.parametrize("branchless_mapping", [False, True])
@pytest.mark.parametrize("error", [GitHubError(502, "upstream connect error"), ValueError("unexpected")])
async def test_pr_metadata_fetch_failure(db, caplog, branchless_mapping, error):
    if branchless_mapping:
        db.upsert_issue(key="octo/widget#7", repo="octo/widget", number=7, state="opened", pr_number=12)

    async def fail(*_args):
        raise error

    async def resolve():
        return await tasks._resolve_issue_row_for_pr(
            db=db, github=SimpleNamespace(get_pull_request=fail), repo_full="octo/widget", pr_number=12
        )

    if isinstance(error, GitHubError):
        row, pr = await resolve()
        assert (row.number if row else None) == (7 if branchless_mapping else None)
        assert pr is None
        assert "PR metadata fetch failed" in caplog.text
    else:
        with pytest.raises(ValueError, match="unexpected"):
            await resolve()


@pytest.mark.parametrize(
    ("handler", "warning", "fetches", "failure_index"),
    [
        (tasks.review_pr, "review_pr fetch failed", ("get_repo", "get_issue", "get_pull_request"), 0),
        (tasks.review_pr, "review_pr fetch failed", ("get_repo", "get_issue", "get_pull_request"), 1),
        (tasks.review_pr, "review_pr fetch failed", ("get_repo", "get_issue", "get_pull_request"), 2),
        (tasks.handle_review, "review fetch failed", ("get_repo", "get_issue"), 0),
        (tasks.handle_review, "review fetch failed", ("get_repo", "get_issue"), 1),
        (tasks.handle_pr_conversation, "pr-conversation fetch failed", ("get_repo", "get_issue"), 0),
        (tasks.handle_pr_conversation, "pr-conversation fetch failed", ("get_repo", "get_issue"), 1),
    ],
)
@pytest.mark.parametrize("error", [GitHubError(502, "upstream connect error"), ValueError("unexpected")])
async def test_pr_handler_fetch_failure(
    db, settings, monkeypatch, caplog, handler, warning, fetches, failure_index, error
):
    if handler is not tasks.review_pr:
        db.upsert_issue(
            key="octo/widget#7", repo="octo/widget", number=7, state="opened", branch="farm/7", pr_number=12
        )

    calls = []

    def fetch(name, should_fail):
        async def run(*_args):
            calls.append(name)
            if should_fail:
                raise error
            return SimpleNamespace()

        return run

    async def unreachable(**_kwargs):
        raise AssertionError("agent must not run after fetch failure")

    monkeypatch.setattr(tasks, "run_task", unreachable)
    github = SimpleNamespace(**{name: fetch(name, index == failure_index) for index, name in enumerate(fetches)})

    async def invoke():
        return await handler(
            settings=settings,
            db=db,
            github=github,
            sandbox=SimpleNamespace(natives_cache=None),
            git_transport=SimpleNamespace(),
            payload={
                "repository": {"full_name": "octo/widget"},
                "pull_request": {"number": 12},
                "issue": {"number": 12},
            },
            delivery_id="d1",
        )

    if isinstance(error, GitHubError):
        assert await invoke() is None
        assert warning in caplog.text
    else:
        with pytest.raises(ValueError, match="unexpected"):
            await invoke()
    assert calls == list(fetches[: failure_index + 1])
