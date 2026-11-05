import { afterEach, describe, expect, it, test } from "bun:test";
import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
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
		const names = ["pi-knowledge", "pi-natives", "other"];
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
				name === "pi-knowledge"
					? `/// Knowledge doctest.
/// \`\`\`
/// assert!(${options.failDoc ? "false" : "true"});
/// \`\`\`
pub fn documented() {}
mod knowledge { #[test] fn knowledge_case() { assert!(${options.fail ? "false" : "true"}); } }
mod another_module { #[test] fn knowledge_other_module_case() {} }`
					: name === "pi-natives"
						? `mod knowledge { #[test] fn native_knowledge_binding_case() {} }
mod shell { #[test] fn excluded_case() { ${options.full ? "" : 'panic!("must be filtered");'} } }`
						: `mod knowledge { #[test] fn other_crate_case() { ${options.full ? "" : 'panic!("must be excluded");'} } }`,
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
		"runs the full Knowledge package and native Knowledge bindings regardless of unrelated changes",
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
				expect(xml).toContain("knowledge_case");
				expect(xml).toContain("knowledge_other_module_case");
				expect(xml).not.toContain("excluded_case");
				expect(xml).toContain("native_knowledge_binding_case");
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
			expect(xml).toContain("knowledge_case");
			expect(xml).toContain("knowledge_other_module_case");
			expect(xml).toContain("native_knowledge_binding_case");
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
	for (const packages of [["pi-knowledge"], ["pi-natives"], ["pi-knowledge", "pi-natives"]]) {
		it(
			`executes only selected fork packages ${packages.join(", ")}`,
			async () => {
				const { result } = await runWorkspace({ selection: affected([...packages, "other"]) });
				expect(result.exitCode, result.stderr).toBe(0);
				const nextest = result.producers.find(producer => producer.producer === "cargo nextest run")!;
				expect(nextest.selection).toMatchObject({ tool: "cargo-delta", mode: "affected", packages, baseline });
				for (const name of ["pi-knowledge", "pi-natives"])
					expect(nextest.command.includes(name)).toBe(packages.includes(name));
				const xml = result.reports[result.producers.indexOf(nextest)];
				expect(xml.includes("knowledge_other_module_case")).toBe(packages.includes("pi-knowledge"));
				expect(xml.includes("native_knowledge_binding_case")).toBe(packages.includes("pi-natives"));
				expect(xml).not.toContain("excluded_case");
				const doc = result.producers.find(producer => producer.producer === "cargo test --doc")!;
				expect(doc.status).toBe(packages.includes("pi-knowledge") ? "stage" : "not-selected");
				if (!packages.includes("pi-knowledge"))
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

// run-rs-task.ts decides whether the Rust half of `bun check` runs. Each case
// copies the real script into a throwaway git repo and runs `check:rs` there with
// `cargo` shadowed by a stub on PATH, so a case observes exactly what a
// contributor does: whether cargo ran, the line the gate printed, and its exit
// code. No Rust is built.

const cleanups: (() => Promise<void>)[] = [];
// Each case builds and clones a repository and spawns bun; on a loaded host
// that outruns bun's 5 s default.
const CASE_TIMEOUT_MS = 30_000;

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Fixture {
	root: string;
	/** Bare-bones stand-in for the main repository: two commits on `main`. */
	origin: string;
	/** A full clone of `origin`, so `origin/main` exists. */
	work: string;
	shimDir: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await $`git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false ${args}`
		.cwd(cwd)
		.quiet();
	return result.text();
}

async function writeExecutable(file: string, content: string): Promise<void> {
	await Bun.write(file, content);
	await fsAsync.chmod(file, 0o755);
}

async function makeFixture(): Promise<Fixture> {
	const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "omp-run-rs-task-"));
	cleanups.push(() => fsAsync.rm(root, { recursive: true, force: true }));
	const origin = path.join(root, "origin");
	const work = path.join(root, "work");
	const shimDir = path.join(root, "bin");
	// `rustup` fails so the script falls back to the `cargo` on PATH: the stub.
	await writeExecutable(path.join(shimDir, "rustup"), "#!/bin/sh\nexit 1\n");
	await writeExecutable(path.join(shimDir, "cargo"), '#!/bin/sh\necho "cargo-stub $*"\n');

	fs.cpSync(import.meta.dir, path.join(origin, "scripts"), {
		recursive: true,
		filter: source => fs.statSync(source).isDirectory() || source.endsWith(".ts"),
	});
	await Bun.write(path.join(origin, "packages/app/src/a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(origin, "crates/x/src/lib.rs"), "pub fn x() {}\n");
	await git(origin, "init", "-q", "-b", "main");
	await git(origin, "add", "-A");
	await git(origin, "commit", "-q", "-m", "base");
	// A second commit, so a depth-1 clone is really shallow.
	await commitFile(origin, "packages/app/src/a.ts", "export const a = 2;\n", "second");
	await git(root, "clone", "-q", origin, work);
	fs.symlinkSync(path.join(import.meta.dir, "..", "node_modules"), path.join(work, "node_modules"), "junction");
	fs.appendFileSync(path.join(work, ".git", "info", "exclude"), "\n/node_modules\n");
	return { root, origin, work, shimDir };
}

async function commitFile(repo: string, file: string, content: string, message: string): Promise<void> {
	await Bun.write(path.join(repo, file), content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", message);
}

/** What a contributor sees from one gate run. */
interface CheckRsResult {
	exitCode: number;
	output: string;
	cargoRan: boolean;
}

async function runCheckRs(fixture: Fixture, cwd: string, env: Record<string, string> = {}): Promise<CheckRsResult> {
	const base: Record<string, string | undefined> = { ...process.env };
	// The ambient environment must not decide the case: an omp shell exports
	// CI=true, a GitHub runner exports GITHUB_ACTIONS, and a git hook exports GIT_DIR.
	for (const key of ["CI", "GITHUB_ACTIONS", "OMP_FORCE_RUST_TASKS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
		delete base[key];
	}
	const proc = Bun.spawn([process.execPath, "scripts/run-rs-task.ts", "check:rs"], {
		cwd,
		env: { ...base, ...env, PATH: `${fixture.shimDir}${path.delimiter}${process.env.PATH ?? ""}` },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const output = `${stdout}${stderr}`;
	return { exitCode, output, cargoRan: output.includes("cargo-stub fmt --all -- --check") };
}

describe.skipIf(process.platform === "win32")("run-rs-task.ts check:rs", () => {
	// Failure mode: a contributor commits a Rust change, runs `bun check` on the
	// clean tree, and gets a green gate that never looked at their Rust.
	test(
		"a committed Rust change on a clean tree runs the Rust gate and names the file",
		async () => {
			const fixture = await makeFixture();
			await git(fixture.work, "switch", "-q", "-c", "feature");
			await commitFile(fixture.work, "crates/x/src/lib.rs", "pub fn x() -> u8 { 1 }\n", "rust change");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(true);
			expect(result.output).toContain("crates/x/src/lib.rs");
			expect(result.output).not.toContain("cargo-stub clippy");
			expect(result.exitCode).toBe(0);
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"a TypeScript-only commit skips outside CI and runs under CI",
		async () => {
			const fixture = await makeFixture();
			await git(fixture.work, "remote", "add", "upstream", `file://${fixture.origin}`);
			await git(fixture.work, "fetch", "-q", "upstream");
			await git(fixture.work, "switch", "-q", "--detach");
			await commitFile(fixture.work, "packages/app/src/a.ts", "export const a = 3;\n", "ts change");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Skipping check:rs");
			const ci = await runCheckRs(fixture, fixture.work, { CI: "true" });
			expect(ci.cargoRan).toBe(true);
			expect(ci.exitCode).toBe(0);
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"crate fixture changes run the Rust gate",
		async () => {
			const fixture = await makeFixture();
			await Bun.write(path.join(fixture.work, "crates/x/fixtures/input.json"), "{}\n");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(true);
			expect(result.output).toContain("crates/x/fixtures/input.json");
			expect(result.exitCode).toBe(0);
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: `git status` folds an untracked directory into one
	// `crates/newcrate/` entry, so a brand-new crate looks like no Rust change at all.
	test(
		"a new untracked crate runs the Rust gate",
		async () => {
			const fixture = await makeFixture();
			await Bun.write(path.join(fixture.work, "crates/newcrate/Cargo.toml"), '[package]\nname = "newcrate"\n');
			await Bun.write(path.join(fixture.work, "crates/newcrate/src/lib.rs"), "pub fn y() {}\n");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(true);
			expect(result.output).toContain("crates/newcrate/");
		},
		CASE_TIMEOUT_MS,
	);
});
