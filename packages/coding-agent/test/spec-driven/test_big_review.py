"""Run with Python 3.11+: exercise the bundled skills' public file/CLI contract."""
import asyncio
import json
import runpy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = (Path(__file__).resolve().parents[2] / "src/spec-driven/vendor/resources/"
          "jch/skills/big-review-scan/review.py")


class BigReviewTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Review test")
        self.git("config", "user.email", "review@example.test")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root).decode().strip()

    def write(self, rel, data):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8")

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "snapshot")
        return self.git("rev-parse", "HEAD")

    def run_cli(self, *args, fail=False):
        p = subprocess.run([sys.executable, "-B", SCRIPT, *args], cwd=self.root,
                           capture_output=True, text=True)
        if fail:
            self.assertNotEqual(p.returncode, 0)
            return p.stderr
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def units(self, state):
        result = []
        for prompt in sorted((Path(state["directory"]) / "prompts").glob("*.md")):
            rows = [json.loads(line) for line in prompt.read_text().splitlines() if line.startswith("{")]
            self.assertTrue(rows)
            result.extend(rows)
        return result

    def test_fork_owns_changed_deleted_and_renamed_paths_only(self):
        self.write("src/a.ts", "export const value = 1;\n")
        self.write("src/deleted.ts", "export const obsolete = 0;\n")
        self.write("old.txt", "source that is only renamed\n")
        self.write("keep.txt", "unchanged\n")
        base = self.commit()
        self.git("update-ref", "refs/remotes/upstream/main", base)
        (self.root / "old.txt").rename(self.root / "new.txt")
        (self.root / "src/deleted.ts").unlink()
        self.write("src/a.ts", 'export {value} from "./context.js";\n')
        self.write("src/context.ts", "export const value = 2;\n")
        self.commit()
        state = self.run_cli("plan", "fork", "3")
        self.assertEqual(state["base"], base)
        rows = self.units(state)
        self.assertEqual({(u["path"], u["kind"]) for u in rows},
                         {("src/a.ts", "M"), ("src/deleted.ts", "D"), ("new.txt", "R")})
        self.assertEqual(next(u for u in rows if u["kind"] == "R")["old_path"], "old.txt")

    def test_split_ranges_cover_every_line_and_resume_uses_pinned_snapshot(self):
        self.write("lib.py", "".join(f"def f{i}():\n    return {i}\n" for i in range(256)))
        head = self.commit()
        state = self.run_cli("plan", "full", "128")
        ranges = sorted(u["源码行"] for u in self.units(state))
        self.assertEqual([line for a, b in ranges for line in range(a, b + 1)], list(range(1, 513)))
        current = Path(state["directory"])
        self.write(".git/info/exclude", ".omp/\n")
        self.write("later.txt", "changed head\n")
        self.commit()
        self.assertEqual(self.run_cli("plan", "full", "128")["head"], head)
        args = [state["generation"], "042", state["attempt"]]
        draft = current / "drafts" / f"{state['attempt']}-042.md"
        draft.write_text("  \n")
        self.run_cli("publish", *args, fail=True)
        draft.write_text("Free prose, no headings or priority fields.")
        self.assertEqual(self.run_cli("status")["complete"], 0)
        self.run_cli("publish", *args)
        self.run_cli("publish", *args)
        self.assertEqual(self.run_cli("status")["complete"], 1)
        self.assertNotIn("042", self.run_cli("plan", "full", "128")["missing"])
        self.run_cli("plan", "full", "2", fail=True)
        self.assertTrue(current.exists())
        replacement = self.run_cli("plan", "full", "2", "init")
        self.assertFalse(current.exists())
        self.assertEqual(replacement["complete"], 0)
        self.run_cli("publish", *args, fail=True)

    def test_init_removes_old_directory_even_if_new_scope_is_empty(self):
        self.write("only.txt", "one\n")
        head = self.commit()
        self.git("update-ref", "refs/remotes/upstream/main", head)
        state = self.run_cli("plan", "full", "1")
        self.run_cli("plan", "fork", "2", "init", fail=True)
        self.assertFalse(Path(state["directory"]).exists())
        self.run_cli("status", fail=True)
        self.run_cli("plan", "full", "1")

    def test_local_dependency_stays_with_its_owner_when_capacity_allows(self):
        for name in ("a.ts", "b.ts", "y.ts", "z.ts"):
            self.write(name, 'import "./z";\n' if name == "a.ts" else "// padding 12\n")
        self.commit()
        state = self.run_cli("plan", "full", "2")
        prompts = sorted((Path(state["directory"]) / "prompts").glob("*.md"))
        contents = [p.read_text() for p in prompts]
        self.assertTrue(any('"a.ts"' in text and '"z.ts"' in text for text in contents))


class EvalDispatchTest(unittest.IsolatedAsyncioTestCase):
    async def test_fresh_workpool_pushes_only_missing_shards(self):
        submitted = []

        class Pool:
            def status(self):
                return {"limit": 32, "freshAgents": True}

            def push(self, *messages):
                submitted.extend(json.loads(message) for message in messages)

        def create_pool(kind, **options):
            self.assertEqual((kind, options["model"]), ("task", "configured/small"))
            return Pool()

        dispatch = runpy.run_path(str(SCRIPT.with_name("dispatch.py")),
                                  init_globals={"workpool": create_pool})["dispatch_scan"]
        plan = {"directory": "/review", "attempt": "a", "generation": "g", "missing": ["002", "041"]}
        await dispatch(plan, SCRIPT, "configured/small")
        self.assertEqual([item["publish_argv_from_project_root"][-3:] for item in submitted],
                         [["g", "002", "a"], ["g", "041", "a"]])

    async def test_reuse_host_gets_one_independent_handle_per_item_with_rolling_limit(self):
        class Pool:
            def status(self):
                return {"limit": 32, "freshAgents": False}

            def close(self):
                pass

        running = set()
        maximum = 0
        seen = set()
        last_started = asyncio.Event()

        async def fake_agent(message, **options):
            nonlocal maximum
            shard = Path(json.loads(message)["read_and_follow_task_file"]).stem
            self.assertNotIn(shard, seen)
            seen.add(shard)
            running.add(shard)
            maximum = max(maximum, len(running))
            if shard == "001":
                await asyncio.wait_for(last_started.wait(), 3)
            else:
                await asyncio.sleep(0)
            if shard == "128":
                last_started.set()
            running.remove(shard)

        helpers = {"workpool": lambda *a, **kw: Pool(), "agent": fake_agent, "log": lambda _: None}
        dispatch = runpy.run_path(str(SCRIPT.with_name("dispatch.py")), init_globals=helpers)["dispatch_scan"]
        state = {"directory": "/review", "generation": "x", "attempt": "y",
                 "missing": [f"{i:03d}" for i in range(1, 129)]}
        result = await dispatch(state, SCRIPT)
        self.assertEqual(result["failed"], [])
        self.assertEqual(maximum, 32)
        self.assertEqual(len(seen), 128)


if __name__ == "__main__":
    unittest.main()
