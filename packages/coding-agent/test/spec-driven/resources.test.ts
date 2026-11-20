import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, parseFrontmatter, TempDir } from "@oh-my-pi/pi-utils";
import {
	ensureSpecDrivenResources,
	loadSpecDrivenSkill,
	resolveSpecDrivenResourcePath,
	runOpenSpec,
	runSuperpowersScript,
	type SpecDrivenProcessResult,
} from "../../src/spec-driven/resources";
import inventory from "../../src/spec-driven/vendor/inventory.json";
import { initializeRepository } from "./repository-fixture";

const upstreamOpenSpecSkills = [
	"openspec-apply-change",
	"openspec-archive-change",
	"openspec-bulk-archive-change",
	"openspec-continue-change",
	"openspec-explore",
	"openspec-ff-change",
	"openspec-new-change",
	"openspec-onboard",
	"openspec-propose",
	"openspec-sync-specs",
	"openspec-update-change",
	"openspec-verify-change",
];
const proposalContent =
	"## Why\nKeep requirements available offline.\n\n## What Changes\n- Document offline access.\n\n## Capabilities\n### New Capabilities\n- `offline-resources`: offline requirements access\n### Modified Capabilities\nNone.\n\n## Impact\nRequirements documentation only.\n";
const deltaContent =
	"## Purpose\nDescribe how users can read the bundled requirements without any network connection or external checkout.\n\n## ADDED Requirements\n\n### Requirement: Offline requirements access\nThe system SHALL expose bundled requirements without a network connection.\n\n#### Scenario: Read requirements offline\n- **WHEN** a user requests the bundled requirements offline\n- **THEN** the requirements are available without a network request\n";

// Give each native CLI consumer its own HOME and XDG roots.
async function isolatedOpenSpec(project: string, configuration?: Record<string, unknown>) {
	const resources = await ensureSpecDrivenResources();
	const home = path.join(project, ".consumer-home");
	await fs.mkdir(path.join(home, "config", "openspec"), { recursive: true });
	await fs.writeFile(
		path.join(home, "config", "openspec", "config.json"),
		JSON.stringify({ delivery: "both", ...configuration }),
	);
	return async (args: string[], cwd = project) => {
		const child = Bun.spawn([process.execPath, path.join(resources.openspecRoot, "bin/openspec.js"), ...args], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				BUN_BE_BUN: "1",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH:
					process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? path.join(temporary, "bun-transpiler-cache"),
				NODE_PATH: "",
				HOME: home,
				USERPROFILE: home,
				APPDATA: path.join(home, "appdata"),
				LOCALAPPDATA: path.join(home, "localappdata"),
				CODEX_HOME: path.join(home, "codex"),
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_DATA_HOME: path.join(home, "data"),
				XDG_CACHE_HOME: path.join(home, "cache"),
				DO_NOT_TRACK: "1",
				OPENSPEC_TELEMETRY: "0",
			},
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	};
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
	const entries: Record<string, string> = {};
	async function visit(directory: string): Promise<void> {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			const relative = path.relative(root, absolute);
			if (entry.isDirectory()) {
				entries[relative] = "directory";
				await visit(absolute);
			} else {
				entries[relative] = crypto
					.createHash("sha256")
					.update(await fs.readFile(absolute))
					.digest("hex");
			}
		}
	}
	await visit(root);
	return entries;
}

let temporary: string;
beforeAll(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-upstream-resources-"));
});
afterAll(async () => {
	await fs.rm(temporary, { recursive: true, force: true });
});

describe("pinned upstream resources", () => {
	it("loads the pinned skill identities from their declared paths", async () => {
		const resources = await ensureSpecDrivenResources();
		expect(resources.manifest.openspec.version).toBe(inventory.openspec.version);
		expect(resources.manifest.superpowers.revision).toBe("22f0b463e7a5e579904dd6211a520321035526f7");
		expect(
			resources.manifest.skills
				.filter(entry => String(entry.source) === "openspec")
				.map(entry => entry.name)
				.sort(),
		).toEqual(upstreamOpenSpecSkills);
		expect(resources.manifest.skills.some(entry => entry.source === "superpowers")).toBe(true);
		for (const entry of resources.manifest.skills) {
			const skill = await loadSpecDrivenSkill(entry.source, entry.name);
			expect(skill.filePath).toBe(await resolveSpecDrivenResourcePath(resources.root, entry.path));
			expect(skill.baseDir).toBe(path.dirname(skill.filePath));
			expect((await loadSpecDrivenSkill(entry.source, entry.name)).filePath).toBe(skill.filePath);
			if (entry.source === "superpowers") expect(skill.containRoot).toBe(resources.superpowersRoot);
			if (entry.source === "openspec") {
				expect(entry.path).toBe(`openspec/skills/${entry.name}/SKILL.md`);
				const content = await fs.readFile(skill.filePath, "utf8");
				expect(
					parseFrontmatter(content, { source: skill.filePath, repair: false, level: "off" }).frontmatter.name,
				).toBe(entry.name);
			}
		}
		const packageMetadata = JSON.parse(
			await fs.readFile(path.join(resources.superpowersRoot, "package.json"), "utf8"),
		);
		expect(packageMetadata.type).toBe("module");
		const review = await resolveSpecDrivenResourcePath(
			resources.superpowersRoot,
			"skills/subagent-driven-development/scripts/review-package",
		);
		expect((await fs.stat(review)).isFile()).toBe(true);
		await expect(loadSpecDrivenSkill("superpowers", "../writing-plans")).rejects.toThrow("Unknown bundled");
	});

	it("loads Grill-me and its bundled metadata from the pinned JCH source", async () => {
		const resources = await ensureSpecDrivenResources();
		expect("jch" in resources.manifest ? resources.manifest.jch : undefined).toEqual(
			expect.objectContaining({ revision: "d1332445063976050be7aecfcac893a9b9c2fbfd" }),
		);
		const skill = await loadSpecDrivenSkill("jch", "jch-grill-me");
		const entry = resources.manifest.skills.find(
			entry => String(entry.source) === "jch" && entry.name === skill.name,
		);
		expect(entry).toBeDefined();
		expect(skill.source).toBe("bundled-jch");
		expect(skill.hide).toBe(true);
		expect(skill.filePath).toBe(await resolveSpecDrivenResourcePath(resources.root, entry!.path));
		expect(skill.containRoot).not.toBe(resources.superpowersRoot);
		expect(skill.containRoot).not.toBe(resources.openspecRoot);
		const metadata = await resolveSpecDrivenResourcePath(skill.baseDir, "agents/openai.yaml");
		for (const filePath of [skill.filePath, metadata]) {
			const relative = path.relative(resources.root, filePath).split(path.sep).join("/");
			const file = resources.manifest.files.find(file => file.path === relative);
			expect(file).toBeDefined();
			expect((await fs.stat(filePath)).isFile()).toBe(true);
			expect(path.relative(skill.containRoot!, filePath).startsWith("..")).toBe(false);
		}
	});

	it("rejects legacy aliases and unknown OpenSpec skill identities", async () => {
		for (const name of ["opsx-verify", "opsx-new", "opsx-continue", "../openspec-new-change"]) {
			await expect(loadSpecDrivenSkill("openspec", name)).rejects.toThrow("Unknown bundled openspec skill");
		}
	});

	it("initializes the native default schema without installing tool integrations", async () => {
		const project = path.join(temporary, "native-init");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		expect((await cli(["init"])).exitCode).toBe(0);
		const config = await fs.readFile(path.join(project, "openspec", "config.yaml"), "utf8");
		expect(config).toMatch(/^schema:\s*spec-driven\s*$/m);
		for (const directory of ["specs", "changes", "changes/archive"]) {
			expect((await fs.stat(path.join(project, "openspec", directory))).isDirectory()).toBe(true);
		}
		expect((await fs.readdir(project)).sort()).toEqual([".consumer-home", "openspec"]);
	}, 30_000);

	it("preserves native defaults through the public init and schema-less change wrapper", async () => {
		const project = path.join(temporary, "native-wrapper");
		await fs.mkdir(project);
		const target = path.join(project, "target with spaces");
		const initialized = await runOpenSpec(["init", "--language", "Chinese", target], project);
		expect(initialized.exitCode).toBe(0);
		const configPath = path.join(target, "openspec", "config.yaml");
		const config = await Bun.file(configPath).text();
		expect(config).toMatch(/^schema:\s*spec-driven\s*$/m);
		expect(config).toContain("Language: Chinese");
		expect(initialized.stdout).toContain("schema: spec-driven");
		const conflicting = await runOpenSpec(["init", target, "--language", "English"], project);
		expect(conflicting.exitCode).not.toBe(0);
		expect(await Bun.file(configPath).text()).toBe(config);

		const schemaLess = path.join(project, "schema-less");
		await fs.mkdir(path.join(schemaLess, "openspec", "changes"), { recursive: true });
		const created = await runOpenSpec(["new", "change", "native-change"], schemaLess);
		expect(created.exitCode).toBe(0);
		const status = await runOpenSpec(["status", "--change", "native-change", "--json"], schemaLess);
		expect(status.exitCode).toBe(0);
		const graph = JSON.parse(status.stdout);
		expect(graph.schemaName).toBe("spec-driven");
		expect(graph.artifacts.map((entry: { id: string }) => entry.id).sort()).toEqual([
			"design",
			"proposal",
			"specs",
			"tasks",
		]);
		expect(await Bun.file(path.join(schemaLess, "openspec", "config.yaml")).text()).toMatch(
			/^schema:\s*spec-driven\s*$/m,
		);
	}, 30_000);

	it("rejects the removed update command without changing project integrations", async () => {
		const project = path.join(temporary, "removed-update");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		const skill = path.join(project, ".omp", "skills", "custom", "SKILL.md");
		await Bun.write(skill, "User-owned integration\n");
		for (const args of [["update"], ["update", "--dry-run", "--json"]]) {
			const result = await cli(args);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("unknown command 'update'");
			expect(result.stdout).toBe("");
			expect(await Bun.file(skill).text()).toBe("User-owned integration\n");
		}
		const profile = await cli(["config", "profile", "core"]);
		expect(profile.exitCode).toBe(0);
		const config = await Bun.file(path.join(project, ".consumer-home", "config", "openspec", "config.json")).json();
		expect(config.profile).toBe("core");
		expect(await Bun.file(skill).text()).toBe("User-owned integration\n");
		expect(await Bun.file(path.join(project, "openspec", "config.yaml")).exists()).toBe(false);
		expect(profile.stdout).not.toContain("openspec update");
	}, 30_000);

	it("rejects removed Store commands and selectors without writing or contaminating JSON stdout", async () => {
		const project = path.join(temporary, "removed-store");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		expect((await cli(["init"])).exitCode).toBe(0);
		await fs.writeFile(path.join(project, "user.txt"), "User-owned bytes\r\n");
		const before = await snapshotTree(project);
		const invocations = [
			["store", "list"],
			["store", "list", "--json"],
			...["--store", "--store-path"].flatMap(option => [
				["context", option, "unused", "--json"],
				["new", "change", "must-not-exist", option, "unused", "--json"],
			]),
		];
		for (const args of invocations) {
			const result = await cli(args);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/unknown (command|option)/i);
			expect(result.stdout).toBe("");
			expect(await snapshotTree(project)).toEqual(before);
		}
	}, 30_000);

	it("isolates nearest ancestor, nested and adjacent project roots for reads and writes", async () => {
		const parent = path.join(temporary, "nearest-roots");
		await fs.mkdir(parent);
		const cli = await isolatedOpenSpec(parent);
		const outer = path.join(parent, "outer");
		const nested = path.join(outer, "nested");
		const sibling = path.join(parent, "sibling");
		for (const root of [outer, nested, sibling]) {
			await fs.mkdir(path.join(root, "src", "deep"), { recursive: true });
			expect((await cli(["init"], root)).exitCode).toBe(0);
			await fs.writeFile(
				path.join(root, "openspec", "config.yaml"),
				`schema: spec-driven\ncontext: ${JSON.stringify(root)}\n`,
			);
		}
		for (const root of [outer, nested, sibling]) {
			const deep = path.join(root, "src", "deep");
			for (const cwd of [root, deep]) {
				const context = await cli(["context", "--json"], cwd);
				expect(context.exitCode).toBe(0);
				expect(JSON.parse(context.stdout).root).toMatchObject({ path: root, source: "nearest" });
			}
			const created = await cli(["new", "change", "same-name", "--json"], deep);
			expect(created.exitCode).toBe(0);
			const changeDir = path.join(root, "openspec", "changes", "same-name");
			expect(JSON.parse(created.stdout).change.path).toBe(changeDir);
			const instructions = await cli(["instructions", "proposal", "--change", "same-name", "--json"], deep);
			expect(instructions.exitCode).toBe(0);
			expect(JSON.parse(instructions.stdout)).toMatchObject({
				changeDir,
				context: expect.stringContaining(root),
			});
			expect(await Bun.file(path.join(deep, "openspec", "config.yaml")).exists()).toBe(false);
		}
		expect((await fs.readdir(path.join(parent, "outer", "openspec", "changes"))).sort()).toEqual([
			"archive",
			"same-name",
		]);
	}, 60_000);

	it("does not initialize rootless queries but retains explicit implicit-root change creation", async () => {
		const project = path.join(temporary, "implicit-root");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		const before = await snapshotTree(project);
		for (const args of [
			["context", "--json"],
			["doctor", "--json"],
			["validate", "--all", "--json"],
		]) {
			const result = await cli(args);
			expect(result.exitCode).not.toBe(0);
			expect(JSON.parse(result.stdout).status).toEqual(
				expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
			);
			expect(await snapshotTree(project)).toEqual(before);
		}
		const created = await cli(["new", "change", "explicit-change", "--json"]);
		expect(created.exitCode).toBe(0);
		const changeDir = path.join(project, "openspec", "changes", "explicit-change");
		expect(JSON.parse(created.stdout)).toMatchObject({
			root: { path: project, source: "implicit" },
			change: { path: changeDir, schema: "spec-driven" },
		});
		expect(await Bun.file(path.join(changeDir, ".openspec.yaml")).exists()).toBe(true);
	}, 30_000);

	for (const extension of ["yaml", "yml"]) {
		for (const field of ["store", "references"]) {
			it(`rejects present ${field} fields in config.${extension}, including empty and null values`, async () => {
				const project = path.join(temporary, `unsupported-${extension}-${field}`);
				await fs.mkdir(path.join(project, "openspec", "changes", "existing"), { recursive: true });
				const cli = await isolatedOpenSpec(project);
				await fs.writeFile(path.join(project, "user.txt"), "Preserve user files\r\n");
				await fs.writeFile(path.join(project, "openspec", "changes", "existing", "proposal.md"), proposalContent);
				const configPath = path.join(project, "openspec", `config.${extension}`);
				for (const value of field === "store" ? ['"external"', '""', "null"] : ["[external]", "[]", "null"]) {
					await fs.writeFile(configPath, `schema: spec-driven\n${field}: ${value}\n`);
					const before = await snapshotTree(project);
					for (const args of [["init"], ["context", "--json"], ["new", "change", "rejected", "--json"]]) {
						const result = await cli(args);
						expect(result.exitCode).not.toBe(0);
						if (args.includes("--json")) {
							expect(JSON.parse(result.stdout).status).toEqual(
								expect.arrayContaining([
									expect.objectContaining({ code: "unsupported_project_field", severity: "error" }),
								]),
							);
						} else {
							expect(result.stderr).toMatch(new RegExp(field, "i"));
						}
						expect(await snapshotTree(project)).toEqual(before);
					}
				}
			}, 60_000);
		}
	}

	it("reports local context and doctor health without repairing directory or configuration faults", async () => {
		const project = path.join(temporary, "local-diagnostics");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		expect((await cli(["init"])).exitCode).toBe(0);
		const before = await snapshotTree(project);
		const context = await cli(["context", "--json"]);
		expect(context.exitCode).toBe(0);
		expect(JSON.parse(context.stdout)).toEqual({
			root: { path: project, source: "nearest", role: "openspec_root" },
			status: [],
		});
		const doctor = await cli(["doctor", "--json"]);
		expect(doctor.exitCode).toBe(0);
		expect(JSON.parse(doctor.stdout)).toEqual({
			root: { path: project, source: "nearest", healthy: true, status: [] },
			configPath: path.join(project, "openspec", "config.yaml"),
		});
		expect(await snapshotTree(project)).toEqual(before);
		await fs.rm(path.join(project, "openspec", "specs"), { recursive: true });
		await fs.writeFile(path.join(project, "openspec", "specs"), "Not a directory\n");
		for (const configMissing of [false, true]) {
			if (configMissing) await fs.rm(path.join(project, "openspec", "config.yaml"));
			const broken = await snapshotTree(project);
			const diagnosed = await cli(["doctor", "--json"]);
			expect(diagnosed.exitCode).toBe(0);
			const health = JSON.parse(diagnosed.stdout);
			expect(health.root.healthy).toBe(false);
			expect(health.root.status).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "openspec_specs_not_directory" })]),
			);
			if (configMissing) {
				expect(health.root.status).toEqual(
					expect.arrayContaining([expect.objectContaining({ code: "openspec_config_missing" })]),
				);
			}
			const working = await cli(["context", "--json"]);
			expect(working.exitCode).toBe(0);
			expect(JSON.parse(working.stdout).status).toEqual(health.root.status);
			expect(await snapshotTree(project)).toEqual(broken);
		}
	}, 30_000);

	it("persists, reads and removes Workset views without changing member directories or opening an IDE", async () => {
		const project = path.join(temporary, "local-worksets");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		const members = [path.join(project, "first member"), path.join(project, "second member")];
		for (const member of members) {
			await fs.mkdir(member);
			await fs.writeFile(path.join(member, "user.txt"), `Keep ${member}\r\n`);
		}
		const before = await Promise.all(members.map(snapshotTree));
		const created = await cli([
			"workset",
			"create",
			"local-view",
			"--member",
			`primary=${members[0]}`,
			"--member",
			`secondary=${members[1]}`,
			"--json",
		]);
		expect(created.exitCode).toBe(0);
		const workset = JSON.parse(created.stdout).workset;
		expect(workset).toEqual({
			name: "local-view",
			members: [
				{ name: "primary", path: members[0] },
				{ name: "secondary", path: members[1] },
			],
		});
		for (const command of ["list", "ls"]) {
			const listed = await cli(["workset", command, "--json"]);
			expect(listed.exitCode).toBe(0);
			expect(JSON.parse(listed.stdout).worksets).toEqual([workset]);
		}
		const removed = await cli(["workset", "remove", "local-view", "--yes", "--json"]);
		expect(removed.exitCode).toBe(0);
		expect(JSON.parse(removed.stdout).removed).toEqual({ name: "local-view" });
		const remaining = await cli(["workset", "list", "--json"]);
		expect(remaining.exitCode).toBe(0);
		expect(JSON.parse(remaining.stdout).worksets).toEqual([]);
		expect(await Promise.all(members.map(snapshotTree))).toEqual(before);
	}, 30_000);

	it("consumes project-local schemas, skipped specs and inherited guidance from a descendant cwd", async () => {
		const project = path.join(temporary, "nested-custom-workflow");
		const deep = path.join(project, "src", "deep");
		const schemaDir = path.join(project, "openspec", "schemas", "local-flow");
		await fs.mkdir(deep, { recursive: true });
		await fs.mkdir(path.join(schemaDir, "templates"), { recursive: true });
		await fs.writeFile(
			path.join(project, "openspec", "config.yml"),
			"schema: local-flow\ncontext: Local project context\nrules:\n  proposal:\n    - Keep the local requirement\n" +
				"operations:\n  apply:\n    guidance:\n      - Use the local implementation checklist\n" +
				"  archive:\n    guidance:\n      - Review the local release checklist\n",
		);
		await fs.writeFile(
			path.join(schemaDir, "schema.yaml"),
			"name: local-flow\nversion: 1\ndescription: Local workflow\nartifacts:\n" +
				"  - id: proposal\n    generates: proposal.md\n    description: Proposal\n    template: proposal.md\n    requires: []\n" +
				'  - id: specs\n    generates: "specs/**/*.md"\n    description: Specs\n    template: spec.md\n    requires: [proposal]\n' +
				'  - id: checklist\n    generates: "work/*.md"\n    description: Checklist\n    template: checklist.md\n    requires: [specs]\n' +
				'apply:\n  requires: [checklist]\n  tracks: "work/*.md"\n  instruction: Implement local tasks.\n',
		);
		for (const file of ["proposal.md", "spec.md", "checklist.md"]) {
			await fs.writeFile(path.join(schemaDir, "templates", file), `# Local ${file}\n`);
		}
		const cli = await isolatedOpenSpec(project);
		const created = await cli(["new", "change", "local-change", "--json"], deep);
		expect(created.exitCode).toBe(0);
		expect(JSON.parse(created.stdout).change.schema).toBe("local-flow");
		const changeDir = path.join(project, "openspec", "changes", "local-change");
		const proposal = await cli(["instructions", "proposal", "--change", "local-change", "--json"], deep);
		expect(proposal.exitCode).toBe(0);
		expect(JSON.parse(proposal.stdout)).toMatchObject({
			schemaName: "local-flow",
			changeDir,
			context: expect.stringContaining("Local project context"),
			rules: ["Keep the local requirement"],
			template: "# Local proposal.md\n",
			resolvedOutputPath: path.join(changeDir, "proposal.md"),
		});
		await fs.appendFile(path.join(changeDir, ".openspec.yaml"), "skip_specs: true\n");
		await fs.writeFile(path.join(changeDir, "proposal.md"), proposalContent);
		const skipped = await cli(["instructions", "specs", "--change", "local-change", "--json"], deep);
		expect(skipped.exitCode).toBe(0);
		expect(JSON.parse(skipped.stdout).skipped).toBe(true);
		const ready = await cli(["status", "--change", "local-change", "--json"], deep);
		expect(ready.exitCode).toBe(0);
		const status = JSON.parse(ready.stdout);
		expect(status.changeRoot).toBe(changeDir);
		expect(status.actionContext.allowedEditRoots).toEqual([project]);
		expect(status.artifacts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "specs", status: "skipped" }),
				expect.objectContaining({ id: "checklist", status: "ready" }),
			]),
		);
		await fs.mkdir(path.join(changeDir, "work"));
		await fs.writeFile(path.join(changeDir, "work", "first.md"), "- [x] First local task\n");
		await fs.writeFile(path.join(changeDir, "work", "second.md"), "- [ ] Second local task\n");
		const apply = await cli(["instructions", "apply", "--change", "local-change", "--json"], deep);
		expect(apply.exitCode).toBe(0);
		expect(JSON.parse(apply.stdout)).toMatchObject({
			state: "ready",
			context: "Local project context",
			operationGuidance: ["Use the local implementation checklist"],
			progress: { total: 2, complete: 1, remaining: 1 },
		});
		expect(JSON.parse(apply.stdout).contextFiles.checklist.sort()).toEqual([
			path.join(changeDir, "work", "first.md"),
			path.join(changeDir, "work", "second.md"),
		]);
		const archive = await cli(["instructions", "archive", "--change", "local-change", "--json"], deep);
		expect(archive.exitCode).toBe(0);
		expect(JSON.parse(archive.stdout)).toMatchObject({
			context: "Local project context",
			operationGuidance: ["Review the local release checklist"],
		});
		expect(await Bun.file(path.join(deep, "openspec", "config.yaml")).exists()).toBe(false);
		expect(await Bun.file(path.join(changeDir, "specs")).exists()).toBe(false);
	}, 30_000);

	it("uses the native four-artifact default schema through planning and archive", async () => {
		const project = path.join(temporary, "native-default");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		expect((await cli(["init"])).exitCode).toBe(0);
		expect((await cli(["new", "change", "native-change"])).exitCode).toBe(0);
		const changeDir = path.join(project, "openspec", "changes", "native-change");
		const initial = await cli(["status", "--change", "native-change", "--json"]);
		expect(initial.exitCode).toBe(0);
		const status = JSON.parse(initial.stdout);
		expect(status.schemaName).toBe("spec-driven");
		expect(status.artifacts.map((entry: { id: string }) => entry.id).sort()).toEqual([
			"design",
			"proposal",
			"specs",
			"tasks",
		]);
		expect(status.isComplete).toBe(false);
		const dependencies: Record<string, string[]> = {
			proposal: [],
			specs: ["proposal"],
			design: ["proposal"],
			tasks: ["design", "specs"],
		};
		for (const artifact of ["proposal", "specs", "design", "tasks"]) {
			const result = await cli(["instructions", artifact, "--change", "native-change", "--json"]);
			expect(result.exitCode).toBe(0);
			const instructions = JSON.parse(result.stdout);
			expect(instructions.artifactId).toBe(artifact);
			expect(instructions.dependencies.map((entry: { id: string }) => entry.id).sort()).toEqual(
				dependencies[artifact],
			);
		}
		const templates = await cli(["templates", "--json"]);
		expect(templates.exitCode).toBe(0);
		expect(Object.keys(JSON.parse(templates.stdout)).sort()).toEqual(["design", "proposal", "specs", "tasks"]);
		expect((await cli(["schema", "validate", "spec-driven", "--json"])).exitCode).toBe(0);
		await fs.writeFile(path.join(changeDir, "proposal.md"), proposalContent);
		await fs.mkdir(path.join(changeDir, "specs", "offline-resources"), { recursive: true });
		await fs.writeFile(path.join(changeDir, "specs", "offline-resources", "spec.md"), deltaContent);
		const partial = await cli(["status", "--change", "native-change", "--json"]);
		expect(partial.exitCode).toBe(0);
		expect(JSON.parse(partial.stdout).isComplete).toBe(false);
		await fs.writeFile(path.join(changeDir, "design.md"), "## Context\nOffline resources.\n");
		await fs.writeFile(
			path.join(changeDir, "tasks.md"),
			"## 1. Implementation\n\n- [x] 1.1 Make resources available offline\n",
		);
		const completed = await cli(["status", "--change", "native-change", "--json"]);
		expect(completed.exitCode).toBe(0);
		expect(JSON.parse(completed.stdout).isComplete).toBe(true);
		const apply = await cli(["instructions", "apply", "--change", "native-change", "--json"]);
		expect(apply.exitCode).toBe(0);
		expect(JSON.parse(apply.stdout).tasks).toHaveLength(1);
		expect(JSON.parse(apply.stdout).tasks[0].done).toBe(true);
		expect((await cli(["validate", "native-change", "--strict", "--json"])).exitCode).toBe(0);
		expect((await cli(["archive", "native-change", "--yes"])).exitCode).toBe(0);
		const mainSpec = await fs.readFile(
			path.join(project, "openspec", "specs", "offline-resources", "spec.md"),
			"utf8",
		);
		expect(mainSpec).toContain("### Requirement: Offline requirements access");
		expect(mainSpec).toContain("#### Scenario: Read requirements offline");
		const archivedName = (await fs.readdir(path.join(project, "openspec", "changes", "archive"))).find(name =>
			name.endsWith("-native-change"),
		);
		expect(archivedName).toBeDefined();
		for (const file of ["proposal.md", "design.md", "tasks.md"]) {
			expect(
				await Bun.file(path.join(project, "openspec", "changes", "archive", archivedName!, file)).exists(),
			).toBe(true);
		}
	}, 60_000);

	it("rejects malformed deltas during native archive even when artifacts are complete and specs are skipped", async () => {
		const project = path.join(temporary, "invalid-delta-archive");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		expect((await cli(["init"])).exitCode).toBe(0);
		expect((await cli(["new", "change", "invalid-delta"])).exitCode).toBe(0);
		const changeDir = path.join(project, "openspec", "changes", "invalid-delta");
		await fs.writeFile(path.join(changeDir, "proposal.md"), proposalContent);
		const specDir = path.join(changeDir, "specs", "offline-resources");
		await fs.mkdir(specDir, { recursive: true });
		const malformed = deltaContent.slice(0, deltaContent.indexOf("#### Scenario:"));
		await fs.writeFile(path.join(specDir, "spec.md"), malformed);
		await fs.writeFile(path.join(changeDir, "design.md"), "## Context\nOffline resources.\n");
		await fs.writeFile(
			path.join(changeDir, "tasks.md"),
			"## 1. Implementation\n\n- [x] 1.1 Complete offline resources\n",
		);
		const metadata = await fs.readFile(path.join(changeDir, ".openspec.yaml"));
		const status = await cli(["status", "--change", "invalid-delta", "--json"]);
		expect(status.exitCode).toBe(0);
		expect(JSON.parse(status.stdout).isComplete).toBe(true);
		const validated = await cli(["validate", "invalid-delta"]);
		expect(validated.exitCode).toBe(1);
		const validationOutput = `${validated.stdout}\n${validated.stderr}`;
		expect(validationOutput).toContain('ADDED "Offline requirements access" must include at least one scenario');
		const recovery = validationOutput.match(/omp openspec (show invalid-delta --json --deltas-only)(?:\r?\n|$)/);
		expect(recovery).not.toBeNull();
		const shown = await cli(recovery![1].split(" "));
		expect(shown.exitCode).toBe(0);
		expect(JSON.parse(shown.stdout)).toMatchObject({ id: "invalid-delta", deltaCount: 1 });
		expect(shown.stdout).toContain("Offline requirements access");
		const archived = await cli(["archive", "invalid-delta", "--skip-specs", "--yes"]);
		expect(archived.exitCode).toBe(1);
		expect(`${archived.stdout}\n${archived.stderr}`).toMatch(/validation failed/i);
		expect(await fs.readFile(path.join(changeDir, ".openspec.yaml"))).toEqual(metadata);
		expect(await fs.readFile(path.join(changeDir, "proposal.md"), "utf8")).toBe(proposalContent);
		expect(await fs.readFile(path.join(specDir, "spec.md"), "utf8")).toBe(malformed);
		expect(await Bun.file(path.join(project, "openspec", "specs", "offline-resources", "spec.md")).exists()).toBe(
			false,
		);
		const archives = await fs
			.readdir(path.join(project, "openspec", "changes", "archive"))
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			});
		expect(archives.some(name => name.endsWith("-invalid-delta"))).toBe(false);
	}, 30_000);

	for (const separable of [true, false]) {
		it(`honors ${separable ? "independent" : "design-dependent"} legacy schema dependencies`, async () => {
			const project = path.join(temporary, `legacy-schema-${separable}`);
			const schemaDir = path.join(project, "openspec", "schemas", "spec-driven");
			const changeDir = path.join(project, "openspec", "changes", "legacy-change");
			await fs.mkdir(path.join(schemaDir, "templates"), { recursive: true });
			await fs.mkdir(path.join(changeDir, "specs", "offline-resources"), { recursive: true });
			await fs.writeFile(
				path.join(schemaDir, "schema.yaml"),
				`name: spec-driven\nversion: 1\ndescription: Historical workflow\nartifacts:\n` +
					`  - id: proposal\n    generates: proposal.md\n    description: Proposal\n    template: proposal.md\n    requires: []\n` +
					`  - id: specs\n    generates: "specs/**/*.md"\n    description: Delta\n    template: spec.md\n    requires: [proposal${separable ? "" : ", design"}]\n` +
					`  - id: design\n    generates: design.md\n    description: Design\n    template: design.md\n    requires: [proposal]\n` +
					`  - id: tasks\n    generates: tasks.md\n    description: Tasks\n    template: tasks.md\n    requires: [specs, design]\n` +
					`apply:\n  requires: [tasks]\n  tracks: tasks.md\n  instruction: Implement the tracked tasks.\n`,
			);
			for (const file of ["proposal.md", "spec.md", "design.md", "tasks.md"]) {
				await fs.writeFile(path.join(schemaDir, "templates", file), `# ${file}\n`);
			}
			const historical: Record<string, Buffer> = {
				".openspec.yaml": Buffer.from("schema: spec-driven\ncreated: 2026-01-02\n"),
				"design.md": Buffer.from("# Historical design\r\nPreserve exact bytes.\r\n"),
				"tasks.md": Buffer.from("# Historical tasks\r\n- [ ] Historical task\r\n"),
			};
			for (const [file, bytes] of Object.entries(historical)) await fs.writeFile(path.join(changeDir, file), bytes);
			await fs.writeFile(path.join(changeDir, "proposal.md"), proposalContent);
			await fs.writeFile(path.join(changeDir, "specs", "offline-resources", "spec.md"), deltaContent);
			const cli = await isolatedOpenSpec(project);
			const result = await cli(["instructions", "specs", "--change", "legacy-change", "--json"]);
			expect(result.exitCode).toBe(0);
			const instructions = JSON.parse(result.stdout);
			expect(instructions.artifactId).toBe("specs");
			expect(instructions.dependencies.map((entry: { id: string }) => entry.id).sort()).toEqual(
				separable ? ["proposal"] : ["design", "proposal"],
			);
			expect(instructions.unlocks).toContain("tasks");
			const status = await cli(["status", "--change", "legacy-change", "--json"]);
			expect(status.exitCode).toBe(0);
			expect(
				JSON.parse(status.stdout)
					.artifacts.map((entry: { id: string }) => entry.id)
					.sort(),
			).toEqual(["design", "proposal", "specs", "tasks"]);
			const apply = await cli(["instructions", "apply", "--change", "legacy-change", "--json"]);
			expect(apply.exitCode).toBe(0);
			expect(JSON.parse(apply.stdout).tasks).toHaveLength(1);
			for (const [file, bytes] of Object.entries(historical))
				expect((await fs.readFile(path.join(changeDir, file))).equals(bytes)).toBe(true);
		}, 30_000);
	}

	it("rejects traversal, absolute paths and a canonical junction escape", async () => {
		const root = path.join(temporary, "containment");
		const outside = path.join(temporary, "outside");
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "private.txt"), "outside");
		await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		for (const invalid of [
			"../outside/private.txt",
			"/etc/passwd",
			"C:/Windows/win.ini",
			"skills/../../outside",
			"skills\\escape",
			"./file",
		]) {
			await expect(resolveSpecDrivenResourcePath(root, invalid)).rejects.toThrow();
		}
		await expect(resolveSpecDrivenResourcePath(root, "escape/private.txt")).rejects.toThrow("canonical root");
		await expect(runSuperpowersScript(".pi/extensions/superpowers.ts", [], temporary)).rejects.toThrow(
			"Not a bundled skill script",
		);
		await expect(runSuperpowersScript("skills/../package.json", [], temporary)).rejects.toThrow();
	});

	it("preserves project context through native proposal and spec instructions", async () => {
		const cwd = path.join(temporary, "real-project");
		await fs.mkdir(path.join(cwd, "openspec"), { recursive: true });
		const userContext = "Literal user data: openspec new change user-data";
		await fs.writeFile(
			path.join(cwd, "openspec", "config.yaml"),
			`schema: spec-driven\ncontext: ${JSON.stringify(userContext)}\n`,
		);
		const created = await runOpenSpec(["new", "change", "resource-probe", "--schema", "spec-driven"], cwd);
		expect(created.exitCode).toBe(0);
		const proposal = await runOpenSpec(["instructions", "proposal", "--change", "resource-probe", "--json"], cwd);
		expect(proposal.exitCode).toBe(0);
		expect(JSON.parse(proposal.stdout).artifactId).toBe("proposal");
		expect(JSON.parse(proposal.stdout).context).toContain(userContext);
		await fs.writeFile(
			path.join(cwd, "openspec", "changes", "resource-probe", "proposal.md"),
			"## Why\nExpose offline resources.\n\n## What Changes\n- Bundle upstream resources.\n\n## Capabilities\n### New Capabilities\n- `offline-resources`: offline capabilities\n### Modified Capabilities\nNone.\n\n## Impact\nOMP packaging.\n",
		);
		const specs = await runOpenSpec(["instructions", "specs", "--change", "resource-probe", "--json"], cwd);
		expect(specs.exitCode).toBe(0);
		expect(JSON.parse(specs.stdout).artifactId).toBe("specs");
		const invalid = await runOpenSpec(["status", "--change", "not-a-change", "--json"], cwd);
		expect(invalid.exitCode).not.toBe(0);
	});

	it("launches a detached package without source workspaces or external dependencies", async () => {
		const detached = path.join(temporary, "detached-distribution");
		await fs.cp((await ensureSpecDrivenResources()).root, detached, { recursive: true });
		const isolatedCwd = path.join(temporary, "consumer-project");
		await fs.mkdir(isolatedCwd);
		const entry = path.join(detached, "openspec/bin/openspec.js");
		const child = Bun.spawn([process.execPath, entry, "--version"], {
			cwd: isolatedCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				BUN_BE_BUN: "1",
				NODE_PATH: "",
				XDG_DATA_HOME: path.join(temporary, "isolated-data"),
				XDG_CONFIG_HOME: path.join(temporary, "isolated-config"),
				DO_NOT_TRACK: "1",
				OPENSPEC_TELEMETRY: "0",
			},
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(stdout.trim()).toBe(inventory.openspec.version);
		const templates = Bun.spawn([process.execPath, entry, "templates", "--json"], {
			cwd: isolatedCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				BUN_BE_BUN: "1",
				NODE_PATH: "",
				XDG_DATA_HOME: path.join(temporary, "isolated-data"),
				XDG_CONFIG_HOME: path.join(temporary, "isolated-config"),
				DO_NOT_TRACK: "1",
				OPENSPEC_TELEMETRY: "0",
			},
		});
		const [templateOutput, templateErrors, templateExit] = await Promise.all([
			new Response(templates.stdout).text(),
			new Response(templates.stderr).text(),
			templates.exited,
		]);
		expect(templateExit).toBe(0);
		const paths = Object.values(JSON.parse(templateOutput)) as { path: string; source: string }[];
		for (const template of paths) {
			expect(typeof template.path).toBe("string");
			if (typeof template.path !== "string") throw new Error(templateErrors);
			expect(template.source).toBe("package");
			expect(path.relative(detached, template.path).startsWith("..")).toBe(false);
			expect(await Bun.file(template.path).exists()).toBe(true);
		}
	});

	it.skipIf(process.platform === "win32")(
		"runs original scripts through the public source CLI and forwards real failures",
		async () => {
			async function invoke(args: string[]) {
				const child = Bun.spawn(
					[process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts"), "superpowers", ...args],
					{
						cwd: temporary,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						env: { ...process.env, BUN_BE_BUN: "1", NODE_PATH: "" },
					},
				);
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				return { stdout, stderr, exitCode };
			}

			const javascript = await invoke(["skills/writing-skills/render-graphs.js"]);
			expect(javascript.exitCode).toBe(1);
			expect(javascript.stderr).toContain("Usage: render-graphs.js");
			const bash = await invoke(["skills/subagent-driven-development/scripts/review-package"]);
			if (
				bash.stderr.includes(
					"Superpowers scripts require Bash and POSIX utilities (Git for Windows Bash on Windows)",
				)
			) {
				expect(bash.exitCode).toBe(1);
			} else {
				expect(bash.exitCode).toBe(2);
				expect(bash.stderr).toContain("usage: review-package");
			}
			const missing = await invoke([]);
			expect(missing.exitCode).toBe(2);
			expect(missing.stderr).toContain("Usage: omp superpowers <relative-skill-script> [args...]");
			const help = await invoke(["--help"]);
			expect(help.exitCode).toBe(0);
			expect(help.stderr).toBe("");
			expect(help.stdout).toContain("skills/writing-skills/render-graphs.js");
			for (const script of ["skills/not-a-script.js", ".pi/extensions/superpowers.ts", "../package.json"]) {
				const rejected = await invoke([script]);
				expect(rejected.exitCode).toBe(1);
				expect(rejected.stderr).toContain(`Not a bundled skill script: ${script}`);
			}
		},
	);

	it("launches original Bash and Node scripts and preserves their real usage failures", async () => {
		const javascript = await runSuperpowersScript("skills/writing-skills/render-graphs.js", [], temporary);
		expect(javascript.exitCode).toBe(1);
		expect(javascript.stderr).toContain("Usage: render-graphs.js");
		try {
			const bash = await runSuperpowersScript(
				"skills/subagent-driven-development/scripts/review-package",
				[],
				temporary,
			);
			expect(bash.exitCode).toBe(2);
			expect(bash.stderr).toContain("usage: review-package");
		} catch (error) {
			// A machine without Bash is a supported, explicit missing prerequisite, not a success.
			expect(error instanceof Error ? error.message : String(error)).toBe(
				"Superpowers scripts require Bash and POSIX utilities (Git for Windows Bash on Windows)",
			);
		}
		const abort = new AbortController();
		abort.abort();
		await expect(runOpenSpec(["--version"], temporary, abort.signal)).rejects.toThrow();
	});
});

describe("bundled Superpowers helper regressions", () => {
	it("rejects a non-repository cwd and honors -C without choosing the plan's directory", async () => {
		await using root = await TempDir.create("@superpowers-repository-");
		const project = root.join("working tree Ω");
		const outside = root.join("outside");
		await initializeRepository(project);
		await fs.mkdir(outside);
		const plan = path.join(outside, "plan.md");
		await Bun.write(plan, "# Plan\n");
		const script = "skills/subagent-driven-development/scripts/sdd-workspace";
		const rejected = await runSuperpowersScript(script, [plan], outside);
		expect(rejected.exitCode).toBe(2);
		expect(rejected.stderr).toContain("SDD scripts must run from inside the git working tree");
		await expect(fs.stat(path.join(outside, ".superpowers"))).rejects.toMatchObject({ code: "ENOENT" });

		const selected = await runSuperpowersScript(script, ["-C", project, plan], outside);
		expect(selected.exitCode).toBe(0);
		const workspace = selected.stdout.trim();
		// Native callers must be able to open the printed path, including on Windows.
		expect(path.isAbsolute(workspace)).toBe(true);
		expect(await fs.realpath(workspace)).toBe(await fs.realpath(path.join(project, ".superpowers/sdd/plan")));
		expect(await Bun.file(path.join(workspace, "plan-path")).text()).toContain("plan.md");

		const uncommitted = await runSuperpowersScript("skills/executing-plans/scripts/task-start", [plan, "1"], project);
		expect(uncommitted.exitCode).toBe(2);
		expect(uncommitted.stderr).toContain("with at least one commit");
	});

	it("extracts letter-first, suffixed and dotted task IDs without swallowing a neighboring task", async () => {
		await using root = await TempDir.create("@superpowers-task-ids-");
		await initializeRepository(root.path());
		await Bun.write(
			root.join("plan.md"),
			"### Task A1: Setup\nSet up the project.\n### Task 6: Main\nImplement the main path.\n### Task 6b: Edge\nHandle the edge case.\n### Task 2.1: Nested ID\nCheck the nested identifier.\n",
		);
		for (const [id, expected] of [
			["A1", "### Task A1: Setup\nSet up the project.\n"],
			["6", "### Task 6: Main\nImplement the main path.\n"],
			["6b", "### Task 6b: Edge\nHandle the edge case.\n"],
			["2.1", "### Task 2.1: Nested ID\nCheck the nested identifier.\n"],
		]) {
			// Exercise default workspace routing once; the other cases isolate task parsing.
			const explicitOutput = id !== "A1";
			const output = explicitOutput ? `task-${id}-brief.md` : `.superpowers/sdd/plan/task-${id}-brief.md`;
			const result = await runSuperpowersScript(
				"skills/subagent-driven-development/scripts/task-brief",
				explicitOutput ? ["plan.md", id!, output] : ["plan.md", id!],
				root.path(),
			);
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(root.join(output)).text()).toBe(expected!);
		}
	});

	it("rejects an unclosed fence rather than giving an implementer multiple tasks", async () => {
		await using root = await TempDir.create("@superpowers-task-fence-");
		await initializeRepository(root.path());
		await Bun.write(
			root.join("plan.md"),
			"### Task 1: First\n```typescript\nconst value = 1;\n### Task 2: Second\nDo not include this task.\n",
		);
		const result = await runSuperpowersScript(
			"skills/subagent-driven-development/scripts/task-brief",
			["plan.md", "1"],
			root.path(),
		);
		expect(result.exitCode).toBe(4);
		expect(result.stderr).toContain("never closes");
		expect(await Bun.file(root.join(".superpowers/sdd/plan/task-1-brief.md")).exists()).toBe(false);
	});
});

it("embedded script launch preserves exact arguments and workspace runtime environment", async () => {
	const cwd = path.join(temporary, "script arguments Ω (workspace)");
	await fs.mkdir(cwd);
	const args = ["missing skill directory Ω (not a command)", "--combine", "spaced argument", "literal=$VALUE"];
	const resources = await ensureSpecDrivenResources();
	const spawn = Bun.spawn;
	const launches: Array<{ command: string[]; env?: Record<string, string> }> = [];
	const intercepted = spyOn(Bun, "spawn").mockImplementation(((
		command: string[],
		options: { env?: Record<string, string> },
	) => {
		launches.push({ command: [...command], env: options.env });
		return Reflect.apply(spawn, Bun, [command, options]);
	}) as typeof Bun.spawn);
	try {
		const result = await runSuperpowersScript("skills/writing-skills/render-graphs.js", args, cwd);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(path.join(cwd, args[0]!, "SKILL.md"));
		expect(result.stdout).toBe("");
		expect(launches).toHaveLength(1);
		const launch = launches[0]!;
		expect(launch.command).toEqual([
			process.execPath,
			await resolveSpecDrivenResourcePath(resources.superpowersRoot, "skills/writing-skills/render-graphs.js"),
			...args,
		]);
		expect(launch.env?.BUN_BE_BUN).toBe("1");
		expect(launch.env?.OMP_BUN_EXECUTABLE).toBe(process.execPath);
		expect(launch.env?.PATH?.split(path.delimiter)[0]).toBe(path.join(resources.root, "omp-runtime"));
		expect(launch.env?.BRAINSTORM_DIR).toBe(path.join(cwd, ".superpowers", "brainstorm"));
		const shellArgs = ["missing plan Ω (not a command).md", "literal base", "literal head"];
		let shell: SpecDrivenProcessResult | undefined;
		try {
			shell = await runSuperpowersScript(
				"skills/subagent-driven-development/scripts/review-package",
				shellArgs,
				cwd,
			);
		} catch (error) {
			expect(error instanceof Error ? error.message : String(error)).toBe(
				"Superpowers scripts require Bash and POSIX utilities (Git for Windows Bash on Windows)",
			);
			expect(launches).toHaveLength(1);
		}
		if (shell) {
			expect(shell.exitCode).toBe(2);
			expect(shell.stderr).toContain(`no such plan file: ${shellArgs[0]}`);
			expect(shell.stdout).toBe("");
			expect(launches).toHaveLength(2);
			const bashLaunch = launches[1]!;
			expect(bashLaunch.command.slice(2)).toEqual(shellArgs);
			expect(bashLaunch.env?.BRAINSTORM_DIR).toBe(path.join(cwd, ".superpowers", "brainstorm"));
			const runtimePaths = bashLaunch.env?.PATH?.split(path.delimiter);
			expect(runtimePaths?.[0]).toBe(path.join(resources.root, "omp-runtime"));
			if (process.platform === "win32") {
				expect(path.basename(bashLaunch.command[0]!).toLowerCase()).toBe("bash.exe");
				expect(bashLaunch.command[0]!.replaceAll("\\", "/").toLowerCase()).not.toContain("/system32/");
				expect(runtimePaths?.slice(1, 3)).toEqual([
					path.dirname(bashLaunch.command[0]!),
					path.resolve(path.dirname(bashLaunch.command[0]!), "../usr/bin"),
				]);
			}
		}
	} finally {
		intercepted.mockRestore();
	}
}, 30_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	it(`public Superpowers ${signal} waits for the actual bundled server to exit without reporting success`, async () => {
		const cwd = path.join(temporary, `script-signal-${signal}`);
		await fs.mkdir(cwd);
		const pidFile = path.join(cwd, "owned-script.pid");
		const preload = path.join(cwd, "observe-script.mjs");
		await fs.writeFile(
			preload,
			[
				'import fs from "node:fs";',
				"const spawn = Bun.spawn;",
				"Bun.spawn = function (...args) {",
				"  const child = Reflect.apply(spawn, Bun, args);",
				'  if (Array.isArray(args[0]) && args[0].some(arg => String(arg).endsWith("server.cjs")))',
				`    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
				"  return child;",
				"};",
			].join("\n"),
		);
		const child = Bun.spawn(
			[
				process.execPath,
				"--preload",
				preload,
				path.resolve(import.meta.dir, "../../src/cli.ts"),
				"superpowers",
				"skills/brainstorming/scripts/server.cjs",
			],
			{
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, BUN_BE_BUN: "1", SUPERPOWERS_DISABLE_TELEMETRY: "1" },
			},
		);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		let scriptPid: number | undefined;
		try {
			const deadline = Date.now() + 10_000;
			const infoPath = path.join(cwd, ".superpowers/brainstorm/state/server-info");
			// The publisher appends a newline after the JSON; existence alone can
			// observe the newly created file before its single record is written.
			let infoText = "";
			while (!infoText.endsWith("\n")) {
				try {
					infoText = await Bun.file(infoPath).text();
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
				if (infoText.endsWith("\n")) break;
				if (child.exitCode !== null) throw new Error(`Script exited before startup: ${await stderr}`);
				if (Date.now() >= deadline) throw new Error("Bundled server did not publish its real startup state");
				await Bun.sleep(10);
			}
			scriptPid = Number(await fs.readFile(pidFile, "utf8"));
			expect(Number.isSafeInteger(scriptPid) && scriptPid > 0).toBe(true);
			const info = JSON.parse(infoText) as { port: number; type: string };
			expect(info.type).toBe("server-started");
			const url = `http://127.0.0.1:${info.port}/`;
			expect((await fetch(url)).status).toBe(403);
			child.kill(signal);
			const exitCode = await Promise.race([
				child.exited,
				Bun.sleep(5_000).then(() => {
					throw new Error(`${signal} did not settle the script process`);
				}),
			]);
			expect(exitCode).not.toBe(0);
			// The CLI buffers output until the script settles; abort can reject
			// before forwarding it. Startup is proven by server-info and HTTP above.
			await stdout;
			await stderr;
			expect(() => process.kill(scriptPid!, 0)).toThrow();
			await expect(fetch(url)).rejects.toThrow();
		} finally {
			if (child.exitCode === null) child.kill();
			if (scriptPid !== undefined) {
				try {
					process.kill(scriptPid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			await child.exited;
			await Promise.all([stdout, stderr]);
		}
	}, 30_000);
}
