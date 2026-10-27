import { expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { DocsSearchEngine } from "../../src/docs/engine";
import {
	contentText,
	IMPLEMENTATION,
	IMPLEMENTATION_PATH,
	MARKER,
	REQUIREMENT,
	respond,
	rolePayload,
	teamStage,
	type ModelRequest,
	type Reply,
} from "./provider-fixture";
import {
	clearNativeDraft,
	entry,
	eventually,
	expectNativeFailure,
	nativeMessageEntries,
	nativeTranscript,
	tuiTest,
	withTui,
} from "./tui-harness";

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

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(cwd, ".fixture-no-global-config") },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Fixture git ${args.join(" ")}: ${stderr}`);
	return stdout;
}

test.skipIf(!tuiTest)(
	"ordinary openspec-update-change completes existing requirements maintenance without Dev or implementation",
	async () => {
		const target = "openspec/changes/manual-maintenance/specs/greeting/spec.md";
		const original =
			"## MODIFIED Requirements\n\n### Requirement: Greeting\nThe system SHALL preserve internal whitespace.\n\n#### Scenario: Internal spacing\n- **WHEN** the caller supplies Ada  Lovelace\n- **THEN** return Hello, Ada  Lovelace!\n";
		const updated = original.replace(
			"The system SHALL preserve internal whitespace.",
			"The system SHALL trim outer whitespace while preserving internal whitespace.",
		);
		const skill = "skill://opsx-update:raw";
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
					"/skill:opsx-update manual-maintenance-beacon 修改已有 manual-maintenance 需求：增加外侧空白裁剪，保持内部空白；仅维护需求，不实施、不测试、不建 Dev 流程。",
				);
				await tui("expect", "text", "manual-maintenance-complete", "--timeout", "60000");
				await tui("wait", "idle", "--timeout", "30000");
				const completed = provider.requests.at(-1)!;
				expect(
					parseFrontmatter(result(completed, "read", skill), { source: skill, repair: false, level: "off" })
						.frontmatter.name,
				).toBe("opsx-update");
				expect(result(completed, "read", `${target}:raw`)).toContain(
					"The system SHALL preserve internal whitespace.",
				);
				expect(result(completed, "read", target)).toContain(
					"The system SHALL trim outer whitespace while preserving internal whitespace.",
				);
				expect(await Bun.file(path.join(cwd, target)).text()).toBe(updated);
				expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
				expect((await state()).run).toBeUndefined();
				expect(await Bun.file(path.join(cwd, ".omp/dev/state.json")).exists()).toBe(false);
				expect(provider.requests.every(request => !rolePayload(request) && !teamStage(request))).toBe(true);
				expect(calls(completed).map(call => call.name)).toEqual(["read", "read", "write", "read"]);
			},
		);
	},
	180_000,
);

const stageSkills: Record<string, string[]> = {
	requirements: ["brainstorming", "jch-grill-me"],
	solution: [],
	planner: ["writing-plans"],
	executor: ["subagent-driven-development"],
};
const skills = Object.values(stageSkills).flat();

test.skipIf(!tuiTest)(
	"four native stages consume indexed Wiki evidence, enforce stage skill grants and preserve existing worktrees",
	async () => {
		const wikiToken = "OMP_CAPABILITY_WIKI_EVIDENCE";
		const wikiFact = `${wikiToken}: preserve internal whitespace in Ada  Lovelace; trim outer whitespace only.`;
		const sentinel = "export const untouched = 'business bytes remain unchanged';\n";
		let worktrees = "";
		await withTui(
			{
				async setup(cwd) {
					await Bun.write(path.join(cwd, "src/untouched.ts"), sentinel);
					await git(cwd, "init", "-b", "main");
					await git(cwd, "config", "user.name", "TUI fixture");
					await git(cwd, "config", "user.email", "tui-fixture@example.invalid");
					await git(cwd, "add", "src/untouched.ts");
					await git(cwd, "commit", "-m", "isolated fixture baseline");
					await git(cwd, "worktree", "add", "--detach", path.join(path.dirname(cwd), "existing-worktree"));
					worktrees = await git(cwd, "worktree", "list", "--porcelain");
					const documents = path.join(path.dirname(cwd), "wiki-source");
					await Bun.write(path.join(documents, "greeting-contract.md"), `# Greeting contract\n\n${wikiFact}\n`);
					const engine = new DocsSearchEngine({ cwd, agentDir: path.join(path.dirname(cwd), "config", "agent") });
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
							return invoke(request, "read", { i: "Probing actual stage resource grant", path: target });
					}
					if (payload.specDrivenRole === "requirements") {
						if (!executed.some(call => call.name === "wiki"))
							return invoke(request, "wiki", { query: wikiToken, mode: "grep" });
						if (!executed.some(call => call.name === "write" && call.args.path === "src/untouched.ts"))
							return invoke(request, "write", {
								i: "Probing unauthorized business mutation",
								path: "src/untouched.ts",
								content: "unauthorized mutation\n",
							});
						// Carry the real retrieved fact in a stage artifact, not a fabricated provider-only summary.
						const reply = respond(request);
						if (
							reply.tool?.name.replace(/^_/u, "") === "write" &&
							typeof reply.tool.args.content === "string" &&
							String(reply.tool.args.path).endsWith("proposal.md")
						) {
							const evidence = result(request, "wiki");
							expect(evidence).toContain(wikiFact);
							reply.tool.args.content += `\n## Indexed evidence\n${wikiFact}\n`;
						}
						return reply;
					}
					return respond(request);
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state, stage, idle }) => {
				await tui("submit", "/dev");
				await idle();
				await tui("submit", `/dev new ${MARKER}: ${REQUIREMENT}`);
				await stage("requirements");
				const requirementsRequest = provider.requests
					.filter(request => rolePayload(request)?.specDrivenRole === "requirements")
					.at(-1)!;
				expect(result(requirementsRequest, "wiki")).toContain(wikiFact);
				expect(result(requirementsRequest, "write", "src/untouched.ts")).toContain("未授权的阶段文件写入");
				expect(await Bun.file(path.join(cwd, "src/untouched.ts")).text()).toBe(sentinel);
				await tui("submit", "/dev next");
				await stage("solution");
				expect(
					(entry(provider, "solution").files as Array<{ content: string }>).some(file =>
						file.content.includes(wikiFact),
					),
				).toBe(true);
				await tui("submit", "/dev next pure");
				await stage("planning");
				await tui("submit", "/dev next");
				await stage("executing");
				await eventually(state, value => value.run?.awaitingAcceptance === true);
				await idle();
				for (const [role, allowed] of Object.entries(stageSkills)) {
					const completed = provider.requests
						.filter(request => rolePayload(request)?.specDrivenRole === role)
						.at(-1)!;
					for (const name of skills) {
						const target = `skill://${name}:raw`;
						const actual = result(completed, "read", target);
						if (allowed.includes(name)) {
							expect(actual).not.toContain("Skill access denied:");
							expect(
								parseFrontmatter(actual, { source: target, repair: false, level: "off" }).frontmatter.name,
							).toBe(name);
						} else expect(actual).toContain(`Skill access denied: ${name}`);
					}
				}
				expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
				expect(await Bun.file(path.join(cwd, "src/untouched.ts")).text()).toBe(sentinel);
				expect(await git(cwd, "worktree", "list", "--porcelain")).toBe(worktrees);
			},
		);
	},
	300_000,
);

test.skipIf(!tuiTest)(
	"completed four-stage Team with no adoptable direction stays blocked without invented candidates or solo fallback",
	async () => {
		await withTui(
			{
				reply(request) {
					const reply = respond(request);
					if (teamStage(request) === "proposal" && reply.tool && isRecord(reply.tool.args.data))
						reply.tool.args.data.proposal = `${reply.tool.args.data.proposal}\n\n## Mandatory runtime dependency\nFetch the greeting template from an external HTTPS service on every greet call.\n`;
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
					if (!labels.length) throw new Error("Synthesis request lacks actual proposal labels");
					const data = reply.tool.args.data;
					if (!isRecord(data)) throw new Error("Expected real structured Team synthesis");
					data.reportMarkdown = "## 硬约束检查\n全部已讨论方向均违反无网络访问的硬约束，没有可采用方向。";
					data.recommendedProposal = "";
					data.recommendationReason = "";
					data.hardConstraintViolations = labels.map(proposalLabel => ({
						proposalLabel,
						issue: "方案要求联网访问，违反已确认离线硬约束",
						evidence: "用户明确要求运行时不得联网",
					}));
					return reply;
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state, stage, idle }) => {
				await tui("submit", "/dev");
				await idle();
				await tui("submit", "/dev config");
				await tui("expect", "text", "方案 Team", "--timeout", "30000");
				await tui("key", "press", "Up", "Enter");
				await eventually(state, value => value.team);
				await tui("submit", `/dev new ${REQUIREMENT} 运行时不得联网。`);
				await stage("requirements");
				await tui("submit", "/dev next");
				await expectNativeFailure(tui, /Team 未产生可采用候选/);
				await idle();
				const blocked = await state();
				expect(blocked.run?.phase).toBe("solution");
				expect(blocked.team).toBe(true);
				expect(new Set(provider.requests.map(teamStage).filter(Boolean))).toEqual(
					new Set(["proposal", "alignment", "review", "synthesis"]),
				);
				expect(
					provider.requests.filter(request => rolePayload(request)?.specDrivenRole === "solution"),
				).toHaveLength(0);
				expect(
					provider.requests.filter(request =>
						["planner", "executor"].includes(rolePayload(request)?.specDrivenRole ?? ""),
					),
				).toHaveLength(0);
				const solutionPath = blocked.run?.paths?.solution;
				if (!solutionPath) throw new Error("Blocked run lost its durable solution artifact path");
				expect(await Bun.file(path.join(cwd, solutionPath)).exists()).toBe(false);
				const run = blocked.run!;
				const approval = run.approvals.requirements;
				if (!approval?.files.length) throw new Error("Blocked run lost its approved requirement versions");
				expect(approval.userReply).not.toBe("");
				const approvedFiles = await Promise.all(
					approval.files.map(async file => ({
						path: file.path,
						content: await Bun.file(path.join(cwd, file.path)).text(),
					})),
				);
				const requirementsHistory = nativeMessageEntries(await nativeTranscript(run, "requirements"));
				expect(requirementsHistory.length).toBeGreaterThan(0);
				const requests = provider.requests.length;
				await clearNativeDraft(tui, "/dev next");
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await tui("submit", "/dev");
				await stage("solution");
				expect(provider.requests).toHaveLength(requests);
				const restored = await state();
				expect(restored.run?.runId).toBe(run.runId);
				expect(restored.run?.changeId).toBe(run.changeId);
				expect(restored.run?.phase).toBe("solution");
				expect(restored.team).toBe(true);
				expect(restored.run?.approvals).toEqual(run.approvals);
				for (const file of approvedFiles)
					expect(await Bun.file(path.join(cwd, file.path)).text()).toBe(file.content);
				expect(nativeMessageEntries(await nativeTranscript(restored.run!, "requirements"))).toEqual(
					requirementsHistory,
				);
				expect(restored.run?.paths?.solution).toBe(solutionPath);
				expect(await Bun.file(path.join(cwd, solutionPath)).exists()).toBe(false);
			},
		);
	},
	300_000,
);
