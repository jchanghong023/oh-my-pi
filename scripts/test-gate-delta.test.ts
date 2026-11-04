import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { selectRustPackages, type RustDeltaSelection } from "./test-gate-delta";
import { runGate } from "./test-gate-runtime";

const baseline = "a".repeat(40);

async function fixture(output: string, exitCode = 0, version = "cargo-delta 0.5.0", stderr = "") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-delta-"));
	try {
		const program = path.join(root, "cargo-fixture.ts");
		await fs.writeFile(
			program,
			`
import * as fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) console.log(${JSON.stringify(version)});
else { process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode}; }
`,
		);
		let selection: RustDeltaSelection | undefined;
		const gateResult = await runGate(
			"fulltest",
			async gate => {
				selection = await selectRustPackages(gate, root, baseline, [process.execPath, program]);
			},
			{ print: () => {} },
		);
		const calls = (await fs.readFile(path.join(root, "calls.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		return { selection: selection!, calls, gateResult, root };
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

it.each([[[]], [["pi-natives", "pi-knowledge", "other"]]])(
	"passes cargo-delta affected output through: %j",
	async packages => {
		const { selection, calls, gateResult, root } = await fixture(JSON.stringify({ Affected: packages }));
		expect(gateResult.exitCode).toBe(0);
		expect(selection).toMatchObject({ tool: "cargo-delta", mode: "affected", packages, baseline });
		expect(calls).toEqual([
			["delta", "--version"],
			[
				"delta",
				"--config",
				path.join(root, ".config", "cargo-delta.toml"),
				"impact",
				"--base-ref",
				baseline,
				"--affected",
				"--format",
				"json",
			],
		]);
	},
);

it("recognizes the pinned CLI's explicit clean-tree diagnostic, not an ambiguous empty response", async () => {
	const clean = await fixture(
		"",
		0,
		"cargo-delta 0.5.0",
		"Computing impact..\nNo file has been changed or deleted, quitting.\n",
	);
	expect(clean.selection).toMatchObject({ mode: "affected", packages: [], baseline });
	const ambiguous = await fixture("");
	expect(ambiguous.selection).toMatchObject({ mode: "full", packages: ["pi-knowledge", "pi-natives"] });
});

it.each([
	["not json", 0],
	["{}", 0],
	['{"Affected":["bad package"]}', 0],
	['{"Affected":["pi-knowledge","pi-knowledge"]}', 0],
	['{"Affected":[],"Unknown":[]}', 0],
	['{"Affected":[]}', 2],
])("falls back when impact fails or output is unsafe", async (output, exitCode) => {
	const { selection, gateResult } = await fixture(output, exitCode);
	expect(gateResult.exitCode).toBe(0);
	expect(selection).toMatchObject({ mode: "full", packages: ["pi-knowledge", "pi-natives"] });
	expect(selection.reason.length).toBeGreaterThan(0);
});

it("rejects an unverified delta version before impact", async () => {
	const { selection, calls } = await fixture('{"Affected":[]}', 0, "cargo-delta 1.0.0");
	expect(selection.mode).toBe("full");
	expect(calls).toHaveLength(1);
});

it("does not invoke delta without a qualified baseline", async () => {
	let selection: RustDeltaSelection | undefined;
	const gateResult = await runGate(
		"fulltest",
		async gate => {
			selection = await selectRustPackages(gate, import.meta.dir, undefined, [process.execPath, "missing"]);
		},
		{ print: () => {} },
	);
	expect(gateResult.exitCode).toBe(0);
	expect(selection).toMatchObject({ mode: "full", packages: ["pi-knowledge", "pi-natives"] });
});

// Exercise cargo-delta's actual Git/Cargo dependency analysis, not an injected
// affected JSON response. This requires the preinstalled pinned tool; it never
// installs dependencies or substitutes a simulated selection for real evidence.
it("real cargo-delta follows a changed crate through reverse dependencies and excludes an independent crate", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-real-rust-impact-"));
	const run = async (...argv: string[]) => {
		const child = Bun.spawn(argv, {
			cwd: root,
			env: { ...process.env, RUSTUP_AUTO_INSTALL: "0", OMP_GATE_EVENT_TOKEN: "", OMP_GATE_EVENT_FILE: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code, `${argv.join(" ")}\n${stdout}\n${stderr}`).toBe(0);
		return stdout.trim();
	};
	try {
		await fs.mkdir(path.join(root, ".config"));
		await fs.writeFile(
			path.join(root, ".config", "cargo-delta.toml"),
			'file_exclude_patterns = ["target"]\ntrip_wire_patterns = ["Cargo.toml", "Cargo.lock", "**/Cargo.toml"]\n[parser]\nmods = true\nincludes = true\nfile_refs = true\n',
		);
		await fs.writeFile(
			path.join(root, "Cargo.toml"),
			'[workspace]\nresolver = "2"\nmembers = ["pi-knowledge", "pi-natives", "independent"]\n',
		);
		await fs.writeFile(path.join(root, ".gitignore"), "target/\n");
		for (const name of ["pi-knowledge", "pi-natives", "independent"]) {
			const crate = path.join(root, name);
			await fs.mkdir(path.join(crate, "src"), { recursive: true });
			await fs.writeFile(
				path.join(crate, "Cargo.toml"),
				`[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${
					name === "pi-natives" ? '[dependencies]\npi-knowledge = { path = "../pi-knowledge" }\n' : ""
				}`,
			);
			await fs.writeFile(
				path.join(crate, "src", "lib.rs"),
				name === "pi-natives"
					? "pub fn answer() -> u8 { pi_knowledge::answer() }\n"
					: "pub fn answer() -> u8 { 1 }\n",
			);
		}
		await run("cargo", "generate-lockfile", "--offline");
		await run("git", "init", "-q");
		await run("git", "config", "user.name", "Fixture");
		await run("git", "config", "user.email", "fixture@example.invalid");
		await run("git", "add", ".");
		await run("git", "-c", "commit.gpgsign=false", "commit", "-qm", "dependency baseline");
		const revision = await run("git", "rev-parse", "HEAD");
		await fs.writeFile(path.join(root, "pi-knowledge", "src", "lib.rs"), "pub fn answer() -> u8 { 2 }\n");
		let selected: RustDeltaSelection | undefined;
		const result = await runGate(
			"fulltest",
			async gate => {
				selected = await selectRustPackages(gate, root, revision);
			},
			{ print: () => {} },
		);
		expect(result.exitCode).toBe(0);
		expect(selected).toMatchObject({ tool: "cargo-delta", mode: "affected", baseline: revision });
		expect(selected!.packages.toSorted()).toEqual(["pi-knowledge", "pi-natives"]);
		// No cargo test/build is needed to prove selection, and no result cache
		// may be substituted for analyzing this still-dirty source.
		expect(await run("git", "status", "--porcelain")).toContain("pi-knowledge/src/lib.rs");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
