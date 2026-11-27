import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $, type BunPlugin } from "bun";
import { parse as parseYaml } from "yaml";
import { openWikiPackageDirectory } from "../src/openwiki/resource-dependencies";
import {
	specDrivenOpenSpecInputs,
	specDrivenPassthroughDirectories,
	specDrivenSourceFingerprint,
} from "../src/spec-driven/resource-fingerprint";
import { collectSpecDrivenResources } from "../src/spec-driven/resource-inventory";
import { resolveSpecDrivenResourcePath } from "../src/spec-driven/resource-path";

const vendor = path.resolve(import.meta.dir, "../src/spec-driven/vendor");
const resources = path.join(vendor, "resources");

/**
 * Build an owned, disposable OpenSpec runtime from the maintained vendor source.
 * Only build hosts install dependencies; consumers run the resulting JavaScript
 * with OMP's Bun. Preserve module paths for package.json and schema resolution.
 */
export async function prepareOpenSpecRuntime(): Promise<TempDir> {
	const source = path.join(resources, "openspec");
	const { sourceDirectory, packageManifest, dependencyLock: lockfile, runtimeEntries } = specDrivenOpenSpecInputs;
	const runtime = await TempDir.create("@omp-openspec-runtime-");
	try {
		const packageJson = (await Bun.file(path.join(source, packageManifest)).json()) as Record<string, unknown>;
		const lock = await Bun.file(path.join(source, lockfile)).text();
		const dependencyLock = parseYaml(lock) as { overrides?: Record<string, string> };
		// Bun migrates the pnpm lock, including overrides. Keep them in the staging
		// manifest so frozen installation cannot silently resolve a different tree.
		await Bun.write(
			runtime.join(packageManifest),
			JSON.stringify({ ...packageJson, overrides: dependencyLock.overrides }, null, 2),
		);
		await Bun.write(runtime.join(lockfile), lock);
		const cache = process.env.OMP_OPENSPEC_BUN_CACHE;
		const cacheFlags = cache ? ["--offline", "--backend=copyfile", `--cache-dir=${cache}`] : [];
		await $`${process.execPath} install --production --ignore-scripts --frozen-lockfile ${cacheFlags}`
			.cwd(runtime.path())
			.env({ ...process.env, BUN_BE_BUN: "1" });
		// Installation inputs are not runtime resources. Keep the vendor lock in
		// source control, but do not ship it or Bun's installation metadata.
		for (const entry of [lockfile, "bun.lock", "bun.lockb"]) {
			await fs.rm(runtime.join(entry), { force: true });
		}

		const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun", trimUnusedImports: true });
		const sourceRoot = path.join(source, sourceDirectory);
		for await (const relative of new Bun.Glob("**/*").scan({ cwd: sourceRoot, onlyFiles: true })) {
			if (relative.endsWith(".d.ts")) continue;
			const input = Bun.file(path.join(sourceRoot, relative));
			const output = runtime.join("dist", relative.endsWith(".ts") ? `${relative.slice(0, -3)}.js` : relative);
			await Bun.write(output, relative.endsWith(".ts") ? await transpiler.transform(await input.text()) : input);
		}
		// Only runtime resources: README/docs and their screenshots stay in vendor.
		for (const entry of runtimeEntries) {
			await fs.cp(path.join(source, entry), runtime.join(entry), { recursive: true });
		}
		return runtime;
	} catch (error) {
		await runtime.remove();
		throw error;
	}
}

interface RuntimePackage {
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

/** Reject incomplete staging before hashing or publishing an apparently valid archive. */
export async function assertOpenSpecRuntime(root: string): Promise<void> {
	async function file(relative: string): Promise<string> {
		const target = await resolveSpecDrivenResourcePath(root, relative);
		if (!(await fs.stat(target)).isFile()) throw new Error(`OpenSpec runtime file missing: ${relative}`);
		return target;
	}
	for (const relative of ["dist/cli/index.js", "bin/openspec.js", "package.json", "LICENSE"]) await file(relative);
	const modules = await resolveSpecDrivenResourcePath(root, "node_modules");
	if (!(await fs.stat(modules)).isDirectory()) throw new Error("OpenSpec runtime node_modules is not a directory");
	for (const skill of await fs.readdir(path.join(resources, "openspec/skills"), { withFileTypes: true })) {
		if (skill.isDirectory()) await file(`skills/${skill.name}/SKILL.md`);
	}
	for (const schema of await fs.readdir(path.join(resources, "openspec/schemas"), { withFileTypes: true })) {
		if (!schema.isDirectory()) continue;
		const schemaFile = await file(`schemas/${schema.name}/schema.yaml`);
		const parsed = parseYaml(await Bun.file(schemaFile).text()) as { artifacts: { template: string }[] };
		for (const artifact of parsed.artifacts) await file(`schemas/${schema.name}/templates/${artifact.template}`);
	}
	const visited = new Set<string>();
	async function dependencies(directory: string): Promise<void> {
		const canonical = await fs.realpath(directory);
		if (visited.has(canonical)) return;
		visited.add(canonical);
		const manifestPath = await file(
			path.relative(root, path.join(directory, "package.json")).replaceAll(path.sep, "/"),
		);
		const manifest = (await Bun.file(manifestPath).json()) as RuntimePackage;
		for (const name of new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
		])) {
			let dependency: string;
			try {
				dependency = openWikiPackageDirectory(name, directory);
			} catch (error) {
				if (manifest.optionalDependencies?.[name] && !manifest.dependencies?.[name]) continue;
				throw new Error(`OpenSpec runtime dependency missing: ${name} (from ${directory})`, { cause: error });
			}
			await dependencies(dependency);
		}
	}
	await dependencies(root);
	// Resolving manifests alone misses removed exports/main files and transitive
	// module imports. Bundle in memory to resolve the real CLI's lazy module graph.
	const result = await Bun.build({ entrypoints: [path.join(root, "bin/openspec.js")], target: "bun" });
	if (!result.success) {
		throw new Error(
			`OpenSpec runtime module closure is incomplete:\n${result.logs.map(log => log.message).join("\n")}`,
		);
	}
}

/** Prepare once per build invocation; npm, binary and source preparation share this packer. */
export async function buildSpecDrivenArchive(): Promise<Uint8Array> {
	const sourceFingerprint = await specDrivenSourceFingerprint();
	await using runtime = await prepareOpenSpecRuntime();
	await using staging = await TempDir.create("@omp-spec-driven-staging-");
	await fs.rename(runtime.path(), staging.join("openspec"));
	for (const entry of specDrivenPassthroughDirectories) {
		await fs.cp(path.join(resources, entry), staging.join(entry), { recursive: true });
	}
	await assertOpenSpecRuntime(staging.join("openspec"));
	const { manifest, entries } = await collectSpecDrivenResources(staging.path(), sourceFingerprint);
	if ((await specDrivenSourceFingerprint()) !== sourceFingerprint) {
		throw new Error(
			"Spec-driven build inputs changed during preparation; run bun run gen:spec-driven-resources again.",
		);
	}
	entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
	const sorted: Record<string, Uint8Array> = {};
	for (const name of Object.keys(entries).sort()) sorted[name] = entries[name]!;
	const tar = await new Bun.Archive(sorted).bytes();
	// Normalize archive metadata so an unchanged tree has an unchanged cache key.
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;
		const size = Number.parseInt(
			Buffer.from(header.subarray(124, 136)).toString("ascii").replace(/\0.*$/, "").trim() || "0",
			8,
		);
		for (const [start, width] of [
			[108, 8],
			[116, 8],
			[136, 12],
		] as const) {
			header.fill(0x30, start, start + width - 1);
			header[start + width - 2] = 0x30;
			header[start + width - 1] = 0;
		}
		header.fill(0x20, 148, 156);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.set(Buffer.from(checksum.toString(8).padStart(6, "0")), 148);
		header[154] = 0;
		header[155] = 0x20;
		offset += 512 * (1 + Math.ceil(size / 512));
	}
	return Bun.gzipSync(tar, { level: 9 });
}

/** Bun's file loader emits a real asset for npm bundles and embeds it in executables. */
export async function createSpecDrivenArchivePlugin(archive: Uint8Array): Promise<BunPlugin> {
	const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
	const sourceFingerprint = await specDrivenSourceFingerprint();
	return {
		name: "omp-spec-driven-archive",
		target: "bun",
		setup(build) {
			build.onResolve({ filter: /^\.\/resource-archive$/ }, ({ importer }) => {
				if (!importer.replaceAll("\\", "/").endsWith("/spec-driven/resources.ts")) return undefined;
				return { path: "resource-module", namespace: "omp-spec-driven-module" };
			});
			build.onLoad({ filter: /.*/, namespace: "omp-spec-driven-module" }, () => ({
				contents: `import path from "omp:spec-driven-archive"; export default { path, sha256: ${JSON.stringify(sha256)}, sourceFingerprint: ${JSON.stringify(sourceFingerprint)} };`,
				loader: "js",
			}));
			build.onResolve({ filter: /^omp:spec-driven-archive$/ }, () => ({
				path: "spec-driven-resources.tar.gz",
				namespace: "omp-spec-driven-archive",
			}));
			build.onLoad({ filter: /.*/, namespace: "omp-spec-driven-archive" }, () => ({
				contents: archive,
				loader: "file",
			}));
		},
	};
}

if (import.meta.main) {
	const archive = await buildSpecDrivenArchive();
	const output = path.resolve(import.meta.dir, "../dist/spec-driven-resources.tar.gz");
	await Bun.write(output, archive);
	process.stdout.write(`Prepared spec-driven resources: ${output}\n`);
}
