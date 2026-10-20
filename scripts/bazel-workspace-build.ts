import * as path from "node:path";
import { archiveWorkspaceProducts, restoreWorkspaceProducts, type WorkspaceProduct } from "./bazel-workspace-products";
import { runBazelCommands } from "./test-gate-bazel";
import { GateCommandError } from "./test-gate-failure-events";
import type { GateCommand, GateRun } from "./test-gate-runtime";

const root = path.resolve(import.meta.dir, "..");
const workspaces: Record<WorkspaceProduct, string> = {
	"browser-relay": "packages/browser-relay",
	"collab-web": "packages/collab-web",
	stats: "packages/stats",
	"robomp-web": "python/robomp/web",
	"coding-agent": "packages/coding-agent",
};

function reusable(product: WorkspaceProduct): boolean {
	if (product !== "coding-agent") return true;
	// Custom compiler bytes and platform signing are external toolchains. Cross-target
	// Bun templates may require network downloads; do not claim a closed cache there.
	return !process.env.BUN_COMPILE_EXECUTABLE_PATH && !process.env.CROSS_TARGET && process.platform !== "darwin";
}

function command(product: WorkspaceProduct): GateCommand {
	return {
		label: `compile/workspace ${product}`,
		argv: ["bun", "scripts/bazel-workspace-build.ts", "--produce", product],
		// The CLI reads collab-web generators, native files and generated browser assets;
		// conservatively use the root's full source + installed dependency closure.
		cwd: root,
		env: {
			CROSS_TARGET: process.env.CROSS_TARGET,
			BUN_COMPILE_EXECUTABLE_PATH: process.env.BUN_COMPILE_EXECUTABLE_PATH,
			BUN_NO_CODESIGN_MACHO_BINARY: process.env.BUN_NO_CODESIGN_MACHO_BINARY,
		},
		...(reusable(product) ? { artifactFiles: [`${product}.tar`] } : { resultReuse: "disabled" as const }),
	};
}

async function buildProducts(gate: GateRun, products: WorkspaceProduct[]): Promise<void> {
	const reports = await runBazelCommands(gate, products.map(command), { root });
	for (const product of products) {
		const report = reports.find(result => result.label === `compile/workspace ${product}`);
		if (!report || (report.status !== "new" && report.status !== "cached")) {
			throw new Error(`Workspace producer did not complete: ${product}`);
		}
		if (!reusable(product)) continue;
		const archive = report.artifacts?.[`${product}.tar`];
		if (!archive || !path.isAbsolute(archive))
			throw new Error(`Workspace producer has no declared archive: ${product}`);
		await restoreWorkspaceProducts(root, product, archive);
	}
}

/** Public aliases share the same per-workspace Bazel product targets. */
export async function runWorkspaceBuild(
	gate: GateRun,
	task: "build" | "collab:web:build" | "robomp:web:build",
): Promise<void> {
	if (task === "collab:web:build") return buildProducts(gate, ["collab-web"]);
	if (task === "robomp:web:build") return buildProducts(gate, ["robomp-web"]);
	// The same always-run public native target installs/stamps/probes each request;
	// its authenticated Bazel host owns the nested raw-artifact producer.
	// build/ and compile/workspace use independent declaration leases.
	await Promise.all([
		buildProducts(gate, ["browser-relay", "collab-web", "stats", "robomp-web"]),
		runBazelCommands(
			gate,
			[
				{
					label: "build/public/build:native",
					argv: ["bun", path.join(root, "scripts/bazel-primitive.ts"), "build:native"],
					cwd: root,
					resultReuse: "disabled",
				},
			],
			{ root },
		),
	]);
	// Both the standalone stats action and CLI gen:stats write dist/client. Finish
	// all prerequisite restores before compilation rather than racing their writers.
	await buildProducts(gate, ["coding-agent"]);
}

async function produce(product: WorkspaceProduct, outputDirectory: string | undefined): Promise<void> {
	if (!Object.hasOwn(workspaces, product)) throw new Error(`Unknown workspace producer: ${product}`);
	// Workspace scripts are intentionally unchanged and contain the canonical real
	// producers. Never invoke the root's public build aliases from an action.
	const child = Bun.spawn(["bun", "run", "build"], {
		cwd: path.join(root, workspaces[product]),
		env: { ...process.env, OMP_GATE_BAZEL_PRIMITIVE: "1" },
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	if (code !== 0) throw new GateCommandError(`Workspace producer failed: ${product}`, code);
	if (outputDirectory) await archiveWorkspaceProducts(root, product, path.join(outputDirectory, `${product}.tar`));
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] !== "--produce" || !args[1])
		throw new Error("Expected --produce <workspace> [--output-dir=<directory>]");
	const outputDirectory = args.find(argument => argument.startsWith("--output-dir="))?.slice("--output-dir=".length);
	if (outputDirectory === "") throw new Error("Missing --output-dir value");
	await produce(args[1] as WorkspaceProduct, outputDirectory);
}
