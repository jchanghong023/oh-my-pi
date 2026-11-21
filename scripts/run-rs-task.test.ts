import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { testTimeoutMs } from "./ci-test-ts";
import { testConcurrencyLimit } from "./test-gate-scheduler";

interface Producer {
	producer: string;
	exitCode: number;
	reportPath: string | null;
	scope: string;
	status: string;
	report: string;
	command: string[];
	durationSeconds: number;
	selection?: { tool: string; mode: string; reason?: string };
}

async function runWorkspace(
	options: {
		fail?: boolean;
		failDoc?: boolean;
		full?: boolean;
	} = {},
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rust-workspace-"));
	try {
		const scripts = path.join(root, "scripts");
		fs.mkdirSync(scripts);
		for (const name of [
			"run-rs-task.ts",
			"windows-test-temp.ts",
			"test-gate-failure-events.ts",
			"test-gate-native-events.ts",
			"test-gate-scheduler.ts",
			"test-reporting.ts",
			"test-gate-events.ts",
			"test-gate-clock.ts",
			"test-gate-libc.ts",
		]) {
			fs.copyFileSync(path.join(import.meta.dir, name), path.join(scripts, name));
		}
		// The copied driver only loads the cleanup marker. Keep Cargo and test
		// cleanup entirely inside the fixture rather than linking workspace trees.
		const utils = path.join(root, "node_modules", "@oh-my-pi", "pi-utils");
		fs.mkdirSync(path.join(utils, "src"), { recursive: true });
		const utilsSource = path.join(import.meta.dir, "../packages/utils");
		fs.copyFileSync(path.join(utilsSource, "package.json"), path.join(utils, "package.json"));
		fs.copyFileSync(path.join(utilsSource, "src/expected-cleanup.ts"), path.join(utils, "src/expected-cleanup.ts"));
		if (options.full) {
			fs.copyFileSync(
				path.join(import.meta.dir, "..", "rust-toolchain.toml"),
				path.join(root, "rust-toolchain.toml"),
			);
			fs.mkdirSync(path.join(root, ".config"));
			fs.writeFileSync(path.join(root, ".config", "nextest.toml"), '[profile.default.junit]\npath = "junit.xml"\n');
			const names = ["native-fixture", "library-fixture"];
			fs.writeFileSync(
				path.join(root, "Cargo.toml"),
				`[workspace]\nresolver = "2"\nmembers = ${JSON.stringify(names)}\n`,
			);
			for (const name of names) {
				const native = name === "native-fixture";
				const crate = path.join(root, name);
				fs.mkdirSync(path.join(crate, "src"), { recursive: true });
				fs.writeFileSync(
					path.join(crate, "Cargo.toml"),
					`[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${native ? '[lib]\ncrate-type = ["cdylib"]\n' : ""}`,
				);
				fs.writeFileSync(
					path.join(crate, "src", "lib.rs"),
					native
						? `mod shell { #[test] fn native_case() {} }`
						: `/// Workspace doctest.
/// \`\`\`
/// assert!(${options.failDoc ? "false" : "true"});
/// \`\`\`
pub fn documented() {}
#[test] fn library_case() { assert!(${options.fail ? "false" : "true"}); }
#[test] fn another_library_case() {}`,
				);
			}
		} else {
			// If default test:rs invokes Cargo to test anything, it must fail.
			fs.writeFileSync(path.join(root, "Cargo.toml"), "[invalid");
		}
		const env = { ...process.env };
		// Isolate gate/report state without discarding the caller's CPU allocation.
		for (const key of Object.keys(env)) {
			if (key.startsWith("OMP_") && key !== "OMP_TEST_CPU_BUDGET" && key !== "OMP_TEST_CONCURRENCY") delete env[key];
		}
		env.CI = "0";
		let reportDir = path.join(root, "reports");
		if (options.full) env.OMP_TEST_REPORT_DIR = reportDir;
		delete env.CARGO_TARGET_DIR;
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(root, "scripts", "run-rs-task.ts"),
				"test:rs",
				...(options.full ? ["--full"] : []),
			],
			{ cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (!options.full) {
			const reportRoot = path.join(root, "runs", "test-timing");
			reportDir = path.join(reportRoot, fs.readdirSync(reportRoot)[0]!);
		}
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
		const run = options.full ? undefined : JSON.parse(fs.readFileSync(path.join(reportDir, "run.json"), "utf8"));
		return { exitCode, stdout, stderr, producers, reports, run };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("Rust test CLI", () => {
	it("records an empty default fork scope without running Cargo", async () => {
		const result = await runWorkspace();
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("no fork-owned Rust tests configured");
		expect(result.producers).toHaveLength(1);
		expect(result.producers[0]).toMatchObject({
			producer: "cargo nextest run",
			scope: "rust-fork-features",
			status: "not-selected",
			exitCode: 0,
			durationSeconds: 0,
			report: "not-supported",
			reportPath: null,
			command: ["bun", "scripts/run-rs-task.ts", "test:rs"],
			selection: {
				tool: "fork-scope",
				mode: "full",
				selected: 0,
				packages: [],
				reason: "No fork-owned Rust tests are configured",
			},
		});
		expect(result.run).toMatchObject({
			scope: "rust-fork-features",
			completion: "complete",
			reconciliation: { status: "validated", cases: 0, executed: 0 },
		});
	});

	it(
		"runs all workspace packages and doctests with --full",
		async () => {
			const result = await runWorkspace({ full: true });
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.producers).toHaveLength(2);
			const nextest = result.producers.find(producer => producer.producer === "cargo nextest run")!;
			expect(nextest.command).toContain("--workspace");
			expect(nextest.command).toContain(`--test-threads=${testConcurrencyLimit()}`);
			expect(nextest.scope).toBe("rust-workspace");
			expect(nextest.selection).toMatchObject({ tool: "cargo-nextest", mode: "full" });
			const xml = result.reports[result.producers.indexOf(nextest)];
			expect(xml).toContain("library_case");
			expect(xml).toContain("native_case");
			const doctest = result.producers.find(producer => producer.producer === "cargo test --doc")!;
			expect(doctest.command).toContain("--workspace");
			expect(doctest.scope).toBe("rust-workspace");
			expect(doctest.status).toBe("stage");
			expect(doctest.report).toBe("not-supported");
			expect(result.stdout).toContain("documented");
		},
		testTimeoutMs(),
	);

	it(
		"continues workspace tests and doctests after a Nextest failure",
		async () => {
			const result = await runWorkspace({ full: true, fail: true });
			const nextest = result.producers.find(producer => producer.producer === "cargo nextest run")!;
			const doctest = result.producers.find(producer => producer.producer === "cargo test --doc")!;
			expect(result.producers).toHaveLength(2);
			expect(nextest.exitCode).not.toBe(0);
			expect(result.exitCode).toBe(nextest.exitCode);
			expect(doctest.status).toBe("stage");
			expect(doctest.exitCode).toBe(0);
			const xml = result.reports[result.producers.indexOf(nextest)];
			expect(xml).toContain("another_library_case");
			expect(xml).toContain("native_case");
			expect(xml).toContain("failure");
		},
		testTimeoutMs(),
	);

	it(
		"propagates a workspace doctest failure after successful Nextest tests",
		async () => {
			const result = await runWorkspace({ full: true, failDoc: true });
			const nextest = result.producers.find(producer => producer.producer === "cargo nextest run")!;
			const doctest = result.producers.find(producer => producer.producer === "cargo test --doc")!;
			expect(result.producers).toHaveLength(2);
			expect(nextest.exitCode).toBe(0);
			expect(doctest.exitCode).not.toBe(0);
			expect(result.exitCode).toBe(doctest.exitCode);
			expect(doctest.status).toBe("failed");
			expect(doctest.report).toBe("not-supported");
			expect(result.stdout).toContain("documented");
		},
		testTimeoutMs(),
	);
});
