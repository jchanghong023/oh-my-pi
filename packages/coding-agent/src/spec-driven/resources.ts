import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import { getDocumentConversionCacheDir } from "@oh-my-pi/pi-utils/dirs";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { terminateOwnedSubprocess } from "@oh-my-pi/pi-utils/subprocess";
import { offlineFromEnv } from "../cli/args";
import { DEFAULT_NPM_REGISTRY } from "../cli/npm-registry";
import type { Skill } from "../extensibility/skills";
import bundledArchive from "./resource-archive";
import { specDrivenSourceFingerprint } from "./resource-fingerprint";
import { isPathInside, resolveSpecDrivenResourcePath } from "./resource-path";

export { resolveSpecDrivenResourcePath };

export type SpecDrivenResourceSource = "openspec" | "superpowers" | "jch";
export interface SpecDrivenSkillEntry {
	source: SpecDrivenResourceSource;
	name: string;
	path: string;
}
export interface SpecDrivenResourceManifest {
	runtimeFormat: 2;
	sourceFingerprint?: string;
	openspec: {
		version: string;
		revision: string;
		/** SHA-256 of the sorted OpenSpec runtime file records (path, byte hash, executable flag). */
		runtimeSha256: string;
	};
	superpowers: { version: string; revision: string };
	jch: { revision: string };
	skills: readonly SpecDrivenSkillEntry[];
	files: readonly { path: string; sha256: string; executable: boolean }[];
}

export interface SpecDrivenResources {
	root: string;
	openspecRoot: string;
	superpowersRoot: string;
	jchRoot: string;
	manifest: SpecDrivenResourceManifest;
}
export interface SpecDrivenProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Capture for SDK calls, inherit output for streaming, or also inherit terminal input. */
export type SpecDrivenProcessIO = "capture" | "stream" | "terminal";

// Keep URL ownership available even if the resource archive or its cache cannot be opened.
// Extraction checks this pinned index against the archive manifest.
const bundledSkillNames = new Set([
	"big-review-scan",
	"big-review-verify",
	"brainstorming",
	"diagnosing-superpowers",
	"dispatching-parallel-agents",
	"executing-plans",
	"finishing-a-development-branch",
	"jch-codebase-design",
	"jch-grill-me",
	"jch-grill-todo",
	"openspec-apply-change",
	"openspec-archive-change",
	"openspec-bulk-archive-change",
	"openspec-continue-change",
	"openspec-explore",
	"openspec-ff-change",
	"openspec-new-change",
	"openspec-onboard",
	"openspec-propose",
	"openspec-sync-specs",
	"openspec-update-change",
	"openspec-verify-change",
	"receiving-code-review",
	"requesting-code-review",
	"subagent-driven-development",
	"systematic-debugging",
	"test-driven-development",
	"using-git-worktrees",
	"using-superpowers",
	"verification-before-completion",
	"writing-plans",
	"writing-skills",
]);

export function hasBundledSpecDrivenSkill(name: string): boolean {
	return bundledSkillNames.has(name);
}

let extraction: Promise<SpecDrivenResources> | undefined;
export function ensureSpecDrivenResources(): Promise<SpecDrivenResources> {
	extraction ??= extractResources().catch(error => {
		extraction = undefined;
		throw error;
	});
	return extraction;
}

async function extractResources(): Promise<SpecDrivenResources> {
	const compiled = process.env.PI_COMPILED === "true" || process.env.PI_BUNDLED === "true";
	// Source and SDK imports use the same archive as npm and binary builds.
	let bytes: Uint8Array;
	if (compiled) {
		if (!bundledArchive) throw new Error("Bundled resource archive asset is missing");
		const assetPath =
			path.isAbsolute(bundledArchive.path) || path.win32.isAbsolute(bundledArchive.path)
				? bundledArchive.path
				: path.resolve(import.meta.dir, bundledArchive.path);
		bytes = await Bun.file(assetPath).bytes();
		if (crypto.createHash("sha256").update(bytes).digest("hex") !== bundledArchive.sha256) {
			throw new Error(
				"Stale or damaged bundled spec-driven archive; rebuild with bun run gen:spec-driven-resources.",
			);
		}
	} else {
		const packageRoot = path.resolve(import.meta.dir, "../..");
		const archivePath = path.join(packageRoot, "dist/spec-driven-resources.tar.gz");
		try {
			bytes = await Bun.file(archivePath).bytes();
		} catch (error) {
			if (!isEnoent(error)) throw error;
			throw new Error(
				`OpenSpec runtime resources are not prepared (${archivePath}). From ${packageRoot}, run bun run gen:spec-driven-resources. Resources are never installed or built automatically at runtime.`,
				{ cause: error },
			);
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
	if (manifest.runtimeFormat !== 2) {
		throw new Error(
			"Unsupported spec-driven resource archive; run bun run gen:spec-driven-resources to prepare it again.",
		);
	}
	const expectedFingerprint = compiled ? bundledArchive?.sourceFingerprint : await specDrivenSourceFingerprint();
	if (!expectedFingerprint || manifest.sourceFingerprint !== expectedFingerprint) {
		throw new Error("Stale spec-driven resource archive; run bun run gen:spec-driven-resources to prepare it again.");
	}
	if (!Array.isArray(manifest.files) || !Array.isArray(manifest.skills)) {
		throw new Error("Incomplete spec-driven manifest; run bun run gen:spec-driven-resources.");
	}
	const declaredPaths = new Set(manifest.files.map(file => file.path));
	for (const required of [
		"openspec/bin/openspec.js",
		"openspec/dist/cli/index.js",
		"openspec/package.json",
		"openspec/schemas/spec-driven/schema.yaml",
	]) {
		if (!declaredPaths.has(required)) {
			throw new Error(`Incomplete spec-driven archive (${required}); run bun run gen:spec-driven-resources.`);
		}
	}
	const unmatchedSkills = new Set(bundledSkillNames);
	for (const skill of manifest.skills) {
		if (!unmatchedSkills.delete(skill.name)) throw new Error(`Unexpected bundled skill in manifest: ${skill.name}`);
		if (!declaredPaths.has(skill.path)) {
			throw new Error(`Incomplete spec-driven skill (${skill.path}); run bun run gen:spec-driven-resources.`);
		}
	}
	if (unmatchedSkills.size > 0)
		throw new Error(`Missing bundled skills in manifest: ${[...unmatchedSkills].join(", ")}`);
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
	const cache = path.join(path.dirname(getDocumentConversionCacheDir()), "spec-driven");
	const root = path.join(cache, digest);
	await fs.mkdir(cache, { recursive: true });
	await withFileLock(
		`${cache}.update`,
		async () => {
			const complete = path.join(root, ".omp-complete");
			if ((await Bun.file(complete).exists()) && (await Bun.file(complete).text()) === digest) return;
			const temporary = await fs.mkdtemp(path.join(path.dirname(cache), ".spec-driven-"));
			try {
				await extractArchive({ bytes, format: "tar.gz" }, temporary);
				for (const file of manifest.files) {
					const target = await resolveSpecDrivenResourcePath(temporary, file.path);
					if (
						crypto
							.createHash("sha256")
							.update(await fs.readFile(target))
							.digest("hex") !== file.sha256
					)
						throw new Error(`Bundled resource digest mismatch: ${file.path}`);
					if (file.executable) await fs.chmod(target, 0o755);
				}
				await fs.writeFile(path.join(temporary, ".omp-complete"), digest);
				// Other digests may still back resource paths held by live sessions.
				await fs.rm(root, { recursive: true, force: true });
				await fs.rename(temporary, root);
			} finally {
				await fs.rm(temporary, { recursive: true, force: true });
			}
		},
		{ retries: 600, retryDelayMs: 100 },
	);
	return {
		root,
		openspecRoot: path.join(root, "openspec"),
		superpowersRoot: path.join(root, "superpowers"),
		jchRoot: path.join(root, "jch"),
		manifest,
	};
}

export async function loadSpecDrivenSkill(source: SpecDrivenResourceSource, name: string): Promise<Skill> {
	const resources = await ensureSpecDrivenResources();
	const entry = resources.manifest.skills.find(skill => skill.source === source && skill.name === name);
	if (!entry) throw new Error(`Unknown bundled ${source} skill: ${name}`);
	const containRoot = {
		openspec: resources.openspecRoot,
		superpowers: resources.superpowersRoot,
		jch: resources.jchRoot,
	}[source];
	const filePath = await resolveSpecDrivenResourcePath(resources.root, entry.path);
	if (!isPathInside(await fs.realpath(containRoot), filePath)) throw new Error("Bundled skill escapes source root");
	const content = await fs.readFile(filePath, "utf8");
	const digest = resources.manifest.files.find(file => file.path === entry.path)?.sha256;
	if (!digest || crypto.createHash("sha256").update(content).digest("hex") !== digest)
		throw new Error(`Bundled resource digest mismatch: ${entry.path}`);
	const parsed = parseFrontmatter(content, { source: filePath, repair: false, level: "off" });
	return {
		name,
		description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "",
		filePath,
		baseDir: path.dirname(filePath),
		source: `bundled-${source}`,
		hide: parsed.frontmatter.hide === true || parsed.frontmatter.disableModelInvocation === true,
		containRoot,
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
	const resources = await ensureSpecDrivenResources();
	const entry = await resolveSpecDrivenResourcePath(resources.openspecRoot, "bin/openspec.js");
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
	const resources = await ensureSpecDrivenResources();
	const inventory = resources.manifest.files.find(file => file.path === `superpowers/${relativePath}`);
	if (!inventory || !relativePath.startsWith("skills/"))
		throw new Error(`Not a bundled skill script: ${relativePath}`);
	const script = await resolveSpecDrivenResourcePath(resources.superpowersRoot, relativePath);
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
