import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import version from "../packages/coding-agent/package.json" with { type: "json" };
import natives from "../packages/natives/package.json" with { type: "json" };
import { containsLegacyVersionSentinel, containsVersionStamp } from "../packages/natives/native/version-sentinel.js";

const root = path.resolve(import.meta.dir, "..");
const nativePath = "packages/natives/native";
const vendorPath = "vendor/openwiki";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "inherit" });
	const result = await child.stdout.text();
	if ((await child.exited) !== 0) throw new Error(`git ${args[0]} failed in ${cwd}`);
	return result;
}

async function pack(out: string): Promise<void> {
	const { platform, arch } = process;
	if ((platform !== "win32" && platform !== "linux") || arch !== "x64" || !out.toLowerCase().endsWith(".zip")) {
		throw new Error("Usage on Windows or Linux x64: bun run pack:sdk [output.zip]");
	}
	const releaseNativeDir = process.env.OMP_RELEASE_NATIVE_DIR;
	const addonDir = path.resolve(root, releaseNativeDir || nativePath);
	const baseline = `pi_natives.${platform}-${arch}-baseline.node`;
	const modern = `pi_natives.${platform}-${arch}-modern.node`;
	const candidates = platform === "linux" ? [baseline] : releaseNativeDir ? [modern] : [baseline, modern];
	const present = new Set(await fs.readdir(addonDir));
	const addons = candidates.filter(name => present.has(name));
	if (!addons.length) throw new Error(`No SDK native addon in ${addonDir}. Expected ${candidates.join(" or ")}.`);
	for (const name of addons) {
		const bytes = await Bun.file(path.join(addonDir, name)).bytes();
		if (!containsVersionStamp(bytes, natives.version) && !containsLegacyVersionSentinel(bytes, natives.version)) {
			throw new Error(`${name} does not match pi-natives ${natives.version}; rebuild the addon before packing.`);
		}
	}

	// The build graph includes workspace-relative imports (browser relay, OpenWiki, and virtual modules).
	// Use tracked source paths, not git history, ignored caches, personal settings, or installed dependencies.
	const paths = (
		await git(
			root,
			"ls-files",
			"--cached",
			"-z",
			"--",
			"LICENSE",
			"README.md",
			"bun.lock",
			"bunfig.toml",
			"package.json",
			"tsconfig*.json",
			"types",
			"patches",
			"packages",
			"docs",
			"docs-zh-CN/team.md",
			"python/robomp/web/package.json",
		)
	)
		.split("\0")
		.filter(name => name && !/^packages\/[^/]+\/(?:bench|test|examples)\//.test(name));
	const vendor = path.join(root, vendorPath);
	if (!(await Bun.file(path.join(vendor, "package.json")).exists())) {
		throw new Error("Initialize vendor/openwiki before packaging the SDK.");
	}
	// Git can discover the parent repo if this directory is not an initialized submodule.
	const vendorPaths = ["src", "skills", "static", "package.json", "tsconfig.json", "tsconfig.client.json", "LICENSE"];
	const vendorFiles = (await git(vendor, "ls-files", "--cached", "-z", "--", ...vendorPaths))
		.split("\0")
		.filter(Boolean);
	if (!vendorFiles.includes("package.json")) throw new Error("vendor/openwiki must be an initialized Git submodule.");
	const files = [
		...new Set([...paths, ...vendorFiles.map(name => `${vendorPath}/${name}`), "scripts/compile-sdk-host.ts"]),
	];
	const stage = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sdk-"));
	const temporary = path.join(path.dirname(out), `.omp-sdk-${randomUUID()}.zip`);
	try {
		await fs.mkdir(path.dirname(out), { recursive: true });
		await Promise.all(
			[...new Set([...files.map(name => path.dirname(name)), nativePath])].map(dir =>
				fs.mkdir(path.join(stage, dir), { recursive: true }),
			),
		);
		for (let index = 0; index < files.length; index += 64) {
			await Promise.all(
				files.slice(index, index + 64).map(name => fs.copyFile(path.join(root, name), path.join(stage, name))),
			);
		}
		await Promise.all(addons.map(name => fs.copyFile(path.join(addonDir, name), path.join(stage, nativePath, name))));
		const manifest = {
			format: 1,
			version: version.version,
			commit: (await git(root, "rev-parse", "HEAD")).trim(),
			bun: Bun.version,
			platform,
			arch,
			addons,
		};
		await Bun.write(path.join(stage, "omp-sdk.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		const command =
			platform === "win32"
				? [
						path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
						"--format=zip",
						"-cf",
						temporary,
						".",
					]
				: ["zip", "-qr", temporary, "."];
		const child = Bun.spawn(command, { cwd: stage, stdout: "inherit", stderr: "inherit" });
		if ((await child.exited) !== 0) throw new Error(`${command[0]} could not create the SDK ZIP`);
		const sha256 = createHash("sha256");
		for await (const bytes of Bun.file(temporary).stream()) sha256.update(bytes);
		await fs.rename(temporary, out);
		console.log(`${out}\nSHA-256: ${sha256.digest("hex")}`);
	} finally {
		await fs.rm(stage, { recursive: true, force: true });
		await fs.rm(temporary, { force: true });
	}
}

if (process.argv.length > 3) throw new Error("Usage: bun run pack:sdk [output.zip]");
await pack(
	path.resolve(
		process.argv[2] ?? path.join(root, "dist", `omp-sdk-${version.version}-${process.platform}-${process.arch}.zip`),
	),
);
