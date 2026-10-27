import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import { getDocumentConversionCacheDir } from "@oh-my-pi/pi-utils/dirs";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import type { Skill } from "../extensibility/skills";
import { collectSpecDrivenResources } from "./resource-inventory";
import bundledArchivePath from "./resource-archive";

export type SpecDrivenResourceSource = "openspec" | "superpowers" | "jch";
export interface SpecDrivenSkillEntry {
	source: SpecDrivenResourceSource;
	name: string;
	path: string;
}
export interface SpecDrivenResourceManifest {
	openspec: { version: string; integrity: string };
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
	specSchemaPath: string;
}
export interface SpecDrivenProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Also checks canonical containment: junctions/symlinks cannot redirect trusted execution. */
export async function resolveSpecDrivenResourcePath(root: string, relativePath: string): Promise<string> {
	if (
		!relativePath ||
		relativePath.includes("\\") ||
		path.posix.isAbsolute(relativePath) ||
		/^[a-z]:/i.test(relativePath) ||
		relativePath.split("/").some(segment => segment === ".." || segment === "." || segment === "")
	) {
		throw new Error(`Invalid bundled resource path: ${relativePath}`);
	}
	const canonicalRoot = await fs.realpath(root);
	const target = path.resolve(root, relativePath);
	if (!inside(path.resolve(root), target)) throw new Error("Bundled resource escapes root");
	const canonical = await fs.realpath(target);
	if (!inside(canonicalRoot, canonical)) throw new Error("Bundled resource escapes canonical root");
	return canonical;
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
	const localRoot = path.join(import.meta.dir, "vendor", "resources");
	// npm excludes nested node_modules even when the vendored tree is in "files".
	// Its prepack bundle therefore also carries a complete fixed-name archive for SDK imports.
	const localAvailable = !compiled && await fs.stat(path.join(localRoot, "openspec", "node_modules"))
		.then(stat => stat.isDirectory()).catch(() => false);
	let bytes: Uint8Array | undefined;
	let entries: Record<string, Uint8Array> | undefined;
	let manifest: SpecDrivenResourceManifest;
	if (compiled) {
		if (!bundledArchivePath) throw new Error("Bundled resource archive asset is missing");
		const assetPath = path.isAbsolute(bundledArchivePath) || path.win32.isAbsolute(bundledArchivePath)
			? bundledArchivePath : path.resolve(import.meta.dir, bundledArchivePath);
		bytes = await Bun.file(assetPath).bytes();
	} else if (!localAvailable) {
		bytes = await Bun.file(path.resolve(import.meta.dir, "../../dist/spec-driven-resources.tar.gz")).bytes();
	}
	if (bytes) {
		const archiveFiles = await new Bun.Archive(bytes).files();
		const manifestFile = archiveFiles.get("manifest.json");
		if (!manifestFile) throw new Error("Bundled resource archive has no manifest");
		manifest = JSON.parse(await manifestFile.text()) as SpecDrivenResourceManifest;
	} else {
		const snapshot = await collectSpecDrivenResources(localRoot);
		manifest = snapshot.manifest;
		entries = snapshot.entries;
	}
	const digest = crypto.createHash("md5").update(JSON.stringify(manifest)).digest("hex");
	const cache = path.join(path.dirname(getDocumentConversionCacheDir()), "spec-driven");
	const root = path.join(cache, digest);
	await fs.mkdir(path.dirname(cache), { recursive: true });
	await withFileLock(`${cache}.update`, async () => {
		const complete = path.join(root, ".omp-complete");
		if ((await Bun.file(complete).exists()) && (await Bun.file(complete).text()) === digest) return;
		const temporary = await fs.mkdtemp(path.join(path.dirname(cache), ".spec-driven-"));
		try {
			if (bytes) {
				await extractArchive({ bytes, format: "tar.gz" }, temporary);
			} else {
				for (const file of manifest.files) {
					const target = path.join(temporary, ...file.path.split("/"));
					await fs.mkdir(path.dirname(target), { recursive: true });
					await fs.writeFile(target, entries![file.path]!);
				}
			}
			for (const file of manifest.files) {
				const target = await resolveSpecDrivenResourcePath(temporary, file.path);
				if (crypto.createHash("sha256").update(await fs.readFile(target)).digest("hex") !== file.sha256)
					throw new Error(`Bundled resource digest mismatch: ${file.path}`);
				if (file.executable) await fs.chmod(target, 0o755);
			}
			await fs.writeFile(path.join(temporary, ".omp-complete"), digest);
			await fs.rm(cache, { recursive: true, force: true });
			await fs.mkdir(cache, { recursive: true });
			await fs.rename(temporary, root);
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}, { retries: 600, retryDelayMs: 100 });
	return {
		root,
		openspecRoot: path.join(root, "openspec"),
		superpowersRoot: path.join(root, "superpowers"),
		jchRoot: path.join(root, "jch"),
		manifest,
		specSchemaPath: path.join(root, "omp-spec", "schema.yaml"),
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
	if (!inside(await fs.realpath(containRoot), filePath)) throw new Error("Bundled skill escapes source root");
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
): Promise<SpecDrivenProcessResult> {
	signal?.throwIfAborted();
	const child = Bun.spawn(command, {
		cwd,
		signal,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", ...extraEnv },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

export async function runOpenSpec(
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<SpecDrivenProcessResult> {
	const resources = await ensureSpecDrivenResources();
	const entry = await resolveSpecDrivenResourcePath(resources.openspecRoot, "bin/openspec.js");
	return run([process.execPath, entry, ...args], cwd, signal, { BUN_BE_BUN: "1" });
}

/** Refuse a project/user override instead of silently using a different Dev workflow. */
export async function assertDevSpecSchema(cwd: string, signal?: AbortSignal): Promise<void> {
	const resources = await ensureSpecDrivenResources();
	const result = await runOpenSpec(["schema", "which", "omp-spec", "--json"], cwd, signal);
	if (result.exitCode !== 0)
		throw new Error(`Cannot resolve the Dev schema: ${result.stdout}\n${result.stderr}`);
	let resolution: unknown;
	try {
		resolution = JSON.parse(result.stdout);
	} catch {
		throw new Error(`Invalid Dev schema resolution: ${result.stdout}`);
	}
	if (
		!resolution ||
		typeof resolution !== "object" ||
		!("source" in resolution) ||
		resolution.source !== "package" ||
		!("path" in resolution) ||
		typeof resolution.path !== "string" ||
		(await fs.realpath(resolution.path)) !==
			(await fs.realpath(path.join(resources.openspecRoot, "schemas", "omp-spec")))
	) {
		throw new Error(
			`Dev requires the bundled omp-spec schema; an external schema shadows it. Resolve the conflict without modifying existing changes. ${result.stdout}`,
		);
	}
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
): Promise<SpecDrivenProcessResult> {
	const resources = await ensureSpecDrivenResources();
	const inventory = resources.manifest.files.find(file => file.path === `superpowers/${relativePath}`);
	if (!inventory || !relativePath.startsWith("skills/"))
		throw new Error(`Not a bundled skill script: ${relativePath}`);
	const script = await resolveSpecDrivenResourcePath(resources.superpowersRoot, relativePath);
	const head = (await fs.readFile(script, "utf8")).split("\n", 1)[0] ?? "";
	const runtimeRoot = path.join(resources.root, "omp-runtime");
	const env = {
		BUN_BE_BUN: "1",
		OMP_BUN_EXECUTABLE: process.execPath,
		PATH: `${runtimeRoot}${path.delimiter}${process.env.PATH ?? ""}`,
		BRAINSTORM_DIR: path.join(cwd, ".superpowers", "brainstorm"),
	};
	if (/\.(?:c?js|mjs)$/.test(relativePath)) return run([process.execPath, script, ...args], cwd, signal, env);
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
	return run([bash, script.replaceAll("\\", "/"), ...args], cwd, signal, env);
}
