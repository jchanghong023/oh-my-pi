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
			const nextest = result.producers.find(producer => producer.producer === "cargo nextest run")!;
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
		"rejects retired affected-test selection instead of silently filtering tests",
		async () => {
			const result = await runWorkspace({ args: ["--affected"] });
			expect(result.exitCode).not.toBe(0);
			expect(result.producers).toHaveLength(0);
		},
		testTimeoutMs(),
	);
});
