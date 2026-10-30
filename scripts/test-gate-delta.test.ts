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

it.each([[[]], [["pi-natives", "pi-wiki", "other"]]])(
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
	expect(ambiguous.selection).toMatchObject({ mode: "full", packages: ["pi-wiki", "pi-natives"] });
});

it.each([
	["not json", 0],
	["{}", 0],
	['{"Affected":["bad package"]}', 0],
	['{"Affected":["pi-wiki","pi-wiki"]}', 0],
	['{"Affected":[],"Unknown":[]}', 0],
	['{"Affected":[]}', 2],
])("falls back when impact fails or output is unsafe", async (output, exitCode) => {
	const { selection, gateResult } = await fixture(output, exitCode);
	expect(gateResult.exitCode).toBe(0);
	expect(selection).toMatchObject({ mode: "full", packages: ["pi-wiki", "pi-natives"] });
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
	expect(selection).toMatchObject({ mode: "full", packages: ["pi-wiki", "pi-natives"] });
});
