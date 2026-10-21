import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function runAffectedFixture(mode: "error" | "invalid-json" | "invalid-shape" | "workspace", dryRun: boolean) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rust-selection-"));
	try {
		// Run the real CLI and its local dependencies, never the checkout's Cargo workspace.
		fs.cpSync(import.meta.dir, path.join(root, "scripts"), {
			recursive: true,
			filter: source => fs.statSync(source).isDirectory() || source.endsWith(".ts"),
		});
		fs.symlinkSync(path.join(import.meta.dir, "..", "node_modules"), path.join(root, "node_modules"), "junction");
		fs.symlinkSync(path.join(import.meta.dir, "..", "packages"), path.join(root, "packages"), "junction");
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		const extension = process.platform === "win32" ? ".exe" : "";
		const cargo = path.join(bin, `cargo${extension}`);
		const rustup = path.join(bin, `rustup${extension}`);
		// Node interprets fixture subcommands without Bun's built-in `test` discovery.
		const node = Bun.which("node");
		if (!node) throw new Error("The fake Cargo CLI fixture requires a Node executable.");
		fs.copyFileSync(node, cargo);
		fs.copyFileSync(node, rustup);
		fs.chmodSync(cargo, 0o755);
		fs.chmodSync(rustup, 0o755);
		fs.writeFileSync(path.join(root, "which"), `console.log(${JSON.stringify(cargo)});\n`);
		const dispatchLog = path.join(root, "dispatch.jsonl");
		const logCommand = `require("node:fs").appendFileSync(${JSON.stringify(dispatchLog)}, JSON.stringify(process.argv.slice(1)) + "\\n");\n`;
		const metadata = {
			packages: ["leaf", "other", "brush-core", "brush-parser", "cfg_aliases", "napi"].map(name => ({
				id: `${name}@1.0.0`,
				name,
				version: "1.0.0",
				source: null,
				manifest_path: path.join(root, "crates", name, "Cargo.toml"),
				dependencies: [],
				targets: [{ kind: ["lib"], doctest: true }],
			})),
			workspace_members: ["leaf", "other", "brush-core", "brush-parser", "cfg_aliases", "napi"].map(
				name => `${name}@1.0.0`,
			),
		};
		const metadataOutput =
			mode === "workspace" ? JSON.stringify(metadata) : mode === "invalid-shape" ? "{}" : "not JSON";
		fs.writeFileSync(
			path.join(root, "metadata"),
			logCommand +
				(mode === "error"
					? 'console.error("fixture metadata failure"); process.exit(23);\n'
					: `console.log(${JSON.stringify(metadataOutput)});\n`),
		);
		for (const command of ["nextest", "test"]) fs.writeFileSync(path.join(root, command), logCommand);
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("OMP_")) delete env[key];
		Object.assign(env, {
			PATH: bin,
			Path: bin,
			"ProgramFiles(x86)": root,
			CI: "1",
			// Never activate Windows compiler-launcher preparation in pre-fix fallback runs.
			...(dryRun && mode !== "workspace" ? { OMP_GATE_EVENT_TOKEN: "rust-selection-fixture" } : {}),
			OMP_FULLTEST_CHANGED_PATHS: JSON.stringify([mode === "workspace" ? "Cargo.toml" : "crates/leaf/src/lib.rs"]),
		});
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(root, "scripts", "run-rs-task.ts"),
				"test:rs",
				"--affected",
				...(dryRun ? ["--dry-run"] : []),
			],
			{ cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const dispatches: string[][] = fs.existsSync(dispatchLog)
			? fs
					.readFileSync(dispatchLog, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line))
			: [];
		if (dispatches.length === 0)
			throw new Error(`Fixture failed before metadata (exit ${exitCode}):\n${stdout}\n${stderr}`);
		return { exitCode, stdout, stderr, dispatches };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("affected Rust CLI selection failures", () => {
	for (const mode of ["error", "invalid-json", "invalid-shape"] as const) {
		for (const dryRun of [false, true]) {
			it(`fails closed for ${mode}${dryRun ? " during dry-run" : ""}`, async () => {
				const result = await runAffectedFixture(mode, dryRun);
				expect(result.dispatches).toHaveLength(1);
				expect(path.basename(result.dispatches[0][0])).toBe("metadata");
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain(
					mode === "error"
						? "fixture metadata failure"
						: mode === "invalid-json"
							? "invalid JSON"
							: "unable to resolve affected Rust crates",
				);
				expect(result.stdout).not.toContain("Rust test crates (");
				if (dryRun) {
					expect(result.stderr).toContain("OMP_GATE_EVENT rust-selection-fixture ");
					expect(result.stderr).toContain('"kind":"failure"');
					expect(result.stderr).toContain('"exitCode":1');
				}
			}, 20_000);
		}
	}

	for (const dryRun of [false, true]) {
		it(`retains deliberate workspace selection${dryRun ? " during dry-run" : ""}`, async () => {
			const result = await runAffectedFixture("workspace", dryRun);
			expect(result.exitCode).toBe(0);
			if (dryRun) {
				expect(result.dispatches).toHaveLength(1);
				expect(result.stdout).toContain("all affected workspace crates");
				expect(result.stdout).toContain("leaf, other");
				expect(result.stdout).not.toContain("-p brush-core");
			} else {
				// Reporting may query the fake nextest version after the test command.
				const commands = result.dispatches.filter(
					args => !(path.basename(args[0]) === "nextest" && args[1] === "--version"),
				);
				expect(commands.map(args => path.basename(args[0]))).toEqual(["metadata", "nextest", "test"]);
				for (const args of commands.slice(1)) {
					expect(args).toContain("leaf");
					expect(args).toContain("other");
					expect(args).not.toContain("brush-core");
				}
			}
		}, 20_000);
	}
});
