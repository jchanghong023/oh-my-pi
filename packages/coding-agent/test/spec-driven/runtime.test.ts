import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@oh-my-pi/omptype/typebox";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { createAssistantMessageEventStream, resolveApiKeyOnce } from "@oh-my-pi/pi-ai";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord, parseImageMetadata } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { ModelRegistry } from "../../src/config/model-registry";
import {
	createDevWorkflowRuntime,
	assertDevFrozenAuthority,
	type DevWorkflowBinding,
	type DevWorkflowPreparation,
	type DevWorkflowRuntime,
} from "../../src/dev-workbench/workflow-runtime";
import { buildRequirementSnapshot, sha256 } from "../../src/dev-workbench/requirement-package";
import { DevWorkflowGit } from "../../src/dev-workbench/workflow-git";
import {
	DEV_WORKFLOW_STAGES,
	type DevNativeSessionRef,
	type DevRequirementContent,
} from "../../src/dev-workbench/workflow-types";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { hasExplicitRepairIntent } from "../../src/spec-driven/actors";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { ToolRestrictions } from "../../src/session/tool-restrictions";
import { createAgentSession } from "../../src/sdk";
import { cfgTaskIsolationEnabled, cfgTaskMaxRecursionDepth, cfgTaskSpeculativeLaunch } from "../../src/task/settings";
import { cfgAsyncEnabled } from "../../src/tools/settings";
import { cfgTeamMembers } from "../../src/team/settings";
import { buildRunnerDeps, resolveTeamParticipantsForSession } from "../../src/team/controller";
import { runTeamDiscussion } from "../../src/team/orchestrator";
import { createTeamSubagentRunner } from "../../src/team/runner";
import {
	contentText,
	createProviderFixture,
	respond,
	teamStage,
	type ModelRequest,
	type Reply,
} from "./provider-fixture";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { READONLY_TOOLS_MODE, TOOL_RESULT } from "../fixtures/instructions-mcp";
import { createWorkflowStage, successfulWorkflowReply } from "./tui-materials-cases";
import { workflowGit, workflowNativeContext } from "../dev-workbench/workflow-fixture";

const exec = promisify(execFile);
const projectId = "project-a";
const irId = "ir-a";
const srId = "sr-a";
const requirementRoot = `docs/dev/requirements/${irId}`;

test("native repair authorization distinguishes explicit execution from discussion", () => {
	for (const text of ["Please fix the failing check", "请修复当前实现", "修复错误，不要修改已批准材料"])
		expect(hasExplicitRepairIntent(text)).toBe(true);
	for (const text of [
		"Could you fix this?",
		"先解释如何修复",
		"不要修复",
		"Explain only",
		"We should discuss the repair",
	])
		expect(hasExplicitRepairIntent(text)).toBe(false);
});
function document(title: string, detail: string) {
	return `# ${title}\n\n## Scenarios\n${detail}\n\n## Rules and boundaries\nOnly confirmed orders; no payment changes.\n\n## Acceptance\nAll stated scenarios preserve exact approved behavior Ω.\n`;
}

async function consumer(
	providerOptions: Parameters<typeof createProviderFixture>[0] = {},
	setup?: (cwd: string) => Promise<void>,
	rootOptions: Partial<Parameters<typeof createAgentSession>[0]> = {},
	runtimeOptions: Partial<
		Pick<Parameters<typeof createDevWorkflowRuntime>[0], "assertCurrent" | "createInteractionUI">
	> = {},
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dev-workflow-consumer-"));
	const cwd = path.join(directory, "repo");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir);
	const provider = createProviderFixture({
		reply: () => ({ text: "Native conversation completed." }),
		...providerOptions,
	});
	const authStorage = await AuthStorage.create(":memory:");
	let root: AgentSession | undefined;
	let runtime: DevWorkflowRuntime | undefined;
	let registry: ModelRegistry | undefined;
	const dispose = async () => {
		try {
			await runtime?.dispose();
			await root?.dispose();
		} finally {
			await registry?.awaitBackgroundRefresh();
			authStorage.close();
			await provider[Symbol.asyncDispose]();
			HistoryStorage.close();
			closeSessionIndex();
			AgentStorage.close();
			closeModelCache();
			await fs.rm(directory, { recursive: true, force: true });
		}
	};
	try {
		await exec("git", ["init", "--initial-branch=main"], { cwd });
		await exec(
			"git",
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"--allow-empty",
				"-m",
				"Initialize native fixture",
			],
			{ cwd },
		);
		await setup?.(cwd);
		const content: DevRequirementContent = {
			title: "Order approval",
			document: {
				path: `${requirementRoot}/ir.md`,
				content: document("Order approval", "Keep the complete IR, including its final line."),
			},
			srs: [
				{
					id: srId,
					title: "Approve orders",
					document: {
						path: `${requirementRoot}/${srId}.md`,
						content: document("Approve orders", "The current SR approval behavior."),
					},
				},
				{
					id: "sr-b",
					title: "Audit approvals",
					document: {
						path: `${requirementRoot}/sr-b.md`,
						content: document("Audit approvals", "A sibling SR must remain frozen too."),
					},
				},
			],
			attachments: [
				{ path: `${requirementRoot}/notes.txt`, content: "Complete attachment Ω\nlast attachment line\n" },
			],
		};
		const snapshot = buildRequirementSnapshot(projectId, irId, content);
		const files = [content.document, ...content.srs.map(sr => sr.document), ...content.attachments].map(file => {
			if (typeof file.content !== "string") throw new Error("Native fixture uses text attachments");
			return { path: file.path, content: file.content, digest: sha256(file.content) };
		});
		for (const file of files) {
			await fs.mkdir(path.dirname(path.join(cwd, file.path)), { recursive: true });
			await fs.writeFile(path.join(cwd, file.path), file.content);
		}
		const authority = { digest: snapshot.digest, files, roots: [requirementRoot] };
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			`providers:\n  deepseek:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        input: [text, image]\n        contextWindow: 1000000\n      - id: chat-b\n        reasoning: false\n        input: [text, image]\n        contextWindow: 1000000\n`,
		);
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir,
			inMemory: true,
			overrides: {
				modelRoles: { default: "deepseek/chat-a", smol: "deepseek/chat-a" },
				"compaction.enabled": false,
				"prewalk.enabled": false,
				"tools.xdev": false,
				"async.enabled": false,
				"eval.js": true,
				"todo.enabled": false,
				"mcp.startupTimeoutMs": 0,
			},
		});
		registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
		const model = registry.find("deepseek", "chat-a");
		if (!model) throw new Error("Local native workflow fixture model unavailable");
		({ session: root } = await createAgentSession({
			cwd,
			agentDir,
			settings,
			model,
			authStorage,
			modelRegistry: registry,
			sessionManager: await SessionManager.open(
				path.join(directory, "sessions", "root.jsonl"),
				path.join(directory, "sessions"),
				undefined,
				{ initialCwd: cwd },
			),
			contextFiles: [],
			rules: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			autoTitle: false,
			offline: true,
			bindProcessState: false,
			...rootOptions,
		}));
		const args = {
			projectId,
			rootSession: root,
			settings,
			cwd,
			assertCurrent: async (binding: DevWorkflowBinding) => {
				if (binding.projectId !== projectId) throw new Error("Fixture admission project mismatch");
			},
			...runtimeOptions,
		};
		runtime = await createDevWorkflowRuntime(args);
		const preparation = (
			phase: DevWorkflowBinding["phase"],
			extra: Partial<DevWorkflowPreparation> = {},
		): DevWorkflowPreparation => ({
			binding: { projectId, irId, ...(phase === "requirements" ? {} : { srId }), phase, round: 1 },
			outputPaths: [
				phase === "requirements"
					? "draft.json"
					: `docs/dev/development/${srId}/${phase === "executing" ? "completion" : phase}.md`,
			],
			...(phase === "requirements" ? {} : { authority }),
			...extra,
		});
		return {
			cwd,
			directory,
			agentDir,
			settings,
			root,
			registry,
			provider,
			content,
			snapshot,
			files,
			authority,
			preparation,
			get runtime() {
				return runtime!;
			},
			async reopen() {
				await runtime!.dispose();
				runtime = await createDevWorkflowRuntime(args);
				return runtime;
			},
			prepare: (phase: DevWorkflowBinding["phase"], extra?: Partial<DevWorkflowPreparation>) =>
				runtime!.prepare(preparation(phase, extra)),
			[Symbol.asyncDispose]: dispose,
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

function hasUser(request: ModelRequest, text: string) {
	return request.messages.some(message => message.role === "user" && contentText(message.content).includes(text));
}
function assignment(request: ModelRequest, marker: string) {
	return hasUser(request, `Complete assignment thoroughly:\n\n${marker}`);
}
function task(marker: string, agent = "task"): Reply {
	return {
		tool: {
			name: "task",
			args: {
				i: "Delegating native work",
				context: "Use the current SR worktree and retain all native constraints.",
				tasks: [{ agent, task: marker, solutionSpace: "complete the assigned native probe" }],
			},
		},
	};
}
function toolNames(request: ModelRequest) {
	return (request.tools ?? []).map(tool => tool.function?.name.replace(/^_/u, ""));
}

test("four-stage facade preparation is persistent, idempotent and model-free with exact object bindings", async () => {
	await using fixture = await consumer();
	const refs: DevNativeSessionRef[] = [];
	for (const phase of ["requirements", ...DEV_WORKFLOW_STAGES] as const) {
		const ref = await fixture.prepare(phase);
		refs.push(ref);
		expect(await fixture.prepare(phase)).toEqual(ref);
		expect(ref).toMatchObject({ projectId, irId, phase, round: 1 });
		expect(ref.role).toBe(phase);
		expect(ref.srId).toBe(phase === "requirements" ? undefined : srId);
		expect(fixture.runtime.session(ref).sessionFile).toBe(ref.sessionFile);
		expect(await fs.stat(ref.sessionFile)).toMatchObject({});
	}
	expect(new Set(refs.map(ref => ref.sessionId)).size).toBe(5);
	expect(fixture.runtime.references()).toEqual(refs);
	expect(fixture.provider.requests).toHaveLength(0);
	const nextRound = await fixture.prepare("planning", {
		binding: { projectId, irId, srId, phase: "planning", round: 2 },
	});
	expect(nextRound.sessionId).not.toBe(refs[2]!.sessionId);
	const sibling = await fixture.prepare("planning", {
		binding: { projectId, irId, srId: "sr-b", phase: "planning", round: 1 },
	});
	expect(sibling.sessionId).not.toBe(refs[2]!.sessionId);
	await expect(fixture.runtime.submit({ ...refs[0]!, irId: "other-ir" }, "misrouted")).rejects.toThrow();
	await expect(fixture.runtime.submit({ ...refs[0]!, round: 2 }, "late round")).rejects.toThrow();
	expect(fixture.provider.requests).toHaveLength(0);
}, 120_000);

test("published and Git-merged requirements admit their own native SR with exact whole-group evidence in every technical role", async () => {
	const h = await createWorkflowStage("pr", {
		setup: async fixture => {
			await workflowGit(fixture.project, ["config", "--local", "core.autocrlf", "true"], fixture.env);
		},
		reply: request => {
			const reply = successfulWorkflowReply(request);
			const context = workflowNativeContext(request);
			if (
				context?.role === "requirements" &&
				reply.tool?.name.replace(/^_/u, "") === "write" &&
				typeof reply.tool.args.content === "string"
			) {
				const content = JSON.parse(reply.tool.args.content) as DevRequirementContent;
				const root = path.posix.dirname(content.document.path);
				content.srs.push({
					id: "sibling-sr",
					title: "Greeting audit",
					document: {
						path: `${root}/srs/audit.md`,
						content: document("Greeting audit", "Retain sibling acceptance."),
					},
				});
				content.attachments.push({
					path: `${root}/attachments/decisions.txt`,
					content: "Complete confirmed greeting decisions Ω\nRetain the final attachment line.\n",
				});
				reply.tool.args.content = JSON.stringify(content);
			}
			return reply;
		},
	});
	await using fixture = h.fixture;
	const group = h.view.groups.find(item => item.id === h.irId)!;
	const sr = h.view.srs.find(item => item.id === h.srId)!;
	expect(group.status).toBe("frozen");
	expect(group.merge).toBeDefined();
	expect(sr.worktree!.path).not.toBe(group.worktree!.path);
	expect(group.snapshot!.srs).toHaveLength(2);
	expect(group.evidenceFiles!.length).toBeGreaterThan(0);
	const versions = [...group.snapshot!.files, ...group.evidenceFiles!];
	for (const phase of DEV_WORKFLOW_STAGES) {
		const contexts = fixture.provider.requests
			.map(workflowNativeContext)
			.filter(context => (context?.binding as DevWorkflowBinding | undefined)?.phase === phase);
		expect(contexts.length).toBeGreaterThan(0);
		for (const context of contexts) {
			const authority = context!.authority as {
				digest: string;
				files: { path: string; content: string; digest: string }[];
			};
			expect(authority.digest).toBe(group.snapshot!.digest);
			expect(authority.files.map(file => file.path).sort()).toEqual(versions.map(file => file.path).sort());
			for (const file of authority.files) {
				const version = versions.find(version => version.path === file.path)!;
				expect(sha256(file.content)).toBe(version.sha256);
				const bytes = await fs.readFile(path.join(sr.worktree!.path, file.path));
				expect(sha256(bytes)).toBe(file.digest);
				expect(bytes.byteLength).toBe(version.size);
				expect(Buffer.from(file.content)).toEqual(bytes);
			}
		}
	}
	expect(await fs.readFile(path.join(fixture.project, "user-file.txt"), "utf8")).toBe("retain user bytes\n");
	expect(await fs.readFile(path.join(sr.worktree!.path, "user-file.txt"), "utf8")).toBe("retain user bytes\r\n");
	expect(await workflowGit(fixture.project, ["config", "--local", "--get", "core.autocrlf"], fixture.env)).toBe(
		"true",
	);
}, 240_000);

test("native preparation preserves filesystem Buffer views and binary attachment bytes across every technical role", async () => {
	await using fixture = await consumer();
	const binary = { path: `${requirementRoot}/attachment.bin`, content: new Uint8Array([0, 255, 13, 10, 128, 42]) };
	const bom = {
		path: `${requirementRoot}/unicode.txt`,
		content: "\uFEFFComplete BOM-prefixed attachment Ω\r\nlast line\r\n",
	};
	const content = { ...fixture.content, attachments: [...fixture.content.attachments, binary, bom] };
	const snapshot = buildRequirementSnapshot(projectId, irId, content);
	await fs.writeFile(path.join(fixture.cwd, binary.path), binary.content);
	await fs.writeFile(path.join(fixture.cwd, bom.path), bom.content);
	const files = await Promise.all(
		snapshot.files.map(async file => ({
			path: file.path,
			content: await fs.readFile(path.join(fixture.cwd, file.path)),
			digest: file.sha256,
		})),
	);
	const evidence = { path: "docs/dev/reviews/ir-a/confirmed.json", content: '{"exact":"review Ω"}\n' };
	await fs.mkdir(path.dirname(path.join(fixture.cwd, evidence.path)), { recursive: true });
	await fs.writeFile(path.join(fixture.cwd, evidence.path), evidence.content);
	const authority = {
		digest: snapshot.digest,
		files: [
			...files,
			{
				...evidence,
				content: await fs.readFile(path.join(fixture.cwd, evidence.path)),
				digest: sha256(evidence.content),
			},
		],
		roots: [requirementRoot, evidence.path],
	};
	for (const phase of DEV_WORKFLOW_STAGES) {
		const ref = await fixture.prepare(phase, { authority });
		await fixture.runtime.assertAuthority(ref);
		await fixture.runtime.submit(ref, `Read the complete fixed ${phase} authority without changing files.`);
		const context = workflowNativeContext(fixture.provider.requests.at(-1)!)!;
		const frozen = context.authority as {
			files: { path: string; content?: string; digest: string; size?: number; binary?: boolean }[];
		};
		expect(frozen.files.map(file => file.path).sort()).toEqual(authority.files.map(file => file.path).sort());
		for (const file of frozen.files) {
			const expected = authority.files.find(expected => expected.path === file.path)!;
			if (file.path === binary.path) {
				expect(file).toMatchObject({
					binary: true,
					size: binary.content.byteLength,
					digest: sha256(binary.content),
				});
				expect(await fs.readFile(path.join(fixture.cwd, file.path))).toEqual(Buffer.from(binary.content));
			} else expect(Buffer.from(file.content!)).toEqual(expected.content);
		}
	}
}, 120_000);

test("native admission rejects corrupt snapshot bytes, divergent checkouts and extra frozen members without repair", async () => {
	await using fixture = await consumer();
	const files = await Promise.all(
		fixture.files.map(async file => ({ ...file, content: await fs.readFile(path.join(fixture.cwd, file.path)) })),
	);
	const authority = { ...fixture.authority, files };
	const invalid = structuredClone(authority);
	invalid.files[0]!.content[0] ^= 1;
	await expect(fixture.prepare("solution", { authority: invalid })).rejects.toThrow("Invalid frozen snapshot");
	const target = path.join(fixture.cwd, files[0]!.path);
	const divergent = Buffer.from("Actual default checkout diverged; do not overwrite.\n");
	await fs.writeFile(target, divergent);
	await expect(fixture.prepare("solution", { authority })).rejects.toThrow("Frozen requirement changed");
	expect(await fs.readFile(target)).toEqual(divergent);
	await fs.writeFile(target, files[0]!.content);
	const extra = path.join(fixture.cwd, requirementRoot, "unconfirmed.txt");
	await fs.writeFile(extra, "not in the confirmed group\n");
	await expect(fixture.prepare("solution", { authority })).rejects.toThrow("Unexpected frozen requirement member");
	expect(await fs.readFile(extra, "utf8")).toBe("not in the confirmed group\n");
	expect(fixture.runtime.references()).toEqual([]);
	expect(fixture.provider.requests).toHaveLength(0);
}, 120_000);

test("frozen worktree materialization never repairs retries or substantively divergent latest-default blobs", async () => {
	await using fixture = await consumer({}, async cwd => {
		await workflowGit(cwd, ["config", "--local", "core.autocrlf", "false"]);
	});
	await fs.writeFile(path.join(fixture.cwd, ".gitignore"), ".omp/\n");
	await workflowGit(fixture.cwd, ["add", "--", ".gitignore", ...fixture.snapshot.files.map(file => file.path)]);
	await workflowGit(fixture.cwd, ["commit", "-m", "Publish exact frozen group"]);
	const remote = path.join(fixture.directory, "remote.git");
	await workflowGit(fixture.directory, ["init", "--bare", "--initial-branch=main", remote]);
	await workflowGit(fixture.cwd, ["remote", "add", "origin", remote]);
	await workflowGit(fixture.cwd, ["push", "-u", "origin", "main"]);
	await workflowGit(fixture.cwd, ["remote", "set-head", "origin", "main"]);
	const git = new DevWorkflowGit();
	const project = {
		...(await git.inspect(fixture.cwd)),
		id: projectId,
		name: "Frozen source regression",
		revision: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	const frozen = { snapshot: fixture.snapshot };
	const operationId = crypto.randomUUID();
	const owned = await git.createWorktree(project, "development", srId, operationId, frozen);
	await assertDevFrozenAuthority(owned.path, fixture.authority);
	const changed = "Substantive user change; never normalize over these bytes.\n";
	const ownedFile = path.join(owned.path, fixture.content.document.path);
	await fs.writeFile(ownedFile, changed);
	await expect(git.createWorktree(project, "development", srId, operationId, frozen)).rejects.toThrow(
		"Frozen requirement changed",
	);
	expect(await fs.readFile(ownedFile, "utf8")).toBe(changed);
	await expect(assertDevFrozenAuthority(owned.path, fixture.authority)).rejects.toThrow("Frozen requirement changed");
	const defaultFile = path.join(fixture.cwd, fixture.content.document.path);
	await fs.writeFile(defaultFile, changed);
	await workflowGit(fixture.cwd, ["add", "--", fixture.content.document.path]);
	await workflowGit(fixture.cwd, ["commit", "-m", "Real later default requirement divergence"]);
	await workflowGit(fixture.cwd, ["push", "origin", "main"]);
	await expect(
		git.createWorktree(project, "development", "sr-after-default-change", crypto.randomUUID(), frozen),
	).rejects.toThrow("Committed material version mismatch");
	expect(await fs.readFile(defaultFile, "utf8")).toBe(changed);
	expect(
		await fs.readFile(
			path.join(
				project.commonDir,
				"omp-dev-worktrees/development/sr-after-default-change",
				fixture.content.document.path,
			),
			"utf8",
		),
	).toBe(changed);
}, 120_000);

test("complete fixed material bytes, versions and human decisions enter native context without replacing raw conversation", async () => {
	await using fixture = await consumer();
	const contextFiles = [
		{ path: "docs/decisions.md", content: "# Complete decision material\nfirst line\n最后一行 Ω\n" },
	];
	const decisions = {
		operationId: "approved-exact-version",
		snapshotDigest: fixture.snapshot.digest,
		reply: " 原文确认\n不替换正文 ",
	};
	const ref = await fixture.prepare("planning", { contextFiles, decisions });
	const raw = "  原始任务\n保留完整正文和空格 Ω  ";
	await fixture.runtime.submit(ref, raw);
	await fixture.runtime.submit(ref, "  普通追问\n不重发材料  ");
	const session = fixture.runtime.session(ref);
	const users = session.messages
		.filter(message => message.role === "user")
		.map(message => contentText(message.content));
	expect(users).toContain(raw);
	expect(users).toContain("  普通追问\n不重发材料  ");
	const context = session.messages.filter(
		message => message.role === "custom" && message.customType === "dev-workflow-context",
	);
	expect(context).toHaveLength(1);
	const contextMessage = context[0];
	if (contextMessage?.role !== "custom") throw new Error("Native workflow context is missing");
	const nativeContext = JSON.parse(contentText(contextMessage.content)) as {
		authority: { files: typeof fixture.files };
		contextFiles: typeof contextFiles;
		decisions: typeof decisions;
	};
	expect(nativeContext.authority.files).toEqual(fixture.files);
	expect(nativeContext.contextFiles).toContainEqual(contextFiles[0]);
	expect(nativeContext.decisions).toEqual(decisions);
	expect(JSON.stringify(ref)).not.toContain(raw);
	expect(await fs.readFile(ref.sessionFile, "utf8")).toContain(JSON.stringify(raw).slice(1, -1));
	expect(fixture.runtime.session(ref)).toBe(session);
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);

test("exact native histories restore without model turns and retain their selected model", async () => {
	await using fixture = await consumer();
	const ref = await fixture.prepare("planning");
	const native = fixture.runtime.session(ref);
	const selected = native.modelRegistry.find("deepseek", "chat-b")!;
	await native.setModel(selected);
	await fixture.runtime.submit(ref, "native history Ω");
	const count = fixture.provider.requests.length;
	await fixture.reopen();
	const restored = await fixture.prepare("planning", { sessionRef: ref });
	expect(restored).toEqual(ref);
	expect(fixture.runtime.session(restored).model?.id).toBe("chat-b");
	expect(fixture.provider.requests).toHaveLength(count);
	expect(JSON.stringify(fixture.runtime.session(restored).messages)).toContain("native history Ω");
	await fixture.runtime.submit(restored, "real resumed input");
	expect(fixture.provider.requests.at(-1)?.model).toBe("chat-b");
}, 120_000);

test("ended phases recover only their exact journal for read-only native viewing", async () => {
	let ended = false;
	await using fixture = await consumer(
		{},
		undefined,
		{},
		{
			assertCurrent: async () => {
				if (ended) throw new Error("Fixture phase has ended");
			},
		},
	);
	const ref = await fixture.prepare("planning");
	await fixture.runtime.submit(ref, "persist this exact native conversation");
	const count = fixture.provider.requests.length;
	await fixture.reopen();
	ended = true;
	await expect(fixture.prepare("planning", { sessionRef: ref })).rejects.toThrow("phase has ended");
	await expect(fixture.prepare("planning", { readonlyRecovery: true })).rejects.toThrow("exact saved session");
	await expect(
		fixture.prepare("planning", { sessionRef: ref, readonlyRecovery: true, authorizeWrites: true }),
	).rejects.toThrow("cannot authorize writes");
	const restored = await fixture.prepare("planning", { sessionRef: ref, readonlyRecovery: true });
	expect(restored).toEqual(ref);
	expect(JSON.stringify(fixture.runtime.session(restored).messages)).toContain(
		"persist this exact native conversation",
	);
	await fixture.runtime.assertAuthority(restored);
	let inputCalled = false;
	await expect(
		fixture.runtime.runInput(restored, async () => {
			inputCalled = true;
		}),
	).rejects.toThrow("stopped");
	expect(inputCalled).toBe(false);
	await expect(fixture.runtime.submit(restored, "must not reopen this ended phase")).rejects.toThrow("stopped");
	expect(fixture.provider.requests).toHaveLength(count);
}, 120_000);

for (const readonlyRecovery of [false, true])
	for (const defect of ["missing", "header", "journal", "malformed", "binding"] as const) {
		test(`native ${readonlyRecovery ? "read-only " : ""}${defect} history rejects recovery instead of substituting another conversation`, async () => {
			await using fixture = await consumer();
			const ref = await fixture.prepare("requirements");
			await fixture.runtime.submit(ref, "original conversation must not be reconstructed");
			await fixture.reopen();
			const count = fixture.provider.requests.length;
			let supplied = ref;
			if (defect === "missing") await fs.rm(ref.sessionFile);
			else if (defect === "binding") supplied = { ...ref, round: ref.round + 1 };
			else {
				const text = await fs.readFile(ref.sessionFile, "utf8");
				const rows = text.trimEnd().split("\n");
				if (defect === "header") {
					const header = rows.findIndex(row => JSON.parse(row).type === "session");
					if (header < 0) throw new Error("Fixture native journal has no session header");
					rows[header] = JSON.stringify({ ...JSON.parse(rows[header]!), id: "not-the-native-session" });
				}
				if (defect === "journal") {
					for (let index = rows.length - 1; index >= 0; index--)
						if (JSON.parse(rows[index]!).customType === "dev-workflow-binding") rows.splice(index, 1);
				}
				if (defect === "malformed") rows.push("{not valid native journal JSON");
				await fs.writeFile(ref.sessionFile, `${rows.join("\n")}\n`);
			}
			await expect(fixture.prepare("requirements", { sessionRef: supplied, readonlyRecovery })).rejects.toThrow();
			expect(fixture.runtime.references()).toEqual([]);
			expect(fixture.provider.requests).toHaveLength(count);
		}, 120_000);
	}

test("facade rejects another project root, foreign worktrees and unbound technical sessions", async () => {
	await using fixture = await consumer();
	await expect(
		createDevWorkflowRuntime({
			projectId: "other-project",
			rootSession: fixture.root,
			settings: fixture.settings,
			cwd: fixture.cwd,
			assertCurrent: async () => {},
		}),
	).rejects.toThrow();
	const foreign = path.join(fixture.directory, "foreign");
	await fs.mkdir(foreign);
	await exec("git", ["init", "--initial-branch=main"], { cwd: foreign });
	await expect(
		createDevWorkflowRuntime({
			projectId,
			rootSession: fixture.root,
			settings: fixture.settings,
			cwd: foreign,
			assertCurrent: async () => {},
		}),
	).rejects.toThrow();
	await expect(fixture.prepare("requirements", { cwd: foreign })).rejects.toThrow();
	await expect(fixture.prepare("solution", { authority: undefined })).rejects.toThrow();
	await expect(
		fixture.prepare("solution", { binding: { projectId, irId, phase: "solution", round: 1 } }),
	).rejects.toThrow();
	expect(fixture.provider.requests).toHaveLength(0);
}, 120_000);

test("real linked worktrees load their own project context without native isolation or root-setting mutation", async () => {
	await using fixture = await consumer();
	const worktree = path.join(fixture.directory, "sr-worktree");
	await exec("git", ["worktree", "add", "-b", "sr-native", worktree], { cwd: fixture.cwd });
	for (const file of fixture.files) {
		await fs.mkdir(path.dirname(path.join(worktree, file.path)), { recursive: true });
		await fs.writeFile(path.join(worktree, file.path), file.content);
	}
	cfgTaskIsolationEnabled.set(fixture.settings, true);
	cfgTaskSpeculativeLaunch.set(fixture.settings, true);
	const ref = await fixture.prepare("executing", { cwd: worktree });
	const native = fixture.runtime.session(ref);
	expect(await fs.realpath(native.sessionManager.getCwd())).toBe(await fs.realpath(worktree));
	expect(cfgTaskIsolationEnabled.get(native.settings)).toBe(false);
	expect(cfgTaskSpeculativeLaunch.get(native.settings)).toBe(false);
	expect(cfgTaskIsolationEnabled.get(fixture.settings)).toBe(true);
	expect(cfgTaskSpeculativeLaunch.get(fixture.settings)).toBe(true);
	await fixture.runtime.submit(ref, "continue in the assigned SR worktree");
	expect(fixture.root.sessionManager.getCwd()).toBe(fixture.cwd);
}, 120_000);

test("SDK tools and only active extension factories survive native facade cloning", async () => {
	const starts = { disabled: 0, enabled: 0 };
	await using fixture = await consumer({}, undefined, {
		customTools: [
			{
				name: "sdk_dev_probe",
				label: "SDK probe",
				description: "Inherited SDK capability",
				parameters: Type.Object({}),
				async execute(): Promise<AgentToolResult<unknown>> {
					return { content: [{ type: "text", text: "SDK capability ran" }] };
				},
			},
		],
		extensions: (["disabled", "enabled"] as const).map(name => api => {
			api.on("session_start", () => {
				starts[name]++;
			});
			api.registerTool({
				name: `dev_${name}_extension`,
				label: name,
				description: "Inherited extension capability",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: name }] };
				},
			});
		}),
	});
	fixture.root.extensionRunner!.setSuspendedExtensions(extension => extension.path === "<inline-0>");
	const before = { ...starts };
	const ref = await fixture.prepare("executing");
	const native = fixture.runtime.session(ref);
	expect(native.getEnabledToolNames()).toContain("sdk_dev_probe");
	expect(native.getEnabledToolNames()).toContain("dev_enabled_extension");
	expect(native.getEnabledToolNames()).not.toContain("dev_disabled_extension");
	expect(native.nativeChildCapabilities?.enableMCP).toBe(false);
	expect(native.nativeChildCapabilities?.enableLsp).toBe(false);
	expect(native.getEnabledToolNames()).toContain("eval");
	await native.extensionRunner!.emit({ type: "session_start" });
	expect(starts.disabled).toBe(before.disabled);
	expect(starts.enabled).toBeGreaterThan(before.enabled);
	expect(fixture.provider.requests).toHaveLength(0);
}, 120_000);

test("actual embedding deny policy is inherited by the facade and cannot be lifted by a model write", async () => {
	let issued = false;
	await using fixture = await consumer(
		{
			reply: () => {
				if (!issued) {
					issued = true;
					return { tool: { name: "write", args: { path: "forbidden.txt", content: "must not land" } } };
				}
				return { text: "denied write acknowledged" };
			},
		},
		undefined,
		{ toolRestrictions: new ToolRestrictions({ denylist: ["write"] }) },
	);
	const ref = await fixture.prepare("executing");
	await fixture.runtime.submit(ref, "attempt denied native write");
	await expect(fs.stat(path.join(fixture.cwd, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(fixture.runtime.session(ref).messages.some(message => message.role === "toolResult" && message.isError)).toBe(
		true,
	);
}, 120_000);

test("canonical native tools cannot rewrite any member of the frozen IR and sibling SR set", async () => {
	let issued = false;
	await using fixture = await consumer({
		reply: () => {
			if (!issued) {
				issued = true;
				return {
					tool: { name: "write", args: { path: `${requirementRoot}/sr-b.md`, content: "changed sibling" } },
				};
			}
			return { text: "frozen boundary explained" };
		},
	});
	const ref = await fixture.prepare("executing");
	await fixture.runtime.submit(ref, "attempt sibling rewrite");
	expect(await fs.readFile(path.join(fixture.cwd, `${requirementRoot}/sr-b.md`), "utf8")).toBe(
		fixture.content.srs[1]!.document.content,
	);
	await fixture.runtime.assertAuthority(ref);
	expect(fixture.runtime.session(ref).messages.some(message => message.role === "toolResult" && message.isError)).toBe(
		true,
	);
}, 120_000);

for (const phase of ["requirements", "solution", "planning", "pr"] as const) {
	test(`${phase} rejects opaque extension writes outside formal outputs and keeps the actual files`, async () => {
		let issued = false;
		let target = "";
		await using fixture = await consumer(
			{
				reply: () => {
					if (!issued) {
						issued = true;
						return { tool: { name: "opaque_write", args: {} } };
					}
					return { text: "must not become a formal result" };
				},
			},
			undefined,
			{
				extensions: [
					api => {
						api.registerTool({
							name: "opaque_write",
							label: "Opaque write",
							description: "Native extension side effect",
							parameters: Type.Object({}),
							async execute() {
								await fs.writeFile(target, "actual extension side effect");
								return { content: [{ type: "text", text: "extension ran" }] };
							},
						});
					},
				],
			},
		);
		target = path.join(fixture.cwd, "unexpected-source.ts");
		const ref = await fixture.prepare(phase);
		await expect(fixture.runtime.submit(ref, "try opaque write")).rejects.toThrow();
		expect(await fs.readFile(target, "utf8")).toBe("actual extension side effect");
		await expect(fixture.runtime.assertAuthority(ref)).rejects.toThrow();
	}, 120_000);
}

test("opaque execution capability changing frozen bytes locks formal output even after bytes are repaired", async () => {
	let target = "";
	let issued = false;
	await using fixture = await consumer(
		{
			reply: () => {
				if (!issued) {
					issued = true;
					return { tool: { name: "opaque_frozen_write", args: {} } };
				}
				return { text: "invalid formal completion" };
			},
		},
		undefined,
		{
			customTools: [
				{
					name: "opaque_frozen_write",
					label: "Opaque frozen write",
					description: "Probe native custom write enforcement",
					parameters: Type.Object({}),
					async execute(): Promise<AgentToolResult<unknown>> {
						await fs.writeFile(target, "changed approved bytes");
						return { content: [{ type: "text", text: "custom tool ran" }] };
					},
				},
			],
		},
	);
	target = path.join(fixture.cwd, fixture.files[0]!.path);
	const ref = await fixture.prepare("executing");
	await expect(fixture.runtime.submit(ref, "try opaque authority bypass")).rejects.toThrow();
	expect(await fs.readFile(target, "utf8")).toBe("changed approved bytes");
	await fs.writeFile(target, fixture.files[0]!.content);
	await expect(fixture.runtime.assertAuthority(ref)).rejects.toThrow();
	await expect(fixture.runtime.submit(ref, "try again after repair")).rejects.toThrow();
}, 120_000);

test(
	"a linked-intake boundary lock survives recursive native stop and disposal without accepting late results",
	async () =>
		(async () => {
			const marker = "OMP_NATIVE_BOUNDARY_STOP_CHILD";
			const entered = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const cleanupStarted = Promise.withResolvers<void>();
			const cleanupAborted = Promise.withResolvers<void>();
			const cleanup = Promise.withResolvers<void>();
			let delegated = false;
			await using fixture = await consumer({
				reply: request => {
					if (assignment(request, marker)) return { text: "invalid late child result" };
					if (!delegated) {
						delegated = true;
						return task(marker);
					}
					return { text: "invalid late parent result" };
				},
				delay: async (request, signal) => {
					if (!assignment(request, marker)) return;
					entered.resolve();
					await new Promise<void>(resolve => {
						if (signal.aborted) resolve();
						else signal.addEventListener("abort", () => resolve(), { once: true });
					});
					aborted.resolve();
				},
			});
			const ref = await fixture.prepare("requirements");
			const native = fixture.runtime.session(ref);
			const running = fixture.runtime.submit(ref, "retain the original linked-intake failure").catch(error => error);
			await entered.promise;
			const ownerId = native.getAgentId();
			const childRef = native.agentRegistry
				?.list()
				.find(agent => agent.parentId === ownerId && agent.kind === "sub");
			const child = childRef?.session;
			const jobs = native.asyncJobManager;
			if (!ownerId || !childRef || !child || !jobs)
				throw new Error("Actual native descendant ownership is unavailable");
			const cleanupJob = jobs.register(
				"bash",
				"owned descendant cleanup after boundary failure",
				async ({ signal }) => {
					cleanupStarted.resolve();
					await new Promise<void>(resolve => {
						if (signal.aborted) resolve();
						else signal.addEventListener("abort", () => resolve(), { once: true });
					});
					cleanupAborted.resolve();
					await cleanup.promise;
					return "actual descendant cleanup settled";
				},
				{ ownerId: childRef.id },
			);
			let stopping: Promise<void> | undefined;
			try {
				await cleanupStarted.promise;
				const intake = path.join(fixture.directory, "intake");
				await fs.mkdir(intake);
				await fs.writeFile(path.join(intake, "original.txt"), "original external business bytes");
				const link = path.join(fixture.cwd, "linked-intake");
				await fs.symlink(intake, link, process.platform === "win32" ? "junction" : "dir");
				const linkedTarget = await fs.readlink(link);
				const boundary = await fixture.runtime.assertAuthority(ref).catch(error => error);
				expect(boundary).toBeInstanceOf(Error);
				expect(boundary.message).toContain("linked-intake");
				const history = await fs.readFile(ref.sessionFile, "utf8");
				let settled = false;
				stopping = fixture.runtime.stop(ref).then(() => {
					settled = true;
				});
				await cleanupAborted.promise;
				await Promise.resolve();
				expect(settled).toBe(false);
				expect(jobs.getJob(cleanupJob)?.endTime).toBeUndefined();
				await expect(fixture.runtime.submit(ref, "new input must not write")).rejects.toThrow();
				cleanup.resolve();
				await stopping;
				await aborted.promise;
				expect(await running).toBeInstanceOf(Error);
				expect(native.isStreaming).toBe(false);
				expect(child.isStreaming).toBe(false);
				expect(
					jobs.getUnsettledJobs().filter(job => job.ownerId === ownerId || job.ownerId === childRef.id),
				).toEqual([]);
				expect(await fixture.runtime.assertAuthority(ref).catch(error => error)).toBe(boundary);
				await expect(
					fixture.runtime.prepare(fixture.preparation("requirements", { sessionRef: ref })),
				).rejects.toThrow(boundary.message);
				await expect(fs.stat(path.join(fixture.cwd, "draft.json"))).rejects.toMatchObject({ code: "ENOENT" });
				expect(await fs.readlink(link)).toBe(linkedTarget);
				expect(await fs.readFile(path.join(intake, "original.txt"), "utf8")).toBe(
					"original external business bytes",
				);
				for (const file of fixture.files)
					expect(new Uint8Array(await fs.readFile(path.join(fixture.cwd, file.path)))).toEqual(
						typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
					);
				for (const session of [native, child])
					for (const message of session.messages)
						if (
							message.role === "assistant" &&
							message.stopReason !== "aborted" &&
							message.stopReason !== "error"
						) {
							expect(contentText(message.content)).not.toContain("invalid late child result");
							expect(contentText(message.content)).not.toContain("invalid late parent result");
						}
				await fixture.runtime.dispose();
				expect(native.isDisposed).toBe(true);
				expect(await fixture.runtime.assertAuthority(ref).catch(error => error)).toBe(boundary);
				expect(await fs.readFile(ref.sessionFile, "utf8")).toContain(history);
			} finally {
				cleanup.resolve();
				await (stopping ?? fixture.runtime.stop(ref));
				await running;
			}
		})().catch((error: unknown) => {
			// Include both async-disposal failures and the original assertion/stop error;
			// Bun's default SuppressedError display otherwise hides the failing invariant.
			console.error(
				"Linked-intake native lifecycle failure",
				JSON.stringify(
					error,
					(_key, value: unknown) => {
						if (!(value instanceof Error)) return value;
						return {
							name: value.name,
							message: value.message,
							stack: value.stack,
							...(value.cause !== undefined ? { cause: value.cause } : {}),
							...(value instanceof AggregateError ? { errors: value.errors } : {}),
							...("error" in value ? { error: value.error } : {}),
							...("suppressed" in value ? { suppressed: value.suppressed } : {}),
						};
					},
					2,
				),
			);
			throw error;
		}),
	120_000,
);

test("a frozen boundary first discovered during disposal stays invalid while real cleanup succeeds", async () => {
	await using fixture = await consumer();
	const ref = await fixture.prepare("executing");
	const native = fixture.runtime.session(ref);
	const target = path.join(fixture.cwd, fixture.files[0]!.path);
	await fs.writeFile(target, "invalid approved authority retained for recovery");
	await fixture.runtime.dispose();
	expect(native.isDisposed).toBe(true);
	const boundary = await fixture.runtime.assertAuthority(ref).catch(error => error);
	expect(boundary).toBeInstanceOf(Error);
	expect(boundary.message).toContain("Frozen requirement changed");
	await fs.writeFile(target, fixture.files[0]!.content);
	expect(await fixture.runtime.assertAuthority(ref).catch(error => error)).toBe(boundary);
	await expect(fixture.runtime.submit(ref, "repaired bytes do not authorize new work")).rejects.toThrow();
	expect(fixture.runtime.references()).toContainEqual(ref);
	expect(await fs.readFile(ref.sessionFile, "utf8")).toContain("dev-workflow-binding");
}, 120_000);

test("native admission rechecks the exact object round before every turn and tool", async () => {
	let current = true;
	let retireBeforeTool = false;
	const output = `docs/dev/development/${srId}/planning.md`;
	const bindings: DevWorkflowBinding[] = [];
	await using fixture = await consumer(
		{
			reply: () => {
				if (retireBeforeTool) {
					retireBeforeTool = false;
					current = false;
					return { tool: { name: "write", args: { path: output, content: "must not become an admitted plan" } } };
				}
				return { text: "stale tool rejection acknowledged" };
			},
		},
		undefined,
		{},
		{
			assertCurrent: async binding => {
				bindings.push(binding);
				if (!current) throw new Error("explicit workflow round retired");
			},
		},
	);
	const ref = await fixture.prepare("planning");
	current = false;
	await expect(fixture.runtime.submit(ref, "late input")).rejects.toThrow("explicit workflow round retired");
	expect(
		bindings.every(
			binding =>
				binding.projectId === projectId && binding.irId === irId && binding.srId === srId && binding.round === 1,
		),
	).toBe(true);
	expect(fixture.provider.requests).toHaveLength(0);
	current = true;
	retireBeforeTool = true;
	await expect(fixture.runtime.submit(ref, "retire this exact round before native tool dispatch")).rejects.toThrow(
		"explicit workflow round retired",
	);
	await expect(fs.stat(path.join(fixture.cwd, output))).rejects.toMatchObject({ code: "ENOENT" });
	expect(
		fixture.runtime
			.session(ref)
			.messages.some(
				message =>
					message.role === "toolResult" &&
					message.isError &&
					contentText(message.content).includes("explicit workflow round retired"),
			),
	).toBe(true);
	expect(
		bindings.every(
			binding =>
				binding.projectId === projectId && binding.irId === irId && binding.srId === srId && binding.round === 1,
		),
	).toBe(true);
}, 120_000);

test("executor delegates real writable tasks and recursive descendants retain extension and SDK capabilities", async () => {
	const childMarker = "OMP_NATIVE_WRITE_CHILD";
	const grandchildMarker = "OMP_NATIVE_WRITE_GRANDCHILD";
	const actions = new Set<string>();
	await using fixture = await consumer(
		{
			reply: request => {
				const role = assignment(request, grandchildMarker)
					? "grandchild"
					: assignment(request, childMarker)
						? "child"
						: hasUser(request, "delegate writable work")
							? "executor"
							: undefined;
				if (!role) return { text: "title" };
				if (!actions.has(role)) {
					actions.add(role);
					if (role === "executor") return task(childMarker);
					if (role === "child") return task(grandchildMarker);
					return {
						tool: { name: "write", args: { path: "probe.txt", content: "native grandchild wrote these bytes" } },
					};
				}
				return { text: `${role} completed` };
			},
		},
		undefined,
		{
			customTools: [
				{
					name: "sdk_child_probe",
					label: "SDK child",
					description: "SDK propagation probe",
					parameters: Type.Object({}),
					async execute(): Promise<AgentToolResult<unknown>> {
						return { content: [{ type: "text", text: "sdk" }] };
					},
				},
			],
			extensions: [
				api => {
					api.registerTool({
						name: "extension_child_probe",
						label: "Extension child",
						description: "Extension propagation probe",
						parameters: Type.Object({}),
						async execute() {
							return { content: [{ type: "text", text: "extension" }] };
						},
					});
				},
			],
		},
	);
	cfgTaskMaxRecursionDepth.set(fixture.settings, 5);
	const ref = await fixture.prepare("executing");
	await fixture.runtime.submit(ref, "delegate writable work");
	expect(await fs.readFile(path.join(fixture.cwd, "probe.txt"), "utf8")).toBe("native grandchild wrote these bytes");
	for (const marker of [childMarker, grandchildMarker]) {
		const request = fixture.provider.requests.find(request => assignment(request, marker));
		expect(request).toBeDefined();
		expect(toolNames(request!)).toContain("write");
		expect(toolNames(request!)).toContain("sdk_child_probe");
		expect(toolNames(request!)).toContain("extension_child_probe");
	}
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);

test("requirements descendants cannot bypass their formal output allowlist", async () => {
	const marker = "OMP_REQUIREMENTS_WRITE_CHILD";
	const actions = new Set<string>();
	await using fixture = await consumer({
		reply: request => {
			const child = assignment(request, marker);
			const role = child ? "child" : hasUser(request, "delegate restricted write") ? "parent" : undefined;
			if (!role) return { text: "title" };
			if (!actions.has(role)) {
				actions.add(role);
				return child
					? { tool: { name: "write", args: { path: "business.ts", content: "must not land" } } }
					: task(marker);
			}
			return { text: "boundary inspected" };
		},
	});
	const ref = await fixture.prepare("requirements");
	await fixture.runtime.submit(ref, "delegate restricted write");
	await expect(fs.stat(path.join(fixture.cwd, "business.ts"))).rejects.toMatchObject({ code: "ENOENT" });
	const childRequests = fixture.provider.requests.filter(request => assignment(request, marker));
	expect(childRequests.length).toBeGreaterThan(1);
	expect(
		childRequests.some(request =>
			request.messages.some(
				message => message.role === "tool" && contentText(message.content).includes("Phase write denied"),
			),
		),
	).toBe(true);
}, 120_000);

test("bundled executor skill authorization follows real recursive native descendants but not ordinary root sessions", async () => {
	const skill = "subagent-driven-development";
	const childMarker = "OMP_NATIVE_SKILL_CHILD";
	const grandchildMarker = "OMP_NATIVE_SKILL_GRANDCHILD";
	const actions = new Set<string>();
	await using fixture = await consumer({
		reply: request => {
			const role = assignment(request, grandchildMarker)
				? "grandchild"
				: assignment(request, childMarker)
					? "child"
					: hasUser(request, "native executor skill probe")
						? "executor"
						: hasUser(request, "ordinary root skill probe")
							? "ordinary"
							: undefined;
			if (!role) return { text: "title" };
			if (!actions.has(`${role}:read`)) {
				actions.add(`${role}:read`);
				return { tool: { name: "read", args: { path: `skill://${skill}:raw` } } };
			}
			if ((role === "executor" || role === "child") && !actions.has(`${role}:task`)) {
				actions.add(`${role}:task`);
				return task(role === "executor" ? childMarker : grandchildMarker);
			}
			return { text: "skill probe complete" };
		},
	});
	cfgTaskMaxRecursionDepth.set(fixture.settings, 5);
	await fixture.root.prompt("ordinary root skill probe");
	const ref = await fixture.prepare("executing");
	await fixture.runtime.submit(ref, "native executor skill probe");
	for (const marker of [childMarker, grandchildMarker]) {
		const requests = fixture.provider.requests.filter(request => assignment(request, marker));
		expect(requests.length).toBeGreaterThan(1);
		expect(
			requests.some(request =>
				request.messages.some(
					message =>
						message.role === "tool" && contentText(message.content).includes("# Subagent-Driven Development"),
				),
			),
		).toBe(true);
	}
	const ordinary = fixture.root.messages.filter(message => message.role === "toolResult");
	expect(JSON.stringify(ordinary)).toContain("Skill access denied");
}, 120_000);

test("native task wait delivers a real asynchronous child result without polling", async () => {
	const marker = "OMP_NATIVE_ASYNC_WAIT";
	const release = Promise.withResolvers<void>();
	let dispatched = false;
	let waiting = false;
	await using fixture = await consumer({
		reply: async request => {
			if (assignment(request, marker)) {
				await release.promise;
				return { text: "actual asynchronous child result" };
			}
			if (!hasUser(request, "wait for real child")) return { text: "title" };
			if (!dispatched) {
				dispatched = true;
				return task(marker);
			}
			if (!waiting) {
				waiting = true;
				return { tool: { name: "wait", args: {} } };
			}
			return { text: "wait result received" };
		},
	});
	cfgAsyncEnabled.override(fixture.settings, true);
	const ref = await fixture.prepare("executing");
	const native = fixture.runtime.session(ref);
	const executed: string[] = [];
	const unsubscribe = native.subscribe(event => {
		if (event.type === "tool_execution_start") executed.push(event.toolName);
		if (event.type === "tool_execution_update" && event.toolName === "wait") release.resolve();
	});
	try {
		await fixture.runtime.submit(ref, "wait for real child");
		expect(executed).toEqual(["task", "wait"]);
		const result = native.messages.find(message => message.role === "toolResult" && message.toolName === "wait");
		expect(result).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).toContain("actual asynchronous child result");
	} finally {
		release.resolve();
		unsubscribe();
	}
}, 120_000);

test("native reviewers execute declared readonly MCP and extensions but deny opaque and writing operations before execution", async () => {
	const marker = "OMP_NATIVE_RESTRICTED_REVIEWER";
	const escalation = "OMP_READONLY_ESCALATION";
	const attempts: Array<{ name: string; args: Record<string, unknown> }> = [
		{ name: "write", args: { path: "reviewer-canonical.ts", content: "must not land" } },
		{ name: "bash", args: { command: "echo unauthorized > reviewer-shell.txt", timeout: 5 } },
		{ name: "mcp__opaque_ctx_execute", args: {} },
		{ name: "mcp__boundary_ctx_execute", args: {} },
		{ name: "extension_operation_probe", args: { write: false } },
		{ name: "extension_operation_probe", args: { write: true } },
		{ name: "extension_opaque_probe", args: {} },
		{ name: "sdk_readonly_probe", args: {} },
		{ name: "sdk_opaque_probe", args: {} },
		task(escalation).tool!,
	];
	let nextAttempt = 0;
	let called = false;
	let delegated = false;
	let target = "";
	const calls = { extensionRead: 0, extensionWrite: 0, extensionOpaque: 0, sdkRead: 0, sdkOpaque: 0 };
	await using fixture = await consumer(
		{
			reply: request => {
				if (assignment(request, marker)) {
					const tool = attempts[nextAttempt++];
					return tool ? { tool } : { text: "read-only native review completed" };
				}
				if (!hasUser(request, "exercise MCP and reviewer")) return { text: "title" };
				if (!called) {
					called = true;
					return { tool: { name: "mcp__opaque_ctx_execute", args: {} } };
				}
				if (!delegated) {
					delegated = true;
					return task(marker, "reviewer");
				}
				return { text: "native capability exercise complete" };
			},
		},
		async cwd => {
			const server = {
				type: "stdio",
				command: process.execPath,
				args: [path.join(import.meta.dir, "../fixtures/instructions-mcp.ts"), "--context-mode-no-instructions"],
			};
			await fs.writeFile(
				path.join(cwd, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						boundary: { ...server, args: [...server.args, READONLY_TOOLS_MODE] },
						opaque: server,
					},
				}),
			);
		},
		{
			enableMCP: true,
			customTools: [
				{
					name: "sdk_readonly_probe",
					label: "SDK reader",
					description: "Declared native readonly SDK operation",
					approval: "read",
					parameters: Type.Object({}),
					async execute(): Promise<AgentToolResult<unknown>> {
						calls.sdkRead++;
						return { content: [{ type: "text", text: "actual readonly SDK result" }] };
					},
				},
				{
					name: "sdk_opaque_probe",
					label: "Opaque SDK",
					description: "SDK operation without readonly authority",
					parameters: Type.Object({}),
					async execute(): Promise<AgentToolResult<unknown>> {
						calls.sdkOpaque++;
						await fs.writeFile(target, "unauthorized opaque SDK mutation");
						return { content: [{ type: "text", text: "opaque SDK ran" }] };
					},
				},
			],
			extensions: [
				api => {
					api.registerTool({
						name: "extension_operation_probe",
						label: "Extension operation",
						description: "Argument-dependent native readonly authority",
						approval: args => (isRecord(args) && args.write === false ? "read" : "write"),
						parameters: Type.Object({ write: Type.Boolean() }),
						async execute(_id, args) {
							if (args.write) {
								calls.extensionWrite++;
								await fs.writeFile(target, "unauthorized declared extension mutation");
							} else calls.extensionRead++;
							return { content: [{ type: "text", text: "actual readonly extension result" }] };
						},
					});
					api.registerTool({
						name: "extension_opaque_probe",
						label: "Opaque extension",
						description: "Extension without readonly authority",
						parameters: Type.Object({}),
						async execute() {
							calls.extensionOpaque++;
							await fs.writeFile(target, "unauthorized opaque extension mutation");
							return { content: [{ type: "text", text: "opaque extension ran" }] };
						},
					});
				},
			],
		},
	);
	target = path.join(fixture.cwd, "reviewer-opaque.ts");
	const ref = await fixture.prepare("executing");
	const native = fixture.runtime.session(ref);
	expect(native.hasMCPManagerTool("mcp__boundary_ctx_execute")).toBe(true);
	await fixture.runtime.submit(ref, "exercise MCP and reviewer");
	await fixture.runtime.assertAuthority(ref);
	expect(calls).toEqual({ extensionRead: 1, extensionWrite: 0, extensionOpaque: 0, sdkRead: 1, sdkOpaque: 0 });
	for (const file of ["reviewer-canonical.ts", "reviewer-shell.txt", "reviewer-opaque.ts"])
		await expect(fs.stat(path.join(fixture.cwd, file))).rejects.toMatchObject({ code: "ENOENT" });
	const parentMcp = native.messages.find(
		message => message.role === "toolResult" && message.toolName === "mcp__opaque_ctx_execute",
	);
	expect(parentMcp).toMatchObject({ isError: false });
	if (parentMcp?.role !== "toolResult") throw new Error("Actual native MCP result is missing");
	expect(contentText(parentMcp.content)).toContain(TOOL_RESULT);
	const agentRegistry = native.agentRegistry;
	const ownerId = native.getAgentId();
	if (!agentRegistry || !ownerId) throw new Error("Native reviewer owner is not registered");
	const child = agentRegistry.list().find(agent => agent.parentId === ownerId && agent.kind === "sub")?.session;
	if (!child) throw new Error("Native reviewer did not retain its actual session");
	const results = child.messages.filter(message => message.role === "toolResult");
	for (const name of [
		"write",
		"bash",
		"mcp__opaque_ctx_execute",
		"extension_opaque_probe",
		"sdk_opaque_probe",
		"task",
	])
		expect(results.find(message => message.toolName === name)).toMatchObject({ isError: true });
	for (const name of ["mcp__boundary_ctx_execute", "sdk_readonly_probe"])
		expect(results.find(message => message.toolName === name)).toMatchObject({ isError: false });
	expect(
		results.filter(message => message.toolName === "extension_operation_probe").map(message => message.isError),
	).toEqual([false, true]);
	expect(fixture.provider.requests.some(request => assignment(request, escalation))).toBe(false);
	for (const file of fixture.files)
		expect(await fs.readFile(path.join(fixture.cwd, file.path), "utf8")).toBe(file.content);
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);

test("ordinary native Team still uses the visible selected model and real independent read-only participants", async () => {
	await using fixture = await consumer({
		reply: request => (teamStage(request) ? respond(request) : { text: "ordinary native conversation" }),
	});
	cfgTeamMembers.set(fixture.settings, ["deepseek/chat-a", "deepseek/chat-a", "deepseek/chat-a"]);
	const ref = await fixture.prepare("solution");
	const native = fixture.runtime.session(ref);
	await native.setModel(native.modelRegistry.find("deepseek", "chat-b")!);
	expect(native.model?.id).toBe("chat-b");
	const children: Array<{ role: string; selected: string | undefined; replies: string[] }> = [];
	const runner = createTeamSubagentRunner({
		...buildRunnerDeps(native, native.settings, fixture.cwd, undefined, native.getAgentId()),
		onSessionCreated(call, session) {
			const child = { role: call.role, selected: session.model?.id, replies: [] as string[] };
			children.push(child);
			const release = session.subscribe(event => {
				if (event.type === "message_end" && event.message.role === "assistant")
					child.replies.push(event.message.model);
			});
			session.addDisposer(release);
		},
	});
	const participants = resolveTeamParticipantsForSession(native, native.settings);
	if (!participants.ok) throw new Error(participants.error);
	const result = await runTeamDiscussion({
		question: `Complete fixed requirement set\n${JSON.stringify(fixture.files)}`,
		inputVersion: fixture.snapshot.digest,
		cwd: fixture.cwd,
		participants: participants.participants,
		sessionModelPattern: `${native.model!.provider}/${native.model!.id}`,
		runner,
		signal: new AbortController().signal,
		maxConcurrency: 3,
	});
	expect(result.status).toBe("completed");
	expect(result.inputVersion).toBe(fixture.snapshot.digest);
	expect(result.candidates.some(candidate => candidate.adoptable)).toBe(true);
	// Native auxiliary turns may quote a stage prompt while using their own
	// selected model. Observe the real Team children and their foreground replies.
	expect(
		children
			.filter(child => ["aligner", "synthesizer"].includes(child.role))
			.map(child => ({
				role: child.role,
				selected: child.selected,
				replies: [...new Set(child.replies)],
			})),
	).toEqual([
		{ role: "aligner", selected: "chat-b", replies: ["chat-b"] },
		{ role: "synthesizer", selected: "chat-b", replies: ["chat-b"] },
	]);
	const requests = fixture.provider.requests.filter(
		request => teamStage(request) && toolNames(request).includes("yield"),
	);
	expect(requests.some(request => teamStage(request) === "proposal")).toBe(true);
	for (const stage of ["alignment", "synthesis"]) {
		const models = requests.filter(request => teamStage(request) === stage).map(request => request.model);
		expect([...new Set(models)]).toEqual(["chat-b"]);
	}
	for (const request of requests) {
		expect(toolNames(request)).not.toContain("write");
		expect(toolNames(request)).not.toContain("bash");
	}
	expect(fixture.runtime.session(ref)).toBe(native);
	expect(fixture.root.model?.id).toBe("chat-a");
}, 120_000);

test("completion retires autonomous executor writes without recreating the user-owned native Goal", async () => {
	let write = false;
	let reported = false;
	await using fixture = await consumer({
		reply: () => {
			if (write) {
				write = false;
				return { tool: { name: "write", args: { path: "late-source.ts", content: "must not land" } } };
			}
			if (!reported) {
				reported = true;
				write = true;
				return {
					tool: {
						name: "write",
						args: {
							path: `docs/dev/development/${srId}/completion.md`,
							content: "# Incomplete handoff\nUT: not run. ST: not run. Human decision required.\n",
						},
					},
				};
			}
			return { text: "ordinary completion" };
		},
	});
	const ref = await fixture.prepare("executing");
	const native = fixture.runtime.session(ref);
	await native.goalRuntime.createGoal({ objective: "Explicit human objective" });
	await native.goalRuntime.pauseGoal();
	const id = native.getGoalModeState()!.goal.id;
	await fixture.runtime.submit(ref, "complete this execution round");
	await expect(fs.stat(path.join(fixture.cwd, "late-source.ts"))).rejects.toMatchObject({ code: "ENOENT" });
	write = true;
	await fixture.runtime.submit(ref, "explain the completion, not a new authorization");
	await expect(fs.stat(path.join(fixture.cwd, "late-source.ts"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(native.getGoalModeState()!.goal.id).toBe(id);
	expect(native.getGoalModeState()!.goal.status).toBe("paused");
	await fixture.runtime.assertAuthority(ref);
}, 120_000);

test("back settles an actual in-flight native descendant, rejects late results and preserves materials", async () => {
	const marker = "OMP_NATIVE_STOP_CHILD";
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	let delegated = false;
	await using fixture = await consumer({
		reply: request => {
			if (assignment(request, marker)) return { text: "late child result must not become completion" };
			if (hasUser(request, "start then back") && !delegated) {
				delegated = true;
				return task(marker);
			}
			return { text: "late parent result must not become completion" };
		},
		delay: async (request, signal) => {
			if (!assignment(request, marker)) return;
			entered.resolve();
			await new Promise<void>(resolve => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			aborted.resolve();
		},
	});
	const ref = await fixture.prepare("executing");
	const output = "docs/dev/development/sr-a/executing.md";
	await fs.mkdir(path.dirname(path.join(fixture.cwd, output)), { recursive: true });
	await fs.writeFile(path.join(fixture.cwd, output), "preserved incomplete work");
	const running = fixture.runtime.submit(ref, "start then back").catch(error => error);
	await entered.promise;
	const native = fixture.runtime.session(ref);
	const agentRegistry = native.agentRegistry;
	const ownerId = native.getAgentId();
	if (!agentRegistry || !ownerId) throw new Error("In-flight native owner is not registered");
	const childRef = agentRegistry.list().find(agent => agent.parentId === ownerId && agent.kind === "sub");
	const child = childRef?.session;
	if (!childRef || !child)
		throw new Error("The in-flight native descendant was not registered under its actual owner");
	await fixture.runtime.back(ref);
	await aborted.promise;
	expect(await running).toBeInstanceOf(Error);
	expect(native.isStreaming).toBe(false);
	expect(child.isStreaming).toBe(false);
	for (const session of [native, child]) {
		const accepted = session.messages.flatMap(message => {
			if (message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error")
				return [contentText(message.content)];
			if (message.role === "toolResult" && !message.isError) return [contentText(message.content)];
			return [];
		});
		for (const content of accepted) {
			expect(content).not.toContain("late parent result must not become completion");
			expect(content).not.toContain("late child result must not become completion");
		}
	}
	expect(native.getQueuedInputMessages()).toEqual([]);
	expect(
		native.asyncJobManager
			?.getUnsettledJobs()
			.filter(job => job.ownerId === native.getAgentId() || job.ownerId === childRef.id) ?? [],
	).toEqual([]);
	expect(await fs.readFile(path.join(fixture.cwd, output), "utf8")).toBe("preserved incomplete work");
	await expect(fixture.runtime.submit(ref, "late stale input")).rejects.toThrow();
	const fresh = await fixture.prepare("planning", { binding: { projectId, irId, srId, phase: "planning", round: 2 } });
	expect(fresh.round).toBe(2);
	expect(fresh.sessionId).not.toBe(ref.sessionId);
}, 120_000);

test("independent review uses the complete deterministic fixed snapshot and validates a durable report", async () => {
	let report: { path: string; content: string } | undefined;
	await using fixture = await consumer({
		reply: () => {
			if (report) {
				const value = report;
				report = undefined;
				return { tool: { name: "write", args: value } };
			}
			return { text: "independent review finished" };
		},
	});
	const outputPath = "review.json";
	await expect(
		fixture.runtime.review({
			binding: { projectId, irId, phase: "requirements", round: 1 },
			files: fixture.files,
			snapshot: fixture.snapshot,
			outputPath,
		}),
	).rejects.toThrow("actual requirements session parent");
	expect(fixture.provider.requests).toHaveLength(0);
	const requirements = await fixture.prepare("requirements");
	await fixture.runtime.submit(
		requirements,
		"Actual requirements discussion and native history before independent review.",
	);
	report = {
		path: outputPath,
		content: JSON.stringify({ snapshotDigest: fixture.snapshot.digest, verdict: "pass", findings: [] }),
	};
	const result = await fixture.runtime.review({
		binding: { projectId, irId, phase: "requirements", round: 1 },
		files: fixture.files,
		snapshot: fixture.snapshot,
		outputPath,
	});
	expect(result.report).toEqual({ snapshotDigest: fixture.snapshot.digest, verdict: "pass", findings: [] });
	expect(result.ref.role).toBe("reviewer");
	expect(fixture.runtime.references().find(ref => ref.role === "requirements")).toEqual(requirements);
	expect(requirements.sessionId).not.toBe(result.ref.sessionId);
	const reviewerId = fixture.runtime.session(result.ref).getAgentId();
	const requirementsId = fixture.runtime.session(requirements).getAgentId();
	if (!reviewerId || !requirementsId) throw new Error("Independent review and its actual owner must be registered");
	expect(AgentRegistry.global().get(reviewerId)?.parentId).toBe(requirementsId);
	expect(fixture.runtime.session(result.ref).sessionManager.getHeader()?.parentSession).toBe(requirements.sessionFile);
	expect(JSON.parse(await fs.readFile(path.join(fixture.cwd, outputPath), "utf8"))).toEqual(result.report);
	for (const file of fixture.files)
		expect(await fs.readFile(path.join(fixture.cwd, file.path), "utf8")).toBe(file.content);
	expect(JSON.stringify(fixture.provider.requests)).toContain(fixture.snapshot.digest);
	expect(JSON.stringify(result)).not.toContain("approvedAt");
	const parentMessages = [...fixture.runtime.session(requirements).messages];
	report = {
		path: outputPath,
		content: JSON.stringify({
			snapshotDigest: fixture.snapshot.digest,
			verdict: "changes-required",
			findings: ["Clarify the independent acceptance boundary."],
		}),
	};
	const repeated = await fixture.runtime.review({
		binding: { projectId, irId, phase: "requirements", round: 1 },
		files: fixture.files,
		snapshot: fixture.snapshot,
		outputPath,
	});
	expect(repeated.ref.sessionId).not.toBe(result.ref.sessionId);
	expect(repeated.ref.sessionId).not.toBe(requirements.sessionId);
	expect(repeated.report.verdict).toBe("changes-required");
	expect(fixture.runtime.session(requirements).messages).toEqual(parentMessages);
	const repeatedReviewerId = fixture.runtime.session(repeated.ref).getAgentId();
	if (!repeatedReviewerId) throw new Error("Repeated independent review must retain its registered identity");
	expect(AgentRegistry.global().get(repeatedReviewerId)?.parentId).toBe(requirementsId);
	expect(fixture.runtime.session(repeated.ref).sessionManager.getHeader()?.parentSession).toBe(
		requirements.sessionFile,
	);
	const count = fixture.provider.requests.length;
	await expect(
		fixture.runtime.review({
			binding: { projectId, irId, phase: "requirements", round: 2 },
			files: fixture.files.slice(1),
			snapshot: fixture.snapshot,
			outputPath,
		}),
	).rejects.toThrow();
	expect(fixture.provider.requests).toHaveLength(count);
}, 120_000);

test("explicit host authorization reopens execution writes but ordinary prepare and explanation do not", async () => {
	let next: Reply["tool"];
	let reportPending = false;
	let reportRevision = 0;
	await using fixture = await consumer({
		reply: () => {
			if (next) {
				const tool = next;
				next = undefined;
				return { tool };
			}
			if (reportPending) {
				reportPending = false;
				return {
					tool: {
						name: "write",
						args: {
							path: `docs/dev/development/${srId}/completion.md`,
							content: `# Handoff ${++reportRevision}\nUT: not run. ST: not run. Verification remains explicitly incomplete.\n`,
						},
					},
				};
			}
			return { text: "execution input completed" };
		},
	});
	const ref = await fixture.prepare("executing");
	next = { name: "write", args: { path: "implementation.ts", content: "export const revision = 1;\n" } };
	reportPending = true;
	await fixture.runtime.submit(ref, "authorized implementation");
	expect(await fs.readFile(path.join(fixture.cwd, "implementation.ts"), "utf8")).toBe("export const revision = 1;\n");
	expect(await fixture.prepare("executing")).toEqual(ref);
	next = { name: "write", args: { path: "implementation.ts", content: "unauthorized overwrite" } };
	await fixture.runtime.submit(ref, "ordinary explanation");
	expect(await fs.readFile(path.join(fixture.cwd, "implementation.ts"), "utf8")).toBe("export const revision = 1;\n");
	expect(await fixture.prepare("executing", { authorizeWrites: true })).toEqual(ref);
	next = { name: "write", args: { path: "implementation.ts", content: "export const revision = 2;\n" } };
	reportPending = true;
	await fixture.runtime.submit(ref, "explicitly authorized repair");
	expect(await fs.readFile(path.join(fixture.cwd, "implementation.ts"), "utf8")).toBe("export const revision = 2;\n");
	await fixture.runtime.assertAuthority(ref);
}, 120_000);

test("native facade runInput retains real queued feedback and images on the exact owning session", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let first = true;
	await using fixture = await consumer({
		observe: async () => {
			if (first) {
				first = false;
				entered.resolve();
				await release.promise;
			}
		},
	});
	const ref = await fixture.prepare("requirements");
	const native = fixture.runtime.session(ref);
	const running = fixture.runtime.submit(ref, "initial native input");
	const feedback = "  原生排队输入\n保留正文 Ω  ";
	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
	try {
		await entered.promise;
		await fixture.runtime.runInput(ref, () =>
			native.prompt(feedback, {
				streamingBehavior: "followUp",
				images: [{ type: "image", data: image, mimeType: "image/png" }],
				expandPromptTemplates: false,
				runCommands: false,
				throwOnDrop: true,
			}),
		);
	} finally {
		release.resolve();
	}
	await running;
	expect(fixture.runtime.session(ref)).toBe(native);
	const users = native.messages.filter(
		message => message.role === "user" && contentText(message.content).includes(feedback),
	);
	expect(users).toHaveLength(1);
	const user = users[0];
	if (user?.role !== "user") throw new Error("Queued feedback is missing from its owning native session");
	expect(contentText(user.content)).toContain(feedback);
	if (!Array.isArray(user.content)) throw new Error("Queued image is missing from its owning native session");
	const normalized = user.content.find(part => part.type === "image");
	if (!normalized || normalized.type !== "image") throw new Error("Queued image is missing from native history");
	const metadata = parseImageMetadata(Buffer.from(normalized.data, "base64"));
	expect(metadata?.width).toBeGreaterThan(0);
	expect(metadata?.height).toBeGreaterThan(0);
	expect(normalized.mimeType).toBe(metadata!.mimeType);
	const request = fixture.provider.requests.findLast(request => hasUser(request, feedback));
	if (!request) throw new Error("Queued feedback never reached the actual image-capable provider");
	const delivered = request.messages.filter(
		message => message.role === "user" && contentText(message.content).includes(feedback),
	);
	expect(delivered).toHaveLength(1);
	if (!Array.isArray(delivered[0]!.content)) throw new Error("Queued image reached the provider as text only");
	expect(delivered[0]!.content.filter(part => isRecord(part) && part.type === "image_url")).toEqual([
		{ type: "image_url", image_url: { url: `data:${normalized.mimeType};base64,${normalized.data}` } },
	]);
	expect(
		fixture.root.messages.some(message => message.role === "user" && contentText(message.content).includes(feedback)),
	).toBe(false);
	expect(native.isStreaming).toBe(false);
	expect(native.getQueuedInputMessages()).toEqual([]);
}, 120_000);

test("technical context retains complete original specs and all supplied solution and plan material", async () => {
	const original = document(
		"Existing project authority",
		"Full existing constraints; final original specification line Ω.",
	);
	await using fixture = await consumer({}, async cwd => {
		const file = path.join(cwd, "openspec/specs/orders/spec.md");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, original);
	});
	const contextFiles = [
		{
			path: "docs/dev/development/sr-a/solution.md",
			content: "# Current solution\nComplete selected rationale and tradeoffs Ω\n",
		},
		{
			path: "docs/dev/development/sr-a/plan.md",
			content: "# Current plan\nEvery implementation and verification step Ω\n",
		},
	];
	const ref = await fixture.prepare("executing", { contextFiles });
	await fixture.runtime.submit(ref, "implement against the exact approved materials");
	const entry = fixture.runtime
		.session(ref)
		.messages.find(message => message.role === "custom" && message.customType === "dev-workflow-context");
	if (entry?.role !== "custom") throw new Error("Technical native workflow context is missing");
	const context = JSON.parse(contentText(entry.content)) as {
		contextFiles: Array<{ path: string; content: string }>;
	};
	expect(context.contextFiles).toContainEqual({ path: "openspec/specs/orders/spec.md", content: original });
	for (const file of contextFiles) expect(context.contextFiles).toContainEqual(file);
}, 120_000);

test("PR actors receive delivery-only instructions and complete real prior materials", async () => {
	await using fixture = await consumer();
	const contextFiles = ["solution", "plan", "completion", "ut", "st"].map(name => ({
		path: `docs/dev/development/${srId}/${name}.md`,
		content: `# ${name}\nActual prior ${name} material Ω\n`,
	}));
	for (const file of contextFiles) {
		await fs.mkdir(path.dirname(path.join(fixture.cwd, file.path)), { recursive: true });
		await fs.writeFile(path.join(fixture.cwd, file.path), file.content);
	}
	const outputPath = `docs/dev/development/${srId}/delivery.md`;
	const ref = await fixture.prepare("pr", { outputPaths: [outputPath], contextFiles });
	const entry = fixture.runtime
		.session(ref)
		.messages.find(message => message.role === "custom" && message.customType === "dev-workflow-context");
	if (entry?.role !== "custom") throw new Error("PR native workflow context is missing");
	const context = JSON.parse(contentText(entry.content)) as {
		outputContract: string;
		outputPaths: string[];
		contextFiles: typeof contextFiles;
	};
	expect(context.outputPaths).toEqual([outputPath]);
	for (const file of contextFiles) expect(context.contextFiles).toContainEqual(file);
	expect(context.outputContract).toContain("write only delivery.md");
	expect(context.outputContract).toContain("unrun checks and limitations");
	expect(context.outputContract).toContain("manual company PR preparation");
	expect(context.outputContract).toContain("NEVER modify implementation code");
	expect(context.outputContract).not.toContain("Write separate UT and ST reports");
	expect(fixture.provider.requests).toHaveLength(0);
}, 120_000);

test("native clones inherit root provider callbacks without taking provider registry ownership", async () => {
	// Runtime provider extensions must use a provider admitted by native catalog policy.
	const providerName = "deepseek";
	const modelId = "owned-native-model";
	const api = "dev-owned-native-api";
	const keys: Array<string | undefined> = [];
	let authCalls = 0;
	await using fixture = await consumer({}, undefined, {
		getApiKey: async () => {
			authCalls++;
			return "explicit-root-callback-key";
		},
		extensions: [
			extension => {
				extension.registerProvider(providerName, {
					baseUrl: "https://native-fixture.invalid/v1",
					apiKey: "provider-fallback-key",
					api,
					streamSimple: (_model, _context, options) => {
						const stream = createAssistantMessageEventStream();
						const message = {
							...createAssistantMessage("native custom provider completed"),
							api,
							provider: providerName,
							model: modelId,
						};
						void resolveApiKeyOnce(options?.apiKey, options?.signal).then(
							key => {
								keys.push(key);
								stream.push({ type: "start", partial: message });
								stream.push({ type: "done", reason: "stop", message });
							},
							error => {
								stream.push({
									type: "error",
									reason: "error",
									error: {
										...message,
										stopReason: "error",
										errorMessage: error instanceof Error ? error.message : String(error),
									},
								});
							},
						);
						return stream;
					},
					models: [
						{
							id: modelId,
							name: "Owned native model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					],
				});
			},
		],
	});
	const registry = fixture.root.modelRegistry;
	const ownedModel = registry.find(providerName, modelId);
	if (!ownedModel) throw new Error("Root extension provider was not registered");
	await fixture.root.setModel(ownedModel);
	const ref = await fixture.prepare("requirements");
	await fixture.runtime.submit(ref, "native clone request");
	expect(authCalls).toBeGreaterThan(0);
	expect(keys).toContain("explicit-root-callback-key");
	await fixture.runtime.dispose();
	expect(registry.find(providerName, modelId)).toBeDefined();
	await registry.refresh("offline");
	expect(registry.find(providerName, modelId)).toBeDefined();
	await fixture.root.prompt("root provider still works after native disposal");
	expect(keys.length).toBeGreaterThan(1);
	expect(keys.every(key => key === "explicit-root-callback-key")).toBe(true);
}, 120_000);

test("an idle real task descendant loses writable capability at its owner's completion boundary", async () => {
	const marker = "OMP_NATIVE_IDLE_DESCENDANT";
	let delegated = false;
	let lateWrite = false;
	let reported = false;
	await using fixture = await consumer({
		reply: request => {
			if (assignment(request, marker)) {
				if (hasUser(request, "late descendant write") && !lateWrite) {
					lateWrite = true;
					return { tool: { name: "write", args: { path: "late-descendant.ts", content: "must not land" } } };
				}
				return { text: "native child idle" };
			}
			if (hasUser(request, "create idle descendant") && !delegated) {
				delegated = true;
				return task(marker);
			}
			if (hasUser(request, "create idle descendant") && !reported) {
				reported = true;
				return {
					tool: {
						name: "write",
						args: {
							path: `docs/dev/development/${srId}/completion.md`,
							content: "# Descendant handoff\nUT: not run. ST: not run. No verification success claimed.\n",
						},
					},
				};
			}
			return { text: "execution completed" };
		},
	});
	const ref = await fixture.prepare("executing");
	const native = fixture.runtime.session(ref);
	await fixture.runtime.submit(ref, "create idle descendant");
	const child = AgentRegistry.global()
		.list()
		.find(agent => agent.parentId === native.getAgentId() && agent.kind === "sub")?.session;
	if (!child) throw new Error("Native task did not retain its actual idle session");
	await child.prompt("late descendant write");
	await expect(fs.stat(path.join(fixture.cwd, "late-descendant.ts"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(child.messages.some(message => message.role === "toolResult" && message.isError)).toBe(true);
	await fixture.runtime.assertAuthority(ref);
}, 120_000);

test("ordinary executor discussion without a completion report keeps the current authorized implementation writable", async () => {
	let next: Reply["tool"];
	await using fixture = await consumer({
		reply: () => {
			if (next) {
				const tool = next;
				next = undefined;
				return { tool };
			}
			return { text: "Implementation is still in progress; no completion report has been delivered." };
		},
	});
	const ref = await fixture.prepare("executing");
	await fixture.runtime.submit(ref, "clarify implementation before editing");
	next = { name: "write", args: { path: "ongoing.ts", content: "export const ongoing = true;\n" } };
	await fixture.runtime.submit(ref, "continue the same authorized implementation");
	expect(await fs.readFile(path.join(fixture.cwd, "ongoing.ts"), "utf8")).toBe("export const ongoing = true;\n");
	await expect(fs.stat(path.join(fixture.cwd, `docs/dev/development/${srId}/completion.md`))).rejects.toMatchObject({
		code: "ENOENT",
	});
}, 120_000);
