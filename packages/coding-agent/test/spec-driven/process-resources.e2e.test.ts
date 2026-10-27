import { describe, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { LegacyProtocol } from "../../src/modes/zcode/schema";
import inventory from "../../src/spec-driven/vendor/inventory.json";
import {
	fixture,
	GATE_BUDGET,
	git,
	isConversation,
	launch,
	PublicPeer,
	registerInvalidFileTests,
	run,
	test,
	textValues,
	workspace,
} from "./process-fixture";
import { registerPackagedSkillTest } from "./process-packaged-skills-fixture";
import {
	contentText,
	createProviderFixture,
	MARKER,
	type Reply,
	REQUIREMENT,
	respond,
	rolePayload,
} from "./provider-fixture";

describe("spec-driven actual OMP public entry", () => {
	test(
		"linked requirements cannot change business files and resume after the link is removed",
		async () => {
			await using root = await TempDir.create("@omp-dev-document-link-");
			let cwd = "";
			let linkedDirectory = "";
			let blockedWrite: Reply["tool"];
			let repairing = false;
			let repairDispatched = false;
			await using provider = createProviderFixture({
				async reply(request) {
					const role = rolePayload(request)?.specDrivenRole;
					if (repairing && role === "requirements") {
						if (!repairDispatched && blockedWrite) {
							repairDispatched = true;
							return { tool: blockedWrite };
						}
						return { text: "需求文档已在正常目录中补齐，请确认。" };
					}
					const reply = respond(request);
					const requested = reply.tool?.args.path;
					if (
						role === "requirements" &&
						typeof requested === "string" &&
						requested.endsWith("/spec.md") &&
						!blockedWrite
					) {
						blockedWrite = reply.tool;
						linkedDirectory = path.dirname(path.join(cwd, requested));
						await fs.mkdir(path.dirname(linkedDirectory), { recursive: true });
						await fs.symlink(
							path.join(cwd, "src"),
							linkedDirectory,
							process.platform === "win32" ? "junction" : "dir",
						);
					}
					return reply;
				},
			});
			const config = await fixture(root, provider.baseUrl);
			cwd = config.cwd;
			await fs.mkdir(path.join(cwd, "src"));
			const business = path.join(cwd, "src/spec.md");
			await fs.writeFile(business, "business bytes");
			await using peer = new PublicPeer(cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(cwd);
			await peer.send(session, "/dev");
			const since = await peer.send(session, `/dev new ${MARKER}: ${REQUIREMENT}`);
			const current = await peer.stage(session, "requirements", false);
			const stageId = current.spec.interaction?.recipient?.sessionId;
			if (!stageId) throw new Error("Native requirements session missing");
			await peer.settled(stageId, since);
			if (!blockedWrite || !linkedDirectory) throw new Error("Native specification write was not exercised");
			expect(await fs.readFile(business, "utf8")).toBe("business bytes");
			await peer.send(session, "/dev next", "failed");
			expect((await peer.stage(session, "requirements", false)).spec.interaction?.recipient?.sessionId).toBe(
				stageId,
			);
			await fs.rm(linkedDirectory, { recursive: true, force: true });
			repairing = true;
			const repairSince = await peer.send(session, "请在已移除链接的原路径补齐需求文档");
			await peer.settled(stageId, repairSince);
			const nextSince = await peer.send(session, "/dev next");
			const solution = await peer.stage(session, "solution", false);
			const solutionId = solution.spec.interaction?.recipient?.sessionId;
			if (!solutionId) throw new Error("Native solution session missing");
			await peer.settled(solutionId, nextSince);
			expect(await fs.readFile(business, "utf8")).toBe("business bytes");
			expect(provider.failures).toEqual([]);
			await peer.send(session, "/dev");
		},
		GATE_BUDGET,
	);

	registerInvalidFileTests(["solution", "planner"]);

	registerPackagedSkillTest(false);

	test(
		"packaged OpenSpec command expands quoted arguments through the actual OMP entry",
		async () => {
			await using root = await TempDir.create("@omp-openspec-command-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(config.cwd);
			const argumentsText = `${MARKER} proposal with spaces 中文需求`;
			const since = await peer.send(session, `/opsx-propose "${argumentsText}"`);
			await peer.next(
				frame =>
					isConversation(frame, session) && textValues(frame).some(text => text.includes(`${MARKER}_CHAT_READY`)),
				since,
			);
			const request = provider.requests.find(item =>
				item.messages.some(
					message => message.role === "user" && contentText(message.content).includes(argumentsText),
				),
			);
			if (!request) throw new Error("The companion command never reached the native model request");
			const input = request.messages
				.filter(message => message.role === "user")
				.map(message => contentText(message.content))
				.join("\n");
			expect(input).toContain(argumentsText);
			expect(rolePayload(request)).toBeUndefined();
			expect(provider.failures).toEqual([]);
			expect(await git(config.cwd, config.env, ["status", "--porcelain"])).toBe("");
		},
		GATE_BUDGET,
	);

	test(
		"public omp openspec init preserves project setup without installing skills or commands",
		async () => {
			await using root = await TempDir.create("@omp-openspec-init-");
			const config = await fixture(root, "http://127.0.0.1:1");
			const commands = path.join(config.cwd, ".omp/commands");
			await fs.mkdir(commands, { recursive: true });
			const custom = path.join(commands, "custom.md");
			await fs.writeFile(custom, "Keep my command.\n");
			const invoke = (args: string[]) => run(config.cwd, config.env, [...launch, "openspec", ...args]);
			const initialized = await invoke(["init", "--language", "Chinese"]);
			expect(initialized.exitCode).toBe(0);
			const configPath = path.join(config.cwd, "openspec/config.yaml");
			const contents = await fs.readFile(configPath, "utf8");
			expect(contents).toMatch(/^schema:\s*mini\s*$/m);
			expect(contents).toContain("Language: Chinese");
			for (const directory of ["specs", "changes/archive"])
				expect((await fs.stat(path.join(config.cwd, "openspec", directory))).isDirectory()).toBe(true);
			expect(await fs.readdir(path.join(config.cwd, ".omp"))).toEqual(["commands"]);
			expect(await fs.readdir(commands)).toEqual(["custom.md"]);
			const repeated = await invoke(["init", "--tools=oh-my-pi", "--", "."]);
			expect(repeated.exitCode).toBe(0);
			expect(await fs.readFile(configPath, "utf8")).toBe(contents);
			expect(await fs.readdir(path.join(config.cwd, ".omp"))).toEqual(["commands"]);
			expect(await fs.readdir(commands)).toEqual(["custom.md"]);
			expect(await fs.readFile(custom, "utf8")).toBe("Keep my command.\n");
		},
		GATE_BUDGET,
	);

	test(
		"implicit defaults and existing configurations preserve native schema selection",
		async () => {
			await using root = await TempDir.create("@omp-openspec-compat-");
			const config = await fixture(root, "http://127.0.0.1:1");
			const invoke = (args: string[]) => run(config.cwd, config.env, [...launch, "openspec", ...args]);
			expect((await invoke(["new", "change", "implicit"])).exitCode).toBe(0);
			const initial = await invoke(["status", "--change", "implicit", "--json"]);
			expect(JSON.parse(initial.stdout).schemaName).toBe("mini");
			const configPath = path.join(config.cwd, "openspec/config.yaml");
			expect(await fs.readFile(configPath, "utf8")).toMatch(/^schema:\s*mini\s*$/m);
			expect((await invoke(["new", "change", "implicit-second"])).exitCode).toBe(0);
			const second = await invoke(["status", "--change", "implicit-second", "--json"]);
			expect(JSON.parse(second.stdout).schemaName).toBe("mini");
			const oldConfig = "schema: spec-driven\n";
			await fs.writeFile(configPath, oldConfig);
			expect((await invoke(["init"])).exitCode).toBe(0);
			expect(await fs.readFile(configPath, "utf8")).toBe(oldConfig);
			expect((await invoke(["new", "change", "configured"])).exitCode).toBe(0);
			const configured = await invoke(["status", "--change", "configured", "--json"]);
			expect(JSON.parse(configured.stdout).schemaName).toBe("spec-driven");
			const unchanged = await invoke(["status", "--change", "implicit", "--json"]);
			expect(JSON.parse(unchanged.stdout).schemaName).toBe("mini");
		},
		GATE_BUDGET,
	);

	test(
		"detached public omp openspec dispatch supplies native commands, schema and instructions",
		async () => {
			await using root = await TempDir.create("@omp-openspec-distribution-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			const invoke = async (args: string[]) => run(config.cwd, config.env, [...launch, "openspec", ...args]);
			const help = await invoke(["--help"]);
			expect(help.exitCode).toBe(0);
			for (const command of [
				"init",
				"list",
				"view",
				"show",
				"change",
				"spec",
				"new",
				"status",
				"instructions",
				"schema",
				"validate",
				"archive",
			])
				expect(help.stdout).toContain(command);
			const version = await invoke(["--version"]);
			expect(version.exitCode).toBe(0);
			expect(version.stdout).toContain(inventory.openspec.version);
			let resourceRoot: string;
			{
				// Locate the distribution through its public skill catalog, not the source resource loader.
				await using peer = new PublicPeer(config.cwd, config.env, provider);
				await peer.ready();
				const session = await peer.create(config.cwd);
				const catalog = LegacyProtocol.zcodeSkillsReferenceCatalogResultSchema.parse(
					await peer.request("skills/referenceCatalog", { workspace: workspace(config.cwd), sessionId: session }),
				);
				const entry = catalog.skills.find(skill => skill.name === "openspec-propose");
				if (!entry) throw new Error("Packaged OpenSpec skill unavailable through public catalog");
				resourceRoot = path.resolve(entry.path, "../../../..");
				expect((await fs.realpath(resourceRoot)).startsWith(await fs.realpath(config.root))).toBe(true);
			}
			const catalogRequestCount = provider.requests.length;
			expect((await invoke(["init"])).exitCode).toBe(0);
			const created = await invoke(["new", "change", "distribution-check"]);
			expect(created.exitCode).toBe(0);
			const status = await invoke(["status", "--change", "distribution-check", "--json"]);
			expect(status.exitCode).toBe(0);
			const state = JSON.parse(status.stdout) as { schemaName: string; artifacts: Array<{ id: string }> };
			expect(state.schemaName).toBe("mini");
			expect(state.artifacts.map(artifact => artifact.id).sort()).toEqual(["proposal", "specs"]);
			for (const artifact of ["proposal", "specs"]) {
				const instruction = await invoke(["instructions", artifact, "--change", "distribution-check", "--json"]);
				expect(instruction.exitCode).toBe(0);
				const value: unknown = JSON.parse(instruction.stdout);
				expect(isRecord(value)).toBe(true);
				expect(JSON.stringify(value)).toContain(artifact);
				expect(JSON.stringify(value)).toContain("template");
			}
			const schemas = await invoke(["schema", "which", "mini", "--json"]);
			expect(schemas.exitCode).toBe(0);
			const resolved = JSON.parse(schemas.stdout) as { source: string; path: string };
			expect(resolved.source).toBe("package");
			expect(path.relative(resourceRoot, resolved.path).startsWith("..")).toBe(false);
			const invalid = await invoke(["validate", "distribution-check", "--json"]);
			expect(invalid.exitCode).not.toBe(0);
			const change = path.join(config.cwd, "openspec/changes/distribution-check");
			await fs.writeFile(
				path.join(change, "proposal.md"),
				"## Why\nExercise packaged CLI.\n\n## What Changes\nAdd greeting.\n\n## Capabilities\n### New Capabilities\n- greeting: greeting behavior\n\n## Impact\nFixture only.\n",
			);
			await fs.mkdir(path.join(change, "specs/greeting"), { recursive: true });
			await fs.writeFile(
				path.join(change, "specs/greeting/spec.md"),
				"## Purpose\nDescribe greeting behavior for users and downstream systems in the fixture.\n\n## ADDED Requirements\n\n### Requirement: Greeting\nThe system SHALL return a greeting.\n\n#### Scenario: Greeting requested\n- **WHEN** greeting is requested\n- **THEN** return a greeting\n",
			);
			const valid = await invoke(["validate", "distribution-check", "--json"]);
			expect(valid.exitCode).toBe(0);
			expect(valid.stdout).toContain("true");
			const complete = await invoke(["status", "--change", "distribution-check", "--json"]);
			expect(JSON.parse(complete.stdout).isComplete).toBe(true);
			expect(
				await fs.stat(path.join(change, "design.md")).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(
				await fs.stat(path.join(change, "tasks.md")).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect((await invoke(["archive", "distribution-check", "--yes"])).exitCode).toBe(0);
			const synced = await fs.readFile(path.join(config.cwd, "openspec/specs/greeting/spec.md"), "utf8");
			expect(synced).toContain("### Requirement: Greeting");
			const archive = await fs.readdir(path.join(config.cwd, "openspec/changes/archive"));
			expect(archive.some(name => name.endsWith("-distribution-check"))).toBe(true);
			expect((await invoke(["new", "change", "legacy-explicit", "--schema", "spec-driven"])).exitCode).toBe(0);
			const legacy = await invoke(["status", "--change", "legacy-explicit", "--json"]);
			expect(
				JSON.parse(legacy.stdout)
					.artifacts.map((item: { id: string }) => item.id)
					.sort(),
			).toEqual(["design", "proposal", "specs", "tasks"]);
			expect(provider.requests).toHaveLength(catalogRequestCount);
		},
		GATE_BUDGET,
	);
});
