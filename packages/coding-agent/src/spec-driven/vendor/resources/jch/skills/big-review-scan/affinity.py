"""Order owned files using local import edges and nearby implementation/test pairs."""
import collections
import posixpath
import re
import subprocess

SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs")
JS_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.[^'"\n]+)['"]""")
PY_IMPORT = re.compile(r"(?m)^\s*from\s+(\.+)([\w.]*)\s+import\s+(\w+)")
RUST_MOD = re.compile(r"(?m)^\s*(?:pub\s+)?mod\s+(\w+)\s*;")
TEST_NAME = re.compile(r"(^test_|_test$|[._-](?:test|spec)$)")


def related_paths(path, source):
    parent = posixpath.dirname(path)
    if path.endswith(".py"):
        for dots, module, name in PY_IMPORT.findall(source):
            package = posixpath.join(parent, *([".."] * (len(dots) - 1)))
            yield posixpath.join(package, module.replace(".", "/") or name)
    elif path.endswith(".rs"):
        directory = parent if posixpath.basename(path) in ("mod.rs", "lib.rs", "main.rs") else path[:-3]
        for name in RUST_MOD.findall(source):
            yield posixpath.join(directory, name)
    else:
        for relative in JS_IMPORT.findall(source):
            yield posixpath.join(parent, relative)


def dependency_order(units):
    paths = {u.path for u in units}
    sources = [u for u in units if u.path.endswith(SUFFIXES) and u.oid]
    neighbors = collections.defaultdict(set)
    pairs = collections.defaultdict(set)
    by_stem = collections.defaultdict(list)
    for u in sources:
        stem = posixpath.splitext(posixpath.basename(u.path))[0]
        by_stem[TEST_NAME.sub("", stem)].append((stem, u.path))
    for stem, group in by_stem.items():
        implementations = [path for name, path in group if name == stem]
        if len(implementations) == 1:
            for name, test in group:
                if name != stem:
                    pairs[test].add(implementations[0])
                    pairs[implementations[0]].add(test)

    # A single Git process serves immutable blob IDs, including deleted files.
    if sources:
        with subprocess.Popen(["git", "cat-file", "--batch"],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE) as proc:
            for u in sorted(sources, key=lambda u: u.path):
                proc.stdin.write(u.oid.encode() + b"\n")
                proc.stdin.flush()
                meta = proc.stdout.readline().split()
                if len(meta) != 3:
                    raise ValueError(f"Cannot read owned source {u.path!r}")
                size = int(meta[-1])
                sample = proc.stdout.read(min(size, 96 * 1024))
                left = size - len(sample)
                while left:
                    block = proc.stdout.read(min(left, 65536))
                    if not block:
                        raise ValueError("Incomplete git object")
                    left -= len(block)
                if proc.stdout.read(1) != b"\n":
                    raise ValueError("Incomplete git cat-file record")
                for relative in related_paths(u.path, sample.decode(errors="replace")):
                    target = posixpath.normpath(relative)
                    stem, ext = posixpath.splitext(target)
                    if ext in (".js", ".mjs", ".cjs"):
                        target = stem
                    choices = [relative, target, *(target + ext for ext in SUFFIXES),
                               *(target + "/index" + ext for ext in SUFFIXES), target + "/mod.rs",
                               target + "/__init__.py"]
                    for candidate in choices:
                        resolved = posixpath.normpath(candidate)
                        if resolved in paths and resolved != u.path:
                            neighbors[u.path].add(resolved)
                            neighbors[resolved].add(u.path)
                            break
            proc.stdin.close()
            if proc.wait():
                raise ValueError("git cat-file failed while grouping dependencies")
    ranks = {}
    for start in sorted(paths):
        stack = [start]
        while stack:
            path = stack.pop()
            if path in ranks:
                continue
            ranks[path] = len(ranks)
            stack.extend(sorted((p for p in neighbors[path] if p not in ranks), reverse=True))
            stack.extend(sorted((p for p in pairs[path] if p not in ranks), reverse=True))
    return ranks
