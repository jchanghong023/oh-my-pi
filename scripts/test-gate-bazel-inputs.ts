import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { ts } from "@ts-morph/common";
import type { GateCommand } from "./test-gate-runtime";
import { gateResources, type GateResources } from "./test-gate-bazel-resources";

export interface GateInputGraph {
	files: string[];
	resolutionPaths: string[];
	groups: Record<string, string[]>;
	deps: Record<string, string[]>;
	targets: Record<string, string>;
	cycleRoots: string[];
}

/** Compress absent lookups to their first observable filesystem boundary.
 * Directory listings and path states are reused only during this discovery;
 * native watches, not this transient lookup, own subsequent invalidation. */
function compactResolutionPaths(candidates: Iterable<string>): string[] {
	type Boundary = { directory: boolean; boundary?: string; linked: boolean };
	const windows = process.platform === "win32";
	const identity = (filename: string): string => (windows ? filename.toLowerCase() : filename);
	const watches = new Map<string, string>();
	const states = new Map<string, Boundary>();
	const listings = new Map<string, Set<string>>();
	const active = new Set<string>();
	const watch = (filename: string): void => {
		watches.set(identity(filename), filename);
	};
	const inspect = (filename: string): Boundary => {
		const key = identity(filename);
		const previous = states.get(key);
		if (previous) return previous;
		if (active.has(key)) throw new Error(`Cyclic input resolution symlink: ${filename}`);
		active.add(key);
		try {
			const parent = path.dirname(filename);
			let linked = false;
			if (parent !== filename) {
				const container = inspect(parent);
				linked = container.linked;
				if (!container.directory) {
					states.set(key, container);
					return container;
				}
				const parentKey = identity(parent);
				let names = listings.get(parentKey);
				if (!names) {
					names = new Set(readdirSync(parent).map(identity));
					listings.set(parentKey, names);
				}
				// Win32 can resolve trailing dots/spaces to an existing entry even
				// though that spelling does not occur in its directory listing.
				if (!names.has(identity(path.basename(filename))) && !(windows && /[. ]$/.test(filename))) {
					const missing = { directory: false, boundary: parent, linked };
					states.set(key, missing);
					return missing;
				}
			}
			let info: Stats;
			try {
				info = lstatSync(filename);
			} catch (error) {
				if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				// An unavailable drive/root has no observable ancestor. Preserve
				// each original native candidate instead of inventing a frontier.
				const missing = { directory: false, boundary: parent === filename ? undefined : parent, linked };
				states.set(key, missing);
				return missing;
			}
			let state: Boundary = { directory: info.isDirectory(), boundary: filename, linked };
			if (info.isSymbolicLink()) {
				// Keep the lexical link (including dangling junctions) and the
				// target frontier: a target can appear outside the link's parent.
				watch(filename);
				const targetPath = path.resolve(parent, readlinkSync(filename));
				const target = inspect(targetPath);
				watch(target.boundary ?? targetPath);
				state = {
					directory: target.directory,
					boundary: target.directory ? filename : target.boundary,
					linked: true,
				};
			}
			states.set(key, state);
			return state;
		} finally {
			active.delete(key);
		}
	};
	for (const candidate of candidates) {
		const filename = path.resolve(candidate);
		const state = inspect(filename);
		watch(state.boundary ?? filename);
		// Do not compress the original declaration across symlink/junction
		// chains: native markers describe resolved state, not readlink text.
		if (state.linked) watch(filename);
	}
	return [...watches.values()].sort();
}

/** Discover only the helper's executable closure, never the gate inventory.
 * Paths include absent lookup candidates: repositories must watch their existence
 * as well as the selected files. Directories are shallow resolution boundaries. */
export async function discoverBazelHelperInputs(entry: string): Promise<string[]> {
	entry = path.resolve(entry);
	const root = path.parse(entry).root;
	const inputs = new Set<string>();
	const entries = new Set([entry]);
	const scanned = new Set<string>();
	const configurations = new Set<string>();
	const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
	const builtin = (name: string): boolean => /^(?:node|bun):/.test(name) || name === "bun" || builtins.has(name);
	const add = (filename: string): void => {
		const absolute = path.resolve(filename);
		if (absolute.split(/[\\/]/).some(part => part === ".cache" || part === ".git"))
			throw new Error(`Helper runtime input cannot be an output/cache path: ${absolute}`);
		inputs.add(absolute);
	};
	const ancestors = (directory: string, visit: (directory: string) => void): void => {
		for (;;) {
			visit(directory);
			const parent = path.dirname(directory);
			if (parent === directory) return;
			directory = parent;
		}
	};
	const configuration = (directory: string): void => {
		ancestors(directory, current => {
			if (configurations.has(current)) return;
			configurations.add(current);
			for (const basename of ["package.json", "bunfig.toml", "tsconfig.json", "jsconfig.json"]) {
				const filename = path.join(current, basename);
				add(filename);
				if (!/^[tj]sconfig\.json$/.test(basename) || !ts.sys.fileExists(filename)) continue;
				const readFile = (file: string): string | undefined => {
					add(file);
					return ts.sys.readFile(file);
				};
				const parsed = ts.readConfigFile(filename, readFile);
				if (parsed.error) throw new Error(`Cannot read helper resolution configuration: ${filename}`);
				const configuration = ts.parseJsonConfigFileContent(
					parsed.config,
					{
						useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
						fileExists: file => {
							add(file);
							return ts.sys.fileExists(file);
						},
						readFile,
						readDirectory: () => [],
					},
					current,
				);
				if (configuration.errors.some(error => error.code !== 18002 && error.code !== 18003))
					throw new Error(`Cannot establish helper configuration closure: ${filename}`);
			}
		});
	};
	const lookup = (specifier: string, directory: string): void => {
		if (builtin(specifier)) return;
		if (path.isAbsolute(specifier) || /^(?:\.{1,2})(?:[\\/]|$)/.test(specifier)) {
			const candidate = path.resolve(directory, specifier);
			add(candidate);
			add(path.dirname(candidate));
			try {
				if (statSync(candidate).isDirectory()) add(path.join(candidate, "package.json"));
			} catch (error) {
				if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				add(path.join(candidate, "package.json"));
			}
			return;
		}
		if (specifier.startsWith("#")) return; // Ancestor package imports are watched by configuration().
		const parts = specifier.split("/");
		const packageName = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
		ancestors(directory, current => {
			const candidate = path.join(current, "node_modules", packageName);
			add(candidate);
			add(path.join(candidate, "package.json"));
			const requested = path.join(current, "node_modules", specifier);
			add(requested);
			if (requested !== candidate) add(path.dirname(requested));
		});
	};
	// Resource discovery probes only explicitly referenced paths. An opaque or
	// directory-wide resource must fail rather than silently selecting the repo.
	const resourceInventory = Object.assign(new Set<string>(), {
		has(relative: string): boolean {
			const absolute = path.resolve(root, relative);
			// The resource reader probes ordinary call literals against inventory;
			// a probe is not itself a file input (for example join("\n")).
			// Watch its existing directory boundary so a missing real resource
			// still invalidates discovery when created. Canonicalize directories:
			// Windows can stat a trailing-whitespace name as its parent directory.
			let directory = path.dirname(absolute);
			for (;;) {
				try {
					if (statSync(directory).isDirectory()) {
						add(realpathSync(directory));
						break;
					}
				} catch (error) {
					if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				}
				const parent = path.dirname(directory);
				if (parent === directory) throw new Error(`Cannot establish helper resource boundary: ${absolute}`);
				directory = parent;
			}
			try {
				if (!statSync(absolute).isFile()) return false;
				add(absolute);
				return true;
			} catch (error) {
				if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
				throw error;
			}
		},
		[Symbol.iterator](): SetIterator<string> {
			throw new Error("Cannot establish a bounded helper directory resource closure");
		},
	});
	for (;;) {
		const result = await Bun.build({
			entrypoints: [...entries].sort(),
			root,
			target: "bun",
			treeShaking: false,
			metafile: true,
			loader: { ".node": "file", ".wasm": "file" },
			plugins: [
				{
					name: "bazel-helper-inputs",
					setup(build) {
						build.onResolve({ filter: /./ }, args => {
							if (!args.importer || builtin(args.path)) return;
							const directory = path.dirname(args.importer);
							configuration(directory);
							lookup(args.path, directory);
							const resolved = Bun.resolveSync(args.path, directory);
							if (!builtin(resolved)) {
								if (!path.isAbsolute(resolved)) throw new Error(`Non-file helper import: ${args.path}`);
								add(resolved);
								add(path.dirname(resolved));
							}
						});
					},
				},
			],
		});
		if (!result.success || !result.metafile)
			throw new Error(`Cannot discover helper runtime closure: ${result.logs.map(String).join("\n")}`);
		let added = false;
		for (const [filename, metadata] of Object.entries(result.metafile.inputs)) {
			if (builtin(filename)) continue;
			const absolute = path.resolve(filename);
			add(absolute);
			const real = realpathSync(absolute);
			add(real);
			add(path.dirname(absolute));
			add(path.dirname(real));
			configuration(path.dirname(absolute));
			configuration(path.dirname(real));
			for (const imported of metadata.imports)
				if (imported.external && !builtin(imported.path))
					throw new Error(`Untracked external helper import: ${imported.path} from ${absolute}`);
			if (scanned.has(absolute) || !/\.[cm]?[jt]sx?$/.test(absolute)) continue;
			scanned.add(absolute);
			let text = await Bun.file(absolute).text();
			// The shared resource reader understands import.meta.url/dir. Lower
			// Bun's path shorthand structurally, without rewriting string literals.
			if (text.includes("import.meta")) {
				const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, false);
				const transformed = ts.transform(source, [
					context => {
						const visit: ts.Visitor = node => {
							if (
								ts.isPropertyAccessExpression(node) &&
								ts.isMetaProperty(node.expression) &&
								node.name.text === "path"
							)
								return ts.factory.createStringLiteral(absolute);
							return ts.visitEachChild(node, visit, context);
						};
						return node => ts.visitNode(node, visit) as ts.SourceFile;
					},
				]);
				try {
					text = ts.createPrinter().printFile(transformed.transformed[0]!);
				} finally {
					transformed.dispose();
				}
			}
			const resources = gateResources(absolute, text, resourceInventory, root);
			if (resources.fallback || resources.repositoryFallback)
				throw new Error(`Cannot establish a bounded helper runtime resource closure: ${absolute}`);
			for (const resource of resources.files) add(path.resolve(root, resource));
			for (const resource of resources.entries) {
				const filename = path.resolve(root, resource);
				if (!entries.has(filename)) {
					entries.add(filename);
					added = true;
				}
			}
		}
		if (!added) break;
	}
	if (!inputs.has(entry)) throw new Error(`Missing helper entry in runtime closure: ${entry}`);
	return [...inputs].sort();
}

/** Bun owns import resolution/chunking; Bazel owns the resulting filegroup DAG,
 * transitive digests and successful results. No bundled code is executed/saved. */
export async function discoverGateInputs(
	root: string,
	commands: readonly GateCommand[],
	inventory: readonly string[],
): Promise<GateInputGraph> {
	const groups: Record<string, string[]> = {};
	const deps: Record<string, string[]> = {};
	const targets: Record<string, string> = {};
	const commandEntries: Record<string, string[]> = {};
	const entrypoints = new Set<string>();
	const cycleRoots = new Set<string>();
	// Existence and directory entries are separate from real action files.
	// Let Bun choose extensions; watch the candidate's parent so newly added
	// higher-priority siblings invalidate resolution without duplicating it.
	const resolutionPaths = new Set<string>();
	const watchResolution = (specifier: string, directory: string): void => {
		if (!path.isAbsolute(specifier) && !/^(?:\.{1,2})(?:[\\/]|$)/.test(specifier)) return;
		const candidate = path.resolve(directory, specifier);
		resolutionPaths.add(candidate);
		resolutionPaths.add(path.dirname(candidate));
	};
	for (const command of commands) {
		if (!/^(?:test|smoke)\//.test(command.label)) continue;
		const entries: string[] = [];
		for (const arg of command.argv.slice(1)) {
			if (!/\.[cm]?[jt]sx?$/.test(arg) || arg.startsWith("-")) continue;
			const filename = path.resolve(root, command.cwd ?? ".", arg);
			if (await Bun.file(filename).exists()) entries.push(filename);
		}
		if (command.label.startsWith("smoke/")) {
			const cli = path.join(root, "packages/coding-agent/src/cli.ts");
			if (await Bun.file(cli).exists()) entries.push(cli);
		}
		if (entries.length) {
			commandEntries[command.label] = entries;
			for (const entry of entries) entrypoints.add(entry);
		}
	}
	if (!entrypoints.size)
		return { files: [...inventory].sort(), resolutionPaths: [], groups, deps, targets, cycleRoots: [] };
	const files = new Set(inventory);
	// Resource enumeration must not observe modules/assets appended by an earlier
	// scan. Bun's metafile iteration order is not a semantic dependency input.
	const resourceInventory = new Set(inventory);
	const resources = new Map<string, GateResources>();
	const unresolved = new Set<string>();
	const resolutions = new Map<string, boolean>();
	let metafile: Bun.BuildMetafile | undefined;
	// Workers and subprocess fixture scripts are entries too. Re-run only the
	// dependency discovery until Bun has incorporated all such explicit roots.
	for (;;) {
		let result: Bun.BuildOutput;
		try {
			result = await Bun.build({
				entrypoints: [...entrypoints].sort(),
				root,
				target: "bun",
				splitting: true,
				treeShaking: false,
				metafile: true,
				loader: { ".node": "file", ".wasm": "file" },
				plugins: [
					{
						name: "gate-inputs",
						setup(build) {
							build.onResolve({ filter: /./ }, args => {
								if (!args.importer || /^(?:node|bun):/.test(args.path)) return;
								const directory = path.dirname(args.importer);
								watchResolution(args.path, directory);
								const key = `${directory}\0${args.path}`;
								let resolved = resolutions.get(key);
								if (resolved === undefined) {
									try {
										Bun.resolveSync(args.path, directory);
										resolved = true;
									} catch {
										resolved = false;
									}
									resolutions.set(key, resolved);
								}
								if (!resolved) {
									unresolved.add(path.resolve(args.importer));
									return { path: args.path, external: true };
								}
							});
						},
					},
				],
			});
		} catch (error) {
			console.log(`bazel input discovery fallback=existing-scope reason=${JSON.stringify(String(error))}`);
			// This is the existing conservative source/installed boundary, not a
			// successful empty discovery. Retain its inventory in the native
			// repository graph so every consumer sees the real fallback inputs.
			return {
				files: [...inventory].sort(),
				resolutionPaths: compactResolutionPaths(resolutionPaths),
				groups: {},
				deps: {},
				targets: {},
				cycleRoots: [],
			};
		}
		if (!result.success || !result.metafile) throw new Error("Bun input discovery did not produce a module graph");
		metafile = result.metafile;
		let added = false;
		const pending: { absolute: string; text: Promise<string> }[] = [];
		for (const input of Object.keys(metafile.inputs).sort()) {
			const absolute = path.resolve(input);
			const relative = path.relative(root, absolute).replaceAll("\\", "/");
			if (relative.startsWith("../") || path.isAbsolute(relative))
				throw new Error(`Bun source input escapes the repository: ${input}`);
			files.add(relative);
			// Directory/package entry resolution can land below the requested
			// candidate (for example ./package -> ./package/lib/main.js).
			// Sibling extensions there are resolution inputs as well.
			resolutionPaths.add(path.dirname(absolute));
			if (!/\.[cm]?[jt]sx?$/.test(input) || resources.has(absolute)) continue;
			pending.push({ absolute, text: Bun.file(absolute).text() });
		}
		// Start reads together, but consume in path order: I/O completion order
		// must never affect resource declarations or subprocess entry discovery.
		const texts = await Promise.all(pending.map(input => input.text));
		for (const [index, input] of pending.entries()) {
			const resource = gateResources(input.absolute, texts[index]!, resourceInventory, root, absolute => {
				resolutionPaths.add(absolute);
			});
			resources.set(input.absolute, resource);
			for (const file of resource.files) files.add(file);
			for (const entry of resource.entries) {
				const filename = path.resolve(root, entry);
				if (!entrypoints.has(filename)) {
					entrypoints.add(filename);
					added = true;
				}
			}
		}
		if (!added) break;
	}
	const outputGroups: Record<string, string> = {};
	const entryGroups: Record<string, string> = {};
	const configGroups = new Map<string, string>();
	// Invocation-local filesystem reuse only; every discovery rereads real
	// configuration inputs and Bazel remains responsible for invalidation.
	const configContents = new Map<string, string | undefined>();
	const configExistence = new Map<string, boolean>();
	const fileExists = (filename: string): boolean => {
		let exists = configExistence.get(filename);
		if (exists === undefined) {
			exists = ts.sys.fileExists(filename);
			configExistence.set(filename, exists);
		}
		return exists;
	};
	const configuration = (directory: string): string => {
		const previous = configGroups.get(directory);
		if (previous) return previous;
		const name = `config_${Bun.hash(path.relative(root, directory)).toString(16)}`;
		{
			const inputs = new Set<string>();
			const readFile = (filename: string): string | undefined => {
				if (!configContents.has(filename)) configContents.set(filename, ts.sys.readFile(filename));
				const content = configContents.get(filename);
				if (content !== undefined) {
					const relative = path.relative(root, filename).replaceAll("\\", "/");
					if (relative.startsWith("../") || path.isAbsolute(relative))
						throw new Error(`Configuration input escapes the repository: ${filename}`);
					inputs.add(relative);
				}
				return content;
			};
			const basenames = ["package.json", "bunfig.toml", "tsconfig.json", "tsconfig.base.json"];
			// One directory read replaces four separate probes and their promises.
			// Do not use the Git inventory here: ignored installed configurations
			// are still real inputs, including inherited package configurations.
			const present = new Set(readdirSync(directory).map(basename => basename.toUpperCase()));
			for (const basename of basenames) {
				if (!present.has(basename.toUpperCase())) continue;
				const filename = path.join(directory, basename);
				if (!fileExists(filename)) continue;
				inputs.add(path.relative(root, filename).replaceAll("\\", "/"));
				if (basename.startsWith("tsconfig")) {
					const config = ts.readConfigFile(filename, readFile);
					if (config.config)
						ts.parseJsonConfigFileContent(
							config.config,
							{
								useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
								fileExists,
								readFile,
								readDirectory: () => [],
							},
							directory,
							{},
							filename,
						);
				}
			}
			groups[name] = [...inputs].sort();
			deps[name] = path.relative(root, directory) === "" ? [] : [configuration(path.dirname(directory))];
			for (const input of inputs) files.add(input);
		}
		configGroups.set(directory, name);
		return name;
	};
	// Configuration chains are memoized within this discovery, not across runs.
	for (const input of Object.keys(metafile.inputs)) configuration(path.dirname(path.resolve(input)));
	const sourceImports = new Map(
		Object.entries(metafile.inputs).map(([input, metadata]) => [path.resolve(input), metadata.imports]),
	);
	const sourceOwners = new Map<string, string>();
	for (const [output, metadata] of Object.entries(metafile.outputs)) {
		const inputs = [
			...new Set([...Object.keys(metadata.inputs), ...(metadata.entryPoint ? [metadata.entryPoint] : [])]),
		]
			.map(input => path.relative(root, path.resolve(input)).replaceAll("\\", "/"))
			.sort();
		// Labels depend on source paths, never generated chunk-content hashes.
		const name = `module_${Bun.hash(JSON.stringify([metadata.entryPoint ?? "", inputs])).toString(16)}`;
		const key = path.posix.normalize(output.replaceAll("\\", "/"));
		outputGroups[key] = name;
		groups[name] = inputs;
		deps[name] = [];
		if (metadata.entryPoint) entryGroups[path.resolve(metadata.entryPoint)] = name;
		for (const input of inputs) {
			const absolute = path.resolve(root, input);
			const previous = sourceOwners.get(absolute);
			if (!previous || name < previous) sourceOwners.set(absolute, name);
		}
	}
	for (const [output, metadata] of Object.entries(metafile.outputs)) {
		const key = path.posix.normalize(output.replaceAll("\\", "/"));
		const name = outputGroups[key]!;
		const inputs = new Set(groups[name]);
		const dependencies = new Set<string>();
		for (const imported of metadata.imports) {
			const importedKey = path.posix.normalize(path.posix.join(path.posix.dirname(key), imported.path));
			const dependency = outputGroups[importedKey] ?? outputGroups[path.posix.normalize(imported.path)];
			if (dependency && dependency !== name) {
				dependencies.add(dependency);
				if (imported.kind === "dynamic-import") cycleRoots.add(name);
			}
		}
		const pendingInputs = [...groups[name]!];
		const visitedInputs = new Set(pendingInputs);
		for (const input of pendingInputs) {
			const absolute = path.resolve(root, input);
			// Output inputs describe emitted byte contributions. Side-effect-only
			// or zero-contribution modules may be absent there; the source graph
			// still declares their real import dependency on every discovery.
			for (const imported of sourceImports.get(absolute) ?? []) {
				if (imported.external) continue;
				const importedAbsolute = path.resolve(imported.path);
				if (!sourceImports.has(importedAbsolute)) continue;
				const owner = sourceOwners.get(importedAbsolute);
				if (owner && owner !== name) {
					if (!dependencies.has(owner)) {
						dependencies.add(owner);
						cycleRoots.add(name);
					}
				} else if (!owner) {
					const relative = path.relative(root, importedAbsolute).replaceAll("\\", "/");
					inputs.add(relative);
					if (!visitedInputs.has(relative)) {
						visitedInputs.add(relative);
						pendingInputs.push(relative);
					}
				}
			}
			const resource = resources.get(absolute);
			for (const file of resource?.files ?? []) inputs.add(file);
			for (const entry of resource?.entries ?? []) {
				const dependency = entryGroups[path.resolve(root, entry)];
				if (dependency && dependency !== name) {
					dependencies.add(dependency);
					cycleRoots.add(name);
				}
			}
			// Keep the previous conservative boundary for genuinely opaque local
			// loading; unresolved/opaque third-party loading retains installed inputs.
			if (resource?.fallback || unresolved.has(absolute)) {
				const owner = input.match(/^packages\/([^/]+)\//)?.[1];
				dependencies.add(
					resource?.repositoryFallback
						? "all"
						: input.startsWith("node_modules/")
							? "@installed//:installed"
							: owner
								? `fallback_pkg_${owner}`
								: "all",
				);
				dependencies.add("@installed//:installed");
			}
			dependencies.add(configuration(path.dirname(absolute)));
		}
		groups[name] = [...inputs].sort();
		deps[name] = [...dependencies].sort();
		for (const input of inputs) files.add(input);
	}
	for (const command of commands) {
		const entries = commandEntries[command.label];
		if (!entries) continue;
		const name = `command_${Bun.hash(command.label).toString(16)}`;
		groups[name] = [];
		deps[name] = entries.map(entry => {
			const dependency = entryGroups[entry];
			if (!dependency) throw new Error(`Missing Bun entry dependency: ${entry}`);
			return dependency;
		});
		if (/^test\/Rust/.test(command.label)) {
			groups[name] = inventory.filter(file =>
				/^(?:crates\/|vendor\/|\.cargo\/|Cargo\.(?:toml|lock)$|rust(?:-toolchain|-toolchain\.toml|fmt\.toml)$)/.test(
					file,
				),
			);
		}
		targets[command.label] = name;
	}
	console.log(
		`bazel input discovery entries=${commandEntries ? Object.keys(commandEntries).length : 0} modules=${Object.keys(metafile.inputs).length} groups=${Object.keys(groups).length}`,
	);
	return {
		files: [...files].sort(),
		resolutionPaths: compactResolutionPaths(resolutionPaths),
		groups,
		deps,
		targets,
		cycleRoots: [...cycleRoots].sort(),
	};
}
