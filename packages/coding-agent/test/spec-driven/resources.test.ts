import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import type { Skill } from "../../src/extensibility/skills";
import {
	ensureSpecDrivenResources,
	loadSpecDrivenSkill,
	resolveSpecDrivenResourcePath,
	runOpenSpec,
	runSuperpowersScript,
} from "../../src/spec-driven/resources";
import { archiveBase64 } from "../../src/spec-driven/vendor/archive.generated";

// Exercise the approved consumer signature before the production cutover lands.
const loadControlledSkill = loadSpecDrivenSkill as (
	source: "openspec" | "superpowers" | "jch",
	name: string,
	options?: { role?: "requirements" | "solution" | "planner" | "executor" | "reviewer" },
) => Promise<Skill>;

const retainedWorkflows = ["archive", "continue", "explore", "new", "propose", "sync", "update"];
const retainedOpenSpecSkills = [
	"openspec-archive-change",
	"openspec-continue-change",
	"openspec-explore",
	"openspec-new-change",
	"openspec-propose",
	"openspec-sync-specs",
	"openspec-update-change",
];
const removedOpenSpecSkills = [
	"openspec-apply-change",
	"openspec-ff-change",
	"openspec-verify-change",
	"openspec-bulk-archive-change",
	"openspec-onboard",
	"feedback",
];
const proposalContent =
	"## Why\nKeep requirements available offline.\n\n## What Changes\n- Document offline access.\n\n## Capabilities\n### New Capabilities\n- `offline-resources`: offline requirements access\n### Modified Capabilities\nNone.\n\n## Impact\nRequirements documentation only.\n";
const deltaContent =
	"## Purpose\nDescribe how users can read the bundled requirements without any network connection or external checkout.\n\n## ADDED Requirements\n\n### Requirement: Offline requirements access\nThe system SHALL expose bundled requirements without a network connection.\n\n#### Scenario: Read requirements offline\n- **WHEN** a user requests the bundled requirements offline\n- **THEN** the requirements are available without a network request\n";

// Init and update read global preferences; give each consumer its own HOME and XDG roots.
async function isolatedOpenSpec(project: string, configuration?: Record<string, unknown>) {
	const resources = await ensureSpecDrivenResources();
	const home = path.join(project, ".consumer-home");
	await fs.mkdir(path.join(home, "config", "openspec"), { recursive: true });
	await fs.writeFile(
		path.join(home, "config", "openspec", "config.json"),
		JSON.stringify({ delivery: "both", ...configuration }),
	);
	return async (args: string[]) => {
		const child = Bun.spawn([process.execPath, path.join(resources.openspecRoot, "bin/openspec.js"), ...args], {
			cwd: project,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				BUN_BE_BUN: "1",
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

async function expectRequirementsDelivery(project: string) {
	const skills = path.join(project, ".claude", "skills");
	const commands = path.join(project, ".claude", "commands", "opsx");
	expect((await fs.readdir(skills)).filter(name => name.startsWith("openspec-")).sort()).toEqual(
		retainedOpenSpecSkills,
	);
	expect((await fs.readdir(commands)).filter(name => name.endsWith(".md")).sort()).toEqual(
		retainedWorkflows.map(name => `${name}.md`),
	);
}

async function expectNoImplementationArtifacts(project: string, change: string) {
	const changeDir = path.join(project, "openspec", "changes", change);
	for (const file of ["design.md", "tasks.md"]) {
		expect(await Bun.file(path.join(changeDir, file)).exists()).toBe(false);
	}
	expect(await fs.readFile(path.join(project, "business.ts"), "utf8")).toBe("export const unchanged = true;\n");
}

let temporary: string;
beforeAll(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-upstream-resources-"));
});
afterAll(async () => {
	await fs.rm(temporary, { recursive: true, force: true });
});

describe("pinned upstream resources", () => {
	it("loads all exact trusted skill identities with their complete relative trees", async () => {
		const resources = await ensureSpecDrivenResources();
		expect(resources.manifest.openspec.version).toBe("1.14.3");
		expect(resources.manifest.superpowers.revision).toBe("2ce8aa15d05bd57213e6f746f953aafb7ded7a8b");
		expect(
			resources.manifest.skills
				.filter(entry => entry.source === "openspec")
				.map(entry => entry.name)
				.sort(),
		).toEqual(retainedOpenSpecSkills);
		expect(resources.manifest.skills.some(entry => entry.source === "superpowers")).toBe(true);
		for (const entry of resources.manifest.skills) {
			const skill = await loadSpecDrivenSkill(entry.source, entry.name);
			const ordinarilyVisible =
				entry.source === "superpowers" &&
				[
					"verification-before-completion",
					"systematic-debugging",
					"writing-plans",
					"subagent-driven-development",
					"executing-plans",
					"using-git-worktrees",
					"test-driven-development",
					"requesting-code-review",
					"finishing-a-development-branch",
					"writing-skills",
				].includes(entry.name);
			expect(skill.hide).toBe(!ordinarilyVisible);
			if (entry.source === "openspec") expect(skill.containRoot).toBe(resources.openspecRoot);
			if (entry.source === "superpowers") expect(skill.containRoot).toBe(resources.superpowersRoot);
		}
		for (const file of resources.manifest.files) {
			const absolute = await resolveSpecDrivenResourcePath(resources.root, file.path);
			expect(
				crypto
					.createHash("sha256")
					.update(await fs.readFile(absolute))
					.digest("hex"),
			).toBe(file.sha256);
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

	it("loads Grill-me from a pinned third source with independently verified bundled metadata", async () => {
		const resources = await ensureSpecDrivenResources();
		expect("jch" in resources.manifest ? resources.manifest.jch : undefined).toEqual(
			expect.objectContaining({ revision: "d1332445063976050be7aecfcac893a9b9c2fbfd" }),
		);
		const skill = await loadControlledSkill("jch", "jch-grill-me");
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
			const bytes = await fs.readFile(filePath);
			expect(bytes.length).toBeGreaterThan(0);
			expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(file!.sha256);
			expect(path.relative(skill.containRoot!, filePath).startsWith("..")).toBe(false);
		}
	});

	for (const [role, source, name] of [
		["requirements", "jch", "jch-grill-me"],
		["requirements", "superpowers", "brainstorming"],
		["planner", "superpowers", "writing-plans"],
		["executor", "superpowers", "subagent-driven-development"],
		["executor", "superpowers", "test-driven-development"],
		["executor", "superpowers", "verification-before-completion"],
		["reviewer", "superpowers", "requesting-code-review"],
	] as const) {
		it(`loads a distinct effective ${name} resource for the ${role} role without changing ordinary loading`, async () => {
			const ordinary = await loadControlledSkill(source, name);
			const before = await fs.readFile(ordinary.filePath);
			const effective = await loadControlledSkill(source, name, { role });
			expect(effective.name).toBe(ordinary.name);
			expect(effective.source).toBe(ordinary.source);
			expect(effective.filePath).not.toBe(ordinary.filePath);
			expect(effective.baseDir).toBe(path.dirname(effective.filePath));
			const effectivePath = await resolveSpecDrivenResourcePath(
				effective.containRoot!,
				path.relative(effective.containRoot!, effective.filePath).split(path.sep).join("/"),
			);
			const effectiveBytes = await fs.readFile(effectivePath);
			expect(effectiveBytes.length).toBeGreaterThan(0);
			expect(effectiveBytes.equals(before)).toBe(false);
			const reloaded = await loadControlledSkill(source, name);
			expect(reloaded.filePath).toBe(ordinary.filePath);
			expect((await fs.readFile(reloaded.filePath)).equals(before)).toBe(true);
		});
	}

	it("rejects explicit loading of all six removed OpenSpec wrappers", async () => {
		const resources = await ensureSpecDrivenResources();
		for (const name of removedOpenSpecSkills) {
			await expect(loadSpecDrivenSkill("openspec", name)).rejects.toThrow("Unknown bundled");
			for (const tree of ["skills", "original-skills"]) {
				expect(resources.manifest.files.some(file => file.path.startsWith(`openspec/${tree}/${name}/`))).toBe(
					false,
				);
			}
		}
		for (const module of [
			"apply-change",
			"ff-change",
			"verify-change",
			"bulk-archive-change",
			"onboard",
			"feedback",
		]) {
			expect(
				resources.manifest.files.some(file =>
					file.path.startsWith(`openspec/dist/core/templates/workflows/${module}.`),
				),
			).toBe(false);
		}
	});

	for (const profile of ["core", "custom"] as const) {
		it(`generates only seven requirements workflows through init and forced update (${profile})`, async () => {
			const project = path.join(temporary, `generated-${profile}`);
			await fs.mkdir(project);
			const cli = await isolatedOpenSpec(project, {
				profile,
				workflows: [...retainedWorkflows, "apply", "ff", "verify", "bulk-archive", "onboard", "feedback"],
			});
			const initialized = await cli(["init", "--tools", "claude", "--force", "--no-animation"]);
			expect(initialized.exitCode).toBe(0);
			await expectRequirementsDelivery(project);
			// Remove managed outputs so update must regenerate, rather than merely retain init's output.
			await fs.rm(path.join(project, ".claude", "skills", "openspec-propose"), { recursive: true });
			await fs.rm(path.join(project, ".claude", "commands", "opsx", "propose.md"));
			const updated = await cli(["update", "--force"]);
			expect(updated.exitCode).toBe(0);
			await expectRequirementsDelivery(project);
		}, 30_000);
	}

	for (const command of ["init", "update"] as const) {
		it(`removes obsolete Kilo workflows through native ${command} without changing user files or history`, async () => {
			const project = path.join(temporary, `kilo-legacy-cleanup-${command}`);
			const legacy = path.join(project, ".kilocode", "workflows");
			const history = path.join(project, "openspec", "changes", "archive", "2026-10-01-existing");
			await fs.mkdir(legacy, { recursive: true });
			await fs.mkdir(history, { recursive: true });
			const historical = {
				"proposal.md": proposalContent,
				"design.md": "# Existing design\nPreserve implementation history.\n",
				"tasks.md": "- [x] Existing implementation task\n",
				".openspec.yaml": "schema: spec-driven\ncreated: 2026-10-01\n",
			};
			for (const [name, content] of Object.entries(historical)) {
				await fs.writeFile(path.join(history, name), content);
			}
			const obsolete = ["apply", "ff", "verify", "bulk-archive", "onboard"];
			for (const workflow of obsolete) {
				await fs.writeFile(
					path.join(legacy, `opsx-${workflow}.md`),
					"<!-- OPENSPEC:START -->\nLegacy managed workflow\n<!-- OPENSPEC:END -->\n",
				);
			}
			const userWorkflow = "# User workflow\nKeep this unrelated command.\n";
			await fs.writeFile(path.join(legacy, "user-workflow.md"), userWorkflow);
			const cli = await isolatedOpenSpec(project);
			const result = await cli(
				command === "init" ? ["init", "--tools", "kilocode", "--force", "--no-animation"] : ["update", "--force"],
			);
			expect(result.exitCode).toBe(0);
			expect((await fs.readdir(legacy)).sort()).toEqual(["user-workflow.md"]);
			expect(await fs.readFile(path.join(legacy, "user-workflow.md"), "utf8")).toBe(userWorkflow);
			expect((await fs.readdir(path.join(project, ".kilo", "command"))).sort()).toEqual(
				retainedWorkflows.map(workflow => `opsx-${workflow}.md`),
			);
			expect(
				(await fs.readdir(path.join(project, ".kilocode", "skills")))
					.filter(name => name.startsWith("openspec-"))
					.sort(),
			).toEqual(retainedOpenSpecSkills);
			for (const [name, content] of Object.entries(historical)) {
				expect(await fs.readFile(path.join(history, name), "utf8")).toBe(content);
			}
		}, 30_000);
	}

	it("keeps legacy tool migration within the seven requirements workflows", async () => {
		const project = path.join(temporary, "legacy-tool-migration");
		const legacy = path.join(project, ".claude", "commands", "openspec");
		await fs.mkdir(legacy, { recursive: true });
		await fs.mkdir(path.join(project, "openspec"), { recursive: true });
		// Native migration requires ownership markers; unmarked commands belong to the user and cannot trigger an upgrade.
		await fs.writeFile(
			path.join(legacy, "proposal.md"),
			"<!-- OPENSPEC:START -->\nLegacy proposal command\n<!-- OPENSPEC:END -->\n",
		);
		await fs.writeFile(
			path.join(legacy, "apply.md"),
			"<!-- OPENSPEC:START -->\nLegacy implementation command\n<!-- OPENSPEC:END -->\n",
		);
		const cli = await isolatedOpenSpec(project);
		const migrated = await cli(["update", "--force"]);
		expect(migrated.exitCode).toBe(0);
		await expectRequirementsDelivery(project);
		expect(await Bun.file(path.join(legacy, "proposal.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(legacy, "apply.md")).exists()).toBe(false);
	}, 30_000);

	it("uses a requirements-only default schema for new, continue, and completed proposal flows", async () => {
		const project = path.join(temporary, "default-requirements");
		await fs.mkdir(project);
		await fs.writeFile(path.join(project, "business.ts"), "export const unchanged = true;\n");
		const cli = await isolatedOpenSpec(project);
		expect((await cli(["init", "--tools", "none", "--force", "--no-animation"])).exitCode).toBe(0);
		expect((await cli(["new", "change", "requirements-only"])).exitCode).toBe(0);
		const changeDir = path.join(project, "openspec", "changes", "requirements-only");
		const metadataBefore = await fs.readFile(path.join(changeDir, ".openspec.yaml"));
		for (const artifact of ["proposal", "specs"]) {
			const statusResult = await cli(["status", "--change", "requirements-only", "--json"]);
			expect(statusResult.exitCode).toBe(0);
			const status = JSON.parse(statusResult.stdout);
			expect(status.artifacts.map((entry: { id: string }) => entry.id).sort()).toEqual(["proposal", "specs"]);
			const result = await cli(["instructions", artifact, "--change", "requirements-only", "--json"]);
			expect(result.exitCode).toBe(0);
			const instructions = JSON.parse(result.stdout);
			expect(instructions.artifactId).toBe(artifact);
			expect(instructions.dependencies.every((entry: { id: string }) => entry.id === "proposal")).toBe(true);
			expect(instructions.unlocks.every((id: string) => id === "specs")).toBe(true);
			if (artifact === "proposal") {
				await fs.writeFile(path.join(changeDir, "proposal.md"), proposalContent);
			} else {
				await fs.mkdir(path.join(changeDir, "specs", "offline-resources"), { recursive: true });
				await fs.writeFile(path.join(changeDir, "specs", "offline-resources", "spec.md"), deltaContent);
			}
		}
		const completed = await cli(["status", "--change", "requirements-only", "--json"]);
		expect(completed.exitCode).toBe(0);
		expect(JSON.parse(completed.stdout).isComplete).toBe(true);
		for (const artifact of ["apply", "design", "tasks"]) {
			const forbidden = await cli(["instructions", artifact, "--change", "requirements-only", "--json"]);
			expect(forbidden.exitCode).not.toBe(0);
		}
		const templates = await cli(["templates", "--json"]);
		expect(templates.exitCode).toBe(0);
		expect(Object.keys(JSON.parse(templates.stdout)).sort()).toEqual(["proposal", "specs"]);
		const schema = await cli(["schema", "validate", JSON.parse(completed.stdout).schemaName, "--json"]);
		expect(schema.exitCode).toBe(0);
		const validated = await cli(["validate", "requirements-only", "--strict", "--json"]);
		expect(validated.exitCode).toBe(0);
		expect(await fs.readFile(path.join(changeDir, ".openspec.yaml"))).toEqual(metadataBefore);
		await expectNoImplementationArtifacts(project, "requirements-only");
		const archived = await cli(["archive", "requirements-only", "--yes"]);
		expect(archived.exitCode).toBe(0);
		const mainSpec = await fs.readFile(
			path.join(project, "openspec", "specs", "offline-resources", "spec.md"),
			"utf8",
		);
		expect(mainSpec).toContain("### Requirement: Offline requirements access");
		expect(mainSpec).toContain("#### Scenario: Read requirements offline");
		const archiveNames = await fs.readdir(path.join(project, "openspec", "changes", "archive"));
		const archivedName = archiveNames.find(name => name.endsWith("-requirements-only"));
		expect(archivedName).toBeDefined();
		for (const file of ["design.md", "tasks.md"]) {
			expect(
				await Bun.file(path.join(project, "openspec", "changes", "archive", archivedName!, file)).exists(),
			).toBe(false);
		}
		expect(await fs.readFile(path.join(project, "business.ts"), "utf8")).toBe("export const unchanged = true;\n");
	}, 60_000);

	for (const separable of [true, false]) {
		it(`handles ${separable ? "separable" : "inseparable"} legacy schemas without rewriting historical artifacts`, async () => {
			const project = path.join(temporary, `legacy-schema-${separable}`);
			const schemaDir = path.join(project, "openspec", "schemas", "spec-driven");
			const changeDir = path.join(project, "openspec", "changes", "legacy-change");
			await fs.mkdir(path.join(schemaDir, "templates"), { recursive: true });
			await fs.mkdir(path.join(changeDir, "specs", "offline-resources"), { recursive: true });
			await fs.writeFile(path.join(project, "business.ts"), "export const unchanged = true;\n");
			// Model an existing user schema; the unsafe variant makes requirement output depend on implementation.
			await fs.writeFile(
				path.join(schemaDir, "schema.yaml"),
				`name: spec-driven\nversion: 1\ndescription: Historical workflow\nartifacts:\n` +
					`  - id: proposal\n    generates: proposal.md\n    description: Requirements proposal\n    template: proposal.md\n    requires: []\n` +
					`  - id: specs\n    generates: "specs/**/*.md"\n    description: Requirements delta\n    template: spec.md\n    requires: [proposal${separable ? "" : ", design"}]\n` +
					`  - id: design\n    generates: design.md\n    description: Historical implementation design\n    template: design.md\n    requires: [proposal]\n` +
					`  - id: tasks\n    generates: tasks.md\n    description: Historical implementation tasks\n    template: tasks.md\n    requires: [specs, design]\n` +
					`apply:\n  requires: [tasks]\n  tracks: tasks.md\n  instruction: Implement the tracked tasks.\n`,
			);
			for (const file of ["proposal.md", "spec.md", "design.md", "tasks.md"]) {
				await fs.writeFile(path.join(schemaDir, "templates", file), `# ${file}\n`);
			}
			const historical: Record<string, Buffer> = {
				".openspec.yaml": Buffer.from("schema: spec-driven\ncreated: 2026-01-02\n"),
				"design.md": Buffer.from("# Historical design\r\nPreserve exact bytes.\r\n"),
				"tasks.md": Buffer.from("# Historical tasks\r\n- [ ] Never execute this task\r\n"),
			};
			for (const [file, bytes] of Object.entries(historical)) await fs.writeFile(path.join(changeDir, file), bytes);
			await fs.writeFile(path.join(changeDir, "proposal.md"), proposalContent);
			await fs.writeFile(path.join(changeDir, "specs", "offline-resources", "spec.md"), deltaContent);
			const cli = await isolatedOpenSpec(project);
			const result = await cli(["instructions", "specs", "--change", "legacy-change", "--json"]);
			if (separable) {
				expect(result.exitCode).toBe(0);
				const instructions = JSON.parse(result.stdout);
				expect(instructions.artifactId).toBe("specs");
				expect(instructions.dependencies.map((entry: { id: string }) => entry.id)).toEqual(["proposal"]);
				expect(instructions.unlocks).not.toContain("tasks");
				expect(instructions.unlocks).not.toContain("design");
				const proposal = await cli(["instructions", "proposal", "--change", "legacy-change", "--json"]);
				expect(proposal.exitCode).toBe(0);
				expect(JSON.parse(proposal.stdout).artifactId).toBe("proposal");
				expect(JSON.parse(proposal.stdout).unlocks).toEqual(["specs"]);
				await fs.writeFile(
					path.join(changeDir, "proposal.md"),
					proposalContent.replace("Document offline access.", "Clarify offline access."),
				);
				// A document revision remains valid without migrating metadata or touching implementation history.
				await fs.writeFile(
					path.join(changeDir, "specs", "offline-resources", "spec.md"),
					deltaContent.replace("without a network request", "without any network request"),
				);
				expect((await cli(["validate", "legacy-change", "--strict", "--json"])).exitCode).toBe(0);
			} else {
				expect(result.exitCode).not.toBe(0);
				expect(`${result.stdout}\n${result.stderr}`).toMatch(/incompatib|cannot.*isolat|无法.*隔离|不兼容/iu);
				expect(await fs.readFile(path.join(changeDir, "specs", "offline-resources", "spec.md"), "utf8")).toBe(
					deltaContent,
				);
			}
			const apply = await cli(["instructions", "apply", "--change", "legacy-change", "--json"]);
			expect(apply.exitCode).not.toBe(0);
			for (const [file, bytes] of Object.entries(historical))
				expect((await fs.readFile(path.join(changeDir, file))).equals(bytes)).toBe(true);
			expect(await fs.readFile(path.join(project, "business.ts"), "utf8")).toBe("export const unchanged = true;\n");
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

	it("uses the real CLI for requirements-only status and proposal/spec instructions", async () => {
		const resources = await ensureSpecDrivenResources();
		const cwd = path.join(temporary, "real-project");
		await fs.mkdir(path.join(cwd, "openspec", "schemas"), { recursive: true });
		await fs.cp(path.dirname(resources.specSchemaPath), path.join(cwd, "openspec", "schemas", "omp-spec"), {
			recursive: true,
		});
		await fs.writeFile(path.join(cwd, "openspec", "config.yaml"), "schema: omp-spec\n");
		const created = await runOpenSpec(["new", "change", "resource-probe", "--schema", "omp-spec"], cwd);
		expect(created.exitCode).toBe(0);
		const initial = await runOpenSpec(["status", "--change", "resource-probe", "--json"], cwd);
		expect(initial.exitCode).toBe(0);
		const status = JSON.parse(initial.stdout);
		expect(status.artifacts.map((artifact: { id: string }) => artifact.id).sort()).toEqual(["proposal", "specs"]);
		const proposal = await runOpenSpec(["instructions", "proposal", "--change", "resource-probe", "--json"], cwd);
		expect(proposal.exitCode).toBe(0);
		expect(JSON.parse(proposal.stdout).artifactId).toBe("proposal");
		await fs.writeFile(
			path.join(cwd, "openspec", "changes", "resource-probe", "proposal.md"),
			"## Why\nExpose offline resources.\n\n## What Changes\n- Bundle upstream resources.\n\n## Capabilities\n### New Capabilities\n- `offline-resources`: offline capabilities\n### Modified Capabilities\nNone.\n\n## Impact\nOMP packaging.\n",
		);
		const specs = await runOpenSpec(["instructions", "specs", "--change", "resource-probe", "--json"], cwd);
		expect(specs.exitCode).toBe(0);
		expect(JSON.parse(specs.stdout).artifactId).toBe("specs");
		const forbidden = await runOpenSpec(["instructions", "tasks", "--change", "resource-probe", "--json"], cwd);
		expect(forbidden.exitCode).not.toBe(0);
		expect(await Bun.file(path.join(cwd, "openspec/changes/resource-probe/tasks.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(cwd, "openspec/changes/resource-probe/design.md")).exists()).toBe(false);
		const invalid = await runOpenSpec(["status", "--change", "not-a-change", "--json"], cwd);
		expect(invalid.exitCode).not.toBe(0);
	});

	it("extracts a detached package and launches upstream without source workspaces or external dependencies", async () => {
		const detached = path.join(temporary, "detached-distribution");
		await extractArchive({ bytes: Buffer.from(archiveBase64, "base64"), format: "tar.gz" }, detached);
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
		expect(stdout.trim()).toBe("1.14.3");
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

	it("runs original scripts through the public source CLI and forwards real failures", async () => {
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
			bash.stderr.includes("Superpowers scripts require Bash and POSIX utilities (Git for Windows Bash on Windows)")
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
	});

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
