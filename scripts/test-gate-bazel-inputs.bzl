"""Cache successful Bun input discovery using Bazel's native filesystem inputs."""

_ENVIRONMENT = [
    "PATH", "Path", "PATHEXT", "NODE_PATH", "NODE_OPTIONS", "NODE_ENV",
    "BUN_OPTIONS", "BUN_INSTALL", "BUN_CONFIG_NO_BUNRC", "BUN_CONFIG_FILE",
    "HOME", "USERPROFILE", "XDG_CONFIG_HOME",
]

def _input_identity(ctx, source):
    # Fold Windows case aliases, not symlink identities or case-sensitive hosts.
    identity = str(source).replace("\\", "/")
    return identity.lower() if "windows" in ctx.os.name.lower() else identity

def _watch_input(ctx, source, watched):
    identity = _input_identity(ctx, source)
    if identity not in watched:
        ctx.watch(source)
        watched[identity] = True

def _watch_installed(ctx, modules, watched, workspaces):
    # Enumerate node_modules explicitly: watching its entire tree would include
    # the gate's own .cache output and invalidate discovery on every invocation.
    pending = [modules]
    for _depth in range(128):
        if not pending:
            return
        following = []
        for directory in pending:
            ctx.watch(directory)
            if not directory.exists or not directory.is_dir:
                continue
            identity = str(directory.realpath)
            if identity in watched:
                continue
            watched[identity] = True
            candidates = []
            for child in directory.readdir(watch = "yes"):
                if child.basename in [".cache", ".git", ".bin"]:
                    continue
                if child.basename == ".bun" and child.is_dir:
                    # Bun's isolated linker stores real packages below these
                    # roots, with the public package entries merely symlinks.
                    for store in child.readdir(watch = "yes"):
                        if store.is_dir:
                            following.append(store.get_child("node_modules"))
                        else:
                            ctx.watch(store)
                elif child.basename.startswith("@") and child.is_dir:
                    candidates.extend(child.readdir(watch = "yes"))
                else:
                    candidates.append(child)
            for package in candidates:
                ctx.watch(package)
                if not package.exists:
                    continue
                if not package.is_dir:
                    continue
                actual = package.realpath
                normalized = str(actual).replace("\\", "/").rstrip("/")
                # A link to the whole workspace (or its ancestor) must never
                # turn the installed closure into a watch of gate outputs.
                workspace_package = False
                for workspace in workspaces:
                    if workspace == normalized or workspace.startswith(normalized + "/"):
                        fail("Installed package points at the workspace or its ancestor: " + str(package))
                    # Both fixture and implementation workspaces may have
                    # package links back toward their own gate cache tree.
                    if normalized.startswith(workspace + "/") and not normalized.startswith(workspace + "/node_modules/"):
                        workspace_package = True
                if workspace_package:
                    following.append(actual.get_child("node_modules"))
                    continue
                key = "package:" + str(actual)
                if key in watched:
                    continue
                watched[key] = True
                ctx.watch_tree(actual)
                following.append(actual.get_child("node_modules"))
        pending = following
    fail("Installed dependency nesting exceeds 128 directories")

def _watch_ancestry(ctx, directory, directories):
    for _depth in range(128):
        identity = str(directory)
        if identity in directories:
            return
        directories[identity] = directory
        for name in ["package.json", "bunfig.toml", "tsconfig.json", "tsconfig.base.json"]:
            ctx.watch(directory.get_child(name))
        parent = directory.dirname
        if not parent or str(parent) == identity:
            return
        directory = parent
    fail("Input discovery configuration ancestry exceeds 128 directories")

def _watch_helper_packages(ctx):
    # Only declared runtime packages belong to the helper's installed closure.
    # Do not watch a whole hoisted node_modules tree, including nested stores.
    for candidate in ctx.attr.helper_paths:
        ctx.watch(ctx.path(candidate))
    pending = [ctx.path(package) for package in ctx.attr.helper_packages]
    visited = {}
    for _depth in range(128):
        if not pending:
            return
        following = []
        for directory in pending:
            ctx.watch(directory)
            if not directory.exists or not directory.is_dir:
                continue
            identity = str(directory.realpath)
            if identity in visited:
                continue
            visited[identity] = True
            for child in directory.readdir(watch = "yes"):
                # Each nested dependency is resolved independently from its
                # importing package and registered through helper_packages.
                if child.basename in ["node_modules", ".git"]:
                    continue
                ctx.watch(child)
                if child.is_dir:
                    following.append(child)
        pending = following
    fail("Input discovery helper package nesting exceeds 128 directories")

def _gate_inputs_repository_impl(ctx):
    root = ctx.path(ctx.attr.root)
    runner = ctx.path(ctx.attr.runner)
    ctx.watch(ctx.path(ctx.attr.bun))
    ctx.watch(runner)
    # The helper imports these implementation files, including the real parser
    # loaded from its own checkout rather than a temporary fixture checkout.
    for name in ["test-gate-bazel-inputs.ts", "test-gate-bazel-resources.ts", "test-gate-runtime.ts"]:
        ctx.watch(runner.dirname.get_child(name))
    environment = {}
    for name in _ENVIRONMENT:
        value = ctx.getenv(name)
        if value != None:
            environment[name] = value
    for name in ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"]:
        if name in environment:
            ctx.watch(ctx.path(environment[name]).get_child(".bunfig.toml"))
    if environment.get("BUN_CONFIG_FILE"):
        config = environment["BUN_CONFIG_FILE"]
        ctx.watch(ctx.path(config) if config.startswith("/") or ":" in config else root.get_child(config))
    directories = {}
    _watch_ancestry(ctx, root, directories)
    # Helper configuration ancestry is still an input, but must not enlarge
    # the consumer's installed-package inventory for a custom-root fixture.
    _watch_ancestry(ctx, runner.dirname, {})
    _watch_helper_packages(ctx)
    for command in json.decode(ctx.attr.commands):
        if command.get("cwd"):
            cwd = command["cwd"]
            _watch_ancestry(ctx, ctx.path(cwd) if cwd.startswith("/") or ":" in cwd else root.get_child(cwd), directories)
    # Both tracked and untracked inventory paths are attrs, so additions and
    # deletions invalidate even when no previously discovered edge names them.
    input_watches = {}
    for relative in ctx.attr.files:
        source = root.get_child(relative)
        _watch_input(ctx, source, input_watches)
        _watch_ancestry(ctx, source.dirname, directories)
    watched = {}
    workspaces = [
        str(root.realpath).replace("\\", "/").rstrip("/"),
        str(runner.dirname.dirname.realpath).replace("\\", "/").rstrip("/"),
    ]
    for directory in directories.values():
        _watch_installed(ctx, directory.get_child("node_modules"), watched, workspaces)
    if environment.get("NODE_PATH"):
        separator = ";" if "windows" in ctx.os.name.lower() else ":"
        for entry in environment["NODE_PATH"].split(separator):
            if entry:
                module_path = ctx.path(entry) if entry.startswith("/") or ":" in entry else root.get_child(entry)
                _watch_installed(ctx, module_path, watched, workspaces)
    request = json.encode({
        "root": str(root),
        "files": ctx.attr.files,
        "commands": json.decode(ctx.attr.commands),
        "output": str(ctx.path("graph.json")),
    })
    # The full inventory exceeds Windows' native command-line limit. Transport
    # the request by file and remove it after successful repository evaluation.
    ctx.file("request.json", request, executable = False)
    result = ctx.execute(
        [ctx.attr.bun, str(runner), str(ctx.path("request.json"))],
        working_directory = str(root),
        environment = environment,
        quiet = True,
    )
    if result.return_code:
        fail("Bun input discovery failed (no graph cached):\n%s\n%s" % (result.stdout, result.stderr))
    if result.stdout.strip():
        print(result.stdout.strip())
    graph = json.decode(ctx.read("graph.json", watch = "no"))
    # Ignored assets/configuration files reached by real resolution are inputs
    # too. Register them after discovery without computing a parallel digest.
    for relative in graph["files"]:
        _watch_input(ctx, root.get_child(relative), input_watches)
    # Bun keeps existing file contents and compresses missing lookups to their
    # nearest observable ancestor. Empty/nested resource directories remain
    # separate shallow boundaries; never recursively watch an output tree.
    resolution_directories = {}
    for candidate in graph["resolutionPaths"]:
        source = ctx.path(candidate)
        _watch_input(ctx, source, input_watches)
        identity = _input_identity(ctx, source)
        if identity not in resolution_directories and source.exists and source.is_dir:
            resolution_directories[identity] = True
            source.readdir(watch = "yes")
    # Inventory and per-command wrappers are irrelevant to native cycle
    # ownership. Keep the query repository's input stable when only those
    # change, without discarding any real module/configuration edges.
    cycle_deps = {}
    if graph["cycleRoots"]:
        for name in sorted(graph["deps"]):
            if not name.startswith("command_"):
                cycle_deps[name] = sorted(graph["deps"][name])
    ctx.file("cycles.json", json.encode({
        "deps": cycle_deps,
        "cycleRoots": sorted(graph["cycleRoots"]),
    }) + "\n", executable = False)
    ctx.file("BUILD.bazel", 'exports_files(["graph.json", "cycles.json"], visibility = ["//visibility:public"])\n')
    ctx.delete("request.json")

gate_inputs_repository = repository_rule(
    implementation = _gate_inputs_repository_impl,
    attrs = {
        "root": attr.string(mandatory = True),
        "files": attr.string_list(mandatory = True),
        "commands": attr.string(mandatory = True),
        "bun": attr.string(mandatory = True),
        "runner": attr.string(mandatory = True),
        "helper_packages": attr.string_list(mandatory = True),
        "helper_paths": attr.string_list(mandatory = True),
    },
)
