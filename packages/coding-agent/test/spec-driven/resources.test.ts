import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import {
	ensureSpecDrivenResources,
	loadSpecDrivenSkill,
	resolveSpecDrivenResourcePath,
	runOpenSpec,
	runSuperpowersScript,
} from "../../src/spec-driven/resources";

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
		expect(resources.manifest.openspec.version).toBe("1.15.0");
		expect(resources.manifest.superpowers.revision).toBe("2ce8aa15d05bd57213e6f746f953aafb7ded7a8b");
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
			const bytes = await fs.readFile(filePath);
			expect(bytes.length).toBeGreaterThan(0);
			expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(file!.sha256);
			expect(path.relative(skill.containRoot!, filePath).startsWith("..")).toBe(false);
		}
	});

	it("rejects legacy aliases and unknown OpenSpec skill identities", async () => {
		for (const name of ["opsx-verify", "opsx-new", "opsx-continue", "../openspec-new-change"]) {
			await expect(loadSpecDrivenSkill("openspec", name)).rejects.toThrow("Unknown bundled openspec skill");
		}
	});

	it("initializes the native default schema without tool integrations when requested", async () => {
		const project = path.join(temporary, "native-init");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		expect((await cli(["init", "--tools", "none"])).exitCode).toBe(0);
		const config = await fs.readFile(path.join(project, "openspec", "config.yaml"), "utf8");
		expect(config).toMatch(/^schema:\s*spec-driven\s*$/m);
		for (const directory of ["specs", "changes", "changes/archive"]) {
			expect((await fs.stat(path.join(project, "openspec", directory))).isDirectory()).toBe(true);
		}
		expect((await fs.readdir(project)).sort()).toEqual([".consumer-home", "openspec"]);
	}, 30_000);

	it("defaults the public wrapper to the mini graph and keeps native archive validation", async () => {
		const project = path.join(temporary, "mini-wrapper");
		await fs.mkdir(project);
		const cli = (args: string[]) => runOpenSpec(args, project);
		expect((await cli(["init"])).exitCode).toBe(0);
		expect((await cli(["schema", "validate", "mini", "--json"])).exitCode).toBe(0);
		expect((await cli(["new", "change", "mini-change"])).exitCode).toBe(0);
		const change = path.join(project, "openspec", "changes", "mini-change");
		const initial = JSON.parse((await cli(["status", "--change", "mini-change", "--json"])).stdout);
		expect(initial.schemaName).toBe("mini");
		expect(initial.artifacts.map((entry: { id: string }) => entry.id).sort()).toEqual(["proposal", "specs"]);
		for (const artifact of ["proposal", "specs"]) {
			const instructions = await cli(["instructions", artifact, "--change", "mini-change", "--json"]);
			expect(instructions.exitCode).toBe(0);
			expect(JSON.parse(instructions.stdout).artifactId).toBe(artifact);
		}
		await fs.writeFile(path.join(change, "proposal.md"), proposalContent);
		const specDir = path.join(change, "specs", "offline-resources");
		await fs.mkdir(specDir, { recursive: true });
		await fs.writeFile(path.join(specDir, "spec.md"), deltaContent.slice(0, deltaContent.indexOf("#### Scenario:")));
		expect((await cli(["archive", "mini-change", "--yes"])).exitCode).not.toBe(0);
		expect(await Bun.file(path.join(change, "proposal.md")).exists()).toBe(true);
		await fs.writeFile(path.join(specDir, "spec.md"), deltaContent);
		expect((await cli(["validate", "mini-change", "--strict", "--json"])).exitCode).toBe(0);
		expect(JSON.parse((await cli(["status", "--change", "mini-change", "--json"])).stdout).isComplete).toBe(true);
		expect((await cli(["archive", "mini-change", "--yes"])).exitCode).toBe(0);
		const spec = await fs.readFile(path.join(project, "openspec", "specs", "offline-resources", "spec.md"), "utf8");
		expect(spec).toContain("#### Scenario: Read requirements offline");
	}, 60_000);

	it("installs and updates native tool integrations", async () => {
		const project = path.join(temporary, "native-tool-integration");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		expect((await cli(["init", "--tools", "claude", "--profile", "core"])).exitCode).toBe(0);
		const applySkill = path.join(project, ".claude", "skills", "openspec-apply-change", "SKILL.md");
		expect(await Bun.file(applySkill).exists()).toBe(true);
		expect((await cli(["update"])).exitCode).toBe(0);
		expect(await Bun.file(applySkill).exists()).toBe(true);
	}, 30_000);

	it("uses the native four-artifact default schema through planning and archive", async () => {
		const project = path.join(temporary, "native-default");
		await fs.mkdir(project);
		const cli = await isolatedOpenSpec(project);
		expect((await cli(["init", "--tools", "none"])).exitCode).toBe(0);
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
		expect((await cli(["init", "--tools", "none"])).exitCode).toBe(0);
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

	it("resolves the bundled Dev schema and rejects a project override", async () => {
		const cwd = path.join(temporary, "dev-schema");
		const home = path.join(cwd, ".consumer-home");
		await fs.mkdir(cwd);
		const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/spec-driven/resources.ts")).href;
		const script = `
			const { assertDevSpecSchema, ensureSpecDrivenResources, runOpenSpec } = await import(${JSON.stringify(moduleUrl)});
			const result = await runOpenSpec(["schema", "which", "omp-spec", "--json"], process.cwd());
			let error = null;
			try { await assertDevSpecSchema(process.cwd()); } catch (e) { error = String(e); }
			console.log(JSON.stringify({ result, error, schemaPath: (await ensureSpecDrivenResources()).specSchemaPath }));
		`;
		async function resolve() {
			const child = Bun.spawn([process.execPath, "--eval", script], {
				cwd,
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
			if (exitCode !== 0) throw new Error(stderr);
			return JSON.parse(stdout);
		}

		const bundled = await resolve();
		expect(bundled.result.exitCode).toBe(0);
		const resolution = JSON.parse(bundled.result.stdout);
		expect(resolution.source).toBe("package");
		expect(await fs.realpath(resolution.path)).toBe(await fs.realpath(path.dirname(bundled.schemaPath)));
		expect(bundled.error).toBeNull();

		const override = path.join(cwd, "openspec", "schemas", "omp-spec");
		await fs.mkdir(path.dirname(override), { recursive: true });
		await fs.cp(path.dirname(bundled.schemaPath), override, { recursive: true });
		const shadowed = await resolve();
		expect(shadowed.result.exitCode).toBe(0);
		expect(JSON.parse(shadowed.result.stdout).source).toBe("project");
		expect(shadowed.error).toContain("an external schema shadows it");
	}, 30_000);

	it("uses the real CLI for requirements-only status and proposal/spec instructions", async () => {
		const resources = await ensureSpecDrivenResources();
		const cwd = path.join(temporary, "real-project");
		await fs.mkdir(path.join(cwd, "openspec", "schemas"), { recursive: true });
		await fs.cp(path.dirname(resources.specSchemaPath), path.join(cwd, "openspec", "schemas", "omp-spec"), {
			recursive: true,
		});
		const userContext = "Literal user data: openspec new change user-data";
		await fs.writeFile(
			path.join(cwd, "openspec", "config.yaml"),
			`schema: omp-spec\ncontext: ${JSON.stringify(userContext)}\n`,
		);
		const created = await runOpenSpec(["new", "change", "resource-probe", "--schema", "omp-spec"], cwd);
		expect(created.exitCode).toBe(0);
		const initial = await runOpenSpec(["status", "--change", "resource-probe", "--json"], cwd);
		expect(initial.exitCode).toBe(0);
		const status = JSON.parse(initial.stdout);
		expect(status.artifacts.map((artifact: { id: string }) => artifact.id).sort()).toEqual(["proposal", "specs"]);
		const proposal = await runOpenSpec(["instructions", "proposal", "--change", "resource-probe", "--json"], cwd);
		expect(proposal.exitCode).toBe(0);
		expect(JSON.parse(proposal.stdout).artifactId).toBe("proposal");
		expect(JSON.parse(proposal.stdout).context).toBe(userContext);
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
		expect(stdout.trim()).toBe("1.15.0");
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
