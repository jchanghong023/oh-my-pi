import * as crypto from "node:crypto";
import { describe, expect, it } from "bun:test";
import { SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import type {
	SpecDrivenOptions,
	SpecDrivenPorts,
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
		requirementIds: ["R1"],
		dependencies,
		conditionIds: [],
		ownedPaths: [`src/${id}.ts`, `test/${id}.test.ts`],
		implementationPaths: [`src/${id}.ts`],
		solutionBinding: "stable-interface",
		validation: [{ id: "unit", command: `test ${id}`, behavior: `approved ${id}` }],
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
	let time = 10;
	let requirementsDraft: SpecRequirementsDraft = {
		proposal: "Add approved behavior",
		specs: [{ path: "capability/spec.md", content: "### Requirement: behavior\n#### Scenario: normal\nWorks" }],
		requirements: [
			{ id: "R1", text: "Approved behavior" },
			{ id: "R2", text: "Unrelated behavior" },
		],
		questions: [],
	};
	let planDraft: SpecPlanDraft = {
		content: "# Plan\n- [x] checkbox is not execution",
		tasks: [task()],
		conditions: [],
		finalValidation: [{ id: "entry", command: "run public-entry", behavior: "Actual public entry", realEntry: true }],
		closure: { sync: true, archive: true },
	};
	const record = (command: string, context: SpecRunContext, exitCode = 0): SpecToolRecord => {
		const id = `tool-${++counter}`;
		const item: SpecToolRecord = {
			id,
			toolCallId: `call-${counter}`,
			runId: context.runId,
			generation: context.generation,
			tool: "spec_verify",
			args: { command, cwd: "/fixture" },
			startedAt: time++,
			finishedAt: time++,
			result: {
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
	const ports: SpecDrivenPorts = {
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
			async execute(input, context) {
				events.push(`execute:${input.task.id}`);
				const red = record(input.task.validation[0]!.command, context, 1);
				const implementationStartedAt = time++;
				documents.set(
					input.task.implementationPaths[0] ?? input.task.ownedPaths[0]!,
					"Actual owned implementation",
				);
				const green = record(input.task.validation[0]!.command, context);
				return {
					changedPaths: [input.task.ownedPaths[0]!],
					recordIds: [red.id, green.id],
					redRecordId: red.id,
					greenRecordId: green.id,
					implementationStartedAt,
					requestedTddException: null,
				};
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
		},
		validation: {
			async run(input, context) {
				events.push(`validate:${input.purpose}:${input.id}`);
				return record(input.command, context).id;
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
	};
}

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
				plan.conditions = [{ id: "C1", description: "Required platform exists", command: "check platform" }];
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
			"stale-generation",
			"arbitrary-red",
			"late-red",
			"no-semantic-review",
			"new-exemption",
		] as const) {
			const f = fixture();
			const execute = f.ports.models.execute;
			f.ports.models.execute = async (input, context) => {
				const result = await execute(input, context);
				if (mode === "missing-ledger") f.ledger.clear();
				if (mode === "stale-generation") f.ledger.get(result.redRecordId!)!.generation--;
				if (mode === "arbitrary-red") f.ledger.get(result.redRecordId!)!.args.command = "unrelated failing command";
				if (mode === "late-red") result.implementationStartedAt = 0;
				if (mode === "new-exemption") result.requestedTddException = "Skip TDD now";
				return result;
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
			{ id: "docs", command: "check documentation", behavior: "Published documentation is valid" },
		];
		f.setPlan(plan);
		f.ports.models.execute = async () => ({
			changedPaths: [],
			recordIds: [],
			redRecordId: null,
			greenRecordId: null,
			implementationStartedAt: null,
			requestedTddException: null,
		});
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
		f.ports.models.execute = async (input, context) => {
			const result = await original(input, context);
			started.resolve();
			await lateResult.promise;
			return result;
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
		plan.tasks[0]!.validation.push({ id: "integration", command: "integration", behavior: "Integration contract" });
		plan.finalValidation.push({
			id: "second-entry",
			command: "run second-entry",
			behavior: "Second real entry",
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
