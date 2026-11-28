import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getAgentExecutableCacheDir } from "@oh-my-pi/pi-utils/dirs";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { terminateOwnedSubprocess } from "@oh-my-pi/pi-utils/subprocess";
import { offlineFromEnv } from "../cli/args";
import { DEFAULT_NPM_REGISTRY } from "../cli/npm-registry";
import type { Skill } from "../extensibility/skills";
import bundledArchive from "./resource-archive";
import { specDrivenOpenSpecInputs, specDrivenSourceFingerprint } from "./resource-fingerprint";
import {
	bundledSpecDrivenSkills,
	type SpecDrivenArchiveKind,
	specDrivenArchiveNames,
	type SpecDrivenResourceManifest,
} from "./resource-manifest";
import { resolveSpecDrivenResourcePath, resolveSpecDrivenResourceTarget } from "./resource-path";

export { resolveSpecDrivenResourcePath };

interface SpecDrivenResources {
	root: string;
	manifest: SpecDrivenResourceManifest;
}
export interface SpecDrivenProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Capture for SDK calls, inherit output for streaming, or also inherit terminal input. */
export type SpecDrivenProcessIO = "capture" | "stream" | "terminal";

const extractions: Partial<Record<SpecDrivenArchiveKind, Promise<SpecDrivenResources>>> = {};

export function ensureSpecDrivenSkillResources(): Promise<SpecDrivenResources> {
	return ensureResources("skills");
}

function ensureResources(kind: SpecDrivenArchiveKind): Promise<SpecDrivenResources> {
	return (extractions[kind] ??= extractResources(kind).catch(error => {
		delete extractions[kind];
		throw error;
	}));
}

async function hasExtractedFiles(root: string, files: SpecDrivenResourceManifest["files"]): Promise<boolean> {
	for (const file of files) {
		try {
			const target = await resolveSpecDrivenResourcePath(root, file.path);
			if (!(await fs.stat(target)).isFile()) return false;
		} catch (error) {
			if (isEnoent(error)) return false;
			throw error;
		}
	}
	return true;
}

async function extractResources(kind: SpecDrivenArchiveKind): Promise<SpecDrivenResources> {
	const compiled = process.env.PI_COMPILED === "true" || process.env.PI_BUNDLED === "true";
	const packageRoot = path.resolve(import.meta.dir, "../..");
	// Source and SDK imports use the same archive as npm and binary builds.
	let bytes: Uint8Array;
	let expectedFingerprint: string | undefined;
	if (compiled) {
		const asset = bundledArchive?.[kind];
		if (!asset) throw new Error(`Bundled ${kind} archive asset is missing`);
		expectedFingerprint = asset.sourceFingerprint;
		const assetPath =
			path.isAbsolute(asset.path) || path.win32.isAbsolute(asset.path)
				? asset.path
				: path.resolve(import.meta.dir, asset.path);
		bytes = await Bun.file(assetPath).bytes();
		if (crypto.createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
			throw new Error(
				"Stale or damaged bundled spec-driven archive; rebuild with bun run gen:spec-driven-resources.",
			);
		}
	} else {
		const archivePath = path.join(packageRoot, "dist", specDrivenArchiveNames[kind]);
		try {
			bytes = await Bun.file(archivePath).bytes();
		} catch (error) {
			if (!isEnoent(error)) throw error;
			throw new Error(
				`Bundled ${kind} resources are not prepared (${archivePath}). From ${packageRoot}, run bun run gen:spec-driven-resources. Resources are never installed or built automatically at runtime.`,
				{ cause: error },
			);
		}
		if (
			existsSync(path.resolve(packageRoot, "../../.git")) ||
			existsSync(path.resolve(packageRoot, specDrivenOpenSpecInputs.directory, specDrivenOpenSpecInputs.packageManifest))
		) {
			expectedFingerprint = await specDrivenSourceFingerprint(kind, packageRoot);
		}
	}
	const archiveFiles = await new Bun.Archive(bytes).files().catch(error => {
		throw new Error("Invalid spec-driven archive; run bun run gen:spec-driven-resources.", { cause: error });
	});
	const manifestFile = archiveFiles.get("manifest.json");
	if (!manifestFile) {
		throw new Error("Spec-driven archive has no manifest; run bun run gen:spec-driven-resources.");
	}
	const manifest = (await manifestFile.json().catch(error => {
		throw new Error("Invalid spec-driven manifest; run bun run gen:spec-driven-resources.", { cause: error });
	})) as SpecDrivenResourceManifest;
	if (manifest.format !== 3 || manifest.kind !== kind) {
		throw new Error(
			"Unsupported spec-driven resource archive; run bun run gen:spec-driven-resources to prepare it again.",
		);
	}
	if (
		typeof manifest.sourceFingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(manifest.sourceFingerprint) ||
		(expectedFingerprint !== undefined && manifest.sourceFingerprint !== expectedFingerprint)
	) {
		throw new Error("Stale spec-driven resource archive; run bun run gen:spec-driven-resources to prepare it again.");
	}
	if (!Array.isArray(manifest.files)) {
		throw new Error("Incomplete spec-driven manifest; run bun run gen:spec-driven-resources.");
	}
	const declaredPaths = new Set(manifest.files.map(file => file.path));
	const required =
		kind === "skills"
			? Array.from(bundledSpecDrivenSkills.values(), skill => skill.path)
			: [
					"openspec/bin/openspec.js",
					"openspec/dist/cli/index.js",
					"openspec/package.json",
					"openspec/schemas/spec-driven/schema.yaml",
				];
	for (const relative of required) {
		if (!declaredPaths.has(relative)) {
			throw new Error(`Incomplete ${kind} archive (${relative}); run bun run gen:spec-driven-resources.`);
		}
	}
	for (const file of manifest.files) {
		const archived = archiveFiles.get(file.path);
		if (
			!archived ||
			crypto
				.createHash("sha256")
				.update(await archived.bytes())
				.digest("hex") !== file.sha256
		) {
			throw new Error(`Damaged spec-driven resource (${file.path}); run bun run gen:spec-driven-resources.`);
		}
	}
	const digest = crypto.createHash("md5").update(JSON.stringify(manifest)).digest("hex");
	const cache = path.join(getAgentExecutableCacheDir(), "spec-driven", kind);
	const root = path.join(cache, digest);
	await fs.mkdir(cache, { recursive: true });
	await withFileLock(
		`${cache}.update`,
		async () => {
			const complete = path.join(root, ".omp-complete");
			const marker = await fs.readFile(complete, "utf8").catch(error => {
				if (isEnoent(error)) return undefined;
				throw error;
			});
			if (marker === digest && (await hasExtractedFiles(root, manifest.files))) return;
			const temporary = await fs.mkdtemp(path.join(path.dirname(cache), ".spec-driven-"));
			try {
				// Bun's parsed view contains only regular files; the manifest selects what is published.
				for (const file of manifest.files) {
					const target = resolveSpecDrivenResourceTarget(temporary, file.path);
					await Bun.write(target, archiveFiles.get(file.path)!);
				}
				for (const file of manifest.files) {
					const target = await resolveSpecDrivenResourcePath(temporary, file.path);
					if (
						crypto
							.createHash("sha256")
							.update(await fs.readFile(target))
							.digest("hex") !== file.sha256
					)
						throw new Error(`Bundled resource digest mismatch: ${file.path}`);
					await fs.chmod(target, file.executable ? 0o755 : 0o644);
				}
				await fs.writeFile(path.join(temporary, ".omp-complete"), digest, { flag: "wx" });
				// Other digests may still back resource paths held by live sessions.
				await fs.rm(root, { recursive: true, force: true });
				await fs.rename(temporary, root);
			} finally {
				await fs.rm(temporary, { recursive: true, force: true });
			}
		},
		{ retries: 600, retryDelayMs: 100 },
	);
	const canonicalRoot = await fs.realpath(root);
	return {
		root: canonicalRoot,
		manifest,
	};
}

/** Resolve the reserved name without granting access or bypassing normal overrides. */
export async function findBundledSpecDrivenSkill(name: string): Promise<Skill | undefined> {
	const entry = bundledSpecDrivenSkills.get(name);
	if (!entry) return undefined;
	const { root } = await ensureSpecDrivenSkillResources();
	const filePath = path.join(root, entry.path);
	return {
		name,
		description: "",
		filePath,
		baseDir: path.dirname(filePath),
		source: `bundled-${entry.source}`,
		hide: true,
		containRoot: path.join(root, entry.source),
	};
}

async function run(
	command: string[],
	cwd: string,
	signal?: AbortSignal,
	extraEnv: Record<string, string> = {},
	io: SpecDrivenProcessIO = "capture",
	ownership: "child" | "tree" = "child",
): Promise<SpecDrivenProcessResult> {
	signal?.throwIfAborted();
	const capture = io === "capture";
	const detached = ownership === "tree" && process.platform !== "win32";
	const child = Bun.spawn(command, {
		cwd,
		detached,
		stdin: io === "terminal" ? "inherit" : "ignore",
		stdout: capture ? "pipe" : "inherit",
		stderr: capture ? "pipe" : "inherit",
		env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", ...extraEnv },
	});
	// Join cancellation and the CLI's exit cleanup. Don't stop a normally
	// completed launcher: a script can intentionally hand off background work.
	let stopping: Promise<void> | undefined;
	const stop = () =>
		(stopping ??=
			ownership === "tree"
				? terminateOwnedSubprocess(child, { detached })
				: (async () => {
						if (child.exitCode === null && child.signalCode === null) child.kill();
						await child.exited;
					})());
	const unregisterCleanup = postmortem.register(`spec-driven-process:${child.pid}`, stop);
	const cancelled = Promise.withResolvers<never>();
	const abort = () => {
		void stop().then(() => cancelled.reject(signal?.reason), cancelled.reject);
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	try {
		const [stdout, stderr, exitCode] = await Promise.race([
			Promise.all([
				capture ? new Response(child.stdout).text() : "",
				capture ? new Response(child.stderr).text() : "",
				child.exited,
			]),
			cancelled.promise,
		]);
		if (stopping) await stopping;
		signal?.throwIfAborted();
		return { exitCode, stdout, stderr };
	} catch (error) {
		await stop();
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		unregisterCleanup();
	}
}

export async function runOpenSpec(
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
	io: SpecDrivenProcessIO = "capture",
): Promise<SpecDrivenProcessResult> {
	signal?.throwIfAborted();
	const previous = extractions.runtime;
	let resources = await ensureResources("runtime");
	if (previous && !(await hasExtractedFiles(resources.root, resources.manifest.files))) {
		if (previous === extractions.runtime) delete extractions.runtime;
		resources = await ensureResources("runtime");
	}
	const entry = await resolveSpecDrivenResourcePath(path.join(resources.root, "openspec"), "bin/openspec.js");
	const extraEnv: Record<string, string> = { BUN_BE_BUN: "1", OMP_OPENSPEC_REGISTRY_ORIGIN: "" };
	if (offlineFromEnv()) {
		const registry = URL.parse(process.env.npm_config_registry?.trim() ?? "");
		if (
			registry?.protocol !== "https:" ||
			registry.hostname.replace(/\.$/, "") === new URL(DEFAULT_NPM_REGISTRY).hostname
		) {
			extraEnv.OPENSPEC_NO_UPDATE_CHECK = "1";
		} else {
			extraEnv.OMP_OPENSPEC_REGISTRY_ORIGIN = registry.origin;
		}
	}
	return run([process.execPath, entry, ...args], cwd, signal, extraEnv, io);
}

async function findBash(): Promise<string> {
	if (process.platform !== "win32") {
		const bash = Bun.which("bash");
		if (bash) return bash;
	} else {
		// WSL's bash.exe is not a Git Bash runtime and cannot consume native paths.
		const git = Bun.which("git");
		const candidates = [
			...(git
				? [
						path.resolve(path.dirname(git), "../bin/bash.exe"),
						path.resolve(path.dirname(git), "../../bin/bash.exe"),
					]
				: []),
			path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe"),
			path.join(process.env.LOCALAPPDATA ?? "", "Programs/Git/bin/bash.exe"),
		];
		for (const candidate of candidates) if (await Bun.file(candidate).exists()) return candidate;
	}
	throw new Error("Superpowers scripts require Bash and POSIX utilities (Git for Windows Bash on Windows)");
}

export async function runSuperpowersScript(
	relativePath: string,
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
	io: SpecDrivenProcessIO = "capture",
): Promise<SpecDrivenProcessResult> {
	const resources = await ensureSpecDrivenSkillResources();
	const inventory = resources.manifest.files.find(file => file.path === `superpowers/${relativePath}`);
	if (!inventory || !relativePath.startsWith("skills/"))
		throw new Error(`Not a bundled skill script: ${relativePath}`);
	const script = await resolveSpecDrivenResourcePath(path.join(resources.root, "superpowers"), relativePath);
	const bytes = await fs.readFile(script);
	if (crypto.createHash("sha256").update(bytes).digest("hex") !== inventory.sha256)
		throw new Error(`Bundled resource digest mismatch: ${inventory.path}`);
	const runtimeRoot = path.join(resources.root, "omp-runtime");
	const env = {
		BUN_BE_BUN: "1",
		OMP_BUN_EXECUTABLE: process.execPath,
		PATH: `${runtimeRoot}${path.delimiter}${process.env.PATH ?? ""}`,
		BRAINSTORM_DIR: path.join(cwd, ".superpowers", "brainstorm"),
	};
	if (/\.(?:c?js|mjs)$/.test(relativePath))
		return run([process.execPath, script, ...args], cwd, signal, env, io, "tree");
	const newline = bytes.indexOf(0x0a);
	const head = bytes.toString("utf8", 0, newline === -1 ? bytes.length : newline);
	if (!head.startsWith("#!") || !/\b(?:bash|sh)\b/.test(head))
		throw new Error(`Unsupported bundled script runtime: ${relativePath}`);
	const bash = await findBash();
	// Resolve Graphviz and other external tools in the actual script; their real exit is propagated.
	if (process.platform === "win32")
		env.PATH = [
			runtimeRoot,
			path.dirname(bash),
			path.resolve(path.dirname(bash), "../usr/bin"),
			process.env.PATH ?? "",
		].join(path.delimiter);
	return run([bash, script.replaceAll("\\", "/"), ...args], cwd, signal, env, io, "tree");
}
