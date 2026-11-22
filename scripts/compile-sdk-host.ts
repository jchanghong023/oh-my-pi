import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const compile = args[0] === "--prepared";
const [entrypoint, outfile, extra] = compile ? args.slice(1) : args;
if (!entrypoint || !outfile || extra !== undefined) {
	throw new Error("Usage: bun scripts/compile-sdk-host.ts <entry.ts> <output.exe>");
}
const sdk: { bun: string; platform: string; arch: string; version: string } = await Bun.file(
	join(root, "omp-sdk.json"),
).json();
if (sdk.bun !== Bun.version || sdk.platform !== process.platform || sdk.arch !== process.arch) {
	throw new Error(`OMP SDK requires Bun ${sdk.bun} on ${sdk.platform}-${sdk.arch}`);
}

async function run(...args: string[]): Promise<void> {
	const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
	if ((await child.exited) !== 0) throw new Error(`bun ${args.join(" ")} failed`);
}

if (compile) {
	const { compileCodingAgent } = await import("../packages/coding-agent/scripts/compile-binary");
	await compileCodingAgent({
		repoRoot: root,
		entrypoint: resolve(entrypoint),
		outfile: resolve(outfile),
		native: { platform: sdk.platform, arch: sdk.arch },
		buildVersion: sdk.version,
		chunkNaming: "chunks/[dir]/[name]-[hash].[ext]",
	});
} else {
	// Bun can cache missing module paths before installation, so compile in a fresh process.
	await run("install", "--frozen-lockfile", "--ignore-scripts");
	await run("--cwd=packages/stats", "run", "gen:stats");
	await run("--cwd=packages/collab-web", "run", "gen:export-viewer");
	await run(import.meta.path, "--prepared", resolve(entrypoint), resolve(outfile));
}
