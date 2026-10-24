import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { createAgentSession } from "../../src/sdk";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { cfgCompactionKeepRecentTokens } from "../../src/session/context-settings";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import type { CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { assertSpecOwnedPath, createSpecExecutionTools } from "../../src/spec-driven/execution-tools";
import { SpecEvidenceService } from "../../src/spec-driven/evidence";
import { SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import { adaptSpecTeamResult, createSpecDrivenRuntime, type SpecDrivenRuntime } from "../../src/spec-driven/runtime";
import { loadSpecDrivenSkill } from "../../src/spec-driven/resources";
import type {
	SpecDrivenPorts,
	SpecDrivenStatus,
	SpecPlan,
	SpecPlanDraft,
	SpecRequirements,
	SpecRequirementsDraft,
	SpecReviewSlot,
	SpecTask,
} from "../../src/spec-driven/types";
import { parseSpecReview } from "../../src/spec-driven/schemas";
import type { TeamRunResult } from "../../src/team/types";
import { contentText, createProviderFixture, MARKER, REQUIREMENT, rolePayload } from "./provider-fixture";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-spec-"));
	roots.push(cwd);
	await fs.writeFile(path.join(cwd, "owned.txt"), "before\n");
	await fs.writeFile(path.join(cwd, "unrelated.txt"), "private\n");
	const context = { runId: "run", generation: 1, signal: new AbortController().signal };
	const task: SpecTask = {
		id: "T001",
		title: "Write",
		instructions: "update owned file",
		requirementIds: ["R1"],
		dependencies: [],
		conditionIds: [],
		ownedPaths: ["owned.txt"],
		implementationPaths: ["owned.txt"],
		solutionBinding: "one",
		validation: [{ id: "V1", command: "exit 0", behavior: "fixture command", inputPaths: ["owned.txt"] }],
		tdd: { mode: "exception", reason: "text fixture", alternativeCommands: ["exit 0"] },
	};
	const tools = createSpecExecutionTools({
		session: {
			cwd,
			hasUI: false,
			settings: Settings.isolated(),
			enableLsp: false,
			getSessionSpawns: () => null,
			getSessionFile: () => null,
		},
		task,
		context,
		artifactDir: path.join(cwd, "change", "checks"),
		evidence: new SpecEvidenceService({
			cwd,
			changeDir: path.join(cwd, "change"),
			owner: {
				actorId: "fixture",
				taskId: task.id,
				workspace: cwd,
				specificationVersion: "fixture-specification",
				planVersion: "fixture-plan",
			},
			run: context,
		}),
		onRecord() {},
	});
	return { cwd, tools, context };
}
const unusedContext = {} as CustomToolContext;

test("native write and edit adapters reject unowned targets before mutation", async () => {
	const { cwd, tools } = await fixture();
	const write = tools.tools.find(tool => tool.name === "write")!;
	const edit = tools.tools.find(tool => tool.name === "edit")!;
	await expect(
		write.execute("bad-write", { path: "unrelated.txt", content: "changed" }, undefined, unusedContext),
	).rejects.toThrow("Unowned");
	await expect(
		edit.execute(
			"bad-edit",
			{ path: "unrelated.txt", old_string: "private", new_string: "changed" },
			undefined,
			unusedContext,
		),
	).rejects.toThrow("Unowned");
	await expect(
		write.execute("device", { path: "xd://bash", content: "exit 0" }, undefined, unusedContext),
	).rejects.toThrow();
	expect(await fs.readFile(path.join(cwd, "unrelated.txt"), "utf8")).toBe("private\n");
	expect(tools.implementationStartedAt).toBeNull();
});

test("owned adapters reuse actual native mutation and cancellation stops subsequent writes", async () => {
	const { cwd, tools } = await fixture();
	const write = tools.tools.find(tool => tool.name === "write")!;
	await write.execute("owned-write", { path: "owned.txt", content: "after\n" }, undefined, unusedContext);
	expect(await fs.readFile(path.join(cwd, "owned.txt"), "utf8")).toBe("after\n");
	const edit = tools.tools.find(tool => tool.name === "edit")!;
	await edit.execute(
		"owned-edit",
		{ path: "owned.txt", old_string: "after", new_string: "edited" },
		undefined,
		unusedContext,
	);
	expect(await fs.readFile(path.join(cwd, "owned.txt"), "utf8")).toBe("edited\n");
	expect(tools.implementationStartedAt).not.toBeNull();
	const aborted = AbortSignal.abort();
	await expect(
		write.execute("cancelled-write", { path: "owned.txt", content: "late" }, undefined, unusedContext, aborted),
	).rejects.toThrow();
	expect(await fs.readFile(path.join(cwd, "owned.txt"), "utf8")).toBe("edited\n");
});

test("exact ownership rejects links escaping the checkout and ambiguous path forms", async () => {
	const { cwd } = await fixture();
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-outside-"));
	roots.push(outside);
	await fs.symlink(outside, path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
	await expect(assertSpecOwnedPath(cwd, "linked/file.txt", ["linked/file.txt"])).rejects.toThrow();
	for (const target of ["../owned.txt", "owned.txt:1-2", "owned.txt?x", "artifact://owned.txt", ".git/config"])
		await expect(assertSpecOwnedPath(cwd, target, [target])).rejects.toThrow();
	expect(await fs.readdir(outside)).toEqual([]);
});

test("verification refuses unapproved IDs without running a command or producing evidence", async () => {
	const { tools } = await fixture();
	const verify = tools.tools.find(tool => tool.name === "spec_verify")!;
	await expect(
		verify.execute("bad-verify", { validationId: "unapproved", stage: "green" }, undefined, unusedContext),
	).rejects.toThrow("Unapproved");
	expect(tools.records).toEqual([]);
});

test("native Team differences retain structured questions and stop choice until a real answer and new discussion", async () => {
	const difference = {
		ambiguity: "离线部署是否允许访问内部模型服务",
		interpretations: [
			{ view: "完全无网络", impact: "只能使用本地模型" },
			{ view: "允许内网", impact: "可以使用内部模型服务" },
		],
		affectsChoice: true,
	};
	const result: TeamRunResult = {
		runId: "discussion-structured",
		inputVersion: "spec-v1",
		status: "completed",
		reportMarkdown: "All ambiguity is resolved. Adopt A.", // Prose must not override the structured facts.
		candidates: [
			{
				id: "A",
				label: "A",
				version: "candidate-v1",
				proposal: "Native reviewed proposal",
				adoptable: true,
				reviewSucceeded: true,
				recheckSucceeded: true,
				unresolvedBlocking: [],
				conditions: ["Verify deployment connectivity"],
				assumptions: [],
				evidence: [],
			},
		],
		interpretationDifferences: [
			difference,
			{
				ambiguity: "报告使用哪种排版",
				interpretations: [{ view: "表格", impact: "只影响呈现" }],
				affectsChoice: false,
			},
		],
	};
	const adapted = adaptSpecTeamResult(result);
	expect(adapted.interpretationDifferences).toEqual([
		{
			id: "discussion-structured-D1",
			question:
				"请确认需求解释：离线部署是否允许访问内部模型服务\n1. 完全无网络\n影响：只能使用本地模型\n2. 允许内网\n影响：可以使用内部模型服务\n应采用哪种解释？请明确答复。",
			affectsChoice: true,
			resolved: false,
		},
		{
			id: "discussion-structured-D2",
			question: "请确认需求解释：报告使用哪种排版\n1. 表格\n影响：只影响呈现\n应采用哪种解释？请明确答复。",
			affectsChoice: false,
			resolved: false,
		},
	]);
	expect(adaptSpecTeamResult(result)).toEqual(adapted);
	expect(adaptSpecTeamResult({ ...result, runId: "another-discussion" }).interpretationDifferences[0]!.id).toBe(
		"another-discussion-D1",
	);
	expect(adapted.candidates[0]!.conditions).toEqual([{ id: "A-C1", description: "Verify deployment connectivity" }]);
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected downstream execution");
	};
	const answers: Array<string | undefined> = [];
	let discussion = 0;
	const ports: SpecDrivenPorts = {
		async handoff(input, context) {
			const body = `Detached Team-adapter fixture boundary: ${input.transition}`;
			return {
				actorId: "fixture-requirements",
				sessionId: "fixture-requirements-session",
				role: "requirements",
				runId: context.runId,
				generation: context.generation,
				transition: input.transition,
				path: `handoffs/${input.transition}.md`,
				digest: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
				body,
				versions: { "proposal.md": input.specification.version },
			};
		},
		artifacts: {
			async initialize() {},
			async writeRequirements() {
				return { version: "spec-v1" };
			},
			async readRequirements() {
				return { version: "spec-v1" };
			},
			async validateRequirements() {},
			writeSolution: unexpected,
			readSolution: unexpected,
			writePlan: unexpected,
			readPlan: unexpected,
			close: unexpected,
		},
		models: {
			async requirements() {
				return {
					proposal: "Deploy offline",
					specs: [
						{
							path: "specs/deployment/spec.md",
							content: "### Requirement: Offline\n#### Scenario: deployment\nOffline deployment",
						},
					],
					requirements: [{ id: "R1", text: "Deploy offline" }],
					questions: [],
				};
			},
			async review() {
				return {
					verdict: "pass",
					summary: "Independent requirements review",
					findings: [],
					resolutions: [],
					questions: [],
					evidenceChecks: [],
				};
			},
			plan: unexpected,
			execute: unexpected,
		},
		team: {
			async run(input) {
				answers.push(input.answer);
				return adaptSpecTeamResult(
					discussion++ === 0
						? result
						: {
								...result,
								runId: "discussion-after-answer",
								interpretationDifferences: result.interpretationDifferences.filter(item => !item.affectsChoice),
							},
				);
			},
		},
		git: { preflight: unexpected, commit: unexpected },
		evidence: {
			read: unexpected,
			async revalidate() {
				return { taskIds: [], reasons: [], overall: false };
			},
			async flush() {},
		},
		validation: { run: unexpected },
	};
	const core = new SpecDrivenOrchestrator(ports, { currentModel: "author", members: ["author", "reviewer"] });
	const draft = await core.start("Deploy offline", "deployment");
	const blocked = await core.confirmSpecification(draft.specification!.version);
	expect(blocked.phase).toBe("awaiting-answers");
	expect(blocked.paused).toBe(false);
	expect(blocked.questions).toEqual([adapted.interpretationDifferences[0]!.question]);
	expect(blocked.team).toEqual(adapted);
	await expect(core.chooseCandidate(result.runId, "A", "candidate-v1")).rejects.toThrow();
	expect(answers).toEqual([undefined]);
	const answered = await core.answer("允许访问内部模型服务，但禁止公网");
	expect(answered.phase).toBe("awaiting-choice");
	expect(answers).toEqual([undefined, "允许访问内部模型服务，但禁止公网"]);
	expect(answered.team!.runId).toBe("discussion-after-answer");
	expect(answered.team!.interpretationDifferences).toEqual([
		{ ...adapted.interpretationDifferences[1]!, id: "discussion-after-answer-D1" },
	]);
});

test("retained requirements producer survives approval wait and rebuilds fixed systems before a second real Provider request", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-retained-consumer-"));
	roots.push(cwd);
	const agentDir = path.join(cwd, ".isolated-agent");
	await fs.mkdir(agentDir);
	await using provider = createProviderFixture({ requirementsQuestion: "May greetings access the network?" });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  spec-fixture:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 1000000\n`,
	);
	const settings = Settings.isolated({
		modelRoles: { default: "spec-fixture/chat-a", smol: "spec-fixture/chat-a" },
		team: { members: ["spec-fixture/chat-a"] },
		"compaction.enabled": false,
		"prewalk.enabled": false,
		"tools.xdev": false,
	});
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const model = registry.find("spec-fixture", "chat-a");
	if (!model) throw new Error("Local fixture model unavailable");
	const { session } = await createAgentSession({
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
	});
	const producers: AgentSession[] = [];
	const originalPrompt = AgentSession.prototype.prompt;
	// Instrument the real SDK boundary; neither the actor nor its Provider result is mocked.
	const promptSpy = spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
		this: AgentSession,
		...args: Parameters<AgentSession["prompt"]>
	) {
		if (typeof args[0] === "string" && args[0].includes('"specDrivenRole":"requirements"')) {
			producers.push(this);
			if (producers.length > 1) await this.refreshBaseSystemPrompt();
		}
		return originalPrompt.apply(this, args);
	});
	let runtime: SpecDrivenRuntime | undefined;
	try {
		runtime = await createSpecDrivenRuntime({ session, settings, cwd });
		const orchestrator = new SpecDrivenOrchestrator(runtime.ports, runtime.options);
		const first = await orchestrator.start(`${MARKER}: ${REQUIREMENT}`, "retained-producer");
		expect(first.phase, first.blockedReason?.slice(0, 1000)).toBe("awaiting-answers");
		expect(producers).toHaveLength(1);
		const producer = producers[0]!;
		// The producer may adjust native handoff retention without writing into its parent.
		expect(producer.settings).not.toBe(settings);
		expect(cfgCompactionKeepRecentTokens.get(producer.settings)).toBe(cfgCompactionKeepRecentTokens.get(settings));
		// A live public maintenance call while waiting proves this is not merely a
		// persisted history ID belonging to a disposed one-shot worker.
		await producer.refreshBaseSystemPrompt();
		const requestStart = provider.requests.length;
		const second = await orchestrator.answer("Keep internal whitespace; exclude network access.");
		expect(second.phase, second.blockedReason?.slice(0, 1000)).toBe("awaiting-specification");
		expect(producers).toHaveLength(2);
		expect(producers[1]).toBe(producer);
		expect(second.generation).toBe(first.generation);
		// The same producer must also remain live while its completed draft waits
		// for explicit user approval; refreshing must not resurrect a replacement.
		await producer.refreshBaseSystemPrompt();
		const turns = provider.requests
			.slice(requestStart)
			.filter(
				request => (request.tools?.length ?? 0) > 0 && rolePayload(request)?.specDrivenRole === "requirements",
			);
		expect(turns.length).toBeGreaterThan(0);
		for (const [source, name] of [
			["superpowers", "brainstorming"],
			["jch", "jch-grill-me"],
		] as const) {
			const skill = await loadSpecDrivenSkill(source, name, { role: "requirements" });
			const body = (await fs.readFile(skill.filePath, "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").trim();
			expect(body.length).toBeGreaterThan(100);
			for (const request of turns) {
				const system = request.messages
					.filter(message => message.role === "system")
					.map(message => contentText(message.content))
					.join("\n");
				expect(system).toContain(body);
				// Business data stays in the user's payload, never in fixed authority.
				expect(system).not.toContain(REQUIREMENT);
				expect(system).not.toContain("Keep internal whitespace; exclude network access.");
			}
		}
		expect(provider.failures).toEqual([]);
	} finally {
		promptSpy.mockRestore();
		await runtime?.dispose();
		await session.dispose();
		authStorage.close();
		// Match the SDK isolation fixtures: Windows cannot remove temporary
		// databases until the shared native stores release their handles.
		HistoryStorage.close();
		closeSessionIndex();
		AgentStorage.close();
		closeModelCache();
	}
}, 600_000);

async function runtimeGit(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		},
	});
	const [output, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Runtime fixture Git failed (${code}): ${error}`);
	return output.trimEnd();
}

async function runtimeConsumer(workspaces: readonly string[] = ["."]) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-runtime-consumer-"));
	roots.push(cwd);
	const agentDir = path.join(cwd, ".isolated-agent");
	await fs.mkdir(agentDir);
	await fs.writeFile(path.join(cwd, ".gitignore"), ".isolated-agent/\n.omp/\nopenspec/\n");
	for (const workspace of workspaces) {
		await fs.mkdir(path.join(cwd, workspace), { recursive: true });
		await fs.writeFile(path.join(cwd, workspace, "prerequisite.txt"), "approved prerequisite\n");
	}
	await runtimeGit(cwd, "init");
	await runtimeGit(cwd, "config", "user.name", "Runtime Fixture");
	await runtimeGit(cwd, "config", "user.email", "runtime@example.test");
	await runtimeGit(cwd, "config", "core.hooksPath", path.join(cwd, "disabled-hooks"));
	await runtimeGit(cwd, "add", ".gitignore", ...workspaces.map(workspace => path.join(workspace, "prerequisite.txt")));
	await runtimeGit(cwd, "commit", "-m", "runtime fixture baseline");
	const provider = createProviderFixture();
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
	};
	try {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			`providers:\n  spec-fixture:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 1000000\n`,
		);
		const settings = Settings.isolated({
			modelRoles: { default: "spec-fixture/chat-a", smol: "spec-fixture/chat-a" },
			team: { members: ["spec-fixture/chat-a"] },
			"compaction.enabled": false,
			"prewalk.enabled": false,
			"tools.xdev": false,
		});
		const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
		const model = registry.find("spec-fixture", "chat-a");
		if (!model) throw new Error("Local runtime model unavailable");
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
		return { cwd, runtime, provider, [Symbol.asyncDispose]: dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}

async function runtimePlan(consumer: Awaited<ReturnType<typeof runtimeConsumer>>, workspace = ".") {
	const context = { runId: "runtime-consumer", generation: 1, signal: new AbortController().signal };
	const changeId = "runtime-boundary";
	const { ports } = consumer.runtime;
	await ports.artifacts.initialize(changeId, context);
	const draft: SpecRequirementsDraft = {
		proposal:
			"# Why\nRead the approved prerequisite.\n\n# What Changes\nAdd a scoped text result.\n\n# Impact\nFixture only.\n",
		specs: [
			{
				path: "specs/runtime/spec.md",
				content:
					"## ADDED Requirements\n\n### Requirement: Approved prerequisite\nThe runtime SHALL read the approved prerequisite.\n\n#### Scenario: Existing input\n- **WHEN** the prerequisite exists\n- **THEN** its content is available before creating the result\n",
			},
		],
		requirements: [{ id: "R1", text: "Read the approved prerequisite." }],
		questions: [],
	};
	const written = await ports.artifacts.writeRequirements(draft, context);
	const specification: SpecRequirements = { ...draft, version: written.version };
	await ports.artifacts.writeSolution(
		{
			specificationVersion: specification.version,
			runId: "runtime-team",
			candidateId: "scoped",
			candidateVersion: "scoped-version",
			proposal: "# Chosen solution\nRead the existing input, then create the owned result.\n",
			conditions: [],
		},
		context,
	);
	const command = `bun -e "console.log(require('node:fs').readFileSync('prerequisite.txt', 'utf8'))"`;
	const planDraft: SpecPlanDraft = {
		content: "# Approved plan\nT001 implements R1 after C1 passes.\n",
		workspace: { executionPath: workspace, isolation: "none", integration: "native" },
		tasks: [
			{
				id: "T001",
				title: "Create result",
				instructions: "Create the approved result after prerequisite qualification.",
				requirementIds: ["R1"],
				dependencies: [],
				conditionIds: ["C1"],
				ownedPaths: ["future.txt"],
				implementationPaths: [],
				solutionBinding: "scoped text result",
				validation: [{ id: "V1", command, behavior: "Read prerequisite", inputPaths: ["prerequisite.txt"] }],
				tdd: { mode: "exception", reason: "Text-only result", alternativeCommands: [command] },
			},
		],
		conditions: [{ id: "C1", description: "Existing prerequisite", command, inputPaths: ["prerequisite.txt"] }],
		finalValidation: [
			{ id: "entry", command, behavior: "Read prerequisite", inputPaths: ["prerequisite.txt"], realEntry: true },
		],
		closure: { sync: false, archive: true },
	};
	const planArtifact = await ports.artifacts.writePlan(planDraft, context);
	const plan: SpecPlan = {
		...planDraft,
		version: `approved-${workspace}`,
		artifactVersion: planArtifact.version,
		specificationVersion: specification.version,
		candidateVersion: "scoped-version",
		solutionVersion: "solution-version",
	};
	return { context, specification, plan, changeId };
}

function runtimeStatus(input: Awaited<ReturnType<typeof runtimePlan>>): SpecDrivenStatus {
	return {
		phase: "closing",
		paused: false,
		generation: input.context.generation,
		changeId: input.changeId,
		specification: input.specification,
		plan: input.plan,
		questions: [],
		reviews: [],
		pendingClosure: [],
		tasks: input.plan.tasks.map(task => ({
			id: task.id,
			fingerprint: "runtime-fixture",
			specificationVersion: input.specification.version,
			planVersion: input.plan.version,
			status: "pending",
			records: [],
			commits: [],
		})),
	};
}

test("runtime condition inputs qualify before dependent owned files exist and native reviewer returns structured result", async () => {
	await using consumer = await runtimeConsumer();
	const input = await runtimePlan(consumer);
	const { ports } = consumer.runtime;
	await ports.git.preflight(input, input.context);
	expect(existsSync(path.join(consumer.cwd, "future.txt"))).toBe(false);
	const id = await ports.validation.run(
		{
			purpose: "condition",
			id: "C1",
			command: input.plan.conditions[0]!.command,
		},
		input.context,
	);
	const [record] = await ports.evidence.read([id], input.context);
	expect(record!.result.exitCode).toBe(0);
	expect(record!.result.stdout).toContain("approved prerequisite");
	expect(record!.inputsBefore?.inputPaths).toEqual(["prerequisite.txt"]);
	expect(record!.inputsBefore?.complete).toBe(true);
	expect(record!.inputsAfter?.complete).toBe(true);
	expect((await ports.evidence.revalidate(input.context)).reasons).toEqual([]);
	const slot: SpecReviewSlot = {
		id: "runtime-review",
		kind: "requirements",
		model: "spec-fixture/chat-a",
		sameModelIndependent: true,
		revision: 0,
		findings: [],
	};
	const review = parseSpecReview(
		await ports.models.review(
			{
				kind: "requirements",
				slot,
				specification: input.specification,
				records: [],
				commits: [],
			},
			input.context,
		),
	);
	expect(review.verdict).toBe("pass");
	const request = consumer.provider.requests.find(
		item =>
			rolePayload(item)?.specDrivenRole === "reviewer" &&
			item.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "yield"),
	)!;
	expect(request).toBeDefined();
	const system = request.messages
		.filter(item => item.role === "system")
		.map(item => contentText(item.content))
		.join("\n");
	expect(system).not.toContain(input.specification.proposal);
	expect(consumer.provider.failures).toEqual([]);
}, 600_000);

test("runtime rebinds Git observations to a newly approved execution workspace and retains actual baselines", async () => {
	await using consumer = await runtimeConsumer(["a", "b"]);
	const input = await runtimePlan(consumer, "a");
	const { ports } = consumer.runtime;
	const directory = path.join(consumer.cwd, "openspec", "changes", input.changeId);
	const unknown = runtimeStatus(input);
	await ports.evidence.flush(unknown, input.context);
	const unknownReport = await fs.readFile(path.join(directory, "verification.md"), "utf8");
	const unknownProjection = JSON.parse(
		unknownReport.match(/## Git baseline and current observations\n\n[\s\S]*?```json\n([\s\S]*?)\n```/u)![1]!,
	);
	expect(unknownProjection).toEqual({ baselines: [], current: null });
	expect(unknownReport).toContain("Baselines: unknown");
	expect(unknownReport).toContain("Current: unknown");
	await ports.git.preflight(input, input.context);
	const first = runtimeStatus(input);
	await ports.evidence.flush(first, input.context);
	const original = first.gitEvidence!.baselines[0]!;
	await fs.writeFile(path.join(consumer.cwd, "b", "untracked.txt"), "observed local change\n");
	const next = {
		...input,
		plan: { ...input.plan, version: "approved-b", workspace: { ...input.plan.workspace, executionPath: "b" } },
	};
	await ports.git.preflight(next, input.context);
	const current = runtimeStatus(next);
	await ports.evidence.flush(current, input.context);
	expect(current.gitEvidence!.baselines).toHaveLength(2);
	expect(current.gitEvidence!.baselines[0]).toEqual(original);
	expect(current.gitEvidence!.baselines[1]!.workspace).toBe(await fs.realpath(path.join(consumer.cwd, "b")));
	expect(current.gitEvidence!.baselines[1]!.status).toContain("b/untracked.txt");
	expect(current.gitEvidence!.current!.workspace).toBe(await fs.realpath(path.join(consumer.cwd, "b")));
	expect(current.gitEvidence!.current!.head).toBe(await runtimeGit(consumer.cwd, "rev-parse", "HEAD"));
	expect(current.gitEvidence!.current!.status).toContain("b/untracked.txt");
	expect(current.gitEvidence!.current!.error).toBeUndefined();
	const report = await fs.readFile(path.join(directory, "verification.md"), "utf8");
	const projection = JSON.parse(
		report.match(/## Git baseline and current observations\n\n[\s\S]*?```json\n([\s\S]*?)\n```/u)![1]!,
	);
	const rawReference = report.match(/\[Raw stage observations\]\((checks\/status-[^)]+\.json)\)/u)![1]!;
	const raw = JSON.parse(await fs.readFile(path.join(directory, rawReference), "utf8"));
	expect(projection).toEqual(raw.status.gitEvidence);
	expect(projection.baselines).toHaveLength(2);
	expect(projection.baselines[0].workspace).toBe(await fs.realpath(path.join(consumer.cwd, "a")));
	expect(projection.baselines[0].head).toBe(original.head);
	expect(projection.baselines[1].workspace).toBe(await fs.realpath(path.join(consumer.cwd, "b")));
	expect(projection.baselines[1].head).toBe(await runtimeGit(consumer.cwd, "rev-parse", "HEAD"));
	expect(projection.current.workspace).toBe(await fs.realpath(path.join(consumer.cwd, "b")));
	expect(projection.current.head).toBe(await runtimeGit(consumer.cwd, "rev-parse", "HEAD"));
	expect(projection.current.status).toContain("b/untracked.txt");
}, 600_000);

test("runtime persists post-archive failure and retries from moved actual originals without recreating retired change", async () => {
	await using consumer = await runtimeConsumer();
	const input = await runtimePlan(consumer);
	const { ports } = consumer.runtime;
	await ports.git.preflight(input, input.context);
	await fs.writeFile(path.join(consumer.cwd, "future.txt"), "owned result\n");
	const recordId = await ports.validation.run(
		{
			purpose: "task",
			id: "T001:V1",
			command: input.plan.tasks[0]!.validation[0]!.command,
		},
		input.context,
	);
	const slot: SpecReviewSlot = {
		id: "archive-requirements-review",
		kind: "requirements",
		model: "spec-fixture/chat-a",
		sameModelIndependent: true,
		revision: 0,
		findings: [],
	};
	const review = parseSpecReview(
		await ports.models.review(
			{
				kind: "requirements",
				slot,
				specification: input.specification,
				records: [],
				commits: [],
			},
			input.context,
		),
	);
	const closure = {
		specification: input.specification,
		plan: input.plan,
		acceptanceVersion: "runtime-host-accepted",
		requirementsReview: { ...slot, lastReview: review, reviewedRevision: slot.revision },
	};
	const beforeArchive = runtimeStatus(input);
	beforeArchive.tasks[0]!.records = await ports.evidence.read([recordId], input.context);
	await ports.evidence.flush(beforeArchive, input.context);
	const retired = path.join(consumer.cwd, "openspec", "changes", input.changeId);
	const readFile = fs.readFile;
	let injected = false;
	const denied = spyOn(fs, "readFile").mockImplementation(
		new Proxy(readFile, {
			apply(target, receiver, args) {
				const file = typeof args[0] === "string" ? args[0] : "";
				const relative = path.relative(consumer.cwd, file).replaceAll(path.sep, "/");
				if (
					!injected &&
					!existsSync(retired) &&
					relative.startsWith("openspec/changes/archive/") &&
					relative.endsWith("/plan.md")
				) {
					injected = true;
					return Promise.reject(new Error("Archived plan observation denied"));
				}
				return Reflect.apply(target, receiver, args);
			},
		}),
	);
	try {
		await expect(ports.artifacts.close(closure, input.context)).rejects.toThrow("Archived plan observation denied");
	} finally {
		denied.mockRestore();
	}
	expect(injected).toBe(true);
	expect(existsSync(retired)).toBe(false);
	const status = runtimeStatus(input);
	status.paused = true;
	status.blockedReason = "Archived plan observation denied";
	status.tasks[0]!.records = await ports.evidence.read([recordId], input.context);
	await ports.evidence.flush(status, input.context);
	expect(status.tasks[0]!.records[0]!.artifact.path.replaceAll(path.sep, "/")).toContain("/openspec/changes/archive/");
	await fs.readFile(status.tasks[0]!.records[0]!.artifact.path, "utf8");
	expect(existsSync(retired)).toBe(false);
	const archiveRoot = path.join(consumer.cwd, "openspec", "changes", "archive");
	const archives = await fs.readdir(archiveRoot);
	expect(archives).toHaveLength(1);
	const archived = path.join(archiveRoot, archives[0]!);
	const report = await fs.readFile(path.join(archived, "verification.md"), "utf8");
	expect(report).toContain("Archived plan observation denied");
	expect(report).toContain(recordId);
	expect((await ports.evidence.revalidate(input.context)).reasons).toEqual([]);
	await ports.artifacts.close(closure, input.context);
	expect((await ports.artifacts.readPlan(input.context)).version).toBe(input.plan.artifactVersion);
	expect(existsSync(retired)).toBe(false);
	expect(await fs.readdir(archiveRoot)).toEqual(archives);
	expect(consumer.provider.failures).toEqual([]);
}, 600_000);
