import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { testTimeoutMs } from "./ci-test-ts";

interface Producer {
	producer: string;
	exitCode: number;
	reportPath: string | null;
	scope: string;
	status: string;
	report: string;
	command: string[];
	timingBasis: string;
	selection?: { tool: string; mode: string; reason?: string };
}

async function runWorkspace(
	options: {
		fail?: boolean;
		failDoc?: boolean;
		repeat?: boolean;
		selection?: unknown;
		rawSelection?: string;
		full?: boolean;
	} = {},
) {
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
		const names = ["pi-wiki", "pi-natives", "other"];
		fs.writeFileSync(
			path.join(root, "Cargo.toml"),
			`[workspace]\nresolver = "2"\nmembers = ${JSON.stringify(names)}\n`,
		);
		for (const name of names) {
			const crate = path.join(root, name);
			fs.mkdirSync(path.join(crate, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(crate, "Cargo.toml"),
				`[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${name === "pi-natives" ? '[lib]\ncrate-type = ["cdylib"]\n' : ""}`,
			);
			fs.writeFileSync(
				path.join(crate, "src", "lib.rs"),
				name === "pi-wiki"
					? `/// Wiki doctest.
/// \`\`\`
/// assert!(${options.failDoc ? "false" : "true"});
/// \`\`\`
pub fn documented() {}
mod wiki { #[test] fn wiki_case() { assert!(${options.fail ? "false" : "true"}); } }
mod another_module { #[test] fn wiki_other_module_case() {} }`
					: name === "pi-natives"
						? `mod wiki { #[test] fn native_wiki_binding_case() {} }
mod python_symbols { #[test] fn symbols_case() {} }
mod shell { #[test] fn excluded_case() { ${options.full ? "" : 'panic!("must be filtered");'} } }`
						: `mod wiki { #[test] fn other_crate_case() { ${options.full ? "" : 'panic!("must be excluded");'} } }`,
			);
		}
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("OMP_")) delete env[key];
		Object.assign(env, {
			CI: "0",
			// Legacy delta cannot suppress any selected fork feature tests.
			OMP_FULLTEST_CHANGED_PATHS: "[]",
			OMP_TEST_REPORT_DIR: path.join(root, "reports"),
		});
		if (options.selection !== undefined) env.OMP_RUST_DELTA_SELECTION = JSON.stringify(options.selection);
		if (options.rawSelection !== undefined) env.OMP_RUST_DELTA_SELECTION = options.rawSelection;
		delete env.CARGO_TARGET_DIR;
		const run = async (reportDir: string) => {
			env.OMP_TEST_REPORT_DIR = reportDir;
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(root, "scripts", "run-rs-task.ts"),
					"test:rs",
					...(options.full ? ["--full"] : []),
				],
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
		};
		const result = await run(path.join(root, "reports"));
		if (!options.repeat) return { result };
		fs.appendFileSync(path.join(root, "other", "src", "lib.rs"), "\n// Changed unrelated source.\n");
		return { result, repeated: await run(path.join(root, "reports-repeat")) };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("Rust fork feature CLI", () => {
	it(
		"runs the full Wiki package and native Wiki bindings and Python symbols regardless of unrelated changes",
		async () => {
			const { result, repeated } = await runWorkspace({ repeat: true });
			for (const run of [result, repeated!]) {
				expect(run.exitCode, run.stderr).toBe(0);
				const nextest = run.producers.find(producer => producer.producer === "cargo nextest run")!;
				expect(nextest.scope).toBe("rust-fork-features");
				expect(nextest.selection).toMatchObject({
					tool: "cargo-nextest",
					mode: "full",
				});
				const xml = run.reports[run.producers.indexOf(nextest)];
				expect(xml).toContain("wiki_case");
				expect(xml).toContain("wiki_other_module_case");
				expect(xml).toContain("symbols_case");
				expect(xml).not.toContain("excluded_case");
				expect(xml).toContain("native_wiki_binding_case");
				expect(xml).not.toContain("other_crate_case");
				const doctest = run.producers.find(producer => producer.producer === "cargo test --doc")!;
				expect(doctest.scope).toBe("rust-fork-features");
				expect(doctest.status).toBe("stage");
				expect(doctest.exitCode).toBe(0);
				expect(doctest.report).toBe("not-supported");
				expect(doctest.reportPath).toBeNull();
				expect(run.stdout).toContain("documented");
			}
		},
		testTimeoutMs(),
	);

	it(
		"continues selected tests and doctests after a Nextest failure",
		async () => {
			const { result } = await runWorkspace({ fail: true });
			const nextest = result.producers.find(producer => producer.producer === "cargo nextest run")!;
			const doctest = result.producers.find(producer => producer.producer === "cargo test --doc")!;
			expect(result.producers).toHaveLength(2);
			expect(nextest.exitCode).not.toBe(0);
			expect(result.exitCode).toBe(nextest.exitCode);
			expect(doctest.status).toBe("stage");
			expect(doctest.exitCode).toBe(0);
			expect(doctest.report).toBe("not-supported");
			const xml = result.reports[result.producers.indexOf(nextest)];
			expect(xml).toContain("wiki_case");
			expect(xml).toContain("wiki_other_module_case");
			expect(xml).toContain("native_wiki_binding_case");
			expect(xml).toContain("symbols_case");
			expect(xml).toContain("failure");
			expect(xml).not.toContain("excluded_case");
		},
		testTimeoutMs(),
	);

	it(
		"propagates a doctest failure after successful selected tests",
		async () => {
			const { result } = await runWorkspace({ failDoc: true });
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

const baseline = "a".repeat(40);
const affected = (packages: string[]) => ({
	tool: "cargo-delta",
	mode: "affected",
	packages,
	baseline,
	reason: "fixture impact",
});

describe("Rust delta selection", () => {
	for (const packages of [["pi-wiki"], ["pi-natives"], ["pi-wiki", "pi-natives"]]) {
		it(
			`executes only selected fork packages ${packages.join(", ")}`,
			async () => {
				const { result } = await runWorkspace({ selection: affected([...packages, "other"]) });
				expect(result.exitCode, result.stderr).toBe(0);
				const nextest = result.producers.find(producer => producer.producer === "cargo nextest run")!;
				expect(nextest.selection).toMatchObject({ tool: "cargo-delta", mode: "affected", packages, baseline });
				for (const name of ["pi-wiki", "pi-natives"])
					expect(nextest.command.includes(name)).toBe(packages.includes(name));
				const xml = result.reports[result.producers.indexOf(nextest)];
				expect(xml.includes("wiki_other_module_case")).toBe(packages.includes("pi-wiki"));
				expect(xml.includes("symbols_case")).toBe(packages.includes("pi-natives"));
				expect(xml).not.toContain("excluded_case");
				const doc = result.producers.find(producer => producer.producer === "cargo test --doc")!;
				expect(doc.status).toBe(packages.includes("pi-wiki") ? "stage" : "not-selected");
				if (!packages.includes("pi-wiki"))
					expect(doc.selection).toMatchObject({
						tool: "cargo-delta",
						mode: "affected",
						selected: 0,
						packages: [],
					});
			},
			testTimeoutMs(),
		);
	}
	it("does not invoke Cargo for an empty fork intersection", async () => {
		const { result } = await runWorkspace({ selection: affected(["other"]) });
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.producers).toHaveLength(2);
		for (const producer of result.producers) {
			expect(producer.status).toBe("not-selected");
			expect(producer.selection).toMatchObject({ tool: "cargo-delta", mode: "affected", selected: 0, packages: [] });
		}
	});
	it(
		"falls back to the complete fork for malformed selection",
		async () => {
			const { result } = await runWorkspace({ rawSelection: "{bad" });
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.producers[0].selection).toMatchObject({ mode: "full" });
		},
		testTimeoutMs(),
	);
	it(
		"treats an invalid package name as a full fork fallback",
		async () => {
			const { result } = await runWorkspace({ selection: affected(["--workspace"]) });
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.producers.find(producer => producer.producer === "cargo nextest run")!.selection).toMatchObject({
				tool: "cargo-nextest",
				mode: "full",
			});
		},
		testTimeoutMs(),
	);
	it(
		"--full ignores affected selection and exercises all workspace packages and doctests",
		async () => {
			const { result } = await runWorkspace({ selection: affected([]), full: true });
			expect(result.exitCode, result.stderr).toBe(0);
			const nextest = result.producers.find(producer => producer.producer === "cargo nextest run")!;
			expect(nextest.command).toContain("--workspace");
			expect(nextest.selection).toMatchObject({ tool: "cargo-nextest", mode: "full" });
			const xml = result.reports[result.producers.indexOf(nextest)];
			expect(xml).toContain("other_crate_case");
			expect(xml).toContain("excluded_case");
			expect(result.producers.find(producer => producer.producer === "cargo test --doc")!.command).toContain(
				"--workspace",
			);
		},
		testTimeoutMs(),
	);
});
