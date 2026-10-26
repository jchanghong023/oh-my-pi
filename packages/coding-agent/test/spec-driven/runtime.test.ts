import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import { createSpecDrivenRuntime, type SpecDrivenRuntime } from "../../src/spec-driven/runtime";
import {
	createProviderFixture,
	MARKER,
	REQUIREMENT,
	respond,
	rolePayload,
	type ModelRequest,
	type Reply,
} from "./provider-fixture";

async function consumer(options: Parameters<typeof createProviderFixture>[0] = {}) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-four-native-"));
	const agentDir = path.join(cwd, ".isolated-agent");
	await fs.mkdir(agentDir);
	const provider = createProviderFixture(options);
	const authStorage = await AuthStorage.create(":memory:");
	let session: AgentSession | undefined;
	let runtime: SpecDrivenRuntime | undefined;
	const dispose = async () => {
		await runtime?.dispose();
		await session?.dispose();
		authStorage.close();
		await provider[Symbol.asyncDispose]();
		HistoryStorage.close();
		closeSessionIndex();
		AgentStorage.close();
		closeModelCache();
		await fs.rm(cwd, { recursive: true, force: true });
	};
	try {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			`providers:\n  spec-fixture:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 1000000\n`,
		);
		const settings = Settings.isolated({
			modelRoles: { default: "spec-fixture/chat-a", smol: "spec-fixture/chat-a" },
			"compaction.enabled": false,
			"prewalk.enabled": false,
			"tools.xdev": false,
			"async.enabled": false,
			"todo.enabled": false,
		});
		const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
		const model = registry.find("spec-fixture", "chat-a");
		if (!model) throw new Error("Local runtime fixture model unavailable");
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			settings,
			model,
			authStorage,
			modelRegistry: registry,
			sessionManager: SessionManager.inMemory(),
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
		}));
		runtime = await createSpecDrivenRuntime({ session, settings, cwd });
		return {
			cwd,
			runtime,
			session,
			provider,
			orchestrator: new SpecDrivenOrchestrator(runtime.ports, runtime.options),
			[Symbol.asyncDispose]: dispose,
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

function lastInput(requests: ModelRequest[], role: string) {
	return requests.map(rolePayload).findLast(item => item?.specDrivenRole === role)?.input;
}

test("four real SDK actors write files, preserve full choice input and wait for acceptance", async () => {
	await using fixture = await consumer();
	const flow = fixture.orchestrator;
	let status = await flow.start(`${MARKER}: ${REQUIREMENT}`, "runtime-files");
	expect(status.phase, status.blockedReason).toBe("awaiting-specification");
	const requirementsActor = flow.recipient();
	status = await flow.confirmSpecification(" 原始需求确认\n保留原文 ");
	expect(status.phase, status.blockedReason).toBe("awaiting-choice");
	const fullSolution = status.solution!.content;
	const rawChoice = "  选用 pure，完整方案原文照办\n不要删去其他候选。  ";
	status = await flow.chooseCandidate("pure", rawChoice);
	expect(status.phase, status.blockedReason).toBe("awaiting-plan");
	const planner = lastInput(fixture.provider.requests, "planner");
	expect(planner?.userReply).toBe(rawChoice);
	expect(planner?.candidateId).toBe("pure");
	expect(JSON.stringify(planner?.files)).toContain("normalizer");
	expect(JSON.stringify(planner?.files)).toContain(JSON.stringify(fullSolution));
	status = await flow.confirmPlan("确认此完整计划");
	expect(status.phase, status.blockedReason).toBe("awaiting-acceptance");
	expect(await fs.readFile(path.join(fixture.cwd, "src/greeting.ts"), "utf8")).toContain("export function greet");
	const paths = status.paths!;
	const materialDirectory = path.join(fixture.cwd, path.dirname(paths.plan));
	expect((await fs.readdir(materialDirectory)).sort()).toEqual(
		[paths.solution, paths.plan, paths.report].map(file => path.basename(file)).sort(),
	);
	const executionBytes = await Promise.all(
		[paths.solution, paths.plan, paths.report].map(file => fs.readFile(path.join(fixture.cwd, file), "utf8")),
	);
	expect(
		new Set(
			fixture.provider.requests
				.map(rolePayload)
				.filter(Boolean)
				.map(item => item!.specDrivenRole),
		),
	).toEqual(new Set(["requirements", "solution", "planner", "executor"]));
	expect(requirementsActor?.actorId).not.toBe(flow.recipient()?.actorId);
	status = await flow.accept();
	expect(status.phase, status.blockedReason).toBe("completed");
	expect(status.archivedChangePath).toContain("openspec/changes/archive/");
	expect(
		await Promise.all(
			[paths.solution, paths.plan, paths.report].map(file => fs.readFile(path.join(fixture.cwd, file), "utf8")),
		),
	).toEqual(executionBytes);
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);

test("missing actual stage files never advance from successful chat text", async () => {
	await using fixture = await consumer({ fileFailure: { role: "requirements", kind: "missing" } });
	const status = await fixture.orchestrator.start(`${MARKER}: ${REQUIREMENT}`, "missing-files");
	expect(status.phase).toBe("requirements");
	expect(status.blockedReason).toBeTruthy();
}, 120_000);

test("pre-execution native writes cannot touch production code", async () => {
	let attempted = false;
	const attack = (request: ModelRequest): Reply => {
		if (!attempted && rolePayload(request)?.specDrivenRole === "requirements") {
			attempted = true;
			const write = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "write")?.function?.name;
			if (!write) throw new Error("Native write must be advertised for actual requirement files");
			return {
				tool: { name: write, args: { path: "src/unauthorized.ts", content: "export const unauthorized = true;" } },
			};
		}
		return respond(request);
	};
	await using fixture = await consumer({ reply: attack });
	const status = await fixture.orchestrator.start(`${MARKER}: ${REQUIREMENT}`, "guarded-files");
	expect(status.phase, status.blockedReason).toBe("awaiting-specification");
	expect(attempted).toBe(true);
	await expect(fs.stat(path.join(fixture.cwd, "src", "unauthorized.ts"))).rejects.toThrow();
	expect(JSON.stringify(fixture.provider.requests)).toContain("未授权的阶段文件写入");
}, 120_000);
