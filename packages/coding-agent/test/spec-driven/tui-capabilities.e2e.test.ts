import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { KnowledgeIndexEngine } from "../../src/knowledge/engine";
import { collectSpecDrivenResources } from "../../src/spec-driven/resource-inventory";
import { loadSpecDrivenSkill } from "../../src/spec-driven/resources";
import {
	contentText,
	IMPLEMENTATION,
	IMPLEMENTATION_PATH,
	MARKER,
	respond,
	rolePayload,
	teamStage,
	type ModelRequest,
	type Reply,
} from "./provider-fixture";
import { eventually, tuiTest, withTui } from "./tui-harness";
import { closePublicWorkbenches, WorkbenchFixture } from "../dev-workbench/fixture";
afterEach(closePublicWorkbenches);

function calls(request: ModelRequest) {
	return request.messages
		.flatMap(message => (message.role === "assistant" ? (message.tool_calls ?? []) : []))
		.map(call => {
			if (
				!isRecord(call) ||
				typeof call.id !== "string" ||
				!isRecord(call.function) ||
				typeof call.function.name !== "string" ||
				typeof call.function.arguments !== "string"
			)
				throw new Error("Malformed native tool call");
			return {
				id: call.id,
				name: call.function.name.replace(/^_/u, ""),
				args: JSON.parse(call.function.arguments) as Record<string, unknown>,
			};
		});
}

function invoke(request: ModelRequest, name: string, args: Record<string, unknown>): Reply {
	const tool = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === name)?.function;
	if (!tool) throw new Error(`Missing advertised native ${name}`);
	return { tool: { name: tool.name, args } };
}

function result(request: ModelRequest, name: string, target?: string): string {
	const call = calls(request).find(call => call.name === name && (target === undefined || call.args.path === target));
	if (!call) throw new Error(`Missing real ${name} call: ${target ?? ""}`);
	const message = request.messages.find(message => message.role === "tool" && message.tool_call_id === call.id);
	if (!message) throw new Error(`Missing real ${name} result: ${call.id}`);
	return contentText(message.content);
}

test.skipIf(!tuiTest || process.platform === "win32")(
	"invalid bash arguments give actionable feedback before a corrected call executes",
	async () => {
		const marker = "OMP_INVALID_BASH_ARGUMENT";
		await withTui(
			{
				reply(request) {
					if (
						!request.messages.some(message => message.role === "user" && contentText(message.content) === marker)
					)
						return respond(request);
					const bashCalls = calls(request).filter(call => call.name === "bash");
					if (bashCalls.length === 0)
						return invoke(request, "bash", { i: "Checking directory", "<rfl:parameter name=": "pwd" });
					if (bashCalls.length === 1) {
						expect(result(request, "bash")).toContain('{"command":"pwd"}');
						return invoke(request, "bash", { i: "Checking directory", command: "pwd" });
					}
					return { text: "OMP_INVALID_BASH_RECOVERED" };
				},
			},
			[120, 36],
			async ({ cwd, provider, tui }) => {
				await tui("submit", marker);
				await tui("expect", "text", "OMP_INVALID_BASH_RECOVERED", "--timeout", "60000");
				const completed = provider.requests.findLast(
					request => calls(request).filter(call => call.name === "bash").length === 2,
				);
				if (!completed) throw new Error("Corrected bash call was not observed");
				const second = calls(completed).filter(call => call.name === "bash")[1]!;
				const output = completed.messages.find(
					message => message.role === "tool" && message.tool_call_id === second.id,
				);
				expect(contentText(output?.content)).toContain(path.basename(cwd));
			},
		);
	},
	120_000,
);

test.skipIf(!tuiTest || process.platform === "win32")(
	"malformed task intent is rejected before spawning and the corrected reviewer runs",
	async () => {
		const marker = "OMP_MALFORMED_REVIEW_INTENT";
		const badIntent = 'y",\n "tasks": [{"agent": "reviewer", "task": "Review"}]}';
		await withTui(
			{
				reply(request) {
					if (
						!request.messages.some(message => message.role === "user" && contentText(message.content) === marker)
					)
						return respond(request);
					const tasks = calls(request).filter(call => call.name === "task");
					if (tasks.length === 0)
						return invoke(request, "task", {
							i: badIntent,
							context: "Review changes",
							tasks: [{ task: "SHOULD_NOT_SPAWN", solutionSpace: "review" }],
						});
					if (tasks.length === 1) {
						expect(result(request, "task")).toContain("not run");
						return invoke(request, "task", {
							i: "Reviewing changes",
							context: "Review changes",
							tasks: [{ agent: "reviewer", task: "OMP_SPEC_REVIEW_CHILD", solutionSpace: "review" }],
						});
					}
					return { text: "OMP_MALFORMED_REVIEW_RECOVERED" };
				},
			},
			[120, 36],
			async ({ provider, tui }) => {
				await tui("submit", marker);
				await tui("expect", "text", "OMP_MALFORMED_REVIEW_RECOVERED", "--timeout", "60000");
				expect(
					provider.requests.some(request =>
						request.messages.some(
							message => message.role === "user" && contentText(message.content).includes("SHOULD_NOT_SPAWN"),
						),
					),
				).toBe(false);
				expect(
					provider.requests.some(request =>
						request.messages.some(
							message =>
								message.role === "user" && contentText(message.content).includes("OMP_SPEC_REVIEW_CHILD"),
						),
					),
				).toBe(true);
			},
		);
	},
	120_000,
);

test.skipIf(!tuiTest || process.platform === "win32")(
	"ordinary openspec-update-change completes existing requirements maintenance without Dev or implementation",
	async () => {
		const target = "openspec/changes/manual-maintenance/specs/greeting/spec.md";
		const original =
			"## MODIFIED Requirements\n\n### Requirement: Greeting\nThe system SHALL preserve internal whitespace.\n\n#### Scenario: Internal spacing\n- **WHEN** the caller supplies Ada  Lovelace\n- **THEN** return Hello, Ada  Lovelace!\n";
		const updated = original.replace(
			"The system SHALL preserve internal whitespace.",
			"The system SHALL trim outer whitespace while preserving internal whitespace.",
		);
		const skill = "skill://openspec-update-change:raw";
		await withTui(
			{
				async setup(cwd) {
					await Bun.write(path.join(cwd, target), original);
					await Bun.write(
						path.join(cwd, "openspec/changes/manual-maintenance/proposal.md"),
						"## Why\nClarify the existing greeting contract.\n\n## What Changes\nMaintain requirements only.\n",
					);
					await Bun.write(path.join(cwd, IMPLEMENTATION_PATH), IMPLEMENTATION);
				},
				reply(request) {
					if (
						!request.messages.some(
							message =>
								message.role === "user" && contentText(message.content).includes("manual-maintenance-beacon"),
						)
					)
						return respond(request);
					const executed = calls(request);
					for (const file of [skill, `${target}:raw`])
						if (!executed.some(call => call.name === "read" && call.args.path === file))
							return invoke(request, "read", { i: "Reading maintenance instructions", path: file });
					if (!executed.some(call => call.name === "write"))
						return invoke(request, "write", {
							i: "Updating existing requirement",
							path: target,
							content: updated,
						});
					if (!executed.some(call => call.name === "read" && call.args.path === target))
						return invoke(request, "read", { i: "Reading maintained requirement", path: target });
					return { text: "manual-maintenance-complete" };
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state }) => {
				await tui(
					"submit",
					"/skill:openspec-update-change manual-maintenance-beacon 修改已有 manual-maintenance 需求：增加外侧空白裁剪，保持内部空白；仅维护需求，不实施、不测试、不建 Dev 流程。",
				);
				await tui("expect", "text", "manual-maintenance-complete", "--timeout", "60000");
				await tui("wait", "idle", "--timeout", "30000");
				const completed = provider.requests.at(-1)!;
				expect(
					parseFrontmatter(result(completed, "read", skill), { source: skill, repair: false, level: "off" })
						.frontmatter.name,
				).toBe("openspec-update-change");
				expect(result(completed, "read", `${target}:raw`)).toContain(
					"The system SHALL preserve internal whitespace.",
				);
				expect(result(completed, "read", target)).toContain(
					"The system SHALL trim outer whitespace while preserving internal whitespace.",
				);
				expect(await Bun.file(path.join(cwd, target)).text()).toBe(updated);
				expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
				expect((await state()).requirements).toEqual([]);
				expect(await Bun.file(path.join(cwd, ".omp/dev/state.json")).exists()).toBe(false);
				expect(provider.requests.every(request => !rolePayload(request) && !teamStage(request))).toBe(true);
				expect(calls(completed).map(call => call.name)).toEqual(["read", "read", "write", "read"]);
			},
		);
	},
	180_000,
);

const stageSkills: Record<string, string[]> = {
	requirements: ["jch-grill-me"],
	solution: [],
	planner: ["writing-plans"],
	executor: ["subagent-driven-development", "using-superpowers"],
};

test("native workbench stages consume indexed Wiki evidence and enforce packaged skill grants", async () => {
	const { manifest } = await collectSpecDrivenResources(
		path.resolve(import.meta.dir, "../../src/spec-driven/vendor/resources"),
	);
	const superpowers = manifest.skills.filter(skill => skill.source === "superpowers").map(skill => skill.name);
	const skills = [...new Set([...Object.values(stageSkills).flat(), ...superpowers])];
	const token = "OMP_CAPABILITY_WIKI_EVIDENCE";
	const fact = `${token}: preserve internal whitespace; trim outer whitespace only.`;
	await using fixture = await WorkbenchFixture.create({
		async setup(cwd, agentDir) {
			await Bun.write(path.join(cwd, "src/untouched.ts"), "original user bytes\n");
			const documents = path.join(cwd, "../wiki-source");
			await Bun.write(path.join(documents, "greeting.md"), `# Contract\n\n${fact}\n`);
			const engine = new KnowledgeIndexEngine({ cwd, agentDir });
			try {
				await engine.init(documents, "capability-contract");
			} finally {
				engine.close();
			}
		},
		reply(request) {
			const payload = rolePayload(request);
			if (!payload) return respond(request);
			const executed = calls(request);
			for (const name of skills) {
				const target = `skill://${name}:raw`;
				if (!executed.some(call => call.name === "read" && call.args.path === target))
					return invoke(request, "read", { i: "Probing stage resource grant", path: target });
			}
			if (payload.specDrivenRole === "requirements") {
				if (!executed.some(call => call.name === "knowledge_search"))
					return invoke(request, "knowledge_search", { query: token, mode: "grep" });
				if (!executed.some(call => call.name === "write" && call.args.path === "src/untouched.ts"))
					return invoke(request, "write", {
						i: "Probing unauthorized mutation",
						path: "src/untouched.ts",
						content: "unauthorized\n",
					});
			}
			return respond(request);
		},
	});
	await fixture.start();
	await fixture.developUntil("executing");
	const requirements = fixture.provider.requests.findLast(
		request => rolePayload(request)?.specDrivenRole === "requirements",
	)!;
	expect(result(requirements, "knowledge_search")).toContain(fact);
	expect(result(requirements, "write", "src/untouched.ts")).toMatch(/未授权|denied|not allowed/iu);
	expect(await Bun.file(path.join(fixture.cwd, "src/untouched.ts")).text()).toBe("original user bytes\n");
	for (const [role, allowed] of Object.entries(stageSkills)) {
		const completed = fixture.provider.requests.findLast(request => rolePayload(request)?.specDrivenRole === role)!;
		for (const name of skills) {
			const target = `skill://${name}:raw`;
			const actual = result(completed, "read", target);
			if (allowed.includes(name) || (role === "executor" && superpowers.includes(name))) {
				expect(actual).not.toContain("Skill access denied:");
				expect(parseFrontmatter(actual, { source: target, repair: false, level: "off" }).frontmatter.name).toBe(
					name,
				);
			} else expect(actual).toContain(`Skill access denied: ${name}`);
		}
	}
	const executor = fixture.provider.requests.find(request => rolePayload(request)?.specDrivenRole === "executor")!;
	const system = executor.messages
		.filter(message => message.role === "system")
		.map(message => contentText(message.content))
		.join("\n");
	const usingSkill = await loadSpecDrivenSkill("superpowers", "using-superpowers");
	const delegated = await loadSpecDrivenSkill("superpowers", "subagent-driven-development");
	expect(system.indexOf(await Bun.file(usingSkill.filePath).text())).toBeGreaterThanOrEqual(0);
	expect(system.indexOf(await Bun.file(delegated.filePath).text())).toBeGreaterThan(
		system.indexOf(await Bun.file(usingSkill.filePath).text()),
	);
	expect(fixture.provider.failures).toEqual([]);
}, 300_000);

test("Team with no adoptable direction remains blocked without solo fallback or invented candidates", async () => {
	await using fixture = await WorkbenchFixture.create({
		reply(request) {
			const reply = respond(request);
			if (teamStage(request) === "proposal" && reply.tool && isRecord(reply.tool.args.data))
				reply.tool.args.data.proposal = `${reply.tool.args.data.proposal}\n\nFetch an external HTTPS template on every greet call.`;
			if (
				rolePayload(request)?.specDrivenRole === "requirements" &&
				reply.tool?.name.replace(/^_/u, "") === "write" &&
				typeof reply.tool.args.content === "string"
			)
				reply.tool.args.content += "\nThe runtime SHALL NOT access the network.\n";
			if (teamStage(request) !== "synthesis" || !reply.tool) return reply;
			const labels = [
				...new Set(
					request.messages
						.filter(message => message.role === "user")
						.flatMap(message =>
							[...contentText(message.content).matchAll(/^### 方案 ([A-Z]+)(?:（.*）)?$/gmu)].map(
								match => match[1]!,
							),
						),
				),
			];
			if (!labels.length || !isRecord(reply.tool.args.data)) throw new Error("Real Team synthesis context missing");
			Object.assign(reply.tool.args.data, {
				reportMarkdown: "All discussed directions violate the explicit offline constraint.",
				recommendedProposal: "",
				recommendationReason: "",
				hardConstraintViolations: labels.map(proposalLabel => ({
					proposalLabel,
					issue: "Requires network",
					evidence: "Runtime must not access network",
				})),
			});
			return reply;
		},
	});
	await fixture.start();
	await fixture.request("team-config", { requirementId: null, expectedRecordVersion: null, useTeam: true });
	const requirements = await fixture.developUntil("requirements");
	await fixture.act(requirements, { kind: "next" });
	const blocked = await fixture.stage(requirements.record.requirementId, "solution");
	expect(blocked.runtime?.blockedReason).toMatch(/Team|候选|adoptable/iu);
	expect(new Set(fixture.provider.requests.map(teamStage).filter(Boolean))).toEqual(
		new Set(["proposal", "alignment", "review", "synthesis"]),
	);
	expect(
		fixture.provider.requests.filter(request =>
			["solution", "planner", "executor"].includes(rolePayload(request)?.specDrivenRole ?? ""),
		),
	).toEqual([]);
	expect(blocked.record.decisions).toEqual(expect.arrayContaining(requirements.record.decisions));
	expect(blocked.record.solutionBasis).toBeNull();
	const count = fixture.provider.requests.length;
	await fixture.get(blocked.record.requirementId);
	expect(fixture.provider.requests).toHaveLength(count);
}, 300_000);
