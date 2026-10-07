#!/usr/bin/env bun
// Full local verification of the modules the fork diff touches: each selected
// module runs its whole suite through the existing runners; untouched modules
// are not test targets (no consumer closure).

import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");

export interface FulltestCommand {
	label: string;
	argv: readonly string[];
	env?: Record<string, string>;
}

export interface FulltestOptions {
	debug: boolean;
	dryRun: boolean;
}

export interface WorkspaceModule {
	directory: string;
	name: string;
	dependencies: readonly string[];
}

export interface FulltestScope {
	packages: string[];
	rust: boolean;
	scripts: boolean;
	native: boolean;
	ui: boolean;
}

function isDocumentation(file: string): boolean {
	return (
		/^(?:docs|docs-zh-CN)\//.test(file) ||
		/^(?:(?:packages\/[^/]+|crates\/(?:vendor\/)?[^/]+)\/)?(?:README(?:\.[^/]*)?|CHANGELOG(?:\.[^/]*)?|LICENSE(?:\.[^/]*)?|AGENTS\.md)$/i.test(
			file,
		) ||
		/^(?:packages\/[^/]+|crates\/(?:vendor\/)?[^/]+)\/docs\//.test(file)
	);
}

/** Select the suites of modules with changed files, not changed test files.
 * Deleted paths still count; consumer modules without changes are not selected. */
export function resolveAffectedTestScope(
	changedPaths: readonly string[],
	modules: readonly WorkspaceModule[],
	rootDependenciesChanged = true,
): FulltestScope {
	const changed = changedPaths.map(file => file.replaceAll("\\", "/")).filter(file => !isDocumentation(file));
	const globalTs =
		(rootDependenciesChanged && changed.includes("package.json")) ||
		changed.some(file => /^(?:bun\.lockb?$|bunfig\.toml$|tsconfig[^/]*\.json$|patches\/)/.test(file));
	const rust = changed.some(file =>
		/^(?:crates\/|Cargo\.(?:toml|lock)$|\.cargo\/|\.config\/nextest\.toml$|rust-toolchain(?:\.toml)?$|\.?rustfmt\.toml$|\.?clippy\.toml$)/.test(
			file,
		),
	);
	const selected = new Set(
		modules
			.filter(module => globalTs || changed.some(file => file.startsWith(`${module.directory}/`)))
			.map(module => module.directory),
	);
	// Rust changes rebuild the addon the natives binding ships; its suite is the
	// binding layer's test surface even when its TS files are unchanged.
	if (rust) selected.add("packages/natives");
	// Removed modules cannot supply their current manifest/dependency identity.
	// Conservatively include every module rather than silently dropping them.
	if (
		changed.some(
			file => /^packages\/[^/]+\//.test(file) && !modules.some(module => file.startsWith(`${module.directory}/`)),
		)
	) {
		for (const module of modules) selected.add(module.directory);
	}
	const packages = modules
		.filter(module => selected.has(module.directory))
		.map(module => module.directory)
		.sort();
	const scripts =
		globalTs ||
		changed.some(
			file => file === "package.json" || file.startsWith("scripts/") || /^install\.(?:sh|ps1)$/.test(file),
		);
	// Native is a prerequisite, not an extra test target. Check forward
	// dependencies too: a changed CLI still needs its unchanged native addon.
	const prerequisites = new Set(packages);
	let grew = true;
	while (grew) {
		grew = false;
		for (const module of modules) {
			if (!prerequisites.has(module.directory)) continue;
			for (const dependency of modules) {
				if (module.dependencies.includes(dependency.name) && !prerequisites.has(dependency.directory)) {
					prerequisites.add(dependency.directory);
					grew = true;
				}
			}
		}
	}
	return {
		packages,
		rust,
		scripts,
		native: rust || scripts || prerequisites.has("packages/natives"),
		ui:
			selected.has("packages/coding-agent") ||
			selected.has("packages/tui") ||
			changed.includes("scripts/fulltest-ui-smoke.ts"),
	};
}

export function buildFulltestPhases(
	options: FulltestOptions,
	scope: FulltestScope,
	changedPaths: readonly string[],
): readonly FulltestCommand[] {
	// Keep the existing upstream-red exception: no check:rs clippy/fmt half
	// until upstream's Windows-only clippy failures are fixed.
	const phases: FulltestCommand[] = [{ label: "static/check:ts", argv: ["bun", "run", "check:ts"] }];
	if (scope.native) phases.push({ label: "build/native", argv: ["bun", "run", "build:native"] });
	if (scope.packages.length)
		phases.push({
			label: "ts/affected",
			argv: [
				"bun",
				"scripts/ci-test-ts.ts",
				"affected",
				`--packages=${JSON.stringify(scope.packages)}`,
				...(options.dryRun ? ["--dry-run"] : []),
			],
		});
	if (scope.rust)
		phases.push({
			label: "rust/affected",
			argv: ["bun", "run", "test:rs", "--affected", ...(options.dryRun ? ["--dry-run"] : [])],
			env: { CI: "1", OMP_FULLTEST_CHANGED_PATHS: JSON.stringify(changedPaths) },
		});
	if (scope.scripts) phases.push({ label: "scripts", argv: ["bun", "run", "test:scripts"] });
	if (scope.ui)
		phases.push({
			label: "ui/smoke",
			argv: ["bun", "scripts/fulltest-ui-smoke.ts", ...(options.debug ? ["--debug"] : [])],
		});
	return phases;
}

function printUsage(): void {
	console.log("Usage: bun run fulltest [--debug] [--dry-run]");
	console.log("  --debug    dump raw TUI output during the UI smoke phase");
	console.log("  --dry-run  show affected modules and commands without building or testing");
}

export function parseFulltestArgs(args: readonly string[]): FulltestOptions | null {
	if (args.some(arg => arg !== "--debug" && arg !== "--dry-run")) {
		printUsage();
		return null;
	}
	return { debug: args.includes("--debug"), dryRun: args.includes("--dry-run") };
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runPhase(command: FulltestCommand, dryRun: boolean): Promise<void> {
	console.log(`\n==> ${command.label}`);
	console.log(command.argv.map(shellQuote).join(" "));
	if (dryRun && command.label !== "ts/affected" && command.label !== "rust/affected") return;
	const child = Bun.spawn([...command.argv], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		env: command.env ? { ...process.env, ...command.env } : undefined,
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${command.label} failed with exit code ${exitCode}`);
}

async function resolveUpstreamBaselineRef(): Promise<string> {
	for (const candidate of ["upstream", "origin/upstream"]) {
		const result = await $`git rev-parse --verify ${candidate}`.cwd(repoRoot).quiet().nothrow();
		if (result.exitCode === 0 && result.stdout.toString().trim() !== "") return candidate;
	}
	throw new Error(
		"fulltest needs the upstream baseline (local `upstream` branch or `origin/upstream`) to select affected modules.",
	);
}

async function discoverChanges(baseline: string): Promise<string[]> {
	// NUL separation preserves spaces, non-ASCII names and embedded newlines;
	// --no-renames reports both sides, so moving code affects both modules.
	const diff = await $`git diff --name-only --no-renames -z ${baseline}`.cwd(repoRoot).quiet().nothrow();
	if (diff.exitCode !== 0) throw new Error(`git diff against ${baseline} failed: ${diff.stderr.toString().trim()}`);
	const untracked = await $`git ls-files --others --exclude-standard -z`.cwd(repoRoot).quiet().nothrow();
	if (untracked.exitCode !== 0) throw new Error(`git ls-files --others failed: ${untracked.stderr.toString().trim()}`);
	return [
		...new Set([...diff.stdout.toString().split("\0"), ...untracked.stdout.toString().split("\0")].filter(Boolean)),
	].sort();
}

async function discoverWorkspaceModules(): Promise<WorkspaceModule[]> {
	const root = await Bun.file(path.join(repoRoot, "package.json")).json();
	const modules: WorkspaceModule[] = [];
	for (const pattern of root.workspaces.packages as string[]) {
		for await (const file of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: repoRoot, onlyFiles: true })) {
			const manifest = await Bun.file(path.join(repoRoot, file)).json();
			modules.push({
				directory: path.posix.dirname(file.replaceAll("\\", "/")),
				name: manifest.name,
				dependencies: Object.keys({
					...manifest.dependencies,
					...manifest.devDependencies,
					...manifest.optionalDependencies,
					...manifest.peerDependencies,
				}),
			});
		}
	}
	return modules;
}

async function rootDependencyConfigurationChanged(baseline: string): Promise<boolean> {
	const previous = await $`git show ${`${baseline}:package.json`}`.cwd(repoRoot).quiet().nothrow();
	if (previous.exitCode !== 0) return true;
	const current = await Bun.file(path.join(repoRoot, "package.json")).json();
	const old = JSON.parse(previous.stdout.toString());
	return [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
		"workspaces",
		"overrides",
		"patchedDependencies",
	].some(key => !isDeepStrictEqual(current[key], old[key]));
}

async function main(options: FulltestOptions): Promise<void> {
	const platformSupported = (process.platform === "linux" || process.platform === "win32") && process.arch === "x64";
	if (!platformSupported)
		throw new Error(`fulltest supports Windows x64 and Linux x64 (found ${process.platform}-${process.arch})`);
	const baseline = await resolveUpstreamBaselineRef();
	const changedPaths = await discoverChanges(baseline);
	const rootDependenciesChanged = changedPaths.includes("package.json")
		? await rootDependencyConfigurationChanged(baseline)
		: false;
	const scope = resolveAffectedTestScope(changedPaths, await discoverWorkspaceModules(), rootDependenciesChanged);
	console.log(`fulltest: baseline=${baseline}; ${changedPaths.length} changed paths`);
	console.log(
		`fulltest: TS modules=${scope.packages.join(", ") || "none"}; Rust=${scope.rust ? "affected crates" : "skip"}; scripts=${scope.scripts ? "all" : "skip"}; UI=${scope.ui ? "smoke" : "skip"}`,
	);
	const phases = buildFulltestPhases(options, scope, changedPaths);
	for (const phase of phases) await runPhase(phase, options.dryRun);
}

if (import.meta.main) {
	const parsed = parseFulltestArgs(process.argv.slice(2));
	if (parsed === null) {
		process.exitCode = 2;
	} else {
		const startedAt = performance.now();
		main(parsed)
			.then(() => {
				console.log(`\nfulltest: ${parsed.dryRun ? "DRY RUN (no builds or tests executed)" : "PASS"}`);
				console.log(`fulltest: total time ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
			})
			.catch(error => {
				console.error(`\nfulltest: FAIL — ${error instanceof Error ? error.message : String(error)}`);
				console.error(`fulltest: total time ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
				process.exitCode = 1;
			});
	}
}
