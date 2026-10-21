"""Bazel-cached input graphs, native cycle domains and path-only source overlays.

All-source inputs reuse the native-build file union plus its excluded products.
Fine dependency edges address cycle domains directly; member labels remain
available without adding redundant alias traversal to real consumer analysis.
"""

def _source_path(relative):
    relative = relative.replace("\\", "/")
    parts = relative.split("/")
    if ":" in relative or any([part in ["", ".", ".."] for part in parts]):
        fail("Expected a repository-relative source path: " + relative)
    return relative

def _overlay_path(relative):
    parts = _source_path(relative).split("/")
    # Prefix directories and leaves differently to avoid collisions. In
    # particular, the original BUILD files never create package boundaries.
    return "files/" + "/".join(["d_" + part for part in parts[:-1]] + ["f_" + parts[-1]])

def _source_identity(ctx, relative):
    # Fold only Windows path spelling, never realpath: distinct symlink module
    # paths and case-sensitive hosts retain their separate source identities.
    relative = relative.replace("\\", "/")
    return relative.lower() if "windows" in ctx.os.name.lower() else relative

def _link_file(ctx, source, destination):
    if "windows" in ctx.os.name.lower() and not ctx.attr.live_symlinks:
        # Bazel's WindowsFileSystem copies files unless symlinks are enabled.
        # Watching originals makes Bazel refresh those copies on source edits;
        # otherwise an unchanged path manifest could hide a changed file.
        ctx.watch(source)
    ctx.symlink(source, destination)

def _add_source(ctx, relative, source, groups, boundaries, mounts, projections):
    parts = relative.replace("\\", "/").split("/")
    identity = _source_identity(ctx, relative)
    destination = projections.get(identity)
    if destination == None:
        mount_length = 1
        for length in range(1, len(parts)):
            if _source_identity(ctx, "/".join(parts[:length])) in boundaries:
                mount_length = length + 1
        if mount_length < len(parts):
            directory = "/".join(parts[:mount_length])
            directory_identity = _source_identity(ctx, directory)
            mount = mounts.get(directory_identity)
            if mount == None:
                mount = "mounts/d_" + directory.replace("_", "__").replace("/", "_s_")
                # Native directory junctions work without Windows file-symlink
                # privilege and expose real inputs without copying every source.
                directory_source = source.dirname
                for _parent in range(len(parts) - mount_length - 1):
                    directory_source = directory_source.dirname
                ctx.symlink(directory_source, mount)
                mounts[directory_identity] = mount
            destination = mount + "/" + "/".join(parts[mount_length:])
        else:
            # Files immediately inside an original Bazel package (including
            # BUILD metadata) need encoded leaves to avoid hidden subpackages.
            destination = _overlay_path(relative)
            _link_file(ctx, source, destination)
        projections[identity] = destination
    groups["all"][destination] = True
    if len(parts) > 2 and parts[0] == "packages":
        group = "pkg_" + parts[1]
    elif len(parts) > 2 and parts[0] == "crates":
        group = "crate_" + parts[1]
    else:
        group = "shared"
    if group not in groups:
        groups[group] = {}
    groups[group][destination] = True
    return destination


def _package_group(directory):
    return "pkg_" + directory.replace("\\", "/").split("/")[-1]

def _rust_environment(ctx, name):
    return ctx.attr.rust_environment.get(name, ctx.getenv(name))

def _rust_which(ctx, name):
    path = _rust_environment(ctx, "PATH") or _rust_environment(ctx, "Path") or ""
    windows = "windows" in ctx.os.name.lower()
    suffixes = [""] + ((_rust_environment(ctx, "PATHEXT") or ".COM;.EXE;.BAT;.CMD").lower().split(";") if windows else [])
    for directory in path.split(";" if windows else ":"):
        directory = directory.strip('"')
        # Windows execution aliases are reparse links, not installed tools.
        # Even watching a missing candidate below one can fail native stat.
        normalized = directory.replace("\\", "/").lower().rstrip("/")
        if windows and (normalized.endswith("/microsoft/windowsapps") or "/microsoft/windowsapps/" in normalized):
            continue
        if directory:
            for suffix in suffixes:
                candidate = ctx.path(directory).get_child(name + suffix)
                ctx.watch(candidate)
                if candidate.exists and not candidate.is_dir:
                    return candidate
    return None

def _rust_command(ctx, argv, root):
    result = ctx.execute(argv, working_directory = str(root), environment = ctx.attr.rust_environment, quiet = True)
    if result.return_code:
        fail("Cannot declare reliable Rust test inputs: %s\n%s" % (" ".join(argv), result.stderr))
    return result.stdout.strip()

def _windows_git_runtime_roots(ctx, executable):
    # cmd/git.exe, mingw64/bin/git.exe, bin/bash.exe and usr/bin/bash.exe
    # belong to the same installation, but have different parent depths.
    directory = executable.dirname
    for _depth in range(4):
        runtime = directory.get_child("usr/bin/msys-2.0.dll")
        ctx.watch(runtime)
        if runtime.exists:
            # Bash and its child utilities load MSYS DLLs, locale/runtime data
            # and installation configuration, not just mingw64's Git DLLs.
            # _external_inputs inventories these trees with native watches and
            # filegroups; Bazel, rather than a custom fingerprint, owns digests.
            return [str(directory.get_child(relative)) for relative in [
                "usr/bin", "usr/lib", "usr/libexec", "usr/share", "etc",
                "mingw64/bin", "mingw64/etc", "mingw64/libexec",
                "mingw64/share/git-core",
            ]]
        parent = directory.dirname
        if not parent or str(parent) == str(directory):
            break
        directory = parent
    return []

def _rust_roots(ctx, root):
    # Resolve rustup's *active* toolchain, not the PATH proxy (which can stay
    # byte-identical across compiler upgrades). These are discovery commands;
    # no Cargo build, test or check is run by this repository.
    rustup = _rust_which(ctx, "rustup")
    for relative in ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"]:
        ctx.watch(root.get_child(relative))
    if not rustup:
        fail("Rust test cache inputs require rustup to resolve the active toolchain")
    cargo = _rust_command(ctx, [str(rustup), "which", "cargo"], root)
    rustc = _rust_command(ctx, [str(rustup), "which", "rustc"], root)
    sysroot = _rust_command(ctx, [rustc, "--print", "sysroot"], root)
    version = _rust_command(ctx, [rustc, "-vV"], root)
    hosts = [line[len("host: "):] for line in version.splitlines() if line.startswith("host: ")]
    if len(hosts) != 1:
        fail("Cannot discover Rust host triple from rustc -vV")
    metadata = json.decode(_rust_command(ctx, [
        cargo, "metadata", "--offline", "--locked", "--format-version=1",
        "--filter-platform", hosts[0],
    ], root))
    # Compiler executables, dynamic libraries, rustlib target libraries and
    # rustdoc live here. Rust's share/doc HTML is not a compiler/test input.
    roots = [sysroot + "/bin", sysroot + "/lib", sysroot + "/libexec", cargo, rustc, str(rustup)]
    workspace = str(root.realpath).replace("\\", "/").rstrip("/") + "/"
    config_directories = {str(root): True}
    for package in metadata["packages"]:
        manifest = ctx.path(package["manifest_path"])
        ctx.watch(manifest)
        config_directories[str(manifest.dirname)] = True
        if not str(manifest.realpath).replace("\\", "/").startswith(workspace):
            roots.append(str(manifest.dirname))
    # rustfmt and clippy can read ignored local configuration. Watch absent
    # candidates as well, so creating one changes the discovered input graph.
    for directory in config_directories:
        for name in ["rustfmt.toml", ".rustfmt.toml", "clippy.toml", ".clippy.toml"]:
            roots.append(str(ctx.path(directory).get_child(name)))
    # pi-shell's build script enumerates this directory, including ignored
    # definitions that the ordinary Git source inventory cannot discover.
    roots.append(str(root.get_child("crates/pi-shell/src/minimizer/defs")))
    # Track both names: Cargo prefers `config` when both exist. Walk all
    # ancestors, since Cargo's configuration search does not stop at Git root.
    directory = root
    for _depth in range(128):
        roots.extend([str(directory.get_child(".cargo/config")), str(directory.get_child(".cargo/config.toml"))])
        parent = directory.dirname
        if not parent or str(parent) == str(directory):
            break
        directory = parent
    if directory.dirname and str(directory.dirname) != str(directory):
        fail("Cargo configuration ancestry exceeds 128 directories")
    home = _rust_environment(ctx, "CARGO_HOME")
    if not home:
        user = _rust_environment(ctx, "USERPROFILE") if "windows" in ctx.os.name.lower() else _rust_environment(ctx, "HOME")
        if user:
            home = str(ctx.path(user).get_child(".cargo"))
    if home:
        roots.extend([home + "/config", home + "/config.toml"])
    rustup_home = _rust_environment(ctx, "RUSTUP_HOME")
    user = _rust_environment(ctx, "USERPROFILE") if "windows" in ctx.os.name.lower() else _rust_environment(ctx, "HOME")
    if not rustup_home and user:
        rustup_home = str(ctx.path(user).get_child(".rustup"))
    if rustup_home:
        ctx.watch(ctx.path(rustup_home + "/settings.toml"))
        roots.append(rustup_home + "/settings.toml")
    if user:
        roots.extend([user + "/.gitconfig", user + "/.config/git/config"])
    for name in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "SDKROOT", "LIBCLANG_PATH"]:
        value = _rust_environment(ctx, name)
        if value:
            roots.append(value)
    if home:
        # Cargo also searches CARGO_HOME/bin when the plugin is not on PATH.
        roots.extend([home + "/bin/cargo-nextest", home + "/bin/cargo-nextest.exe"])
    for name in [
        "RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER",
        "CARGO_BUILD_RUSTC", "CARGO_BUILD_RUSTC_WRAPPER",
        "CC", "CXX", "AR",
    ]:
        value = _rust_environment(ctx, name)
        if value:
            executable = ctx.path(value) if "/" in value or "\\" in value else _rust_which(ctx, value)
            if executable:
                roots.append(str(executable))
                if name in ["RUSTC", "CARGO_BUILD_RUSTC"]:
                    selected_sysroot = _rust_command(ctx, [str(executable), "--print", "sysroot"], root)
                    roots.extend([selected_sysroot + "/bin", selected_sysroot + "/lib", selected_sysroot + "/libexec"])
    # Target-specific linkers and cc-rs overrides select real executables too,
    # not merely different action environment strings.
    for name, value in ctx.attr.rust_environment.items():
        if value and (
            name.startswith("CC_") or name.startswith("CXX_") or name.startswith("AR_") or
            (name.startswith("CARGO_TARGET_") and name.endswith("_LINKER")) or
            name == "RUSTC_LINKER"
        ):
            executable = ctx.path(value) if "/" in value or "\\" in value else _rust_which(ctx, value)
            if executable:
                roots.append(str(executable))
    for name in [
        "cargo-nextest", "git", "jj", "ssh-keygen", "ping", "sleep", "sh",
        "bash", "true", "cat", "setsid", "cmake", "ninja", "cc", "c++",
        "clang", "clang++", "gcc", "g++", "ar", "ld", "pkg-config",
        "cl", "link", "lib", "rc", "mt",
    ]:
        executable = _rust_which(ctx, name)
        if executable:
            roots.append(str(executable))
    git = _rust_which(ctx, "git")
    if git:
        roots.append(_rust_command(ctx, [str(git), "--exec-path"], root))
        origins = _rust_command(ctx, [str(git), "config", "--list", "--show-origin"], root)
        for line in origins.splitlines():
            origin = line.split("\t")[0]
            if origin.startswith("file:"):
                roots.append(str(root.get_child(origin[len("file:"):])))
    if "windows" in ctx.os.name.lower():
        shells = []
        selected_shell = _rust_environment(ctx, "BAZEL_SH")
        if selected_shell:
            normalized = selected_shell.replace("\\", "/").lower()
            if "/microsoft/windowsapps/" in normalized:
                # An inherited execution alias is not a shell input. Fall
                # back to installed tools without ever statting that link.
                selected_shell = None
        if selected_shell:
            executable = ctx.path(selected_shell)
            ctx.watch(executable)
            if not executable.exists or executable.is_dir:
                fail("BAZEL_SH does not name an installed shell: " + selected_shell)
            shells.append(executable)
        for name in ["bash", "sh"]:
            executable = _rust_which(ctx, name)
            if executable:
                shells.append(executable)
        if not shells and git:
            # Git's cmd directory is commonly the only Git entry on PATH.
            directory = git.dirname
            for _depth in range(4):
                executable = directory.get_child("bin/bash.exe")
                ctx.watch(executable)
                if executable.exists and not executable.is_dir and _windows_git_runtime_roots(ctx, executable):
                    shells.append(executable)
                    break
                parent = directory.dirname
                if not parent or str(parent) == str(directory):
                    break
                directory = parent
        if not shells:
            fail("Rust input closure requires an installed Bash; set BAZEL_SH or install Git for Windows")
        # Include the explicitly selected Bazel shell even when it is not on
        # PATH, and don't assume that shell and Git use one installation.
        for executable in ([git] if git else []) + shells:
            roots.append(str(executable))
            roots.extend(_windows_git_runtime_roots(ctx, executable))
    # Explicit compiler/SDK selection is part of the source closure too.
    # The driver additionally keys the action on inherited semantic env vars.
    for name in ["VCToolsInstallDir", "WindowsSdkDir"]:
        value = _rust_environment(ctx, name)
        if value:
            roots.append(value)
    for name in ["INCLUDE", "LIB", "LIBPATH"]:
        value = _rust_environment(ctx, name)
        if value:
            roots.extend([entry for entry in value.split(";") if entry])
    if "windows" in ctx.os.name.lower():
        program_files = _rust_environment(ctx, "ProgramFiles(x86)") or "C:/Program Files (x86)"
        vswhere = ctx.path(program_files + "/Microsoft Visual Studio/Installer/vswhere.exe")
        if vswhere.exists:
            roots.append(str(vswhere))
            component = "Microsoft.VisualStudio.Component.VC.Tools.ARM64" if ctx.os.arch == "aarch64" else "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
            installation = _rust_command(ctx, [
                str(vswhere), "-latest", "-products", "*", "-requires",
                component, "-property", "installationPath",
            ], root)
            if installation:
                roots.extend([
                    installation + "/VC/Tools/MSVC",
                    installation + "/Common7/IDE/CommonExtensions/Microsoft/CMake",
                ])
        roots.extend([
            program_files + "/Windows Kits/10/Include",
            program_files + "/Windows Kits/10/Lib",
            program_files + "/Windows Kits/10/bin",
        ])
    return roots

def _project_external_inputs(ctx, source, destination, files, boundaries):
    if not boundaries:
        ctx.symlink(source, destination)
        return [destination + "/" + relative for relative in files]
    # Explicit leaves must survive original BUILD package boundaries too.
    # Only boundary-adjacent leaves need encoding; the rest retain junctions.
    groups = {"all": {}}
    mounts = {}
    projections = {}
    encoded_boundaries = {_source_identity(ctx, destination): True}
    for boundary in boundaries:
        encoded_boundaries[_source_identity(ctx, destination + ("/" + boundary if boundary else ""))] = True
    for relative in files:
        _add_source(ctx, destination + "/" + relative, source.get_child(relative), groups, encoded_boundaries, mounts, projections)
    return groups["all"].keys()

def _external_inputs(ctx, roots):
    # Inventory names with native Dirents, then let Bazel watch directory
    # membership and digest actual source inputs. No file-content cache exists.
    inputs = []
    # The inventory already enumerates every leaf. Do not make BUILD evaluation
    # traverse the same toolchain/registry/SDK trees again through recursive globs.
    existing = {}
    for filename in roots:
        source = ctx.path(filename)
        ctx.watch(source)
        if not source.exists:
            continue
        canonical = str(source.realpath).replace("\\", "/").rstrip("/")
        key = canonical.lower() if "windows" in ctx.os.name.lower() else canonical
        existing[key] = source
    directories = {}
    selected = []
    for index, key in enumerate(sorted(existing)):
        source = existing[key]
        # Root count scales with Cargo's registry closure. Check only path
        # ancestors, rather than comparing every crate with all prior crates.
        parts = key.split("/")
        if any(["/".join(parts[:length]) in directories for length in range(1, len(parts))]):
            continue
        if source.is_dir:
            directories[key] = True
            selected.append((index, source))
        else:
            destination = "rust_files/f" + str(index)
            _link_file(ctx, source, destination)
            inputs.append(destination)
    if not selected:
        return inputs
    ctx.watch(ctx.path(ctx.attr.rust_inventory_bun))
    ctx.watch(ctx.path(ctx.attr.rust_inventory_runner))
    ctx.file("rust-inventory-request.json", json.encode({
        "roots": [str(source) for _index, source in selected],
        "output": str(ctx.path("rust-inventory.json")),
    }), executable = False)
    result = ctx.execute([
        ctx.attr.rust_inventory_bun,
        ctx.attr.rust_inventory_runner,
        str(ctx.path("rust-inventory-request.json")),
    ], quiet = True)
    if result.return_code:
        fail("Cannot inventory Rust input paths (%s):\n%s" % (result.return_code, result.stderr))
    inventories = json.decode(ctx.read("rust-inventory.json"))
    ctx.delete("rust-inventory-request.json")
    ctx.delete("rust-inventory.json")
    for position, inventory in enumerate(inventories):
        index, source = selected[position]
        # A shallow native watch per real directory catches additions/removals,
        # including a new BUILD boundary after a successful cached invocation.
        # Do not stat each returned child: the helper already classified names.
        for relative, entries in inventory["directories"].items():
            directory = source.get_child(relative) if relative else source
            if sorted([child.basename for child in directory.readdir(watch = "yes")]) != entries:
                fail("Rust input directory changed during inventory: " + str(directory))
        for relative in inventory["links"]:
            ctx.watch(source.get_child(relative))
        inputs.extend(_project_external_inputs(
            ctx,
            source,
            "rust_dirs/r" + str(index),
            inventory["files"],
            inventory["boundaries"],
        ))
    return inputs

def _cycles_impl(ctx):
    graph = json.decode(ctx.read(ctx.path(ctx.attr.input_graph)))
    # The topology excludes test source contents, but the helper's actual runtime
    # implementation and resolution boundaries must invalidate cached queries.
    # Shallow directory watches detect new resolution candidates without walking
    # the tool repository, installed dependencies, or mutable output trees.
    for filename in ctx.attr.graph_runtime_inputs:
        source = ctx.path(filename)
        ctx.watch(source)
        if source.exists and source.is_dir:
            source.readdir(watch = "yes")
    ctx.watch(ctx.path(ctx.attr.graph_runner))
    ctx.watch(ctx.path(ctx.attr.graph_bazel))
    ctx.watch(ctx.path(ctx.attr.graph_bun))
    # With no package edges, every package self-path minus its root is empty.
    # Without module cycle roots, the module query is also empty even when the
    # topology contains ordinary DAG edges. Preserve all other native queries.
    if not any(ctx.attr.package_deps.values()) and not graph["cycleRoots"]:
        ctx.file("cyclic-inputs.json", json.encode({"packages": [], "modules": []}), executable = False)
        ctx.file("BUILD.bazel", 'exports_files(["cyclic-inputs.json"], visibility = ["//visibility:public"])\n', executable = False)
        ctx.file("REPO.bazel", "", executable = False)
        return
    # Resolve the parent's real module through a label, not a guessed cache path.
    # Its MODULE and files are repository inputs: refreshing or overriding the
    # parent module must also invalidate cached native discovery evidence.
    platforms_module = ctx.path(ctx.attr._platforms_module)
    ctx.read(platforms_module)
    ctx.watch_tree(platforms_module.dirname)
    packages = []
    for directory in ctx.attr.package_deps:
        label = "//graph:" + _package_group(directory)
        packages.append('(allpaths("%s", "%s") except "%s")' % (label, label, label))
    modules = []
    for name in graph["cycleRoots"]:
        label = "//graph:" + name
        modules.append('(allpaths("%s", "%s") except "%s")' % (label, label, label))
    query = "(let cycles = %s in allpaths($cycles, $cycles)) union (%s)" % (
        " union ".join(packages) if packages else "set()",
        " union ".join(modules) if modules else "set()",
    )
    output = ctx.path("cyclic-inputs.json")
    # The graph exceeds Windows' process argument limit on the full gate.
    ctx.file("graph-request.json", json.encode({
        "bazel": ctx.attr.graph_bazel,
        "workspace": ctx.attr.graph_workspace,
        "query": query,
        "output": str(output),
        "graph": graph,
        "packageDeps": ctx.attr.package_deps,
        "platformsRoot": str(platforms_module.dirname),
    }), executable = False)
    result = ctx.execute([
        ctx.attr.graph_bun,
        ctx.attr.graph_runner,
        str(ctx.path("graph-request.json")),
    ], timeout = 900, quiet = False)
    if result.return_code:
        fail("Native Bazel cyclic-domain discovery failed (%s):\n%s" % (result.return_code, result.stderr))
    ctx.delete("graph-request.json")
    ctx.file("BUILD.bazel", 'exports_files(["cyclic-inputs.json"], visibility = ["//visibility:public"])\n', executable = False)
    ctx.file("REPO.bazel", "", executable = False)

def _installed_candidates(ctx, source):
    candidates = []
    for child in source.readdir(watch = "yes"):
        if child.basename in [".cache", ".git", ".bin"]:
            continue
        if child.basename == ".bun" and child.is_dir:
            for store in child.readdir(watch = "yes"):
                if not store.is_dir:
                    continue
                dependency_root = store.get_child("node_modules")
                ctx.watch(dependency_root)
                if dependency_root.exists and dependency_root.is_dir:
                    for dependency in dependency_root.readdir(watch = "yes"):
                        if dependency.basename in [".cache", ".git", ".bin"]:
                            continue
                        if dependency.basename.startswith("@") and dependency.is_dir:
                            candidates.extend(dependency.readdir(watch = "yes"))
                        else:
                            candidates.append(dependency)
        elif child.basename.startswith("@") and child.is_dir:
            candidates.extend(child.readdir(watch = "yes"))
        else:
            candidates.append(child)
    return candidates

def _installed_package_inputs(ctx, source):
    # Resolve package membership once, not once here for nested dependencies and
    # again in BUILD globs. Keep every package-owned file, including resources
    # and original BUILD files; nested node_modules get their own package roots.
    roots = []
    files = []
    boundaries = []
    pending = [""]
    for _depth in range(128):
        following = []
        for relative in pending:
            directory = source.get_child(relative) if relative else source
            for child in directory.readdir(watch = "yes"):
                name = relative + "/" + child.basename if relative else child.basename
                if not child.exists:
                    ctx.watch(child)
                    continue
                if child.is_dir:
                    if child.basename == "node_modules":
                        roots.append(child)
                    else:
                        following.append(name)
                else:
                    files.append(name)
                    if child.basename in ["BUILD", "BUILD.bazel"]:
                        boundaries.append(relative)
        if not following:
            return roots, sorted(files), sorted(boundaries)
        pending = following
    fail("Installed package directory tree exceeds 128 directories: " + str(source))

def _sources_impl(ctx):
    root = ctx.path(ctx.attr.root)
    graph = json.decode(ctx.read(ctx.path(ctx.attr.input_graph))) if ctx.attr.input_graph else {"files": [], "groups": {}, "deps": {}}
    # Inventory paths come first so their canonical spelling owns the physical
    # projection. Keep every graph alias as a logical destinations lookup key.
    files = {relative: True for relative in ctx.attr.files + graph["files"]}
    input_groups = graph["groups"]
    input_deps = graph["deps"]
    groups = {"all": {}, "shared": {}, "installed": {}}
    seen = {}
    mounts = {}
    projections = {}
    boundaries = {}
    # Fine groups form a separate native filegroup graph: no implicit package,
    # shared, crate or installed closure is added to these explicit inputs.
    required = {}
    fine_groups = {}
    for name, members in input_groups.items():
        if not name or name in [".", ".."] or any([character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-." for character in name.elems()]):
            fail("Expected a plain input group target name: " + name)
        fine_groups[name] = [_source_path(relative) for relative in members]
        for relative in fine_groups[name]:
            required[relative] = True
    for name, dependencies in input_deps.items():
        if name not in fine_groups:
            fail("Missing declared input group for dependencies: " + name)
    destinations = {}
    for relative in files:
        parts = _source_path(relative).split("/")
        if parts[-1] in ["BUILD", "BUILD.bazel"]:
            boundaries[_source_identity(ctx, "/".join(parts[:-1]))] = True
    # Explicit installed files can sit below BUILD files absent from the Git
    # inventory. Preserve package boundaries before choosing junction mounts.
    checked = {}
    for relative in required:
        parts = relative.split("/")
        for length in range(1, len(parts)):
            directory = "/".join(parts[:length])
            identity = _source_identity(ctx, directory)
            if identity in checked:
                continue
            checked[identity] = True
            for basename in ["BUILD", "BUILD.bazel"]:
                marker = root.get_child(directory + "/" + basename)
                ctx.watch(marker)
                if marker.exists and not marker.is_dir:
                    boundaries[identity] = True
    for relative in files:
        relative = _source_path(relative)
        if relative in seen:
            continue
        seen[relative] = True
        source = root.get_child(relative)
        if not source.exists:
            # A deleted tracked path can remain in git's cached path list.
            # Watch existence and omit it, rather than retaining an old copy.
            ctx.watch(source)
            if relative in required:
                fail("Required input group source is not a file: " + relative)
            continue
        if source.is_dir:
            fail("Gate source paths must name files, not a Git submodule directory: " + relative)
        destinations[relative] = _add_source(ctx, relative, source, groups, boundaries, mounts, projections)
    for relative in required:
        if relative not in destinations:
            fail("Required input group source must be included in files: " + relative)
    installed_count = 0
    installed_files = []
    installed_seen = {}
    installed_containers = {}
    workspace = str(root.realpath).replace("\\", "/").rstrip("/") + "/"
    if "windows" in ctx.os.name.lower():
        workspace = workspace.lower()
    pending = []
    for index, installed_root in enumerate(ctx.attr.installed_roots):
        source = ctx.path(installed_root)
        if not source.exists:
            ctx.watch(source)
            continue
        if not source.is_dir:
            destination = "installed_files/" + str(index) + "_" + source.basename
            _link_file(ctx, source, destination)
            installed_files.append(destination)
            continue
        pending.append(source)
    # Each real package is inventoried once. Nested node_modules remain outside
    # its own file list and are added separately, including nested-only packages.
    for _depth in range(128):
        following = []
        for source in pending:
            container = str(source.realpath).replace("\\", "/").rstrip("/")
            container_key = container.lower() if "windows" in ctx.os.name.lower() else container
            if container_key in installed_containers:
                continue
            installed_containers[container_key] = True
            for candidate in _installed_candidates(ctx, source):
                if not candidate.exists:
                    ctx.watch(candidate)
                    continue
                real = str(candidate.realpath).replace("\\", "/").rstrip("/")
                key = real.lower() if "windows" in ctx.os.name.lower() else real
                if key in installed_seen:
                    continue
                installed_seen[key] = True
                if key.startswith(workspace) and "node_modules" not in key[len(workspace):].split("/"):
                    # Workspace symlinks retain their source-domain boundary;
                    # only their installed dependencies belong in this group.
                    nested = candidate.get_child("node_modules")
                    ctx.watch(nested)
                    if nested.exists and nested.is_dir:
                        following.append(nested)
                    continue
                if candidate.is_dir:
                    destination = "installed_dirs/p" + str(installed_count)
                    installed_count += 1
                    nested, package_files, package_boundaries = _installed_package_inputs(ctx, candidate)
                    installed_files.extend(_project_external_inputs(ctx, candidate.realpath, destination, package_files, package_boundaries))
                    following.extend(nested)
                else:
                    destination = "installed_files/p" + str(len(installed_files))
                    _link_file(ctx, candidate, destination)
                    installed_files.append(destination)
        if not following:
            break
        pending = following
    if following:
        fail("Installed dependency nesting exceeds 128 packages")
    exported = []
    for name, filename in sorted(ctx.attr.tools.items()):
        if "/" in name or "\\" in name or name in ["", ".", ".."]:
            fail("Expected a tool filename, preserving executable extensions: " + name)
        source = ctx.path(filename)
        if not source.exists or source.is_dir:
            fail("Required gate tool is not a file: " + filename)
        destination = "tools/" + name
        _link_file(ctx, source, destination)
        exported.append(destination)
    if ctx.attr.runner:
        for relative in [
            ctx.attr.runner,
            "scripts/test-gate-events.ts",
            "scripts/test-gate-clock.ts",
            "scripts/test-gate-libc.ts",
        ]:
            source = root.get_child(relative)
            if not source.exists or source.is_dir:
                fail("Required gate runner dependency is not a file: " + str(source))
            _link_file(ctx, source, relative)
            exported.append(relative)
    rust_inputs = _external_inputs(ctx, _rust_roots(ctx, root)) if ctx.attr.rust_inputs else []
    build = ['package(default_visibility = ["//visibility:public"])']
    build.append("exports_files(%r)" % exported)
    build.append("filegroup(name = \"rust_inputs\", srcs = %r)" % rust_inputs)
    # The producer reads scripts/codegen, all Cargo/build data and workspace
    # helpers. Its installed addon/declarations are products, never inputs;
    # native/index.js remains the checked-in loader template.
    native_build = {
        destination: True
        for relative, destination in destinations.items()
        if not relative.endswith(".node") and not (
            relative.startswith("packages/natives/native/") and relative.endswith(".d.ts")
        )
    }
    build.append("filegroup(name = \"native_build\", srcs = %r)" % native_build.keys())
    crates = [":" + name for name in sorted(groups) if name.startswith("crate_")]
    build.append("filegroup(name = \"crates\", srcs = %r)" % crates)
    build.append("filegroup(name = \"installed\", srcs = %r)" % installed_files)
    cyclic = {}
    cyclic_modules = {}
    module_domains = {}
    domains = json.decode(ctx.read(ctx.path(ctx.attr.cycle_domains))) if ctx.attr.cycle_domains else {"packages": [], "modules": []}
    for name in domains["packages"]:
        if name not in groups:
            fail("Unknown cyclic package group: " + name)
        cyclic[name] = True
    for members in domains["modules"]:
        if not members:
            fail("Empty native module cycle domain")
        target = "cyclic_" + sorted(members)[0]
        module_domains[target] = members
        for name in members:
            if name not in fine_groups or name in cyclic_modules:
                fail("Unknown or duplicate cyclic module group: " + name)
            cyclic_modules[name] = target
    edges = {}
    for directory, dependencies in ctx.attr.package_deps.items():
        name = _package_group(directory)
        edges[name] = []
        for dependency in dependencies:
            target = _package_group(dependency)
            if target not in groups:
                fail("Missing declared workspace dependency source group: " + dependency)
            if target != name:
                edges[name].append(target)
    cyclic_inputs = [":shared", ":crates"]
    cyclic_fallback_inputs = []
    cyclic_dependencies = {}
    for name in sorted(cyclic):
        cyclic_inputs.extend(groups[name].keys())
        cyclic_fallback_inputs.extend(groups[name].keys())
        for target in edges.get(name, []):
            if target not in cyclic:
                cyclic_dependencies[target] = True
    cyclic_inputs.extend([":" + target for target in sorted(cyclic_dependencies)])
    build.append("filegroup(name = \"cyclic_sources\", srcs = %r)" % sorted({source: True for source in cyclic_inputs}))
    cyclic_fallback_inputs.extend([":fallback_" + target for target in sorted(cyclic_dependencies)])
    build.append("filegroup(name = \"fallback_cyclic_sources\", srcs = %r)" % sorted({source: True for source in cyclic_fallback_inputs}))
    fallback_groups = {"fallback_cyclic_sources": True}
    for name in sorted(groups):
        inputs = groups[name].keys()
        if name == "installed":
            continue
        if name == "all":
            # native_build already owns every workspace leaf except its
            # products. Add those leaves back without traversing unrelated
            # package dependency/cycle wrappers for an all-source consumer.
            inputs = [":native_build"] + [source for source in inputs if source not in native_build]
        elif name in cyclic:
            inputs = [":cyclic_sources"]
        elif name.startswith("pkg_"):
            inputs = inputs + [":shared", ":crates"] + [":" + target for target in edges.get(name, [])]
        build.append("filegroup(name = %r, srcs = %r)" % (name, inputs))
        if name.startswith("pkg_"):
            # Keep this boundary through transitive dependencies and native
            # package cycle domains; coarse pkg_* groups reintroduce shared
            # scripts/docs and crates even when the owner omitted them.
            fallback = "fallback_" + name
            fallback_groups[fallback] = True
            fallback_inputs = [":fallback_cyclic_sources"] if name in cyclic else groups[name].keys() + [":fallback_" + target for target in edges.get(name, [])]
            build.append("filegroup(name = %r, srcs = %r)" % (fallback, fallback_inputs))
    for target, members in sorted(module_domains.items()):
        module_inputs = {}
        for name in members:
            for relative in fine_groups[name]:
                module_inputs[destinations[relative]] = True
            for dependency in input_deps.get(name, []):
                if dependency not in members:
                    module_inputs[dependency if dependency.startswith("@") else ":" + cyclic_modules.get(dependency, dependency)] = True
        build.append("filegroup(name = %r, srcs = %r)" % (target, sorted(module_inputs)))
    for name in sorted(fine_groups):
        if name in groups or name in fallback_groups or name in module_domains or name in ["rust_inputs", "crates", "cyclic_sources", "BUILD.bazel", "REPO.bazel"] or name in exported:
            fail("Input group collides with an existing target: " + name)
        inputs = {destinations[relative]: True for relative in fine_groups[name]}
        for dependency in input_deps.get(name, []):
            if dependency.startswith("@"):
                inputs[dependency] = True
            elif dependency in fine_groups or dependency in groups or dependency in fallback_groups or dependency == "crates":
                # A cycle member is only an alias of its complete domain.
                # Depend on that domain once, not on every member's filegroup;
                # retain the public member labels without analyzing each alias.
                inputs[":" + cyclic_modules.get(dependency, dependency)] = True
            else:
                fail("Missing declared input dependency group: " + dependency)
        inputs = [":" + cyclic_modules[name]] if name in cyclic_modules else sorted(inputs)
        build.append("filegroup(name = %r, srcs = %r)" % (name, inputs))
    # Every declared test/smoke command has a stable target, including commands
    # without an entrypoint and whole-discovery conservative fallback.
    for name, fallback in sorted(ctx.attr.command_sources.items()):
        if name not in fine_groups:
            build.append("filegroup(name = %r, srcs = %r)" % (name, [":" + fallback, "@installed//:installed"]))
    ctx.file("BUILD.bazel", "\n".join(build) + "\n", executable = False)
    ctx.file("REPO.bazel", "", executable = False)

gate_cycles_repository = repository_rule(
    implementation = _cycles_impl,
    attrs = {
        "package_deps": attr.string_list_dict(),
        "graph_workspace": attr.string(mandatory = True),
        "graph_bazel": attr.string(mandatory = True),
        "graph_bun": attr.string(mandatory = True),
        "graph_runner": attr.string(mandatory = True),
        "graph_runtime_inputs": attr.string_list(mandatory = True),
        "input_graph": attr.label(mandatory = True, allow_single_file = True),
        "_platforms_module": attr.label(default = Label("@platforms//:MODULE.bazel"), allow_single_file = True),
    },
)

gate_sources_repository = repository_rule(
    implementation = _sources_impl,
    attrs = {
        "root": attr.string(mandatory = True),
        "files": attr.string_list(),
        # Bun's native repository supplies precise local/external input groups.
        "input_graph": attr.label(allow_single_file = True),
        "command_sources": attr.string_dict(),
        "package_deps": attr.string_list_dict(),
        "cycle_domains": attr.label(allow_single_file = True),
        "tools": attr.string_dict(),
        "installed_roots": attr.string_list(),
        "rust_inputs": attr.bool(default = False),
        "rust_environment": attr.string_dict(),
        "rust_inventory_bun": attr.string(),
        "rust_inventory_runner": attr.string(),
        "runner": attr.string(default = "scripts/test-gate-bazel-runner.ts"),
        # Only set this with Bazel --windows_enable_symlinks and a host that
        # permits real file symlinks. False remains correct with native copies.
        "live_symlinks": attr.bool(default = False),
    },
)
