import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { testTimeoutMs } from "./ci-test-ts";

interface Producer {
	producer: string;
	exitCode: number;
	reportPath: string | null;
}

async function runWorkspace(options: { fail?: boolean; args?: string[] } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rust-workspace-"));
	try {
		fs.cpSync(import.meta.dir, path.join(root, "scripts"), {
			recursive: true,
			filter: source => fs.statSync(source).isDirectory() || source.endsWith(".ts"),
		});
		fs.symlinkSync(path.join(import.meta.dir, "..", "node_modules"), path.join(root, "node_modules"), "junction");
		fs.symlinkSync(path.join(import.meta.dir, "..", "packages"), path.join(root, "packages"), "junction");
		fs.copyFileSync(path.join(import.meta.dir, "..", "rust-toolchain.toml"), path.join(root, "rust-toolchain.toml"));
		fs.mkdirSync(path.join(root, ".config"));
		fs.writeFileSync(path.join(root, ".config", "nextest.toml"), '[profile.default.junit]\npath = "junit.xml"\n');
		const names = ["leaf", "other", "brush-core", "brush-parser", "cfg_aliases", "napi"];
		fs.writeFileSync(
			path.join(root, "Cargo.toml"),
			`[workspace]\nresolver = "2"\nmembers = ${JSON.stringify(names)}\n`,
		);
		for (const name of names) {
			const crate = path.join(root, name);
			fs.mkdirSync(path.join(crate, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(crate, "Cargo.toml"),
				`[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`,
			);
			const failure = options.fail && name === "leaf";
			fs.writeFileSync(
				path.join(crate, "src", "lib.rs"),
				`/// Example.\n///\n/// \`\`\`\n/// assert!(${failure ? "false" : "true"});\n/// \`\`\`\npub fn example() {}\n#[test]\nfn ${name.replaceAll("-", "_")}_case() { assert!(${failure ? "false" : "true"}); }\n`,
			);
		}
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("OMP_")) delete env[key];
		Object.assign(env, {
			CI: "0",
			// An empty legacy delta must not suppress any workspace tests.
			OMP_FULLTEST_CHANGED_PATHS: "[]",
			OMP_TEST_REPORT_DIR: path.join(root, "reports"),
		});
		const child = Bun.spawn(
			[process.execPath, path.join(root, "scripts", "run-rs-task.ts"), "test:rs", ...(options.args ?? [])],
			{
				cwd: root,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const reportDir = path.join(root, "reports");
		const producers: Producer[] = fs.existsSync(reportDir)
			? fs
					.readdirSync(reportDir)
					.filter(name => name.endsWith(".producer.json"))
					.map(name => JSON.parse(fs.readFileSync(path.join(reportDir, name), "utf8")))
			: [];
		const reports = producers.map(p =>
			p.reportPath && fs.existsSync(path.join(reportDir, p.reportPath))
				? fs.readFileSync(path.join(reportDir, p.reportPath), "utf8")
				: "",
		);
		return { exitCode, stdout, stderr, producers, reports };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("Rust workspace CLI", () => {
	it(
		"runs all workspace tests and doctests without changed files",
		async () => {
			const result = await runWorkspace();
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.producers.map(producer => producer.exitCode)).toEqual([0, 0]);
			const xml = result.reports.join("\n");
			expect(xml).toContain("leaf_case");
			expect(xml).toContain("other_case");
			expect(xml).not.toContain("brush_core_case");
			const doctest = result.producers.find(producer => producer.producer === "cargo test --doc")!;
			expect(result.reports[result.producers.indexOf(doctest)]).toContain('tests="2"');
		},
		testTimeoutMs(),
	);

	it(
		"runs remaining tests and doctests after failure, preserving the first exit code",
		async () => {
			const result = await runWorkspace({ fail: true });
			const nextest = result.producers.find(producer => producer.producer === "cargo affected run")!;
			const doctest = result.producers.find(producer => producer.producer === "cargo test --doc")!;
			expect(result.producers).toHaveLength(2);
			expect(nextest.exitCode).not.toBe(0);
			expect(doctest.exitCode).not.toBe(0);
			expect(result.exitCode).toBe(nextest.exitCode);
			const xml = result.reports.join("\n");
			expect(xml).toContain("leaf_case");
			expect(xml).toContain("other_case");
			expect(xml).toContain("failure");
			expect(result.reports[result.producers.indexOf(doctest)]).toContain('tests="2"');
		},
		testTimeoutMs(),
	);

	it(
		"forces a full native run when requested",
		async () => {
			const result = await runWorkspace({ args: ["--full"] });
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.producers.find(producer => producer.producer === "cargo affected run")).toBeDefined();
			expect(result.reports.join("\n")).toContain("leaf_case");
		},
		testTimeoutMs(),
	);
});

describe("cargo-affected native selection", () => {
	it(
		"collects a clean baseline and runs only affected and new tests",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rust-selection-"));
			try {
				fs.cpSync(import.meta.dir, path.join(root, "scripts"), {
					recursive: true,
					filter: source => fs.statSync(source).isDirectory() || source.endsWith(".ts"),
				});
				fs.symlinkSync(
					path.join(import.meta.dir, "..", "node_modules"),
					path.join(root, "node_modules"),
					"junction",
				);
				fs.symlinkSync(path.join(import.meta.dir, "..", "packages"), path.join(root, "packages"), "junction");
				fs.copyFileSync(
					path.join(import.meta.dir, "..", "rust-toolchain.toml"),
					path.join(root, "rust-toolchain.toml"),
				);
				fs.mkdirSync(path.join(root, ".config"));
				fs.writeFileSync(
					path.join(root, ".config", "nextest.toml"),
					'[profile.default.junit]\npath = "junit.xml"\n',
				);
				fs.writeFileSync(
					path.join(root, ".gitignore"),
					"/target/\n/reports/\n/marker\n/scripts/\n/node_modules\n/packages\n",
				);
				const names = ["leaf", "consumer", "other", "brush-core", "brush-parser", "cfg_aliases", "napi"];
				fs.writeFileSync(
					path.join(root, "Cargo.toml"),
					`[workspace]\nresolver = "2"\nmembers = ${JSON.stringify(names)}\n`,
				);
				for (const name of names) {
					fs.mkdirSync(path.join(root, name, "src"), { recursive: true });
					fs.writeFileSync(
						path.join(root, name, "Cargo.toml"),
						`[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n` +
							(name === "consumer"
								? '\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nleaf = { path = "../leaf" }\n'
								: ""),
					);
					fs.writeFileSync(
						path.join(root, name, "src", "lib.rs"),
						name === "consumer"
							? '#[test]\nfn consumer_case() { use std::io::Write; assert_eq!(leaf::value(), 1); writeln!(std::fs::OpenOptions::new().create(true).append(true).open(std::env::var("MARKER").unwrap()).unwrap(), "consumer").unwrap(); }\n'
							: name === "leaf" || name === "other"
								? `${name === "leaf" ? "pub fn value() -> u8 { 1 }\n" : ""}#[test]\nfn ${name}_case() {\n    use std::io::Write;\n    writeln!(std::fs::OpenOptions::new().create(true).append(true).open(std::env::var("MARKER").unwrap()).unwrap(), "${name}").unwrap();\n}\n`
								: "",
					);
				}
				const cargoLookup = Bun.spawnSync(["rustup", "which", "cargo"], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				});
				const cargo = cargoLookup.exitCode === 0 ? cargoLookup.stdout.toString().trim() : "cargo";
				const lock = Bun.spawnSync([cargo || "cargo", "generate-lockfile", "--offline"], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(lock.exitCode, lock.stderr.toString()).toBe(0);
				for (const args of [
					["init"],
					["add", "."],
					["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"],
				]) {
					const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
					expect(result.exitCode, result.stderr.toString()).toBe(0);
				}
				const env = { ...process.env };
				for (const key of Object.keys(env)) if (key.startsWith("OMP_")) delete env[key];
				Object.assign(env, { MARKER: path.join(root, "marker"), OMP_TEST_REPORT_DIR: path.join(root, "reports") });
				delete env.CARGO_TARGET_DIR;
				const run = async (args: string[] = []) => {
					const child = Bun.spawn(
						[process.execPath, path.join(root, "scripts", "run-rs-task.ts"), "test:rs", ...args],
						{
							cwd: root,
							env,
							stdin: "ignore",
							stdout: "pipe",
							stderr: "pipe",
						},
					);
					const [exitCode, stdout, stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
					const producers = fs
						.readdirSync(path.join(root, "reports"))
						.filter(name => name.endsWith(".producer.json"))
						.map(
							name =>
								JSON.parse(fs.readFileSync(path.join(root, "reports", name), "utf8")) as Producer & {
									selection?: { mode: string; selected?: number };
									status?: string;
								},
						);
					const nextest = producers.find(producer => producer.producer.startsWith("cargo affected "))!;
					fs.rmSync(path.join(root, "reports"), { recursive: true, force: true });
					return nextest;
				};
				const baseline = await run();
				expect(baseline.producer).toBe("cargo affected collect");
				expect(baseline.selection?.mode).toBe("full");
				const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(status.exitCode, status.stderr.toString()).toBe(0);
				expect(status.stdout.toString(), `Generated changes after first run:\n${status.stdout.toString()}`).toBe(
					"",
				);
				const explicit = await run(["--collect"]);
				expect(explicit.producer).toBe("cargo affected collect");
				fs.rmSync(path.join(root, "marker"));
				const unchanged = await run();
				expect(unchanged.selection?.mode).toBe("affected");
				expect(unchanged.selection?.selected).toBe(0);
				expect(unchanged.status).toBe("not-selected");
				expect(unchanged.reportPath).toBeNull();
				expect(fs.existsSync(path.join(root, "marker"))).toBe(false);
				const incomplete = path.join(root, "target", "affected", "omp-incomplete-run");
				fs.writeFileSync(incomplete, "interrupted\n");
				const recovered = await run();
				expect(recovered.producer).toBe("cargo affected collect");
				expect(recovered.selection?.mode).toBe("full");
				expect(fs.readFileSync(path.join(root, "marker"), "utf8").trim().split(/\r?\n/).sort()).toEqual([
					"consumer",
					"leaf",
					"other",
				]);
				expect(fs.existsSync(incomplete)).toBe(false);
				fs.rmSync(path.join(root, "marker"));
				const leaf = path.join(root, "leaf", "src", "lib.rs");
				fs.writeFileSync(
					leaf,
					fs
						.readFileSync(leaf, "utf8")
						.replace("-> u8 { 1 }", "-> u8 { 1 /* changed */ }")
						.replace('"leaf").unwrap()', '"leaf_changed").unwrap()') +
						'\n#[test]\nfn new_case() { use std::io::Write; writeln!(std::fs::OpenOptions::new().create(true).append(true).open(std::env::var("MARKER").unwrap()).unwrap(), "new").unwrap(); }\n',
				);
				const changed = await run();
				expect(changed.selection?.mode).toBe("affected");
				const markers = fs.readFileSync(path.join(root, "marker"), "utf8").trim().split(/\r?\n/).sort();
				expect(markers).toEqual(["consumer", "leaf_changed", "new"]);
				// An interrupted baseline cannot be trusted on a dirty tree, where
				// re-collection would incorrectly anchor working-tree lines to HEAD.
				fs.rmSync(path.join(root, "marker"));
				fs.writeFileSync(incomplete, "interrupted\n");
				const dirtyRecovery = await run();
				expect(dirtyRecovery.producer).toBe("cargo affected run");
				expect(dirtyRecovery.selection?.mode).toBe("full");
				expect(fs.readFileSync(path.join(root, "marker"), "utf8").trim().split(/\r?\n/).sort()).toEqual([
					"consumer",
					"leaf_changed",
					"new",
					"other",
				]);
				expect(fs.existsSync(incomplete)).toBe(true);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		testTimeoutMs(),
	);
});
