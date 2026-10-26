import { expect, test } from "bun:test";
import * as path from "node:path";
import {
	BEHAVIOR_TEST,
	contentText,
	IMPLEMENTATION,
	IMPLEMENTATION_PATH,
	REQUIREMENT,
	respond,
	rolePayload,
	type ModelRequest,
	type Reply,
} from "./provider-fixture";
import {
	clearNativeDraft,
	entry,
	eventually,
	nativeMessageEntries,
	nativeTranscript,
	stageContexts,
	tuiTest,
	withTui,
} from "./tui-harness";

function nativeWrite(request: ModelRequest, target: string, content: string): Reply {
	const write = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "write")?.function;
	if (!write) throw new Error("Lifecycle scenario requires the actual native write tool");
	return { tool: { name: write.name, args: { i: "Updating lifecycle delivery", path: target, content } } };
}

function turnResults(request: ModelRequest, text: string): string[] {
	const start = request.messages.findLastIndex(
		message => message.role === "user" && contentText(message.content) === text,
	);
	return request.messages
		.slice(start + 1)
		.filter(message => message.role === "tool")
		.map(message => contentText(message.content));
}

function goalChanges(
	transcript: string,
): Array<{ enabled?: boolean; paused?: boolean; goal?: { objective?: string } }> {
	return transcript
		.split("\n")
		.filter(Boolean)
		.flatMap(line => {
			const item = JSON.parse(line);
			return item.type === "mode_change" && ["goal", "goal_paused"].includes(item.mode)
				? [{ ...item.data, paused: item.mode === "goal_paused" }]
				: [];
		});
}

test.skipIf(!tuiTest)(
	"native execution scope revision preserves business work but requires fresh downstream decisions and delivery",
	async () => {
		const scope =
			"Revised scope: empty names default to friend instead of world; retain trimming and internal whitespace.";
		let revised = false;
		function reviseRequirements(request: ModelRequest): Reply {
			const input = rolePayload(request)!.input;
			const outputs = (input.outputPaths as string[]).map(file => file.replace("*", "greeting"));
			const results = turnResults(request, scope);
			if (results.length >= outputs.length) {
				revised = true;
				return { text: "scope-revision-written-awaiting-explicit-approval" };
			}
			const target = outputs[results.length]!;
			return nativeWrite(
				request,
				target,
				target.endsWith("proposal.md")
					? `## Why\nRevise the existing greeting.\n\n## What Changes\n${scope}\n\n## Capabilities\n### New Capabilities\n- greeting: greeting behavior\n\n## Impact\nRetain the existing source and adapt its default.\n`
					: `## ADDED Requirements\n\n### Requirement: Greeting\nThe system SHALL trim outer whitespace, preserve internal whitespace, and default empty names to friend.\n\n#### Scenario: Revised default\n- **WHEN** the input is empty\n- **THEN** return Hello, friend!\n`,
			);
		}
		await withTui(
			{
				reply(request) {
					const raw = contentText(request.messages.findLast(message => message.role === "user")?.content);
					if (raw === scope && rolePayload(request)?.specDrivenRole === "requirements")
						return reviseRequirements(request);
					const reply = respond(request);
					if (!revised || !reply.tool || reply.tool.name.replace(/^_/u, "") !== "write") return reply;
					const target = String(reply.tool.args.path);
					let content = String(reply.tool.args.content).replaceAll("world", "friend");
					if (rolePayload(request)?.specDrivenRole === "solution") {
						const solution = JSON.parse(content);
						for (const candidate of solution.candidates)
							candidate.content += `\n${scope}\nRetain the existing implementation and adjust only its empty-name default.\n`;
						content = JSON.stringify(solution);
					} else if (target.endsWith(".md"))
						content += `\n${scope}\nRetained prior trimming implementation; adjusted empty-name fallback and behavioral coverage.\n`;
					return { tool: { ...reply.tool, args: { ...reply.tool.args, content } } };
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state, stage, idle }) => {
				await tui("submit", "/dev");
				await idle();
				await tui("submit", `/dev new ${REQUIREMENT}`);
				await stage("requirements");
				await tui("submit", "/dev next");
				await stage("solution");
				await tui("submit", "/dev next pure");
				await stage("planning");
				await tui("submit", "/dev next");
				const original = (await stage("executing")).run!;
				const report = (entry(provider, "executor").outputPaths as string[])[0]!;
				const plan = (entry(provider, "planner").outputPaths as string[])[0]!;
				const oldPlan = await Bun.file(path.join(cwd, plan)).text();
				const oldReport = await Bun.file(path.join(cwd, report)).text();
				expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
				for (const phase of ["planning", "solution", "requirements"]) {
					await tui("submit", "/dev back");
					await stage(phase);
				}
				expect((await state()).run?.approvals).toEqual({});
				expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
				expect(await Bun.file(path.join(cwd, plan)).text()).toBe(oldPlan);
				expect(await Bun.file(path.join(cwd, report)).text()).toBe(oldReport);
				await tui("submit", scope);
				await tui("expect", "text", "scope-revision-written-awaiting-explicit-approval", "--timeout", "30000");
				await idle();
				expect((await state()).run?.phase).toBe("requirements");
				const before = provider.requests.length;
				await tui("submit", "/dev next");
				const solution = (await stage("solution")).run!;
				expect(solution.approvals.solution).toBeUndefined();
				expect(solution.approvals.planner).toBeUndefined();
				expect(
					provider.requests.slice(before).some(request => stageContexts(request).join("\n").includes("friend")),
				).toBe(true);
				await tui("submit", "/dev next pure");
				const planning = (await stage("planning")).run!;
				expect(planning.approvals.planner).toBeUndefined();
				const updatedPlan = await Bun.file(path.join(cwd, plan)).text();
				expect(updatedPlan).not.toBe(oldPlan);
				expect(updatedPlan).toContain(scope);
				await tui("submit", "/dev next");
				const current = (await stage("executing")).run!;
				expect(current.runId).toBe(original.runId);
				expect(current.approvals.requirements).not.toEqual(original.approvals.requirements);
				expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(
					IMPLEMENTATION.replaceAll("world", "friend"),
				);
				expect(await Bun.file(path.join(cwd, "test/greeting.test.ts")).text()).toBe(
					BEHAVIOR_TEST.replaceAll("world", "friend"),
				);
				const updatedReport = await Bun.file(path.join(cwd, report)).text();
				expect(updatedReport).not.toBe(oldReport);
				expect(updatedReport).toContain(scope);
				expect(updatedReport).toContain("1 pass");
			},
		);
	},
	240_000,
);

test.skipIf(!tuiTest)(
	"native Goal is opt-in and cannot write or resume autonomous rounds at acceptance or changed approvals",
	async () => {
		const attempted = "goal-must-not-change-existing-business-bytes\n";
		await withTui(
			{
				dialogue(request) {
					// before_agent_start appends hidden lifecycle facts as a user-role
					// message after the submitted objective; it is not another user turn.
					const objective = request.messages.findLast(
						message => message.role === "user" && contentText(message.content).startsWith("lifecycle-goal-"),
					);
					const text = contentText(objective?.content);
					if (!text.startsWith("lifecycle-goal-")) return respond(request);
					if (turnResults(request, text).length) return { text: `goal-guard-observed:${text}` };
					return nativeWrite(request, IMPLEMENTATION_PATH, attempted);
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state, stage, idle, restart }) => {
				await tui("submit", "/dev");
				await idle();
				await tui("submit", `/dev new ${REQUIREMENT}`);
				await stage("requirements");
				await tui("submit", "/dev next");
				await stage("solution");
				await tui("submit", "/dev next pure");
				await stage("planning");
				await tui("submit", "/dev next");
				await stage("executing");
				const executing = (await eventually(state, value => value.run?.awaitingAcceptance === true)).run!;
				expect(goalChanges(await nativeTranscript(executing, "executor"))).toEqual([]);
				expect(executing.awaitingAcceptance).toBe(true);
				const report = (entry(provider, "executor").outputPaths as string[])[0]!;
				const originalReport = await Bun.file(path.join(cwd, report)).text();
				const originalBehavior = await Bun.file(path.join(cwd, "test/greeting.test.ts")).text();
				const otherSessions = await Promise.all(
					(["requirements", "solution", "planner"] as const).map(async role => ({
						role,
						messages: nativeMessageEntries(await nativeTranscript(executing, role)),
					})),
				);
				const proposal = (entry(provider, "requirements").outputPaths as string[])[0]!;
				const approvedProposal = await Bun.file(path.join(cwd, proposal)).text();
				for (const boundary of ["acceptance", "changed-approval"] as const) {
					if (boundary === "changed-approval")
						await Bun.write(path.join(cwd, proposal), `${approvedProposal}\nUnapproved scope edit.\n`);
					const objective = `lifecycle-goal-${boundary}`;
					const before = provider.requests.length;
					const previousJournal = await nativeTranscript(executing, "executor");
					await tui("submit", `/goal set ${objective}`);
					await tui("expect", "text", `goal-guard-observed:${objective}`, "--timeout", "30000");
					await idle();
					const journal = await nativeTranscript(executing, "executor");
					const boundaryRequests = provider.requests.slice(before);
					expect(boundaryRequests).toHaveLength(2);
					expect(boundaryRequests.every(request => rolePayload(request)?.specDrivenRole === "executor")).toBe(
						true,
					);
					expect(
						boundaryRequests.every(request => !JSON.stringify(request.messages).includes("ordinary-root-beacon")),
					).toBe(true);
					expect(turnResults(boundaryRequests.at(-1)!, objective)).toHaveLength(1);
					const records = journal
						.slice(previousJournal.length)
						.split("\n")
						.filter(Boolean)
						.map(line => JSON.parse(line));
					expect(
						records.some(
							record =>
								record.type === "message" &&
								record.message?.role === "toolResult" &&
								record.message.toolName === "write" &&
								record.message.isError === true,
						),
					).toBe(true);
					const facts = records.find(
						record => record.type === "custom_message" && record.customType === "dev-lifecycle-facts",
					);
					expect(facts).toBeDefined();
					expect(JSON.parse(contentText(facts.content))).toMatchObject({
						awaitingAcceptance: true,
						accepted: false,
						approvedVersionsMatch: boundary === "acceptance",
						explicitRepair: false,
					});
					const changes = goalChanges(journal).filter(change => change.goal?.objective === objective);
					expect(changes.length).toBeGreaterThan(0);
					expect(changes.at(-1)?.paused).toBe(true);
					expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
					expect(await Bun.file(path.join(cwd, report)).text()).toBe(originalReport);
					expect(await Bun.file(path.join(cwd, "test/greeting.test.ts")).text()).toBe(originalBehavior);
					for (const { role, messages } of otherSessions)
						expect(nativeMessageEntries(await nativeTranscript(executing, role))).toEqual(messages);
					for (const [role, saved] of Object.entries(executing.sessions))
						expect((await state()).run?.sessions[role as keyof typeof executing.sessions]).toMatchObject({
							sessionId: saved.sessionId,
							sessionFile: saved.sessionFile,
						});
					expect((await state()).run?.approvals).toEqual(executing.approvals);
					await tui("key", "press", "Escape");
					await idle();
					const calls = provider.requests.length;
					await tui("submit", "/dev");
					await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
					await tui("submit", "/dev");
					await stage("executing");
					expect(provider.requests).toHaveLength(calls);
					await restart();
					const afterRestart = provider.requests.length;
					expect(provider.requests.slice(calls).every(request => !rolePayload(request))).toBe(true);
					await tui("submit", "/dev");
					await stage("executing");
					expect(provider.requests).toHaveLength(afterRestart);
					expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
					expect(await Bun.file(path.join(cwd, report)).text()).toBe(originalReport);
					expect(await Bun.file(path.join(cwd, "test/greeting.test.ts")).text()).toBe(originalBehavior);
					expect((await state()).run?.approvals).toEqual(executing.approvals);
					for (const [role, saved] of Object.entries(executing.sessions))
						expect((await state()).run?.sessions[role as keyof typeof executing.sessions]).toMatchObject({
							sessionId: saved.sessionId,
							sessionFile: saved.sessionFile,
						});
					expect(nativeMessageEntries(await nativeTranscript(executing, "executor"))).toEqual(
						nativeMessageEntries(journal),
					);
					for (const { role, messages } of otherSessions)
						expect(nativeMessageEntries(await nativeTranscript(executing, role))).toEqual(messages);
					await tui("submit", "/goal drop");
					await tui("expect", "text", "Drop goal?", "--timeout", "30000");
					await tui("key", "press", "Home", "Enter");
					await tui("expect", "text", "Goal dropped.", "--timeout", "30000");
				}
			},
		);
	},
	240_000,
);

test.skipIf(!tuiTest)(
	"native retry repairs only the failed visible stage and leaves approvals and hidden ordinary root untouched",
	async () => {
		let reject = true;
		await withTui(
			{
				fail: request =>
					reject && rolePayload(request)?.specDrivenRole === "solution"
						? "visible-solution-retry-boundary"
						: undefined,
				reply(request) {
					if (
						!rolePayload(request) &&
						request.messages.some(
							message => message.role === "user" && contentText(message.content) === "hidden-root-retry-beacon",
						)
					)
						return { text: "hidden-root-retry-complete" };
					return respond(request);
				},
			},
			[120, 36],
			async ({ provider, tui, state, stage, idle }) => {
				await tui("submit", "hidden-root-retry-beacon");
				await tui("expect", "text", "hidden-root-retry-complete", "--timeout", "30000");
				await tui("submit", "/dev");
				await idle();
				await tui("submit", `/dev new ${REQUIREMENT}`);
				await stage("requirements");
				await tui("submit", "/dev next");
				await tui("expect", "text", "visible-solution-retry-boundary", "--timeout", "30000");
				const failed = (await stage("solution")).run!;
				const requirements = nativeMessageEntries(await nativeTranscript(failed, "requirements"));
				await clearNativeDraft(tui, "/dev next");
				reject = false;
				const before = provider.requests.length;
				await tui("submit", "/retry");
				await tui("expect", "text", "文件已写入。请检查实际交付文件", "--timeout", "30000");
				await idle();
				const retried = (await state()).run!;
				expect(retried.phase).toBe("solution");
				expect(retried.approvals).toEqual(failed.approvals);
				expect(retried.sessions.solution?.sessionId).toBe(failed.sessions.solution?.sessionId);
				expect(nativeMessageEntries(await nativeTranscript(retried, "requirements"))).toEqual(requirements);
				expect(provider.requests.slice(before).length).toBeGreaterThan(0);
				expect(
					provider.requests.slice(before).every(request => rolePayload(request)?.specDrivenRole === "solution"),
				).toBe(true);
				expect(
					provider.requests
						.slice(before)
						.every(request => !JSON.stringify(request.messages).includes("hidden-root-retry-beacon")),
				).toBe(true);
				const calls = provider.requests.length;
				await tui("submit", "/dev");
				await tui("expect", "text", "hidden-root-retry-beacon", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
			},
		);
	},
	180_000,
);

for (const mode of ["loop", "goal", "vibe"] as const) {
	test.skipIf(!tuiTest)(
		`ordinary native ${mode} rejects Dev entry without replacing the root`,
		async () => {
			await withTui(
				{
					reply(request) {
						if (
							!rolePayload(request) &&
							request.messages.some(
								message =>
									message.role === "user" && contentText(message.content) === "ordinary-mode-owner-beacon",
							)
						)
							return { text: "ordinary-mode-owner-complete" };
						return respond(request);
					},
				},
				[120, 36],
				async ({ provider, tui, state, idle }) => {
					await tui("submit", "ordinary-mode-owner-beacon");
					await tui("expect", "text", "ordinary-mode-owner-complete", "--timeout", "30000");
					const original = await state();
					await tui("submit", mode === "goal" ? "/goal set ordinary-entry-conflict-objective" : `/${mode}`);
					if (mode !== "goal")
						await tui(
							"expect",
							"text",
							`${mode === "loop" ? "Loop" : "Vibe"} mode enabled.`,
							"--timeout",
							"30000",
						);
					if (mode === "goal") {
						await eventually(
							async () =>
								provider.requests.some(request =>
									request.messages.some(
										message =>
											message.role === "user" &&
											contentText(message.content) === "ordinary-entry-conflict-objective",
									),
								),
							Boolean,
						);
						await tui("submit", "/goal pause");
						await tui("expect", "text", "Goal mode paused.", "--timeout", "30000");
					}
					const calls = provider.requests.length;
					await tui("submit", "/dev");
					await tui("expect", "text", mode === "loop" ? "请先退出 Loop 模式" : "请先退出", "--timeout", "30000");
					await clearNativeDraft(tui, "/dev");
					expect(await state()).toEqual(original);
					expect(provider.requests).toHaveLength(calls);
					expect(await tui("text", "--full")).toContain("ordinary-mode-owner-beacon");
					await tui("submit", mode === "goal" ? "/goal drop" : `/${mode}`);
					if (mode === "goal") {
						await tui("expect", "text", "Drop goal?", "--timeout", "30000");
						await tui("key", "press", "Home", "Enter");
						await tui("expect", "text", "Goal dropped.", "--timeout", "30000");
					} else
						await tui(
							"expect",
							"text",
							`${mode === "loop" ? "Loop" : "Vibe"} mode disabled.`,
							"--timeout",
							"30000",
						);
					await tui("submit", "/dev");
					await idle();
					expect(provider.requests).toHaveLength(calls);
					expect((await state()).run).toBeUndefined();
				},
			);
		},
		180_000,
	);
}
