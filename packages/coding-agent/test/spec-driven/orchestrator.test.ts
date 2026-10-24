import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SpecArtifactStore } from "../../src/spec-driven/artifacts";
import { describe, expect, it } from "bun:test";
import { SpecEvidenceService } from "../../src/spec-driven/evidence";
import { recordSpecCommand } from "../../src/spec-driven/execution-tools";
import { SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import type {
	SpecDrivenOptions,
	SpecDrivenPorts,
	SpecDrivenStatus,
	SpecExecution,
	SpecPlanDraft,
	SpecRequirementsDraft,
	SpecReview,
	SpecReviewInput,
	SpecRunContext,
	SpecTask,
	SpecToolRecord,
} from "../../src/spec-driven/types";

const digest = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function task(id = "T001", dependencies: string[] = []): SpecTask {
	return {
		id,
		title: `Implement ${id}`,
		instructions: `Implement approved behavior ${id}`,
		requirementIds: ["R1", "R2"],
		dependencies,
		conditionIds: [],
		ownedPaths: [`src/${id}.ts`, `test/${id}.test.ts`],
		implementationPaths: [`src/${id}.ts`],
		solutionBinding: "stable-interface",
		validation: [
			{
				id: "unit",
				command: `test ${id}`,
				behavior: `approved ${id}`,
				inputPaths: [`src/${id}.ts`, `test/${id}.test.ts`, "package.json"],
			},
		],
		tdd: { mode: "required", behavior: `approved ${id}` },
	};
}
function pass(input?: SpecReviewInput): SpecReview {
	const tdd = input?.task?.tdd;
	return {
		verdict: "pass",
		summary: "Independent source and execution review",
		findings: [],
		resolutions:
			input?.slot.findings
				.filter(item => item.severity !== "minor")
				.map(item => ({ findingId: item.id, resolved: true, evidence: "Inspected repair and rerun" })) ?? [],
		questions: [],
		evidenceChecks:
			tdd?.mode === "required"
				? [input?.execution?.redRecordId, input?.execution?.greenRecordId].map(id => ({
						recordId: id!,
						behavior: tdd.behavior,
						valid: true,
						reason: "Failure is the missing approved behavior; identical test passes after production write",
					}))
				: [],
	};
}
function failure(taskIds: string[] = []): SpecReview {
	return {
		verdict: "revise",
		summary: "A behavior is missing",
		findings: [
			{
				id: "F1",
				severity: "blocking",
				issue: "Missing boundary behavior",
				evidence: "Source branch and failing boundary scenario",
				taskIds,
			},
		],
		resolutions: [],
		questions: [],
		evidenceChecks: [],
	};
}
function fixture(options: Partial<SpecDrivenOptions> = {}) {
	const events: string[] = [];
	const ledger = new Map<string, SpecToolRecord>();
	const capturedReviews: SpecReviewInput[] = [];
	const documents = new Map<string, string>();
	let specVersion = "";
	let planVersion = "";
	let counter = 0;
	let solutionVersion = "";
	let time = 10;
	let requirementsDraft: SpecRequirementsDraft = {
		proposal: "Add approved behavior",
		specs: [{ path: "specs/capability/spec.md", content: "### Requirement: behavior\n#### Scenario: normal\nWorks" }],
		requirements: [
			{ id: "R1", text: "Approved behavior" },
			{ id: "R2", text: "Unrelated behavior" },
		],
		questions: [],
	};
	let planDraft: SpecPlanDraft = {
		content: "# Plan\n- [x] checkbox is not execution",
		workspace: { executionPath: ".", isolation: "native", integration: "native" },
		tasks: [task()],
		conditions: [],
		finalValidation: [
			{
				id: "entry",
				command: "run public-entry",
				behavior: "Actual public entry",
				inputPaths: ["src", "test", "package.json"],
				realEntry: true,
			},
		],
		closure: { sync: true, archive: true },
	};
	const record = (
		command: string,
		context: SpecRunContext,
		exitCode = 0,
		evidence: { task?: SpecTask; validationId?: string; stage?: "red" | "green" } = {},
	): SpecToolRecord => {
		const id = `tool-${++counter}`;
		const state: SpecDrivenStatus = orchestrator.status();
		const currentTask =
			evidence.task ?? state.plan?.tasks.find(item => item.validation.some(check => check.command === command));
		const validation =
			currentTask?.validation.find(check => check.command === command) ??
			state.plan?.finalValidation.find(check => check.command === command);
		const condition = state.plan?.conditions.find(check => check.command === command);
		const binding = {
			actorId: currentTask ? "fixture-executor" : "fixture-validation",
			taskId: currentTask?.id ?? null,
			workspace: "/fixture",
			specificationVersion: state.specification!.version,
			planVersion: state.plan!.version,
		};
		// Explicit local evidence for state-machine tests, not disk-content qualification.
		const inputPaths = validation?.inputPaths ?? [];
		const inputs = {
			id: `fixture-inputs-${counter}`,
			runId: context.runId,
			generation: context.generation,
			binding,
			inputPaths: [...inputPaths],
			entries: inputPaths.map(file => ({
				path: file,
				canonicalPath: `/fixture/${file}`,
				kind: "file" as const,
				digest: digest({ file, content: documents.get(file) ?? "declared fixture input" }),
			})),
			version: digest(inputPaths.map(file => [file, documents.get(file) ?? "declared fixture input"])),
			complete: true,
		};
		const item: SpecToolRecord = {
			id,
			toolCallId: `call-${counter}`,
			runId: context.runId,
			generation: context.generation,
			tool: "spec_verify",
			args: { command, cwd: "/fixture" },
			startedAt: time++,
			finishedAt: time++,
			binding,
			inputsBefore: structuredClone(inputs),
			inputsAfter: structuredClone(inputs),
			conditions: {
				platform: process.platform,
				shell: "fixture-shell",
				runtime: "fixture-runner",
				runtimeVersion: "1",
			},
			obligation: {
				validationId: evidence.validationId ?? validation?.id ?? condition?.id ?? command,
				approvedCommand: command,
				reason: null,
				...(evidence.stage ? { stage: evidence.stage } : {}),
			},
			result: {
				status: "completed",
				exitCode,
				stdout: exitCode
					? "Expected approved behavior, received missing implementation"
					: "Passed approved behavior",
				stderr: "",
				isError: false,
			},
			artifact: { path: `/evidence/${id}`, version: digest(id) },
		};
		ledger.set(id, item);
		return item;
	};
	const executeTask = async (approvedTask: SpecTask, context: SpecRunContext): Promise<SpecExecution> => {
		events.push(`execute:${approvedTask.id}`);
		const red = record(approvedTask.validation[0]!.command, context, 1, { task: approvedTask, stage: "red" });
		const implementationStartedAt = time++;
		documents.set(approvedTask.implementationPaths[0] ?? approvedTask.ownedPaths[0]!, "Actual owned implementation");
		const green = record(approvedTask.validation[0]!.command, context, 0, { task: approvedTask, stage: "green" });
		return {
			changedPaths: [approvedTask.ownedPaths[0]!],
			recordIds: [red.id, green.id],
			redRecordId: red.id,
			greenRecordId: green.id,
			implementationStartedAt,
			requestedTddException: null,
		};
	};
	const ports: SpecDrivenPorts = {
		async handoff(input, context) {
			events.push(`handoff:${input.transition}`);
			const role =
				input.transition === "requirements-to-solution"
					? "requirements"
					: input.transition === "solution-to-plan"
						? "solution"
						: "planner";
			const body = `Detached state-fixture native boundary: ${input.transition}`;
			return {
				actorId: `fixture-${role}`,
				sessionId: `fixture-session-${role}`,
				role,
				runId: context.runId,
				generation: context.generation,
				transition: input.transition,
				path: `handoffs/${input.transition}.md`,
				digest: crypto.createHash("sha256").update(body).digest("hex"),
				body,
				versions: {
					"proposal.md": input.specification.version,
					...(input.solution ? { "state.json#/solution": input.solution.artifactVersion } : {}),
					...(input.plan ? { "plan.md": input.plan.artifactVersion } : {}),
				},
			};
		},
		artifacts: {
			async initialize() {
				events.push("initialize");
			},
			async writeRequirements(draft) {
				events.push("write-requirements");
				documents.set("proposal", draft.proposal);
				specVersion = digest(draft);
				return { version: specVersion };
			},
			async readRequirements() {
				return { version: specVersion };
			},
			async validateRequirements() {
				events.push("validate-requirements");
			},
			async writeSolution(solution) {
				events.push("write-solution");
				documents.set("solution", JSON.stringify(solution));
				solutionVersion = digest(solution);
				return { version: solutionVersion };
			},
			async readSolution() {
				return { version: solutionVersion };
			},
			async writePlan(draft) {
				events.push("write-plan");
				documents.set("plan", draft.content);
				planVersion = digest(draft);
				return { version: planVersion };
			},
			async readPlan() {
				return { version: planVersion };
			},
			async close(input) {
				events.push("close");
				expect(input.requirementsReview.lastReview?.verdict).toBe("pass");
				documents.set("archived", input.acceptanceVersion);
			},
		},
		models: {
			async requirements() {
				events.push("requirements");
				return structuredClone(requirementsDraft);
			},
			async plan() {
				events.push("planner");
				return structuredClone(planDraft);
			},
			async execute(input, context, control) {
				while (true) {
					const states = control.status();
					const incomplete = states.filter(state => state.status !== "completed");
					if (incomplete.length === 0) return;
					const initial = incomplete.find(state => {
						const approved = input.plan.tasks.find(item => item.id === state.id)!;
						return approved.dependencies.every(id =>
							states.some(item => item.id === id && item.status === "completed"),
						);
					});
					if (!initial) throw new Error("Fixture executor has no dependency-ready approved task");
					let state = initial;
					while (state.status !== "completed") {
						const approvedTask = await control.start(state.id);
						const result =
							state.execution && !state.repairReview
								? state.execution
								: await executeTask(approvedTask, context);
						state = await control.checkpoint(approvedTask.id, result);
						if (orchestrator.status().paused) return;
					}
				}
			},
			async review(input) {
				events.push(`review:${input.kind}:${input.slot.model}:${input.slot.revision}`);
				capturedReviews.push(structuredClone(input));
				return pass(input);
			},
		},
		team: {
			async run(input) {
				events.push("team");
				return {
					runId: "discussion",
					inputVersion: input.specification.version,
					status: "completed",
					report: "A reviewed direction",
					interpretationDifferences: [],
					candidates: [
						{
							id: "A",
							label: "A",
							version: "candidate-v1",
							proposal: "Reviewed implementation direction",
							adoptable: true,
							reviewSucceeded: true,
							recheckSucceeded: true,
							unresolvedBlocking: [],
							conditions: [],
						},
					],
				};
			},
		},
		git: {
			async preflight() {
				events.push("git-preflight");
			},
			async commit(input) {
				events.push(`commit:${input.task.id}`);
				return {
					taskId: input.task.id,
					base: digest(`base-${counter}`),
					head: digest(`head-${counter}`),
					paths: input.changedPaths,
					reviewPackage: "Actual base/head review material",
				};
			},
		},
		evidence: {
			async read(ids) {
				return ids.flatMap(id => {
					const item = ledger.get(id);
					return item ? [structuredClone(item)] : [];
				});
			},
			async revalidate() {
				return { taskIds: [], reasons: [], overall: false };
			},
			async flush() {},
		},
		validation: {
			async run(input, context) {
				events.push(`validate:${input.purpose}:${input.id}`);
				return record(input.command, context, 0, { validationId: input.id }).id;
			},
		},
	};
	const orchestrator = new SpecDrivenOrchestrator(ports, {
		currentModel: "author",
		members: ["author", "reviewer", "third"],
		runId: "test-run",
		...options,
	});
	const toChoice = async () => {
		const state = await orchestrator.start("Implement approved behavior", "change");
		return orchestrator.confirmSpecification(state.specification!.version);
	};
	const toPlan = async () => {
		const state = await toChoice();
		const candidate = state.team!.candidates[0]!;
		return orchestrator.chooseCandidate(state.team!.runId, candidate.id, candidate.version);
	};
	const toAcceptance = async () => {
		const state = await toPlan();
		return orchestrator.confirmPlan(state.plan!.version);
	};
	return {
		ports,
		orchestrator,
		events,
		ledger,
		capturedReviews,
		documents,
		record,
		executeTask,
		toChoice,
		toPlan,
		toAcceptance,
		setRequirements(value: SpecRequirementsDraft) {
			requirementsDraft = value;
		},
		getRequirements() {
			return structuredClone(requirementsDraft);
		},
		setPlan(value: SpecPlanDraft) {
			planDraft = value;
		},
		getPlan() {
			return structuredClone(planDraft);
		},
		editSpec() {
			specVersion = "external-spec-edit";
		},
		editPlan() {
			planVersion = "external-plan-edit";
		},
		editSolution() {
			solutionVersion = "external-solution-edit";
		},
	};
}

/** A runner-owned filesystem ledger; model responses only reference its record IDs. */
async function contentFixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-content-"));
	const f = fixture();
	const store = new SpecArtifactStore({ cwd, changeId: "change" });
	const artifactDir = path.join(cwd, store.changeDir, "checks");
	const plan = f.getPlan();
	plan.tasks = [task("T001"), task("T002", ["T001"]), task("T003")];
	await fs.mkdir(path.join(cwd, "src"), { recursive: true });
	await fs.mkdir(path.join(cwd, "test"), { recursive: true });
	await fs.mkdir(path.join(cwd, "config"), { recursive: true });
	await fs.writeFile(path.join(cwd, "package.json"), "{}\n");
	for (const item of plan.tasks) {
		await fs.mkdir(path.join(cwd, "src", item.id), { recursive: true });
		await fs.writeFile(path.join(cwd, `src/${item.id}.ts`), "missing\n");
		await fs.writeFile(path.join(cwd, `config/${item.id}.json`), "{}\n");
		await fs.writeFile(
			path.join(cwd, `test/${item.id}.test.ts`),
			`const fs = require('node:fs');\nconst actual = fs.readFileSync('src/${item.id}.ts', 'utf8');\nif (actual !== 'approved\\n') { console.error('Expected approved behavior; missing implementation'); process.exit(1); }\nconsole.log('Passed approved behavior');\n`,
		);
		item.validation[0]!.command = `"${process.execPath}" "test/${item.id}.test.ts"`;
		item.validation[0]!.inputPaths.push(`src/${item.id}`, `config/${item.id}.json`);
	}
	plan.finalValidation[0]!.command = plan.tasks.map(item => item.validation[0]!.command).join(" && ");
	plan.finalValidation[0]!.inputPaths.push("config");
	f.setPlan(plan);
	f.ports.artifacts.writeRequirements = async draft => store.writeRequirements(draft);
	f.ports.artifacts.readRequirements = async () => store.readRequirements();
	f.ports.artifacts.writeSolution = async solution => store.writeSolution(solution);
	f.ports.artifacts.readSolution = async () => store.readSolution();
	f.ports.artifacts.writePlan = async draft => store.writePlan(draft);
	f.ports.artifacts.readPlan = async () => store.readPlan();

	// Match the runtime's consuming qualification pointers, while retaining real service originals.
	const qualifications = new Map<string, SpecEvidenceService>();
	let call = 0;
	const run = async (command: string, context: SpecRunContext, destination = artifactDir, stage?: "red" | "green") => {
		const status = f.orchestrator.status();
		const approvedTask = status.plan?.tasks.find(item => item.validation.some(check => check.command === command));
		const validation =
			approvedTask?.validation.find(check => check.command === command) ??
			status.plan?.finalValidation.find(check => check.command === command);
		const binding =
			validation && status.plan && status.specification
				? {
						actorId: approvedTask ? `filesystem-executor-${approvedTask.id}` : "filesystem-validation",
						taskId: approvedTask?.id ?? null,
						workspace: cwd,
						specificationVersion: status.specification.version,
						planVersion: status.plan.version,
					}
				: undefined;
		const service = binding
			? new SpecEvidenceService({
					cwd,
					changeDir: path.join(cwd, store.changeDir),
					owner: binding,
					run: { runId: context.runId, generation: context.generation },
				})
			: undefined;
		const record = await recordSpecCommand({
			cwd,
			command,
			context,
			toolCallId: `filesystem-call-${++call}`,
			artifactDir: destination,
			...(service && binding && validation
				? {
						evidence: {
							binding,
							capture: () =>
								service.capture({ inputPaths: validation.inputPaths, validationId: validation.id }, context),
						},
						obligation: {
							validationId: validation.id,
							approvedCommand: validation.command,
							reason: null,
							...(stage ? { stage } : {}),
						},
					}
				: {}),
		});
		f.ledger.set(record.id, record);
		if (service && stage !== "red") qualifications.set(approvedTask?.id ?? "final", service);
		return record;
	};
	const evidence = {
		...f.ports.evidence,
		async revalidate(context: SpecRunContext) {
			const taskIds = new Set<string>();
			const reasons: string[] = [];
			let overall = false;
			for (const [id, service] of qualifications) {
				const invalid = await service.revalidate(context);
				if (!invalid.reasons.length) continue;
				qualifications.delete(id);
				for (const taskId of invalid.taskIds) taskIds.add(taskId);
				reasons.push(...invalid.reasons);
				overall ||= invalid.overall;
			}
			return { taskIds: [...taskIds], reasons, overall };
		},
		async flush(_status: unknown, _context: SpecRunContext) {
			// Preserve actual originals before publishing the fixture's observed command index.
			for (const record of f.ledger.values()) await fs.readFile(record.artifact.path);
			await fs.writeFile(
				path.join(cwd, store.changeDir, "verification.md"),
				[...f.ledger.values()].map(record => `- checks/${path.basename(record.artifact.path)}\n`).join(""),
			);
		},
	};
	f.ports.evidence = evidence;
	f.ports.models.execute = async (_input, context, control) => {
		for (const state of control.status()) {
			if (state.status === "completed") continue;
			const approvedTask = await control.start(state.id);
			f.events.push(`execute:${approvedTask.id}`);
			if (state.execution) {
				const checkpoint = await control.checkpoint(approvedTask.id, state.execution);
				if (checkpoint.status !== "completed") return;
				continue;
			}
			await fs.writeFile(path.join(cwd, approvedTask.implementationPaths[0]!), "missing\n");
			const red = await run(approvedTask.validation[0]!.command, context, artifactDir, "red");
			const implementationStartedAt = Date.now();
			await fs.writeFile(path.join(cwd, approvedTask.implementationPaths[0]!), "approved\n");
			const green = await run(approvedTask.validation[0]!.command, context, artifactDir, "green");
			const checkpoint = await control.checkpoint(approvedTask.id, {
				changedPaths: approvedTask.implementationPaths,
				recordIds: [red.id, green.id],
				redRecordId: red.id,
				greenRecordId: green.id,
				implementationStartedAt,
				requestedTddException: null,
			});
			if (checkpoint.status !== "completed") return;
		}
	};
	f.ports.validation.run = async (input, context) => {
		f.events.push(`validate:${input.purpose}:${input.id}`);
		return (await run(input.command, context)).id;
	};
	const context: SpecRunContext = { runId: "test-run", generation: 0, signal: new AbortController().signal };
	const diagnostics = (state: SpecDrivenStatus) =>
		JSON.stringify(
			{
				phase: state.phase,
				blockedReason: state.blockedReason,
				records: [...f.ledger.values()].map(record => ({
					id: record.id,
					command: record.args,
					result: record.result,
					artifact: record.artifact.path,
				})),
			},
			null,
			2,
		);
	return { ...f, cwd, store, artifactDir, run, context, evidence, diagnostics, preparedPlan: plan };
}

describe("current-content evidence qualification", () => {
	for (const boundary of ["solution discussion", "planner", "plan reviewer"] as const) {
		it(`demotes preserved same-fingerprint tasks and dependents after input mutation during ${boundary}`, async () => {
			const f = await contentFixture();
			try {
				const ready = await f.toAcceptance();
				expect(ready.phase, f.diagnostics(ready)).toBe("awaiting-acceptance");
				const mutate = () => fs.writeFile(path.join(f.cwd, "config/T001.json"), '{"changed":true}\n');
				if (boundary === "solution discussion") {
					const run = f.ports.team.run;
					f.ports.team.run = async (input, context) => {
						await mutate();
						return run(input, context);
					};
				} else if (boundary === "planner") {
					const plan = f.ports.models.plan;
					f.ports.models.plan = async (input, context) => {
						await mutate();
						return plan(input, context);
					};
				} else {
					const review = f.ports.models.review;
					let changed = false;
					f.ports.models.review = async (input, context) => {
						if (input.kind === "plan" && !changed) {
							changed = true;
							await mutate();
						}
						return review(input, context);
					};
				}
				const choice = await f.orchestrator.changeSolution("Reconsider the same approved implementation");
				const candidate = choice.team!.candidates[0]!;
				let rebound = await f.orchestrator.chooseCandidate(choice.team!.runId, candidate.id, candidate.version);
				if (rebound.paused) rebound = await f.orchestrator.resume();
				expect(rebound.phase, f.diagnostics(rebound)).toBe("awaiting-plan");
				expect(rebound.specificationApproval).toBe(ready.specificationApproval);
				expect(rebound.acceptanceVersion).toBeUndefined();
				for (const id of ["T001", "T002"]) {
					const before = ready.tasks.find(item => item.id === id)!;
					const after = rebound.tasks.find(item => item.id === id)!;
					expect(after.fingerprint).toBe(before.fingerprint);
					expect(after.status).toBe("implemented");
					expect(after.validatedIds).toEqual([]);
					expect(after.review?.id).toBe(before.review?.id);
					expect(after.review?.revision).toBe(before.review?.revision);
					expect(after.review?.reviewedRevision).toBeUndefined();
				}
				const unrelated = rebound.tasks.find(item => item.id === "T003")!;
				const before = ready.tasks.find(item => item.id === "T003")!;
				expect(unrelated.status).toBe("completed");
				expect(unrelated.records).toEqual(before.records);
				expect(unrelated.review).toEqual(before.review);
				const validations = f.events.filter(event => event.startsWith("validate:task:")).length;
				const renewed = await f.orchestrator.confirmPlan(rebound.plan!.version);
				expect(renewed.phase, f.diagnostics(renewed)).toBe("awaiting-acceptance");
				expect(f.events.filter(event => event.startsWith("validate:task:")).length).toBe(validations + 2);
				expect(renewed.acceptanceVersion).not.toBe(ready.acceptanceVersion);
			} finally {
				await fs.rm(f.cwd, { recursive: true, force: true });
			}
		});
	}

	for (const boundary of ["task", "overall"] as const) {
		it(`aborts ${boundary} review when selected input changes immediately before independent invocation`, async () => {
			const f = await contentFixture();
			let reviewContext: SpecRunContext | undefined;
			try {
				if (boundary === "task") {
					const commit = f.ports.git.commit;
					f.ports.git.commit = async (input, context) => {
						reviewContext = context;
						const result = await commit(input, context);
						if (input.task.id === "T001")
							await fs.writeFile(path.join(f.cwd, "config/T001.json"), '{"changed":true}\n');
						return result;
					};
				} else {
					const validate = f.ports.validation.run;
					f.ports.validation.run = async (input, context) => {
						reviewContext = context;
						const id = await validate(input, context);
						if (input.purpose === "final")
							await fs.writeFile(path.join(f.cwd, "config/T001.json"), '{"changed":true}\n');
						return id;
					};
				}
				const blocked = await f.toAcceptance();
				expect(blocked.paused, f.diagnostics(blocked)).toBe(true);
				expect(blocked.blockedReason).toContain("Review inputs changed before independent analysis");
				expect(blocked.acceptanceVersion).toBeUndefined();
				expect(blocked.finalApproval).toBeUndefined();
				expect(blocked.tasks.find(item => item.id === "T001")!.status).toBe("implemented");
				expect(f.capturedReviews.filter(input => input.kind === boundary)).toHaveLength(0);
				expect(f.events).not.toContain("close");
				// The runtime consumes stale qualification pointers; a second refresh cannot rediscover this edit.
				expect(await f.evidence.revalidate(reviewContext!)).toEqual({ taskIds: [], reasons: [], overall: false });
			} finally {
				await fs.rm(f.cwd, { recursive: true, force: true });
			}
		});
	}

	for (const mutation of ["implementation", "test", "config", "untracked creation", "input deletion"] as const) {
		it(`rejects stale accept after actual ${mutation} and invalidates only affected dependent work`, async () => {
			const f = await contentFixture();
			try {
				if (mutation === "untracked creation") {
					const initialized = await f.run("git init && git add src test config package.json", f.context);
					expect(initialized.result.exitCode).toBe(0);
				}
				const ready = await f.toAcceptance();
				expect(ready.phase, f.diagnostics(ready)).toBe("awaiting-acceptance");
				const original = ready.tasks.find(item => item.id === "T003")!;
				if (mutation === "implementation") await fs.appendFile(path.join(f.cwd, "src/T001.ts"), "// changed\n");
				if (mutation === "test") await fs.appendFile(path.join(f.cwd, "test/T001.test.ts"), "// changed\n");
				if (mutation === "config") await fs.writeFile(path.join(f.cwd, "config/T001.json"), '{"mode":"new"}\n');
				if (mutation === "untracked creation") {
					await fs.writeFile(path.join(f.cwd, "src/T001/new-input.ts"), "new dependency\n");
					const status = await f.run(
						"git status --porcelain --untracked-files=all -- src/T001/new-input.ts",
						f.context,
					);
					expect(status.result.exitCode).toBe(0);
					expect(status.result.stdout).toContain("?? src/T001/new-input.ts");
				}
				if (mutation === "input deletion") await fs.unlink(path.join(f.cwd, "config/T001.json"));
				const blocked = await f.orchestrator.accept(ready.acceptanceVersion!);
				expect(blocked.phase).not.toBe("completed");
				expect(blocked.acceptanceVersion).not.toBe(ready.acceptanceVersion);
				expect(f.events).not.toContain("close");
				expect(blocked.specificationApproval).toBe(ready.specificationApproval);
				expect(blocked.planApproval).toBe(ready.planApproval);
				for (const id of ["T001", "T002"]) {
					const current = blocked.tasks.find(item => item.id === id)!;
					const previous = ready.tasks.find(item => item.id === id)!;
					expect(current.status !== "completed" || digest(current.records) !== digest(previous.records)).toBe(
						true,
					);
					expect(current.review?.revision ?? previous.review!.revision).toBeGreaterThanOrEqual(
						previous.review!.revision,
					);
				}
				expect(blocked.tasks.find(item => item.id === "T003")).toEqual(original);
				for (const record of ready.tasks.flatMap(item => item.records))
					expect((await fs.readFile(record.artifact.path, "utf8")).length).toBeGreaterThan(0);
			} finally {
				await fs.rm(f.cwd, { recursive: true, force: true });
			}
		});
	}

	it("preserves approvals and evidence for unrelated docs, same-content commits and generated reports", async () => {
		const f = await contentFixture();
		try {
			const baseline = await f.run(
				"git init && git add src test config package.json && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m baseline && git rev-parse HEAD",
				f.context,
			);
			expect(baseline.result.exitCode).toBe(0);
			const ready = await f.toAcceptance();
			expect(ready.phase, f.diagnostics(ready)).toBe("awaiting-acceptance");
			const executions = f.events.filter(event => event.startsWith("execute:"));
			await fs.writeFile(path.join(f.cwd, "unrelated.md"), "Unrelated explanation\n");
			const commit = await f.run(
				"git -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -m same-content && git rev-parse HEAD",
				f.context,
			);
			expect(commit.result.exitCode).toBe(0);
			expect(commit.result.stdout.trim().split(/\r?\n/).at(-1)).not.toBe(
				baseline.result.stdout.trim().split(/\r?\n/).at(-1),
			);
			await f.evidence.flush(ready, f.context);
			await fs.appendFile(path.join(f.cwd, f.store.changeDir, "verification.md"), "\nReport-only annotation\n");
			const closed = await f.orchestrator.accept(ready.acceptanceVersion!);
			expect(closed.phase).toBe("completed");
			expect(closed.specificationApproval).toBe(ready.specificationApproval);
			expect(closed.planApproval).toBe(ready.planApproval);
			expect(closed.tasks).toEqual(ready.tasks);
			expect(f.events.filter(event => event.startsWith("execute:"))).toEqual(executions);
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	});

	it("revokes final-only qualifications without revoking unchanged task or document approvals", async () => {
		const f = await contentFixture();
		try {
			await fs.writeFile(path.join(f.cwd, "entry.config.json"), '{"enabled":true}\n');
			f.preparedPlan.finalValidation[0]!.inputPaths.push("entry.config.json");
			f.preparedPlan.finalValidation[0]!.command += ` && "${process.execPath}" -e "if (!JSON.parse(require('node:fs').readFileSync('entry.config.json', 'utf8')).enabled) process.exit(1)"`;
			f.setPlan(f.preparedPlan);
			const ready = await f.toAcceptance();
			expect(ready.phase, f.diagnostics(ready)).toBe("awaiting-acceptance");
			await fs.writeFile(path.join(f.cwd, "entry.config.json"), '{"enabled":false}\n');
			const blocked = await f.orchestrator.accept(ready.acceptanceVersion!);
			expect(blocked.phase).not.toBe("completed");
			expect(blocked.acceptanceVersion).not.toBe(ready.acceptanceVersion);
			expect(blocked.tasks).toEqual(ready.tasks);
			expect(blocked.specificationApproval).toBe(ready.specificationApproval);
			expect(blocked.planApproval).toBe(ready.planApproval);
			expect(f.events).not.toContain("close");
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	});

	it("does not qualify new input bytes produced by an otherwise successful verification command", async () => {
		const f = await contentFixture();
		try {
			f.preparedPlan.finalValidation[0]!.command += ` && "${process.execPath}" -e "require('node:fs').appendFileSync('src/T001.ts', '// rewritten by verification\\n')"`;
			f.setPlan(f.preparedPlan);
			const blocked = await f.toAcceptance();
			expect(await fs.readFile(path.join(f.cwd, "src/T001.ts"), "utf8"), f.diagnostics(blocked)).toContain(
				"rewritten by verification",
			);
			expect(blocked.acceptanceVersion).toBeUndefined();
			expect(blocked.phase).not.toBe("awaiting-acceptance");
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	});

	it("blocks publication when raw persistence fails and retains the original evidence", async () => {
		const f = await contentFixture();
		try {
			const obstruction = path.join(f.cwd, "not-a-directory");
			await fs.writeFile(obstruction, "preserve obstruction\n");
			const run = f.ports.validation.run;
			f.ports.validation.run = async (input, context) =>
				input.purpose === "final" ? (await f.run(input.command, context, obstruction)).id : run(input, context);
			const blocked = await f.toAcceptance();
			expect(blocked.paused, f.diagnostics(blocked)).toBe(true);
			expect(blocked.acceptanceVersion).toBeUndefined();
			expect(f.capturedReviews.some(input => input.kind === "overall")).toBe(false);
			expect(await fs.readFile(obstruction, "utf8")).toBe("preserve obstruction\n");
			for (const record of f.ledger.values())
				expect((await fs.readFile(record.artifact.path, "utf8")).length).toBeGreaterThan(0);
			expect(f.events).not.toContain("close");
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	});

	it("does not close or replace the previous report when flushing raw evidence fails", async () => {
		const f = await contentFixture();
		try {
			const ready = await f.toAcceptance();
			expect(ready.phase, f.diagnostics(ready)).toBe("awaiting-acceptance");
			const report = path.join(f.cwd, f.store.changeDir, "verification.md");
			await fs.writeFile(report, "Previous published evidence\n");
			const obstruction = path.join(f.cwd, "blocked-raw-destination");
			await fs.writeFile(obstruction, "not a directory\n");
			f.evidence.flush = async () => {
				await fs.mkdir(path.join(obstruction, "checks"), { recursive: true });
				await fs.writeFile(report, "Must not publish success\n");
			};
			const blocked = await f.orchestrator.accept(ready.acceptanceVersion!);
			expect(blocked.paused).toBe(true);
			expect(blocked.phase).not.toBe("completed");
			expect(f.events).not.toContain("close");
			expect(await fs.readFile(report, "utf8")).toBe("Previous published evidence\n");
			for (const record of f.ledger.values())
				expect((await fs.readFile(record.artifact.path, "utf8")).length).toBeGreaterThan(0);
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	});
});

describe("formal approval and complete parent-task contracts", () => {
	for (const target of [
		"proposal.md",
		"selected candidate",
		"task projection",
		"plan body",
		"coverage table",
	] as const) {
		it(`rejects old confirm-plan after actual ${target} byte tampering`, async () => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-formal-"));
			try {
				const f = fixture();
				const store = new SpecArtifactStore({ cwd, changeId: "change" });
				f.ports.artifacts.writeRequirements = async draft => store.writeRequirements(draft);
				f.ports.artifacts.readRequirements = async () => store.readRequirements();
				f.ports.artifacts.writeSolution = async solution => store.writeSolution(solution);
				f.ports.artifacts.readSolution = async () => store.readSolution();
				f.ports.artifacts.writePlan = async draft => store.writePlan(draft);
				f.ports.artifacts.readPlan = async () => store.readPlan();
				const ready = await f.toPlan();
				expect(ready.phase).toBe("awaiting-plan");
				const runtime = target === "selected candidate" || target === "task projection";
				const relative = runtime
					? store.statePath
					: target === "proposal.md"
						? `${store.changeDir}/proposal.md`
						: store.planPath;
				const file = path.join(cwd, relative);
				const bytes = await fs.readFile(file, "utf8");
				if (runtime) {
					const state = JSON.parse(bytes);
					if (target === "selected candidate") state.solution.proposal += "\nUnapproved interface.";
					else state.plan.tasks[0].instructions += "\nUnapproved obligation.";
					await fs.writeFile(file, JSON.stringify(state));
				} else if (target === "coverage table") {
					const row = bytes.split(/\r?\n/).find(line => line.startsWith("|") && line.includes("R1"));
					expect(row).toBeDefined();
					await fs.writeFile(file, bytes.replace(row!, "| R1 | T999 |"));
				} else {
					await fs.writeFile(file, `${bytes}\nUnapproved ${target} change.\n`);
				}
				const blocked = await f.orchestrator.confirmPlan(ready.plan!.version);
				expect(blocked.paused).toBe(true);
				expect(blocked.planApproval).toBeUndefined();
				expect(f.events.some(event => event.startsWith("execute:"))).toBe(false);
				expect(f.events).not.toContain("git-preflight");
			} finally {
				await fs.rm(cwd, { recursive: true, force: true });
			}
		});
	}

	function coveredFixture() {
		const f = fixture();
		const requirements = f.getRequirements();
		requirements.requirements.push({ id: "R3", text: "Explicitly affected existing scenario" });
		requirements.proposal += "\nPreserve the affected existing scenario.\n";
		f.setRequirements(requirements);
		const plan = f.getPlan();
		plan.tasks = [
			{ ...task("T001"), requirementIds: ["R1", "R3"] },
			{ ...task("T002"), requirementIds: ["R2", "R3"] },
		];
		f.setPlan(plan);
		return f;
	}

	it("allows many-to-many coverage of new and explicitly affected existing requirements before review", async () => {
		const f = coveredFixture();
		expect((await f.toPlan()).phase).toBe("awaiting-plan");
		const reviewed = f.capturedReviews.find(input => input.kind === "plan")!;
		expect(reviewed.plan!.tasks.map(item => [item.id, item.requirementIds])).toEqual([
			["T001", ["R1", "R3"]],
			["T002", ["R2", "R3"]],
		]);
		expect(f.events.some(event => event.startsWith("execute:"))).toBe(false);
	});

	for (const defect of [
		"omitted affected R3",
		"empty references",
		"duplicate references",
		"unknown reference",
		"duplicate task ID",
	] as const) {
		it(`blocks ${defect} before independent plan review or implementation`, async () => {
			const f = coveredFixture();
			const plan = f.getPlan();
			if (defect === "omitted affected R3") {
				plan.tasks[0]!.requirementIds = ["R1"];
				plan.tasks[1]!.requirementIds = ["R2"];
			}
			if (defect === "empty references") plan.tasks[0]!.requirementIds = [];
			if (defect === "duplicate references") plan.tasks[0]!.requirementIds.push("R1");
			if (defect === "unknown reference") plan.tasks[0]!.requirementIds.push("HISTORICAL-OUT-OF-SCOPE");
			if (defect === "duplicate task ID") plan.tasks[1]!.id = "T001";
			f.setPlan(plan);
			const state = await f.toPlan();
			expect(state.paused).toBe(true);
			expect(state.planApproval).toBeUndefined();
			expect(f.capturedReviews.some(input => input.kind === "plan")).toBe(false);
			expect(f.events.some(event => event.startsWith("execute:"))).toBe(false);
		});
	}

	it("allows same-ID coverage repair after an incomplete draft is rejected before plan review", async () => {
		const f = coveredFixture();
		const plan = f.getPlan();
		plan.tasks[0]!.requirementIds = ["R1"];
		plan.tasks[1]!.requirementIds = ["R2"];
		f.setPlan(plan);
		const rejected = await f.toPlan();
		expect(rejected.paused).toBe(true);
		expect(rejected.blockedReason).toBe("Plan omits requirement R3");
		expect(rejected.plan).toBeUndefined();
		expect(rejected.planApproval).toBeUndefined();
		expect(f.events).not.toContain("write-plan");
		expect(f.capturedReviews.some(input => input.kind === "plan")).toBe(false);

		plan.tasks[0]!.requirementIds = ["R1", "R3"];
		f.setPlan(plan);
		const repaired = await f.orchestrator.resume();
		expect(repaired.paused).toBe(false);
		expect(repaired.phase).toBe("awaiting-plan");
		expect(repaired.planApproval).toBeUndefined();
		const reviews = f.capturedReviews.filter(input => input.kind === "plan");
		expect(reviews).toHaveLength(1);
		expect(reviews[0]!.plan!.tasks.map(item => [item.id, item.requirementIds])).toEqual([
			["T001", ["R1", "R3"]],
			["T002", ["R2"]],
		]);
		expect(f.events.some(event => event.startsWith("execute:"))).toBe(false);

		const approved = await f.orchestrator.confirmPlan(repaired.plan!.version);
		expect(approved.paused).toBe(false);
		expect(approved.planApproval).toBe(repaired.plan!.version);
		expect(approved.phase).toBe("awaiting-acceptance");

		plan.tasks[0]!.requirementIds = ["R1"];
		plan.tasks[1]!.requirementIds = ["R2", "R3"];
		f.setPlan(plan);
		const choice = await f.orchestrator.changeSolution("Reconsider the implementation direction");
		const candidate = choice.team!.candidates[0]!;
		const reassigned = await f.orchestrator.chooseCandidate(choice.team!.runId, candidate.id, candidate.version);
		expect(reassigned.paused).toBe(true);
		expect(reassigned.blockedReason).toBe("Stable task ID T001 was reassigned");
		expect(reassigned.planApproval).toBeUndefined();
		expect(f.capturedReviews.filter(input => input.kind === "plan")).toHaveLength(1);
	});

	it("saves selected candidate bytes and conditions before dispatching the planner", async () => {
		const f = fixture();
		const proposal =
			"# Chosen design\r\n\r\nInterface: `getSample()` → `{ value: 1 }`.\r\n\r\nTrade-off: explicit ordering.  \r\n";
		const conditions = [
			{ id: "C1", description: "Existing entry remains compatible", command: "check compatibility" },
		];
		const run = f.ports.team.run;
		f.ports.team.run = async (input, context) => {
			const result = await run(input, context);
			result.candidates[0]!.proposal = proposal;
			result.candidates[0]!.conditions = conditions;
			return result;
		};
		const plan = f.getPlan();
		plan.conditions = [{ ...conditions[0]!, inputPaths: ["package.json"] }];
		plan.tasks[0]!.conditionIds = ["C1"];
		f.setPlan(plan);
		const planner = f.ports.models.plan;
		f.ports.models.plan = async (input, context) => {
			expect(f.events).toContain("write-solution");
			expect(JSON.parse(f.documents.get("solution")!)).toEqual({
				specificationVersion: input.specification.version,
				runId: "discussion",
				candidateId: "A",
				candidateVersion: "candidate-v1",
				proposal,
				conditions,
			});
			expect(input.candidate.proposal).toBe(proposal);
			return planner(input, context);
		};
		expect((await f.toPlan()).phase).toBe("awaiting-plan");
		expect(f.events.indexOf("write-solution")).toBeLessThan(f.events.indexOf("planner"));
	});

	it("does not dispatch the planner when selected solution publication fails", async () => {
		const f = fixture();
		f.ports.artifacts.writeSolution = async () => {
			throw new Error("solution publication failed");
		};
		expect((await f.toPlan()).paused).toBe(true);
		expect(f.events).not.toContain("planner");
	});

	it("rejects old confirm-plan after an external solution edit without dispatch", async () => {
		const f = fixture();
		const state = await f.toPlan();
		f.editSolution();
		const blocked = await f.orchestrator.confirmPlan(state.plan!.version);
		expect(blocked.paused).toBe(true);
		expect(blocked.planApproval).toBeUndefined();
		expect(f.events.some(event => event.startsWith("execute:"))).toBe(false);
	});

	for (const defect of [
		"escaped workspace",
		"absolute workspace",
		"empty inputs",
		"escaped input",
		"shell input",
		"absolute input",
	] as const) {
		it(`rejects ${defect} before plan review`, async () => {
			const f = fixture();
			const plan = f.getPlan();
			if (defect === "escaped workspace") plan.workspace.executionPath = "../other-checkout";
			if (defect === "absolute workspace") plan.workspace.executionPath = "/other-checkout";
			if (defect === "empty inputs") plan.tasks[0]!.validation[0]!.inputPaths = [];
			if (defect === "escaped input") plan.tasks[0]!.validation[0]!.inputPaths = ["../credentials"];
			if (defect === "shell input") plan.tasks[0]!.validation[0]!.inputPaths = ["$(cat secret)"];
			if (defect === "absolute input") plan.finalValidation[0]!.inputPaths = ["C:\\outside\\input"];
			f.setPlan(plan);
			expect((await f.toPlan()).paused).toBe(true);
			expect(f.capturedReviews.some(input => input.kind === "plan")).toBe(false);
		});
	}

	for (const defect of ["empty reason", "missing alternative"] as const) {
		it(`rejects a preapproved TDD exception with ${defect}`, async () => {
			const f = fixture();
			const plan = f.getPlan();
			plan.tasks[0]!.tdd = {
				mode: "exception",
				reason: defect === "empty reason" ? "" : "Documentation-only task",
				alternativeCommands: defect === "missing alternative" ? [] : ["inspect rendered documentation"],
			};
			f.setPlan(plan);
			expect((await f.toPlan()).paused).toBe(true);
			expect(f.capturedReviews.some(input => input.kind === "plan")).toBe(false);
		});
	}
});

describe("whole-stage autonomous execution", () => {
	for (const mode of ["normal", "goal"] as const) {
		it(`lets one ${mode} stage choose inline then overlapping dispatch without another approval`, async () => {
			const f = fixture();
			const plan = f.getPlan();
			plan.tasks = [task("T001"), task("T002", ["T001"]), task("T003", ["T001"])];
			f.setPlan(plan);
			let stages = 0;
			const order: string[] = [];
			f.ports.models.execute = async (input, context, control) => {
				stages++;
				expect(input.mode).toBe(mode);
				expect(input.tasks.map(state => state.id)).toEqual(["T001", "T002", "T003"]);
				const first = await control.start("T001");
				order.push("inline:T001");
				const firstState = await control.checkpoint(first.id, await f.executeTask(first, context));
				expect(firstState.status).toBe("completed");
				expect(f.events).toContain("validate:task:T001:unit");
				expect(
					f.capturedReviews.filter(review => review.kind === "task" && review.task?.id === first.id),
				).toHaveLength(1);
				const release = Promise.withResolvers<void>();
				let admitted = 0;
				const dispatch = async (id: string) => {
					const approved = await control.start(id);
					order.push(`dispatch:${id}`);
					if (++admitted === 2) release.resolve();
					await release.promise;
					const completed = await control.checkpoint(id, await f.executeTask(approved, context));
					expect(completed.status).toBe("completed");
				};
				await Promise.all([dispatch("T003"), dispatch("T002")]);
			};
			const ready = await f.toPlan();
			const result =
				mode === "normal"
					? await f.orchestrator.confirmPlan(ready.plan!.version)
					: await f.orchestrator.confirmPlan(ready.plan!.version, { mode });
			expect(result.phase).toBe("awaiting-acceptance");
			expect(result.executionMode).toBe(mode);
			expect(stages).toBe(1);
			expect(order).toEqual(["inline:T001", "dispatch:T003", "dispatch:T002"]);
			expect(result.tasks.every(state => state.status === "completed")).toBe(true);
			expect(f.events).not.toContain("close");
			for (const id of ["T001", "T002", "T003"])
				expect(f.capturedReviews.filter(review => review.kind === "task" && review.task?.id === id)).toHaveLength(
					1,
				);
		});
	}

	it("refuses an unready dependent and does not trust detached status or final prose", async () => {
		const f = fixture();
		const plan = f.getPlan();
		plan.tasks = [task("T001"), task("T002", ["T001"])];
		f.setPlan(plan);
		f.ports.models.execute = async (_input, _context, control) => {
			await expect(control.start("T002")).rejects.toThrow();
			await expect(control.start("unknown")).rejects.toThrow();
			const projection = control.status();
			projection[0]!.status = "completed";
			expect(control.status()[0]!.status).toBe("pending");
			await expect(control.start("T002")).rejects.toThrow();
		};
		const result = await f.toAcceptance();
		expect(result.phase).not.toBe("awaiting-acceptance");
		expect(result.tasks.every(state => state.status !== "completed")).toBe(true);
		expect(f.events).not.toContain("validate:final:entry");
		expect(f.capturedReviews.some(review => review.kind === "task")).toBe(false);
	});
	it("keeps approved material contracts authoritative over executor snapshot edits", async () => {
		const f = fixture();
		const plan = f.getPlan();
		plan.tasks = [task("T001"), task("T002", ["T001"])];
		f.setPlan(plan);
		f.ports.models.execute = async (input, context, control) => {
			const claimed = input.plan.tasks[1]!;
			claimed.dependencies = [];
			claimed.ownedPaths.push("outside-approved-scope.ts");
			claimed.validation = [];
			claimed.tdd = { mode: "exception", reason: "Executor preference", alternativeCommands: ["true"] };
			await expect(control.start("T002")).rejects.toThrow();
			const first = await control.start("T001");
			await control.checkpoint(first.id, await f.executeTask(first, context));
			const approved = await control.start("T002");
			expect(approved).toEqual(plan.tasks[1]!);
			const result = await f.executeTask(approved, context);
			result.changedPaths.push("outside-approved-scope.ts");
			await control.checkpoint(approved.id, result);
		};
		const result = await f.toAcceptance();
		expect(result.tasks[1]!.status).not.toBe("completed");
		expect(result.phase).not.toBe("awaiting-acceptance");
		expect(result.acceptanceVersion).toBeUndefined();
		expect(result.plan!.tasks[1]).toEqual(plan.tasks[1]!);
		expect(f.events).not.toContain("validate:final:entry");
	});
});
describe("SpecDrivenOrchestrator", () => {
	it("runs every gate, keeps document readiness separate, and closes only after explicit acceptance", async () => {
		const f = fixture();
		const specification = await f.orchestrator.start("Implement behavior", "change");
		expect(specification.phase).toBe("awaiting-specification");
		expect(f.events).not.toContain("team");
		const choices = await f.orchestrator.confirmSpecification(specification.specification!.version);
		expect(choices.phase).toBe("awaiting-choice");
		expect(f.events).not.toContain("planner");
		const plan = await f.orchestrator.chooseCandidate("discussion", "A", "candidate-v1");
		expect(plan.phase).toBe("awaiting-plan");
		expect(plan.tasks[0]!.status).toBe("pending");
		expect(f.events).not.toContain("git-preflight");
		const ready = await f.orchestrator.confirmPlan(plan.plan!.version);
		expect(ready.phase).toBe("awaiting-acceptance");
		expect(ready.tasks[0]!.status).toBe("completed");
		expect(f.events).not.toContain("close");
		expect(f.events.indexOf("validate:final:entry")).toBeLessThan(
			f.events.findIndex(item => item.startsWith("review:overall")),
		);
		const closed = await f.orchestrator.accept(ready.acceptanceVersion!);
		expect(closed.phase).toBe("completed");
		expect(f.documents.get("archived")).toBe(ready.acceptanceVersion);
		expect(f.capturedReviews.map(input => input.kind)).toEqual(["requirements", "plan", "task", "overall"]);
	});

	it("rejects stale spec, discussion, candidate, plan and final approvals without dispatch", async () => {
		const f = fixture();
		await f.orchestrator.start("Request", "change");
		await expect(f.orchestrator.confirmSpecification("stale")).rejects.toThrow("Stale specification");
		expect(f.events).not.toContain("team");
		await f.orchestrator.confirmSpecification(f.orchestrator.status().specification!.version);
		await expect(f.orchestrator.chooseCandidate("old", "A", "candidate-v1")).rejects.toThrow("Stale discussion");
		await expect(f.orchestrator.chooseCandidate("discussion", "A", "old")).rejects.toThrow("Stale or ineligible");
		const plan = await f.orchestrator.chooseCandidate("discussion", "A", "candidate-v1");
		await expect(f.orchestrator.confirmPlan("old")).rejects.toThrow("Stale plan");
		expect(f.events.some(item => item.startsWith("execute:"))).toBe(false);
		await f.orchestrator.confirmPlan(plan.plan!.version);
		await expect(f.orchestrator.accept("old")).rejects.toThrow("Stale final");
		expect(f.events).not.toContain("close");
	});

	it("rejects zero candidates, failed rechecks and stale Team inputs", async () => {
		for (const mode of ["zero", "recheck", "stale", "failed"] as const) {
			const f = fixture();
			const original = f.ports.team.run;
			f.ports.team.run = async (input, context) => {
				const result = await original(input, context);
				if (mode === "zero") result.candidates = [];
				if (mode === "recheck") result.candidates[0]!.recheckSucceeded = false;
				if (mode === "stale") result.inputVersion = "old";
				if (mode === "failed") result.status = "failed";
				return result;
			};
			const state = await f.toChoice();
			expect(state.paused).toBe(true);
			expect(f.events).not.toContain("planner");
		}
	});

	it("requires an actual answer and a fresh Team run for choice-affecting ambiguity", async () => {
		const f = fixture();
		const original = f.ports.team.run;
		f.ports.team.run = async (input, context) => {
			const result = await original(input, context);
			if (!input.answer)
				result.interpretationDifferences = [
					{ id: "D1", question: "Which behavior is intended?", affectsChoice: true, resolved: false },
				];
			return result;
		};
		const state = await f.toChoice();
		expect(state.phase).toBe("awaiting-answers");
		await expect(f.orchestrator.chooseCandidate("discussion", "A", "candidate-v1")).rejects.toThrow();
		const answered = await f.orchestrator.answer("The documented behavior");
		expect(answered.phase).toBe("awaiting-choice");
		expect(f.events.filter(item => item === "team")).toHaveLength(2);
	});

	it("pins a single reviewer through two repairs and never reopens a failed cap on resume", async () => {
		const f = fixture();
		let reviews = 0;
		f.ports.models.review = async input => {
			f.capturedReviews.push(structuredClone(input));
			reviews++;
			return failure();
		};
		const state = await f.orchestrator.start("Request", "change");
		expect(state.paused).toBe(true);
		expect(state.blockedReason).toContain("two repair rounds");
		expect(reviews).toBe(3);
		expect(f.capturedReviews.map(input => input.slot.revision)).toEqual([0, 1, 2]);
		expect(new Set(f.capturedReviews.map(input => input.slot.id)).size).toBe(1);
		expect(new Set(f.capturedReviews.map(input => input.slot.model))).toEqual(new Set(["reviewer"]));
		await f.orchestrator.resume();
		expect(reviews).toBe(3);
	});

	it("requires explicit resolution evidence and stable finding IDs during recheck", async () => {
		for (const mode of ["missing", "renamed", "invalid"] as const) {
			const f = fixture();
			let reviews = 0;
			f.ports.models.review = async () => {
				if (reviews++ === 0) return failure();
				if (mode === "invalid") return { verdict: "pass" };
				if (mode === "renamed") {
					const result = failure();
					result.findings[0]!.id = "new-id";
					return result;
				}
				return pass();
			};
			const state = await f.orchestrator.start("Request", "change");
			expect(state.paused).toBe(true);
			expect(f.events).not.toContain("team");
		}
	});

	it("enforces the same two-repair cap at plan, task and overall slots", async () => {
		for (const kind of ["plan", "task", "overall"] as const) {
			const f = fixture();
			const original = f.ports.models.review;
			f.ports.models.review = async (input, context) => {
				if (input.kind !== kind) return original(input, context);
				f.capturedReviews.push(structuredClone(input));
				return failure(kind === "overall" ? ["T001"] : []);
			};
			const ready = await f.toPlan();
			const state = kind === "plan" ? ready : await f.orchestrator.confirmPlan(ready.plan!.version);
			expect(state.paused).toBe(true);
			expect(state.blockedReason).toContain("two repair rounds");
			const reviews = f.capturedReviews.filter(input => input.kind === kind);
			expect(reviews.map(input => input.slot.revision)).toEqual([0, 1, 2]);
			expect(new Set(reviews.map(input => input.slot.id)).size).toBe(1);
			expect(new Set(reviews.map(input => input.slot.model)).size).toBe(1);
			expect(state.acceptanceVersion).toBeUndefined();
		}
	});

	it("applies a requirements repair and mandatory evidence-backed recheck in the original seat", async () => {
		const f = fixture();
		const original = f.ports.models.review;
		let first = true;
		f.ports.models.review = async (input, context) => {
			if (input.kind === "requirements" && first) {
				first = false;
				f.capturedReviews.push(structuredClone(input));
				const amended = f.getRequirements();
				amended.specs[0]!.content += "\n#### Scenario: boundary\nBoundary is preserved";
				f.setRequirements(amended);
				return failure();
			}
			return original(input, context);
		};
		const state = await f.orchestrator.start("Request", "change");
		expect(state.phase).toBe("awaiting-specification");
		expect(state.specification!.specs[0]!.content).toContain("Scenario: boundary");
		const reviews = f.capturedReviews.filter(input => input.kind === "requirements");
		expect(reviews).toHaveLength(2);
		expect(reviews[0]!.slot.id).toBe(reviews[1]!.slot.id);
		expect(reviews[1]!.slot.findings[0]!.id).toBe("F1");
		expect(state.reviews[0]!.lastReview!.resolutions[0]!.resolved).toBe(true);
	});

	it("rotates ordered configured reviewers and labels a same-model independent context", async () => {
		const f = fixture();
		await f.toAcceptance();
		expect(f.capturedReviews.map(input => input.slot.model)).toEqual(["reviewer", "reviewer", "third", "reviewer"]);
		const single = fixture({ members: undefined });
		await single.toAcceptance();
		expect(
			single.capturedReviews.every(input => input.slot.sameModelIndependent && input.slot.model === "author"),
		).toBe(true);
		expect(() => fixture({ unavailableMembers: ["bad"] })).toThrow("Unavailable team.members");
	});

	it("runs dependencies serially and never unlocks a rejected predecessor", async () => {
		const f = fixture();
		const plan = f.getPlan();
		plan.tasks = [task("T002", ["T001"]), task("T001")];
		f.setPlan(plan);
		await f.toAcceptance();
		expect(f.events.filter(item => item.startsWith("execute:"))).toEqual(["execute:T001", "execute:T002"]);
		const blocked = fixture();
		blocked.setPlan(plan);
		const original = blocked.ports.models.review;
		blocked.ports.models.review = async (input, context) =>
			input.kind === "task" ? failure(["T001"]) : original(input, context);
		const state = await blocked.toAcceptance();
		expect(state.paused).toBe(true);
		expect(blocked.events).not.toContain("execute:T002");
	});

	it("rejects missing and cyclic dependency graphs before execution", async () => {
		for (const dependency of ["T999", "T002"]) {
			const f = fixture();
			const plan = f.getPlan();
			plan.tasks = [task("T001", [dependency]), task("T002", ["T001"])];
			f.setPlan(plan);
			const state = await f.toPlan();
			expect(state.paused).toBe(true);
			expect(f.events.some(item => item.startsWith("execute:"))).toBe(false);
		}
	});

	it("turns candidate assumptions into executable plan conditions and blocks on real failed checks", async () => {
		for (const complete of [false, true]) {
			const f = fixture();
			const original = f.ports.team.run;
			f.ports.team.run = async (input, context) => {
				const result = await original(input, context);
				result.candidates[0]!.conditions = [{ id: "C1", description: "Required platform exists" }];
				return result;
			};
			const plan = f.getPlan();
			if (complete) {
				plan.conditions = [
					{
						id: "C1",
						description: "Required platform exists",
						command: "check platform",
						inputPaths: ["package.json"],
					},
				];
				plan.tasks[0]!.conditionIds = ["C1"];
			}
			f.setPlan(plan);
			f.ports.validation.run = async (input, context) =>
				f.record(input.command, context, input.purpose === "condition" ? 1 : 0).id;
			const ready = await f.toPlan();
			const state = complete ? await f.orchestrator.confirmPlan(ready.plan!.version) : ready;
			expect(state.paused).toBe(true);
			expect(f.events.some(item => item.startsWith("execute:"))).toBe(false);
		}
	});

	it("rejects counterfeit ledger evidence, arbitrary RED, missing semantics and new TDD exemptions", async () => {
		for (const mode of [
			"missing-ledger",
			"future-generation",
			"arbitrary-red",
			"late-red",
			"no-semantic-review",
			"new-exemption",
		] as const) {
			const f = fixture();
			f.ports.models.execute = async (_input, context, control) => {
				const approvedTask = await control.start("T001");
				const result = await f.executeTask(approvedTask, context);
				if (mode === "missing-ledger") f.ledger.clear();
				if (mode === "future-generation") f.ledger.get(result.redRecordId!)!.generation++;
				if (mode === "arbitrary-red") f.ledger.get(result.redRecordId!)!.args.command = "unrelated failing command";
				if (mode === "late-red") result.implementationStartedAt = 0;
				if (mode === "new-exemption") result.requestedTddException = "Skip TDD now";
				await control.checkpoint(approvedTask.id, result);
			};
			if (mode === "no-semantic-review")
				f.ports.models.review = async input => ({ ...pass(input), evidenceChecks: [] });
			const state = await f.toAcceptance();
			expect(state.paused).toBe(true);
			expect(state.tasks[0]!.status).not.toBe("completed");
			expect(f.events).not.toContain("validate:final:entry");
		}
	});

	it("honors preapproved TDD exceptions with actual alternate and final validation", async () => {
		const f = fixture();
		const plan = f.getPlan();
		plan.tasks[0]!.tdd = {
			mode: "exception",
			reason: "Documentation only",
			alternativeCommands: ["check documentation"],
		};
		plan.tasks[0]!.implementationPaths = [];
		plan.tasks[0]!.validation = [
			{
				id: "docs",
				command: "check documentation",
				behavior: "Published documentation is valid",
				inputPaths: ["docs"],
			},
		];
		f.setPlan(plan);
		f.ports.models.execute = async (_input, _context, control) => {
			await control.start("T001");
			await control.checkpoint("T001", {
				changedPaths: [],
				recordIds: [],
				redRecordId: null,
				greenRecordId: null,
				implementationStartedAt: null,
				requestedTddException: null,
			});
		};
		const state = await f.toAcceptance();
		expect(state.phase).toBe("awaiting-acceptance");
		expect(f.events).toContain("validate:task:T001:docs");
		expect(f.events.some(event => event.startsWith("commit:"))).toBe(false);
		expect(f.capturedReviews.find(input => input.kind === "task")!.records.length).toBeGreaterThan(0);
	});

	it("cancels in-flight dispatch, rejects late model writes, and resumes without repeating valid work", async () => {
		const f = fixture();
		const original = f.ports.models.execute;
		const started = Promise.withResolvers<void>();
		const lateResult = Promise.withResolvers<SpecExecution>();
		f.ports.models.execute = async (_input, context, control) => {
			const approvedTask = await control.start("T001");
			const result = await f.executeTask(approvedTask, context);
			started.resolve();
			await lateResult.promise;
			await control.checkpoint(approvedTask.id, result);
		};
		const ready = await f.toPlan();
		const active = f.orchestrator.confirmPlan(ready.plan!.version);
		await started.promise;
		f.orchestrator.pause();
		lateResult.resolve({
			changedPaths: [],
			recordIds: [],
			redRecordId: null,
			greenRecordId: null,
			implementationStartedAt: null,
			requestedTddException: null,
		});
		await active;
		expect(f.orchestrator.status().tasks[0]!.status).toBe("pending");
		expect(f.events).not.toContain("commit:T001");
		f.ports.models.execute = original;
		const state = await f.orchestrator.resume();
		expect(state.phase).toBe("awaiting-acceptance");
		expect(f.events.filter(item => item === "requirements")).toHaveLength(1);
		expect(f.events.filter(item => item === "planner")).toHaveLength(1);
		f.orchestrator.pause();
		await expect(f.orchestrator.accept(state.acceptanceVersion!)).rejects.toThrow();
		await f.orchestrator.resume();
		expect(f.events.filter(item => item === "commit:T001")).toHaveLength(1);
	});

	it("preserves completed unrelated work and files while invalidating downstream approvals on amendment", async () => {
		const f = fixture();
		const originalPlan = f.getPlan();
		originalPlan.tasks = [
			{ ...task("T001"), requirementIds: ["R1"] },
			{ ...task("T002"), requirementIds: ["R2"] },
		];
		f.setPlan(originalPlan);
		const before = await f.toAcceptance();
		const requirements = f.getRequirements();
		requirements.requirements[1]!.text = "Changed unrelated requirement";
		requirements.proposal = "Clarified unrelated behavior";
		f.setRequirements(requirements);
		const amended = await f.orchestrator.amendRequirements("Change R2 only");
		expect(amended.phase).toBe("awaiting-specification");
		expect(amended.specificationApproval).toBeUndefined();
		expect(amended.planApproval).toBeUndefined();
		expect(amended.acceptanceVersion).toBeUndefined();
		expect(f.documents.has("src/T001.ts")).toBe(true);
		await expect(f.orchestrator.confirmSpecification(before.specification!.version)).rejects.toThrow();
		await f.orchestrator.confirmSpecification(amended.specification!.version);
		const plan = await f.orchestrator.chooseCandidate("discussion", "A", "candidate-v1");
		expect(plan.tasks[0]!.status).toBe("completed");
		expect(plan.plan!.version).not.toBe(before.plan!.version);
		await expect(f.orchestrator.confirmPlan(before.plan!.version)).rejects.toThrow("Stale plan");
		await f.orchestrator.confirmPlan(plan.plan!.version);
		expect(f.events.filter(item => item === "execute:T001")).toHaveLength(1);
	});

	it("invalidates changed task inputs and dependent work without deleting existing files", async () => {
		const f = fixture();
		await f.toAcceptance();
		const requirements = f.getRequirements();
		requirements.requirements[0]!.text = "Changed relevant behavior";
		f.setRequirements(requirements);
		const amended = await f.orchestrator.amendRequirements("Change R1");
		await f.orchestrator.confirmSpecification(amended.specification!.version);
		const plan = await f.orchestrator.chooseCandidate("discussion", "A", "candidate-v1");
		expect(plan.tasks[0]!.status).toBe("pending");
		expect(f.documents.has("src/T001.ts")).toBe(true);
	});

	it("detects external spec/plan edits at approval and revokes old dependent authorization", async () => {
		const f = fixture();
		const ready = await f.toPlan();
		f.editPlan();
		const blocked = await f.orchestrator.confirmPlan(ready.plan!.version);
		expect(blocked.paused).toBe(true);
		expect(blocked.planApproval).toBeUndefined();
		expect(f.events.some(item => item.startsWith("execute:"))).toBe(false);
		const s = fixture();
		const spec = await s.orchestrator.start("Request", "change");
		s.editSpec();
		const invalid = await s.orchestrator.confirmSpecification(spec.specification!.version);
		expect(invalid.specificationApproval).toBeUndefined();
		expect(invalid.phase).toBe("requirements");
		expect(s.events).not.toContain("team");
	});

	it("requires real overall validation and blocks closure conflicts after acceptance", async () => {
		const f = fixture();
		f.ports.validation.run = async (input, context) =>
			f.record(input.command, context, input.purpose === "final" ? 1 : 0).id;
		const failed = await f.toAcceptance();
		expect(failed.paused).toBe(true);
		expect(failed.acceptanceVersion).toBeUndefined();
		expect(f.capturedReviews.some(input => input.kind === "overall")).toBe(false);
		const conflict = fixture();
		conflict.ports.artifacts.close = async () => {
			throw new Error("Original Markdown source changed; unique match is no longer valid");
		};
		const ready = await conflict.toAcceptance();
		const blocked = await conflict.orchestrator.accept(ready.acceptanceVersion!);
		expect(blocked.phase).toBe("closing");
		expect(blocked.paused).toBe(true);
		expect(blocked.blockedReason).toContain("Original Markdown source changed");
		expect(conflict.documents.has("archived")).toBe(false);
	});

	it("drops a paused requirements result before publishing any document", async () => {
		const f = fixture();
		const entered = Promise.withResolvers<void>();
		const result = Promise.withResolvers<SpecRequirementsDraft>();
		f.ports.models.requirements = async () => {
			entered.resolve();
			return result.promise;
		};
		const active = f.orchestrator.start("Request", "change");
		await entered.promise;
		f.orchestrator.pause();
		result.resolve(f.getRequirements());
		await active;
		expect(f.events).not.toContain("write-requirements");
		expect(f.orchestrator.status().specification).toBeUndefined();
	});

	it("retains valid command results across a failed validation and resume", async () => {
		const f = fixture();
		const plan = f.getPlan();
		plan.tasks[0]!.validation.push({
			id: "integration",
			command: "integration",
			behavior: "Integration contract",
			inputPaths: ["src", "test"],
		});
		plan.finalValidation.push({
			id: "second-entry",
			command: "run second-entry",
			behavior: "Second real entry",
			inputPaths: ["src", "test", "package.json"],
			realEntry: true,
		});
		f.setPlan(plan);
		const original = f.ports.validation.run;
		let failedTask = false;
		let failedFinal = false;
		f.ports.validation.run = async (input, context) => {
			if (input.id === "T001:integration" && !failedTask) {
				failedTask = true;
				throw new Error("Temporary task validation failure");
			}
			if (input.id === "second-entry" && !failedFinal) {
				failedFinal = true;
				throw new Error("Temporary final validation failure");
			}
			return original(input, context);
		};
		const failed = await f.toAcceptance();
		expect(failed.paused).toBe(true);
		const finalFailed = await f.orchestrator.resume();
		expect(finalFailed.paused).toBe(true);
		const ready = await f.orchestrator.resume();
		expect(ready.phase).toBe("awaiting-acceptance");
		expect(f.events.filter(item => item === "validate:task:T001:unit")).toHaveLength(1);
		expect(f.events.filter(item => item === "validate:final:entry")).toHaveLength(1);
		expect(f.events.filter(item => item === "execute:T001")).toHaveLength(1);
		expect(f.events.filter(item => item === "commit:T001")).toHaveLength(1);
	});

	it("pauses honestly on missing tools, malformed model results, and cancelled runs", async () => {
		const f = fixture();
		f.ports.models.requirements = async () => "not JSON";
		const malformed = await f.orchestrator.start("Request", "change");
		expect(malformed.paused).toBe(true);
		expect(malformed.blockedReason).toContain("malformed JSON");
		const missing = fixture();
		missing.ports.validation.run = async () => {
			throw new Error("Required executable is unavailable");
		};
		const failed = await missing.toAcceptance();
		expect(failed.blockedReason).toContain("Required executable is unavailable");
		missing.orchestrator.cancel();
		await expect(missing.orchestrator.resume()).rejects.toThrow("Cancelled");
	});

	it("carries reviewed Markdown source patches into final authorized closure", async () => {
		const f = fixture();
		const draft = f.getRequirements();
		draft.sourceMapVersion = digest("original authoritative Markdown");
		draft.sourcePatches = [
			{
				operation: "modify",
				sourceId: "existing-requirement",
				replacement: "Approved replacement with original scenarios",
			},
		];
		f.setRequirements(draft);
		let reviewed = false;
		const review = f.ports.models.review;
		f.ports.models.review = async (input, context) => {
			if (input.kind === "requirements") {
				expect(input.specification.sourcePatches).toEqual(draft.sourcePatches);
				expect(input.specification.sourceMapVersion).toBe(draft.sourceMapVersion);
				reviewed = true;
			}
			return review(input, context);
		};
		const close = f.ports.artifacts.close;
		f.ports.artifacts.close = async (input, context) => {
			expect(reviewed).toBe(true);
			expect(input.specification.sourcePatches).toEqual(draft.sourcePatches);
			return close(input, context);
		};
		const ready = await f.toAcceptance();
		expect((await f.orchestrator.accept(ready.acceptanceVersion!)).phase).toBe("completed");
	});
});
