import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import { getDocumentConversionCacheDir } from "@oh-my-pi/pi-utils/dirs";
import type { Skill } from "../extensibility/skills";
import type { SpecStageRole } from "./types";
import { archiveBase64, archiveSha256, resourceManifest } from "./vendor/archive.generated";

export type SpecDrivenResourceSource = "superpowers" | "jch";
export interface SpecDrivenSkillEntry {
	source: SpecDrivenResourceSource;
	name: string;
	path: string;
}
export interface SpecDrivenMethodEntry extends SpecDrivenSkillEntry {
	role: SpecStageRole | "reviewer";
	originalPath: string;
	originalSha256: string;
	sha256: string;
	adaptation: string;
}
export interface SpecDrivenResourceManifest {
	openspec: { version: string; integrity: string };
	superpowers: { version: string; revision: string };
	jch: { revision: string };
	methods: readonly SpecDrivenMethodEntry[];
	commands: readonly { name: string; path: string }[];
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
	const bytes = Buffer.from(archiveBase64, "base64");
	if (crypto.createHash("sha256").update(bytes).digest("hex") !== archiveSha256)
		throw new Error("Bundled resource archive digest mismatch");
	const cache = path.join(path.dirname(getDocumentConversionCacheDir()), "spec-driven");
	const root = path.join(cache, archiveSha256);
	await fs.mkdir(cache, { recursive: true });
	const complete = path.join(root, ".omp-complete");
	if (!(await Bun.file(complete).exists())) {
		const temporary = await fs.mkdtemp(path.join(cache, ".extract-"));
		try {
			await extractArchive({ bytes, format: "tar.gz" }, temporary);
			for (const file of resourceManifest.files) {
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
			await fs.writeFile(path.join(temporary, ".omp-complete"), archiveSha256);
			try {
				await fs.rename(temporary, root);
			} catch (error) {
				if (!(await Bun.file(complete).exists())) throw error;
			}
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}
	return {
		root,
		openspecRoot: path.join(root, "openspec"),
		superpowersRoot: path.join(root, "superpowers"),
		jchRoot: path.join(root, "jch"),
		manifest: resourceManifest,
		specSchemaPath: path.join(root, "omp-spec", "schema.yaml"),
	};
}

export async function loadOpenSpecCommand(name: string): Promise<string> {
	const resources = await ensureSpecDrivenResources();
	const entry = resources.manifest.commands.find(command => command.name === name);
	if (!entry) throw new Error(`Unknown bundled OpenSpec command: ${name}`);
	const filePath = await resolveSpecDrivenResourcePath(resources.root, entry.path);
	if (!inside(await fs.realpath(resources.openspecRoot), filePath))
		throw new Error("Bundled command escapes OpenSpec root");
	const content = await fs.readFile(filePath, "utf8");
	const digest = resources.manifest.files.find(file => file.path === entry.path)?.sha256;
	if (!digest || crypto.createHash("sha256").update(content).digest("hex") !== digest)
		throw new Error(`Bundled resource digest mismatch: ${entry.path}`);
	const parsed = parseFrontmatter(content, { source: filePath, repair: false, level: "off" });
	if (!parsed.body.trim()) throw new Error(`Empty bundled OpenSpec command: ${name}`);
	return parsed.body.trim();
}

export async function loadSpecDrivenSkill(
	source: SpecDrivenResourceSource,
	name: string,
	options: { role?: SpecStageRole | "reviewer" } = {},
): Promise<Skill> {
	const resources = await ensureSpecDrivenResources();
	const original = resources.manifest.skills.find(skill => skill.source === source && skill.name === name);
	if (!original) throw new Error(`Unknown bundled ${source} skill: ${name}`);
	const method = options.role
		? resources.manifest.methods.find(
				skill => skill.source === source && skill.name === name && skill.role === options.role,
			)
		: undefined;
	if (options.role && !method)
		throw new Error(`Bundled ${source} skill ${name} is not allowed for role ${options.role}`);
	const entry = method ?? original;
	const containRoot = {
		superpowers: resources.superpowersRoot,
		jch: resources.jchRoot,
	}[source];
	const filePath = await resolveSpecDrivenResourcePath(resources.root, entry.path);
	if (!inside(await fs.realpath(containRoot), filePath)) throw new Error("Bundled skill escapes source root");
	const content = await fs.readFile(filePath, "utf8");
	const digest = resources.manifest.files.find(file => file.path === entry.path)?.sha256;
	if (!digest || crypto.createHash("sha256").update(content).digest("hex") !== digest)
		throw new Error(`Bundled resource digest mismatch: ${entry.path}`);
	if (method) {
		const originalPath = await resolveSpecDrivenResourcePath(resources.root, method.originalPath);
		if (
			!inside(await fs.realpath(containRoot), originalPath) ||
			crypto
				.createHash("sha256")
				.update(await fs.readFile(originalPath))
				.digest("hex") !== method.originalSha256 ||
			digest !== method.sha256
		)
			throw new Error(`Bundled method provenance mismatch: ${name}`);
	}
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
