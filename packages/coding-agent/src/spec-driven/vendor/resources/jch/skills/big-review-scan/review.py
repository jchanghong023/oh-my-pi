"""Plan and resume OMP big reviews. Python 3.11 standard library and local Git."""
import argparse
import bisect
import heapq
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import uuid
from contextlib import closing
from dataclasses import dataclass, replace
from pathlib import Path
from string import Template

sys.dont_write_bytecode = True
from affinity import dependency_order


def git(*args):
    return subprocess.check_output(["git", "--literal-pathspecs", *args])


BASELINE = "openspec/specs/fork-upstream-baseline/spec.md"
DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"]


def fork_base(head, explicit):
    if explicit is not None:
        return resolve_base(head, explicit)
    if git("ls-tree", head, "--", BASELINE):
        spec = git("show", f"{head}:{BASELINE}").decode()
        matches = re.findall(r"(?m)^[-*] \*\*Upstream commit\*\*[：:]\s*\x60([0-9a-f]{40}|[0-9a-f]{64})\x60\s*$", spec)
        if len(matches) != 1:
            raise ValueError(f"{BASELINE}: expected one recorded Upstream commit; supply --base REF to override")
        return resolve_base(head, matches[0])
    try:
        ref = git("symbolic-ref", "--quiet", "refs/remotes/upstream/HEAD").decode().strip()
        bases = git("merge-base", "--all", head, ref).decode().splitlines()
    except subprocess.CalledProcessError as exc:
        raise ValueError("Cannot resolve the local upstream default branch and merge base; supply --base REF") from exc
    if len(bases) != 1:
        raise ValueError("Cannot determine a unique integrated upstream base; supply --base REF")
    return bases[0]


def resolve_base(head, ref):
    try:
        base = git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").decode().strip()
    except subprocess.CalledProcessError as exc:
        raise ValueError(f"Invalid baseline {ref!r}; supply a commit or ref with --base") from exc
    if subprocess.run(["git", "merge-base", "--is-ancestor", base, head], check=False).returncode:
        raise ValueError(f"Baseline {ref!r} is not an ancestor of the target commit")
    return base


@dataclass(frozen=True)
class Unit:
    path: str
    weight: int
    kind: str
    old: str = ""
    oid: str = ""
    first: int = 0
    last: int = 0

    def describe(self):
        fields = {"path": self.path, "kind": self.kind}
        if self.old:
            fields["old_path"] = self.old
        if self.first:
            fields["补丁行" if self.kind != "file" else "源码行"] = [self.first, self.last]
        return json.dumps(fields, ensure_ascii=False)


def inventory(head, base):
    if not base:
        items = []
        for row in git("ls-tree", "-rlz", head).split(b"\0")[:-1]:
            meta, path = row.split(b"\t", 1)
            mode, kind, oid, size = meta.split()
            normal = kind == b"blob" and mode.startswith(b"100")
            items.append(Unit(os.fsdecode(path), max(1, int(size)) if normal else 1,
                              "file" if normal else mode.decode(), oid=oid.decode() if normal else ""))
        return items

    options = [*DIFF, "--diff-filter=DMRT", "-z"]
    records = iter(git(*options, "--raw", "--no-abbrev", base, head).split(b"\0")[:-1])
    files = []
    for header in records:
        old_mode, new_mode, old_oid, new_oid, status = header.lstrip(b":").split()
        old = os.fsdecode(next(records))
        renamed = status.startswith(b"R")
        path = os.fsdecode(next(records)) if renamed else old
        mode, oid = (old_mode, old_oid) if status == b"D" else (new_mode, new_oid)
        files.append((status[:1].decode(), path, old if renamed else "",
                      oid.decode() if mode.startswith(b"100") else ""))

    weights = {}
    records = iter(git(*options, "--numstat", base, head).split(b"\0")[:-1])
    for row in records:
        added, removed, path = row.split(b"\t", 2)
        if not path:  # rename: empty pathname followed by old and new names
            next(records)
            path = next(records)
        weights[os.fsdecode(path)] = 1 if added == b"-" else max(1, int(added) + int(removed))
    return [Unit(path, weights[path], kind, old, oid) for kind, path, old, oid in files]


# Prefer declaration and hunk boundaries near a balanced cut. Only real changed
# lines can start a new fork assignment, including deletions.
DECLARATION = re.compile(rb"^\s*(?:(?:export|default|async|pub|public|private|static|abstract)\s+)*(?:def|class|function|interface|enum|type|fn|struct|impl|trait|func)\b")


def split_points(unit, head, base):
    if base:
        if unit.weight == 1:
            return 0, [], []
        paths = [unit.old, unit.path] if unit.old else [unit.path]
        args = [*DIFF, "--unified=3", base, head, "--", *paths]
    elif unit.kind == "file":
        args = ["cat-file", "blob", unit.oid]
    else:
        return 0, [], []
    preferred, changed = [], []
    lines = 0
    with subprocess.Popen(["git", "--literal-pathspecs", *args], stdout=subprocess.PIPE) as proc:
        if b"\0" in proc.stdout.peek(8192)[:8192]:
            proc.stdout.close()
            proc.wait()
            return 0, [], []
        in_hunk = False
        first_change = False
        for lines, row in enumerate(proc.stdout, 1):
            if base:
                if row.startswith(b"@@ "):
                    in_hunk = first_change = True
                elif in_hunk and row[:1] in (b"+", b"-"):
                    changed.append(lines)
                    if first_change or DECLARATION.match(row[1:]):
                        preferred.append(lines)
                    first_change = False
            elif DECLARATION.match(row):
                preferred.append(lines)
        if proc.wait():
            raise ValueError(f"Cannot inspect {unit.path!r} at the pinned revision")
    return lines, preferred, changed


def cut_at(first, last, preferred, changed, patch):
    low = first + 1
    if patch:
        # Keep at least one actually changed line in each half.
        left = bisect.bisect_left(changed, first)
        right = bisect.bisect_right(changed, last)
        if right - left < 2:
            return None
        low = changed[left + 1]
        midpoint = changed[(left + right) // 2]
    else:
        if first >= last:
            return None
        midpoint = (first + last + 1) // 2
    pos = bisect.bisect_left(preferred, midpoint)
    nearby = [v for v in preferred[max(0, pos - 1):pos + 1]
              if low <= v <= last and abs(v - midpoint) <= (last - first) / 5]
    return min(nearby, key=lambda v: abs(v - midpoint)) if nearby else midpoint


def partition(units, count, head, base):
    if not units:
        raise ValueError("The requested scope has no reviewable changes or files")
    # Split the heaviest text only when needed. Then pack adjacent paths together.
    target = max(1, math.ceil(sum(unit.weight for unit in units) / count))
    queue = [(-u.weight, i, u) for i, u in enumerate(units)]
    heapq.heapify(queue)
    serial = len(queue)
    ready = []
    boundaries = {}
    while queue:
        _, _, unit = heapq.heappop(queue)
        need_more = len(queue) + len(ready) + 1 < count
        if not need_more and unit.weight <= target:
            ready.append(unit)
            continue
        first = unit.first or 1
        if unit.path not in boundaries:
            boundaries[unit.path] = split_points(unit, head, base)
        lines, preferred, changed = boundaries[unit.path]
        last = unit.last or lines
        cut = cut_at(first, last, preferred, changed, bool(base))
        if cut is None:
            ready.append(unit)
            continue
        for start, end in [(first, cut - 1), (cut, last)]:
            weight = max(1, round(unit.weight * (end - start + 1) / (last - first + 1)))
            piece = replace(unit, weight=weight, first=start, last=end)
            heapq.heappush(queue, (-weight, serial, piece))
            serial += 1
    if len(ready) < count:
        raise ValueError(f"Only {len(ready)} nonempty units available for {count} shards")
    ranks = dependency_order(units)
    ready.sort(key=lambda u: (ranks[u.path], u.first))
    remaining = sum(u.weight for u in ready)
    shards, batch, weight = [], [], 0
    for i, unit in enumerate(ready):
        slots = count - len(shards)
        if batch and slots > 1 and (
            len(ready) - i == slots - 1 or weight + unit.weight / 2 >= remaining / slots
        ):
            shards.append(batch)
            remaining -= weight
            batch, weight = [], 0
        batch.append(unit)
        weight += unit.weight
    return [*shards, batch]


def number(i):
    return f"{i:03d}"


def generate(directory, mode, count, head, base):
    batches = partition(inventory(head, base), count, head, base)
    template = Template(Path(__file__).with_name("shard.md").read_text(encoding="utf-8"))
    for folder in ["prompts", "reports", "drafts"]:
        (directory / folder).mkdir(parents=True)
    for i, units in enumerate(batches, 1):
        name = number(i)
        prompt = template.substitute(shard=name, root=Path.cwd(), mode=mode,
                                     head=head, base=base or "—", generation=directory.name,
                                     units="\n".join(u.describe() for u in units),
                                     report=directory / "reports" / f"{name}.md")
        (directory / "prompts" / f"{name}.md").write_text(prompt, encoding="utf-8", errors="backslashreplace")


def nonempty(path):
    return path.is_file() and not path.is_symlink() and bool(path.read_bytes().strip())


def command(args, db, state):
    db.execute("BEGIN IMMEDIATE")
    db.execute("CREATE TABLE IF NOT EXISTS active (generation TEXT, mode TEXT, count INTEGER, head TEXT, base TEXT)")
    active = db.execute("SELECT * FROM active").fetchone()
    if active and not (state / active[0]).is_dir():
        db.execute("DELETE FROM active")
        active = None
    if args.action == "plan":
        if not active or args.init:
            head = git("rev-parse", "--verify", "HEAD^{commit}").decode().strip()
            base = fork_base(head, args.base) if args.mode == "fork" else ""
            generation = uuid.uuid4().hex
            new = state / generation
            try:
                generate(new, args.mode, args.count, head, base)
            except BaseException:
                if new.exists():
                    shutil.rmtree(new)
                raise
            active = (generation, args.mode, args.count, head, base)
            db.execute("DELETE FROM active")
            db.execute("INSERT INTO active VALUES (?, ?, ?, ?, ?)", active)
            if args.init:
                # Do not discard the previous run until its replacement is ready.
                for folder in state.iterdir():
                    if folder != new and re.fullmatch("[a-f0-9]{32}", folder.name) and folder.is_dir():
                        shutil.rmtree(folder)
        elif active[1:3] != (args.mode, args.count) or (
            args.base is not None and resolve_base(active[3], args.base) != active[4]
        ):
            raise ValueError("Active mode, shard count or base differs. Use init to replace this run.")
    if not active:
        raise ValueError("No active big-review scan")
    generation, mode, count, head, base = active
    if not re.fullmatch("[a-f0-9]{32}", generation):
        raise ValueError("Invalid generation")
    directory = state / generation
    if args.action == "publish":
        if generation != args.generation or not 1 <= args.shard <= count:
            raise ValueError("Stale run or unknown shard")
        if not re.fullmatch("[a-f0-9]{32}", args.attempt):
            raise ValueError("Invalid attempt")
        name = number(args.shard)
        draft = directory / "drafts" / f"{args.attempt}-{name}.md"
        report = directory / "reports" / f"{name}.md"
        if not nonempty(report):
            if not nonempty(draft):
                raise ValueError("Missing or empty draft")
            os.replace(draft, report)
        return {"shard": name, "report": str(report)}
    missing = []
    for i in range(1, count + 1):
        name = number(i)
        if not nonempty(directory / "prompts" / f"{name}.md"):
            raise ValueError(f"Missing task file {name}; use init to rebuild")
        if not nonempty(directory / "reports" / f"{name}.md"):
            missing.append(name)
    return dict(generation=generation, directory=str(directory.resolve()), mode=mode,
                head=head, base=base, total=count, complete=count-len(missing), missing=missing,
                attempt=uuid.uuid4().hex, python_executable=sys.executable)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="action", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("mode", choices=["full", "fork"])
    plan.add_argument("count", type=int)
    plan.add_argument("init", choices=["init"], nargs="?")
    plan.add_argument("--base", metavar="REF", help="explicit ancestor commit or ref (fork only)")
    commands.add_parser("status")
    publish = commands.add_parser("publish")
    publish.add_argument("generation")
    publish.add_argument("shard", type=int)
    publish.add_argument("attempt")
    args = parser.parse_args()
    if args.action == "plan":
        if args.count < 1:
            plan.error("Shard count must be positive")
        if args.mode != "fork" and args.base is not None:
            plan.error("--base requires fork mode")
    os.chdir(os.fsdecode(git("rev-parse", "--show-toplevel").rstrip(b"\n")))
    git_dir = Path(os.fsdecode(git("rev-parse", "--absolute-git-dir").rstrip(b"\n"))).resolve()
    state = git_dir / "omp-big-review"
    if state.resolve() != state:
        raise ValueError("Review workspace must be inside this worktree's Git metadata directory")
    database = state / "state.sqlite3"
    if args.action != "plan" and not database.is_file():
        raise ValueError("No active big-review scan")
    state.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(database, timeout=60)) as db, db:
        result = command(args, db, state)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, sqlite3.Error, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
