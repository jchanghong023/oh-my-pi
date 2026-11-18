"""Load into OMP Python eval. OMP supplies workpool, agent, and log in the cell."""
import asyncio
import json
import sys
from pathlib import Path


async def dispatch_scan(plan, script, model=None):
    directory = Path(plan["directory"])
    pending = plan["missing"]
    if not pending:
        return {"complete": plan["complete"], "pending": 0}
    options = {"model": model} if model else {}
    label = "big-review-" + plan["attempt"]
    messages = {}
    for shard in pending:
        messages[shard] = json.dumps({
            "read_and_follow_task_file": str(directory / "prompts" / f"{shard}.md"),
            "write_complete_report_to_draft": str(directory / "drafts" / f"{plan['attempt']}-{shard}.md"),
            "publish_argv_from_project_root": [
                sys.executable, str(script), "publish", plan["generation"], shard, plan["attempt"],
            ],
        }, ensure_ascii=False)
    pool = workpool("task", name=label, **options)
    status = pool.status()
    limit = status["limit"]
    if status["freshAgents"] and limit and 0 < limit <= 32:
        pool.push(*messages.values())
        return {"pool": label, "submitted": len(messages), "limit": limit}

    # Ordinary keep-alive pools can batch multiple shards in one conversation.
    # Independent handles retain per-shard context and respect the actual host cap.
    pool.close()
    slots = min(32, int(limit)) if limit and 0 < limit < 32 else 32
    semaphore = asyncio.Semaphore(slots)
    failed = []

    async def review(shard, message):
        async with semaphore:
            handle = None
            try:
                handle = agent(message, agent="task", label=f"{label}-{shard}", **options)
                await handle
                log(f"Finished shard {shard}")
            except asyncio.CancelledError:
                if handle is not None:
                    handle.cancel()
                raise
            except Exception as error:
                failed.append(shard)
                log(f"Shard {shard}: {error}")

    await asyncio.gather(*(review(shard, message) for shard, message in messages.items()))
    return {"submitted": len(messages), "failed": failed, "limit": slots}
