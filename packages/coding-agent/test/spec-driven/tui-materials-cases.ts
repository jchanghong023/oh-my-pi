import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	DevNativeSessionRef,
	DevWorkflowCommand,
	DevWorkflowStage,
	DevWorkflowView,
} from "../../src/dev-workbench/workflow-types";
import {
	WorkflowConsumerFixture,
	type WorkflowConsumerProcess,
	pollWorkflow,
	workflowGit,
	workflowNativeContext,
} from "../dev-workbench/workflow-fixture";
import { type FixtureRole, type ModelRequest, type Reply } from "./provider-fixture";

export interface MaterialFailure {
	role: FixtureRole;
	kind: "missing" | "malformed" | "unknown";
}
const stageFor = (role: FixtureRole): "requirements" | DevWorkflowStage =>
	role === "planner" ? "planning" : role === "executor" ? "executing" : role;

/** Native provider seam emits actual write calls; all authority and transition checks stay in production. */
export function successfulWorkflowReply(request: ModelRequest, failure?: MaterialFailure): Reply {
	const context = workflowNativeContext(request);
	if (!context || !Array.isArray(context.outputPaths) || typeof context.binding !== "object" || !context.binding)
		return { text: "Ordinary native dialogue; no workflow decision." };
	const binding = context.binding as { irId: string; srId?: string; phase: "requirements" | DevWorkflowStage };
	const outputPaths = context.outputPaths as string[];
	const applies = failure && binding.phase === stageFor(failure.role) && context.role !== "reviewer";
	const completed = request.messages
		.flatMap(message => message.tool_calls ?? [])
		.flatMap(call => {
			if (!call || typeof call !== "object" || !("function" in call)) return [];
			const fn = call.function as { name?: string; arguments?: string };
			if (fn.name?.replace(/^_/u, "") !== "write" || typeof fn.arguments !== "string") return [];
			try {
				return [JSON.parse(fn.arguments) as { path?: string }];
			} catch {
				return [];
			}
		});
	if (applies && failure.kind === "missing")
		return { text: "Required formal output not produced; this is not approval." };
	// Native executing delivery closes writes when completion.md lands.
	// UT and ST must therefore be delivered before the completion authority.
	const orderedPaths =
		binding.phase === "executing"
			? [
					...outputPaths.filter(file => !file.endsWith("/completion.md")),
					...outputPaths.filter(file => file.endsWith("/completion.md")),
				]
			: outputPaths;
	const target = orderedPaths.find(file => !completed.some(call => call.path === file));
	if (!target) return { text: "Native material delivery ended; no human approval and no claimed verification." };
	const markdown = (title: string) =>
		`# ${title}\n\n## Scenarios\nPreserve internal whitespace in the requested greeting Ω.\n\n## Rules and boundaries\nTrim outer whitespace and use world for empty input. Do not modify unrelated behavior.\n\n## Acceptance\nAPI and CLI return the specified greeting. Verification has not been run by this material-format fixture.\n`;
	let content: string;
	if (context.role === "reviewer")
		content = JSON.stringify({
			snapshotDigest: (context.authority as { digest: string }).digest,
			verdict: "pass",
			findings: [],
		});
	else if (binding.phase === "requirements") {
		const requirements = {
			title: "Greeting behavior",
			document: { path: `docs/dev/requirements/${binding.irId}/ir.md`, content: markdown("Greeting behavior") },
			srs: [
				{
					id: `sr-${binding.irId}`,
					title: "Greeting API and CLI",
					document: {
						path: `docs/dev/requirements/${binding.irId}/srs/greeting.md`,
						content: markdown("Greeting API and CLI"),
					},
				},
			],
			attachments: [],
		};
		if (applies && failure.kind === "unknown")
			Object.assign(requirements, { approval: "not a supported material field" });
		content = applies && failure.kind === "malformed" ? "{ malformed requirement JSON" : JSON.stringify(requirements);
	} else
		content =
			applies && failure.kind === "malformed"
				? "not formal Markdown"
				: markdown(target.split("/").at(-1)!.replace(".md", ""));
	const path =
		applies && failure.kind === "unknown" && binding.phase !== "requirements" ? `${target}.unknown` : target;
	if (completed.some(call => call.path === path)) return { text: "Unsupported output did not grant formal approval." };
	const write = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "write")?.function;
	if (!write) throw new Error("Native workflow did not advertise the real write tool");
	return { tool: { name: write.name, args: { i: "Writing current formal material", path, content } } };
}

export interface WorkflowStageOptions {
	setup?: (fixture: WorkflowConsumerFixture) => Promise<void>;
	reply?: (request: ModelRequest) => Reply | Response | Promise<Reply | Response>;
	failure?: MaterialFailure;
}
export interface WorkflowStageFixture {
	fixture: WorkflowConsumerFixture;
	process: WorkflowConsumerProcess;
	projectId: string;
	irId: string;
	srId: string;
	view: DevWorkflowView;
}
export async function bindWorkflowObject(
	process: WorkflowConsumerProcess,
	projectId: string,
	irId: string,
	srId?: string,
): Promise<void> {
	const response = await process.request("workflow/bind", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId, irId, srId }),
	});
	if (!response.ok) throw new Error(`Workflow binding failed (${response.status}): ${await response.text()}`);
}
type ConsumerCommand = DevWorkflowCommand extends infer C
	? C extends DevWorkflowCommand
		? Omit<C, "operationId" | "expectedRevision">
		: never
	: never;
export async function workflowCommand(
	process: WorkflowConsumerProcess,
	command: ConsumerCommand,
): Promise<DevWorkflowView> {
	const current = await process.view(command.projectId);
	const result = await process.command({
		...command,
		operationId: crypto.randomUUID(),
		expectedRevision: current.revision,
	} as DevWorkflowCommand);
	if (!result.response.ok || result.result.status !== "completed")
		throw new Error(`Workflow command ${command.type} failed: ${JSON.stringify(result.result)}`);
	return process.view(command.projectId);
}
export async function submitWorkflowMaterial(
	h: Omit<WorkflowStageFixture, "view">,
	stage: "requirements" | DevWorkflowStage,
	failing = false,
): Promise<DevWorkflowView> {
	await bindWorkflowObject(h.process, h.projectId, h.irId, stage === "requirements" ? undefined : h.srId);
	const before = await h.process.view(h.projectId);
	const operationId = crypto.randomUUID();
	const count = h.fixture.provider.requests.length;
	// Replaying this exact accepted operation reads its status without admitting
	// another turn. Completion includes ingestion, unlike isStreaming alone.
	const request = () =>
		h.process.request("workflow/input", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId: h.projectId,
				irId: h.irId,
				srId: stage === "requirements" ? undefined : h.srId,
				text: "Produce only the complete current formal material. Do not approve any stage or claim verification ran.",
				operationId,
				expectedRevision: before.revision,
			}),
		});
	const response = await request();
	if (!response.ok) throw new Error(`Native material input failed (${response.status}): ${await response.text()}`);
	const { session } = (await response.json()) as { session: DevNativeSessionRef };
	const settled = await pollWorkflow(
		async () => {
			const response = await request();
			if (!response.ok)
				throw new Error(`Native material status failed (${response.status}): ${await response.text()}`);
			const status = (await response.json()) as { operationId: string; status: string; error?: string };
			return { status, view: await h.process.view(h.projectId) };
		},
		({ status, view }) => {
			if (status.operationId !== operationId) throw new Error("Native material operation identity changed");
			if (status.status === "running") return false;
			if (status.status !== "completed" && !failing)
				throw new Error(`Native ${stage} input failed: ${status.error ?? JSON.stringify(status)}`);
			const input = view.operations.find(receipt => receipt.operationId === operationId);
			if (!input || input.status === "running" || view.running.length) return false;
			if (view.operations.some(receipt => receipt.status === "running")) return false;
			if (input.status !== "completed" && !failing)
				throw new Error(`Native ${stage} input failed: ${input.error ?? JSON.stringify(input)}`);
			if (h.fixture.provider.requests.length === count) return false;
			if (failing) return true;
			// Streaming ends before ingestion. Only its completed, version-matched
			// durable receipt makes the snapshot/material digest safe to consume.
			const prefix = `${stage === "requirements" ? "intake" : "materials"}-${session.sessionId}-`;
			return view.operations.some(receipt => {
				if (
					!receipt.operationId.startsWith(prefix) ||
					receipt.status !== "completed" ||
					receipt.revision <= input.revision ||
					receipt.irId !== h.irId
				)
					return false;
				if (stage === "requirements") {
					const group = [...view.groups, ...view.drafts].find(group => group.id === h.irId);
					const digest = group?.snapshot?.digest;
					return !!digest && receipt.steps.some(step => step.name === "files" && step.detail === digest);
				}
				const sr = view.srs.find(sr => sr.id === h.srId);
				return (
					receipt.srId === h.srId &&
					sr?.stage === stage &&
					sr.round === session.round &&
					receipt.steps.some(step => step.name === "stage-edit" && step.detail === `${stage}:${sr.round}`) &&
					receipt.steps.some(step => step.name === "materials" && step.detail === sr.materialDigest)
				);
			});
		},
		`Native ${stage} material ingestion`,
	);
	return settled.view;
}

/** One shared real workflow setup; local Git merge is controlled test action, not platform PR verification. */
export async function createWorkflowStage(
	stage: "requirements" | DevWorkflowStage,
	options: WorkflowStageOptions = {},
): Promise<WorkflowStageFixture> {
	const fixture = await WorkflowConsumerFixture.create({
		reply: options.reply ?? (request => successfulWorkflowReply(request, options.failure)),
	});
	try {
		// Native VCS deliberately denies GIT_* config-source overrides, unlike
		// workflowGit's CLI. Pin this fixture repository (never user/global config)
		// so the Windows installation's autocrlf=true cannot turn frozen LF blobs
		// into different CRLF bytes when native VCS creates the SR checkout.
		await workflowGit(fixture.project, ["config", "--local", "core.autocrlf", "false"], fixture.env);
		await options.setup?.(fixture);
		const process = await fixture.start();
		let view = await process.view();
		const projectId = view.currentProjectId ?? view.projects.find(project => project.root === fixture.project)?.id;
		if (!projectId) throw new Error("Actual cwd project was not registered");
		view = await workflowCommand(process, { type: "createRelease", projectId, title: "Formal material consumers" });
		const releaseId = view.releases.at(-1)!.id;
		view = await workflowCommand(process, { type: "createLocalDraft", projectId, releaseId });
		const irId = view.drafts.at(-1)!.id;
		const srId = `sr-${irId}`;
		const h = { fixture, process, projectId, irId, srId };
		view = await submitWorkflowMaterial(h, "requirements", options.failure?.role === "requirements");
		if (stage === "requirements") return { ...h, view };
		const group = view.drafts.find(item => item.id === irId)!;
		view = await workflowCommand(process, {
			type: "confirmRequirements",
			projectId,
			irId,
			snapshotDigest: group.snapshot!.digest,
		});
		const confirmed = view.groups.find(item => item.id === irId)!;
		await workflowGit(confirmed.worktree!.path, ["config", "user.name", "Material consumer"], fixture.env);
		await workflowGit(confirmed.worktree!.path, ["config", "user.email", "consumer@example.invalid"], fixture.env);
		await workflowGit(confirmed.worktree!.path, ["config", "commit.gpgsign", "false"], fixture.env);
		const requirementVersions = [
			...confirmed.files,
			...(confirmed.evidenceFiles ?? []),
			...(confirmed.retiredFiles ?? []),
		];
		await workflowCommand(process, {
			type: "publishMaterials",
			projectId,
			irId,
			scope: "requirements",
			paths: requirementVersions.map(file => file.path),
			versions: requirementVersions,
			message: "Confirmed complete requirements",
			push: true,
		});
		await workflowCommand(process, {
			type: "markRequirementsPrSubmitted",
			projectId,
			irId,
			url: "https://company.example/manual/requirements/1",
		});
		await workflowGit(fixture.project, ["merge", "--squash", confirmed.worktree!.branch], fixture.env);
		await workflowGit(fixture.project, ["commit", "-m", "Controlled test squash merge of requirements"], fixture.env);
		await workflowGit(fixture.project, ["push", "origin", "HEAD"], fixture.env);
		await workflowCommand(process, { type: "markRequirementsMerged", projectId, irId });
		await bindWorkflowObject(process, projectId, irId, srId);
		view = await workflowCommand(process, { type: "startSr", projectId, irId, srId });
		for (const phase of ["solution", "planning", "executing", "pr"] as const) {
			view = await submitWorkflowMaterial(h, phase, options.failure && stageFor(options.failure.role) === phase);
			if (phase === stage) return { ...h, view };
			const sr = view.srs.find(item => item.id === srId)!;
			view = await workflowCommand(process, {
				type: "approveStage",
				projectId,
				irId,
				srId,
				stage: phase,
				round: sr.round,
				materialDigest: sr.materialDigest!,
			});
		}
		throw new Error(`Unknown target stage ${stage}`);
	} catch (error) {
		await fixture.close();
		throw error;
	}
}

async function assertMaterialFailures(role: FixtureRole): Promise<void> {
	const stage = stageFor(role);
	const h = await createWorkflowStage(stage);
	await using fixture = h.fixture;
	const current = await h.process.view(h.projectId);
	const group = [...current.groups, ...current.drafts].find(item => item.id === h.irId)!;
	const sr = current.srs.find(item => item.id === h.srId);
	const relative =
		stage === "requirements"
			? group.documentPath
			: sr!.materials.find(material => material.stage === stage && material.valid)!.path;
	const target = path.join(stage === "requirements" ? group.worktree!.path : sr!.worktree!.path, relative);
	const original = await fs.readFile(target);
	for (const kind of ["missing", "malformed", "unknown"] as const) {
		if (kind === "missing") await fs.unlink(target);
		else
			await fs.writeFile(
				target,
				kind === "malformed"
					? "{ malformed formal material"
					: "# Different unconfirmed authority\n\nUnknown material version; no approval.\n",
			);
		try {
			const before = await h.process.view(h.projectId);
			const count = fixture.provider.requests.length;
			const response = await h.process.command(
				stage === "requirements"
					? {
							type: "confirmRequirements",
							projectId: h.projectId,
							irId: h.irId,
							snapshotDigest: group.snapshot!.digest,
							expectedRevision: before.revision,
							operationId: crypto.randomUUID(),
						}
					: {
							type: "approveStage",
							projectId: h.projectId,
							irId: h.irId,
							srId: h.srId,
							stage,
							round: sr!.round,
							materialDigest: sr!.materialDigest!,
							expectedRevision: before.revision,
							operationId: crypto.randomUUID(),
						},
			);
			expect(response.response.ok && response.result.status === "completed").toBe(false);
			const after = await h.process.view(h.projectId);
			expect(after.srs.find(item => item.id === h.srId)?.approvals).toEqual(sr?.approvals);
			expect(after.srs.find(item => item.id === h.srId)?.stage).toBe(sr?.stage);
			expect([...after.groups, ...after.drafts].find(item => item.id === h.irId)?.confirmation).toEqual(
				group.confirmation,
			);
			expect(fixture.provider.requests).toHaveLength(count);
		} finally {
			await fs.writeFile(target, original);
		}
	}
}
export function registerMaterialFailureTests(roles: readonly FixtureRole[]): void {
	for (const role of roles)
		test(
			`public workflow ${role} rejects missing, malformed and unknown byte versions without consuming approval`,
			() => assertMaterialFailures(role),
			180_000,
		);
}
