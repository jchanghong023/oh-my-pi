import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { assertSpecOwnedPath, createSpecExecutionTools } from "../../src/spec-driven/execution-tools";
import { SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import { adaptSpecTeamResult } from "../../src/spec-driven/runtime";
import type { SpecDrivenPorts, SpecTask } from "../../src/spec-driven/types";
import type { TeamRunResult } from "../../src/team/types";

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
		validation: [{ id: "V1", command: "exit 0", behavior: "fixture command" }],
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
		artifactDir: cwd,
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

test("approved verification retains actual output identity and tool-call provenance", async () => {
	const { tools } = await fixture();
	const verify = tools.tools.find(tool => tool.name === "spec_verify")!;
	await verify.execute("real-approved-call", { validationId: "V1", stage: "green" }, undefined, unusedContext);
	expect(tools.records).toHaveLength(1);
	const record = tools.records[0]!;
	expect(record.toolCallId).toBe("real-approved-call");
	expect(record.args.command).toBe("exit 0");
	expect(record.result.exitCode).toBe(0);
	expect(record.finishedAt).toBeGreaterThanOrEqual(record.startedAt);
	expect(record.artifact.version).toMatch(/^[a-f0-9]{64}$/);
	const actual = JSON.parse(await fs.readFile(record.artifact.path, "utf8"));
	expect(actual.command).toBe(record.args.command);
	expect(actual.code).toBe(record.result.exitCode);
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
		artifacts: {
			async initialize() {},
			async writeRequirements() {
				return { version: "spec-v1" };
			},
			async readRequirements() {
				return { version: "spec-v1" };
			},
			async validateRequirements() {},
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
							path: "deployment/spec.md",
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
		evidence: { read: unexpected },
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
