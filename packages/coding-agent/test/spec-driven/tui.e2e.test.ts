import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SpecSavedRun } from "../../src/spec-driven/types";
import {
	contentText,
	continuationText,
	IMPLEMENTATION,
	IMPLEMENTATION_PATH,
	MARKER,
	REQUIREMENT,
	respond,
	rolePayload,
	teamStage,
} from "./provider-fixture";
import {
	clearNativeDraft,
	entry,
	eventually,
	expectNativeFailure,
	nativeMessageEntries,
	nativeTranscript,
	stageContexts,
	tuiTest,
	userTexts,
	withTui,
	type State,
} from "./tui-harness";

// One full non-Team path covers the real four native sessions, approval handoffs and restoration.
test.skipIf(!tuiTest)(
	"native Dev preserves root, raw dialogue, handoffs, back, restoration and final archive",
	async () => {
		let repairReport: { path: string; content: string } | undefined;
		let blockedWriteCallId: string | undefined;
		const discussion = "报告后解释测试结果，不要修复或批准。";
		await withTui(
			{
				dialogue(request) {
					const raw = continuationText(request);
					const lastUser = request.messages.findLastIndex(
						message => message.role === "user" && contentText(message.content) === raw,
					);
					const results = request.messages.slice(lastUser + 1).filter(message => message.role === "tool");
					if (raw === discussion) {
						if (results.length) {
							blockedWriteCallId = results.at(-1)!.tool_call_id;
							return { text: `${MARKER}_EXECUTOR_DIALOGUE · native-discussion-write-denied` };
						}
						if (!repairReport) throw new Error("Discussion report was not observed");
						const write = request.tools?.find(
							item => item.function?.name.replace(/^_/u, "") === "write",
						)?.function;
						if (!write) throw new Error("Discussion must exercise the actual native write guard");
						return {
							tool: {
								name: write.name,
								args: {
									i: "Attempting unapproved report mutation",
									path: repairReport.path,
									content: "# Unauthorized discussion mutation\n",
								},
							},
						};
					}
					if (!raw?.startsWith("repair")) return respond(request);
					if (results.length >= 2) return { text: "explicit-native-repair-complete" };
					const write = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === "write")?.function;
					if (!write) throw new Error("Explicit executor repair must restore native write access");
					if (results.length === 1) {
						if (!repairReport) throw new Error("Repair report was not observed");
						return { tool: { name: write.name, args: { i: "Refreshing completion report", ...repairReport } } };
					}
					return {
						tool: {
							name: write.name,
							args: {
								i: "Repairing requested implementation",
								path: IMPLEMENTATION_PATH,
								content: IMPLEMENTATION,
							},
						},
					};
				},
			},
			[100, 28],
			async ({ cwd, provider, tui, state, idle, stage }) => {
				const ordinaryCalls = provider.requests.length;
				async function viewMaterials(files: string[], draft: string, resize = false): Promise<void> {
					const before = await state();
					const calls = provider.requests.length;
					const normalize = (text: string) => text.replace(/[│┃║┆┊\s]/gu, "");
					const expected = await Promise.all(
						files.map(async file => {
							const content = await Bun.file(path.join(cwd, file)).text();
							return {
								path: file,
								lines: content.split("\n").filter(line => line.trim()),
								solution: file.endsWith("-solutions.json") ? JSON.parse(content) : undefined,
							};
						}),
					);
					await tui("submit", "/session");
					await tui("expect", "text", "Session Info", "--timeout", "30000");
					const screens: string[] = [];
					async function scrollDetails(): Promise<void> {
						await tui("key", "press", "Home");
						let previous: string | undefined;
						for (let index = 0; index < 100; index++) {
							await tui("wait", "idle", "--timeout", "30000");
							const screen = await tui("text");
							screens.push(normalize(screen));
							if (screen === previous) return;
							previous = screen;
							// Overlap each viewport so wrapped material lines remain readable in full.
							await tui("key", "press", "Down", "Down", "Down", "Down", "Down");
						}
						throw new Error("Native /session details did not reach their scroll boundary");
					}
					await scrollDetails();
					if (resize) {
						await tui("resize", "120", "36");
						await scrollDetails();
					}
					const details = screens.join("\n");
					for (const file of expected) {
						expect(details).toContain(normalize(file.path));
						for (const line of file.lines) expect(details).toContain(normalize(line));
						if (file.solution) {
							const recommendation = file.solution.candidates.find(
								(candidate: { id: string }) => candidate.id === file.solution.recommendedCandidateId,
							);
							expect(details).toContain(normalize(`${recommendation.title} (${recommendation.id}) · 推荐`));
							for (const candidate of file.solution.candidates)
								expect(details).toContain(normalize(`${candidate.title} (${candidate.id})`));
						}
					}
					expect(details).not.toContain("specs/*/spec.md");
					expect(provider.requests).toHaveLength(calls);
					expect(await state()).toEqual(before);
					await tui("key", "press", "Escape");
					await tui("type", draft);
					await tui("expect", "text", draft, "--timeout", "30000");
					expect(provider.requests).toHaveLength(calls);
					expect(await state()).toEqual(before);
					await clearNativeDraft(tui);
				}
				await tui("submit", "/dev unknown-review-command");
				await tui("expect", "text", "未知 /dev 子命令", "--timeout", "30000");
				expect(provider.requests).toHaveLength(ordinaryCalls);
				await clearNativeDraft(tui, "/dev unknown-review-command");
				await tui("submit", "/dev");
				await idle();
				expect(provider.requests).toHaveLength(ordinaryCalls);
				await tui("submit", "unclaimed-draft-beacon");
				await tui("expect", "text", "unclaimed-draft-beacon", "--timeout", "30000");
				expect(provider.requests).toHaveLength(ordinaryCalls);
				await clearNativeDraft(tui);
				await tui("submit", `/dev new ${MARKER}: ${REQUIREMENT}`);
				const requirements = (await stage("requirements")).run!;
				const requirementsInput = entry(provider, "requirements");
				await viewMaterials(
					(requirementsInput.outputPaths as string[]).map(file => file.replace("*", "greeting")),
					"requirements-details-returned-focus",
					true,
				);
				const raw = "需求追问：保持 Ada  Lovelace 内部空白，不表示批准。";
				await tui("submit", raw);
				await tui("expect", "text", `${MARKER}_REQUIREMENTS_DIALOGUE`, "--timeout", "30000");
				await idle();
				const followup = provider.requests.at(-1)!;
				expect(userTexts(followup).at(-1)).toBe(raw);
				expect(stageContexts(followup)).toHaveLength(1);
				expect((await state()).run?.sessions.requirements?.sessionId).toBe(
					requirements.sessions.requirements?.sessionId,
				);
				const screen = (await tui("text")).split("\n");
				const bar = screen.findIndex(line => line.includes("Dev ·"));
				expect(bar).toBeGreaterThanOrEqual(0);
				expect(screen.slice(bar, bar + 3)).toHaveLength(3);
				expect(screen[bar + 1]).toContain("/dev next");
				expect(screen[bar + 2]).toContain("输入发送当前会话");
				// No modal consumes normal typing or Enter at the ready boundary.
				await tui("type", "unsubmitted-native-draft");
				await tui("expect", "text", "unsubmitted-native-draft", "--timeout", "30000");
				await clearNativeDraft(tui);
				await tui("submit", "/dev next");
				const solution = (await stage("solution")).run!;
				const solutionInput = entry(provider, "solution");
				for (const file of solutionInput.files as Array<{ path: string; content: string }>)
					expect(file.content).toBe(await Bun.file(path.join(cwd, file.path)).text());
				expect(solutionInput.decisions).toMatchObject({ requirements: "/dev next" });
				const count = provider.requests.length;
				await tui("submit", "/dev back");
				await stage("requirements");
				expect(provider.requests).toHaveLength(count);
				expect(await tui("text", "--full")).toContain(raw);
				expect((await state()).run?.sessions.requirements?.sessionId).toBe(
					requirements.sessions.requirements?.sessionId,
				);
				await tui("submit", "/dev next");
				await stage("solution");
				await tui("expect", "text", "/dev next [方案ID]", "--timeout", "30000");
				const candidates = await Bun.file(
					path.join(cwd, (entry(provider, "solution").outputPaths as string[])[0]!),
				).json();
				await viewMaterials(entry(provider, "solution").outputPaths as string[], "solution-details-returned-focus");
				await tui("submit", `/dev next ${candidates.candidates[0].id}`);
				const planning = (await stage("planning")).run!;
				const plannerInput = entry(provider, "planner");
				expect(plannerInput.candidateId).toBe(candidates.candidates[0].id);
				expect(plannerInput.decisions).toMatchObject({ solution: `/dev next ${candidates.candidates[0].id}` });
				for (const file of plannerInput.files as Array<{ path: string; content: string }>)
					expect(file.content).toBe(await Bun.file(path.join(cwd, file.path)).text());
				expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).exists()).toBe(false);
				await tui("submit", "/dev next");
				const executing = (await stage("executing")).run!;
				await eventually(state, value => value.run?.awaitingAcceptance === true);
				await idle();
				const ids = [
					requirements.sessions.requirements,
					solution.sessions.solution,
					planning.sessions.planner,
					executing.sessions.executor,
				].map(recipient => recipient?.sessionId);
				expect(ids.every(Boolean)).toBe(true);
				expect(new Set(ids).size).toBe(4);
				const reportPath = (entry(provider, "executor").outputPaths as string[])[0]!;
				const report = await Bun.file(path.join(cwd, reportPath)).text();
				repairReport = { path: reportPath, content: report };
				expect(report).toContain("1 pass");
				await tui("submit", discussion);
				await tui("expect", "text", `${MARKER}_EXECUTOR_DIALOGUE`, "--timeout", "30000");
				await idle();
				expect(await Bun.file(path.join(cwd, reportPath)).text()).toBe(report);
				expect(blockedWriteCallId).toBeString();
				const transcript = (await nativeTranscript(executing, "executor"))
					.trim()
					.split("\n")
					.map(
						line =>
							JSON.parse(line) as {
								message?: { role?: string; toolCallId?: string; toolName?: string; isError?: boolean };
							},
					);
				expect(
					transcript.some(
						entry =>
							entry.message?.role === "toolResult" &&
							entry.message.toolCallId === blockedWriteCallId &&
							entry.message.toolName?.replace(/^_/u, "") === "write" &&
							entry.message.isError === true,
					),
				).toBe(true);
				expect(await tui("text", "--full")).toContain("native-discussion-write-denied");
				expect((await state()).run?.phase).toBe("executing");
				expect((await state()).run?.archivedChangePath).toBeUndefined();
				await tui("submit", "repair 明确重写实现文件，保持已批准范围，不验收");
				await tui("expect", "text", "explicit-native-repair-complete", "--timeout", "30000");
				await idle();
				expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
				expect((await state()).run?.archivedChangePath).toBeUndefined();
				const executorFile = executing.sessions.executor?.sessionFile;
				const beforeExit = provider.requests.length;
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				expect(await tui("text", "--full")).not.toContain(discussion);
				await tui("submit", "/dev");
				await stage("executing");
				await tui("expect", "text", "explicit-native-repair-complete", "--timeout", "30000");
				expect(provider.requests).toHaveLength(beforeExit);
				expect((await state()).run?.sessions.executor?.sessionFile).toBe(executorFile);
				const restored = await state();
				const restoredTranscript = await nativeTranscript(restored.run!, "executor");
				const restoredMessages = restoredTranscript
					.trim()
					.split("\n")
					.map(line => JSON.parse(line) as { message?: { role?: string; content?: unknown } });
				expect(
					restoredMessages.some(
						entry => entry.message?.role === "user" && contentText(entry.message.content) === discussion,
					),
				).toBe(true);
				// Retired viewport rows are not terminal scrollback's history contract.
				// The native rewind browser reads the restored journal; viewing and
				// cancelling it must not select a target or mutate the branch.
				await tui("key", "press", "Escape", "Escape");
				await tui("key", "press", "a", "Home");
				let historyScreen = "";
				let previousHistoryScreen: string | undefined;
				for (let index = 0; index < 500; index++) {
					await tui("wait", "idle", "--timeout", "30000");
					historyScreen = await tui("text");
					if (historyScreen.includes(discussion) || historyScreen === previousHistoryScreen) break;
					previousHistoryScreen = historyScreen;
					await tui("key", "press", "Shift+Down");
				}
				expect(historyScreen).toContain(discussion);
				await tui("key", "press", "Escape");
				await tui("type", "restored-history-editor-focus");
				await tui("expect", "text", "restored-history-editor-focus", "--timeout", "30000");
				await clearNativeDraft(tui);
				expect(await state()).toEqual(restored);
				expect(await nativeTranscript(restored.run!, "executor")).toBe(restoredTranscript);
				expect(provider.requests).toHaveLength(beforeExit);
				await tui("submit", "/dev next");
				const closed = await eventually(state, value => !!value.run?.archivedChangePath);
				await idle();
				await tui("expect", "text", "验收完成，需求已归档", "--timeout", "30000");
				expect(await tui("text")).not.toMatch(/👥\s*[1-9]/u);
				expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).text()).toContain(REQUIREMENT);
				expect(await Bun.file(path.join(cwd, closed.run!.archivedChangePath!, "proposal.md")).exists()).toBe(true);
				expect(closed.run?.changeId).toBe(requirements.changeId);
				expect(
					(requirementsInput.outputPaths as string[]).some(file => file.includes(requirements.changeId!)),
				).toBe(true);
				await tui("submit", "/dev drop");
				await eventually(state, value => !value.run && !value.team);
				await idle();
				expect((await state()).run).toBeUndefined();
				expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).exists()).toBe(true);
				expect(await Bun.file(path.join(cwd, reportPath)).exists()).toBe(true);
				expect(await fs.readFile(executorFile!, "utf8")).toContain(discussion);
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
			},
		);
	},
	300_000,
);

// Team configuration uses only the native selector, and raw followups cannot rerun it.
test.skipIf(!tuiTest)(
	"native Team config cancels, persists, freezes, and does not replay on dialogue",
	async () => {
		await withTui({}, [120, 36], async ({ cwd, provider, tui, state, idle, stage }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", "/dev config");
			await tui("expect", "text", "当前关闭", "--timeout", "30000");
			await tui("key", "press", "Enter");
			await idle();
			expect((await state()).team).toBe(false);
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Down", "Escape");
			expect((await state()).team).toBe(false);
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Up", "Enter");
			await eventually(state, value => value.team);
			await tui("submit", "/dev");
			await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
			const before = provider.requests.length;
			await tui("submit", "/dev");
			await idle();
			expect(provider.requests).toHaveLength(before);
			expect((await state()).team).toBe(true);
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await stage("requirements");
			await tui("submit", "/dev next");
			await stage("solution");
			const teamCalls = provider.requests.filter(request => teamStage(request));
			expect(teamCalls.length).toBeGreaterThan(0);
			expect(new Set(teamCalls.map(teamStage))).toEqual(new Set(["proposal", "alignment", "review", "synthesis"]));
			const solutionFile = (entry(provider, "solution").outputPaths as string[])[0]!;
			const material = await Bun.file(path.join(cwd, solutionFile)).text();
			await tui("submit", "/dev config");
			expect((await state()).team).toBe(true);
			await tui("submit", "请比较完整候选的风险，不批准。");
			await tui("expect", "text", `${MARKER}_SOLUTION_DIALOGUE`, "--timeout", "30000");
			await idle();
			expect(provider.requests.filter(request => teamStage(request))).toHaveLength(teamCalls.length);
			expect(await Bun.file(path.join(cwd, solutionFile)).text()).toBe(material);
			await tui("resize", "100", "28");
			expect(await tui("text")).toContain("Dev ·");
			const candidate = JSON.parse(material).candidates[0].id as string;
			await tui("submit", `/dev next ${candidate}`);
			await stage("planning");
			for (const phase of ["planning", "executing"] as const) {
				if (phase === "executing") {
					await tui("submit", "/dev next");
					await stage("executing");
				}
				await tui("submit", "/dev config");
				await tui("expect", "text", "当前阶段不允许此操作", "--timeout", "30000");
				expect((await state()).team).toBe(true);
			}
			const backCalls = provider.requests.length;
			for (const phase of ["planning", "solution", "requirements"]) {
				await tui("submit", "/dev back");
				await stage(phase);
				expect((await state()).team).toBe(true);
				expect(provider.requests).toHaveLength(backCalls);
			}
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Down", "Enter");
			await eventually(state, value => !value.team);
			expect(provider.requests).toHaveLength(backCalls);
			await tui("submit", "/dev drop");
			await eventually(state, value => !value.run && !value.team);
			await idle();
			expect((await state()).team).toBe(false);
			expect((await state()).run).toBeUndefined();
			expect(await Bun.file(path.join(cwd, solutionFile)).text()).toBe(material);
		});
	},
	300_000,
);

// A native executor failure must preserve its conversation; explicit repair retries there.
test.skipIf(!tuiTest)(
	"executor native failure retains history, read-only discussion and explicit repair retry",
	async () => {
		let broken = true;
		let attempts = 0;
		await withTui(
			{
				fileFailure: { role: "executor", kind: "missing" },
				dialogue(request, input) {
					const raw = continuationText(request) ?? "";
					if (!raw.startsWith("repair")) return respond(request);
					if (raw.startsWith("repair closing")) {
						const lastUser = request.messages.findLastIndex(
							message => message.role === "user" && contentText(message.content) === raw,
						);
						if (request.messages.slice(lastUser + 1).some(message => message.role === "tool"))
							return { text: "native-closing-fault-repaired" };
						const bash = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "bash")?.function;
						if (!bash) throw new Error("Explicit closing repair must expose native bash");
						return {
							tool: {
								name: bash.name,
								args: {
									i: "Removing closing path obstruction",
									command: "bun -e \"require('node:fs').unlinkSync('openspec/specs/greeting')\"",
									timeout: 30,
								},
							},
						};
					}
					if (broken) {
						attempts++;
						return { text: "executor-repair-still-blocked" };
					}
					const advertised = request.tools?.find(
						tool => tool.function?.name.replace(/^_/u, "") === "write",
					)?.function;
					if (!advertised) throw new Error("Explicit repair must expose native write");
					const path = (input.outputPaths as string[])[0]!;
					const lastUser = request.messages.findLastIndex(
						message => message.role === "user" && contentText(message.content) === raw,
					);
					if (request.messages.slice(lastUser + 1).some(message => message.role === "tool"))
						return { text: "executor-repair-complete" };
					return {
						tool: {
							name: advertised.name,
							args: {
								i: "Repairing native completion report",
								path,
								content:
									"# 完成报告\n\n## 完成情况\nNo implementation delivered.\n\n## 验证结果\nNot run: deliberate public failure fixture.\n\n## 未完成项\nGreeting implementation remains outstanding.\n",
							},
						},
					};
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
				const execution = (await stage("executing")).run!;
				await tui("submit", "/goal set manual-executor-objective");
				await tui("submit", "/goal pause");
				await tui("expect", "text", `${MARKER}_EXECUTOR_DIALOGUE: manual-executor-objective`, "--timeout", "30000");
				await idle();
				const goalEntries = (await nativeTranscript(execution, "executor"))
					.trim()
					.split("\n")
					.map(line => JSON.parse(line) as { type: string; data?: { goal?: { id: string; objective: string } } })
					.filter(
						item => item.type === "mode_change" && item.data?.goal?.objective === "manual-executor-objective",
					);
				expect(goalEntries.length).toBeGreaterThan(0);
				const goalId = goalEntries.at(-1)!.data!.goal!.id;
				const callsBeforeMissingReport = provider.requests.length;
				const missingReportPath = (entry(provider, "executor").outputPaths as string[])[0]!;
				const missingDiagnostic = await fs.readFile(path.join(await fs.realpath(cwd), missingReportPath)).then(
					() => {
						throw new Error("The executor fixture unexpectedly created its completion report");
					},
					(error: unknown) => {
						if (!(error instanceof Error)) throw error;
						return error.message;
					},
				);
				await tui("submit", "/dev next");
				// The fixed status row summarizes the missing material; the full native
				// read error and path remain available in the /session details.
				await expectNativeFailure(tui, /完成报告/u, missingDiagnostic, "/dev next");
				await idle();
				expect(await Bun.file(path.join(cwd, missingReportPath)).exists()).toBe(false);
				expect((await state()).run?.phase).toBe("executing");
				expect((await state()).run?.archivedChangePath).toBeUndefined();
				expect((await state()).run?.approvals.executor).toBeUndefined();
				expect(provider.requests).toHaveLength(callsBeforeMissingReport);
				expect((await state()).run?.sessions.executor?.sessionId).toBe(execution.sessions.executor?.sessionId);
				await tui("submit", "repair 请补齐报告但不要批准");
				await tui("expect", "text", "executor-repair-still-blocked", "--timeout", "30000");
				await idle();
				expect(attempts).toBeGreaterThan(0);
				broken = false;
				await tui("submit", "repair 重试报告，保留未完成项");
				await tui("expect", "text", "executor-repair-complete", "--timeout", "30000");
				await idle();
				expect((await state()).run?.sessions.executor?.sessionId).toBe(execution.sessions.executor?.sessionId);
				expect(await Bun.file(path.join(cwd, missingReportPath)).exists()).toBe(true);
				expect((await state()).run?.approvals.executor).toBeUndefined();
				expect((await state()).run?.archivedChangePath).toBeUndefined();
				expect(await nativeTranscript(execution, "executor")).toContain("executor-repair-still-blocked");
				const retainedGoals = (await nativeTranscript(execution, "executor"))
					.trim()
					.split("\n")
					.map(line => JSON.parse(line) as { type: string; data?: { goal?: { id: string; objective: string } } })
					.filter(
						item => item.type === "mode_change" && item.data?.goal?.objective === "manual-executor-objective",
					);
				expect(new Set(retainedGoals.map(item => item.data!.goal!.id))).toEqual(new Set([goalId]));
				expect(provider.requests.filter(request => teamStage(request))).toHaveLength(0);
				// A real filesystem fault blocks native requirement sync, not a mocked close result.
				await fs.mkdir(path.join(cwd, "openspec/specs"), { recursive: true });
				await Bun.write(path.join(cwd, "openspec/specs/greeting"), "deliberate-sync-obstruction\n");
				const beforeClosing = provider.requests.length;
				await tui("submit", "/dev next");
				await tui("expect", "text", "OpenSpec archive failed", "--timeout", "30000");
				await idle();
				expect((await state()).run?.sessions.executor?.sessionFile).toBe(execution.sessions.executor?.sessionFile);
				expect((await state()).run?.archivedChangePath).toBeUndefined();
				expect(provider.requests).toHaveLength(beforeClosing);
				const acceptedReport = await Bun.file(path.join(cwd, missingReportPath)).text();
				await Bun.write(path.join(cwd, missingReportPath), `${acceptedReport}\nExternal post-acceptance edit.\n`);
				await clearNativeDraft(tui, "/dev next");
				await tui("submit", "/dev next");
				await tui("expect", "text", "变化", "--timeout", "30000");
				expect((await state()).run?.sessions.executor?.sessionId).toBe(execution.sessions.executor?.sessionId);
				expect((await state()).run?.archivedChangePath).toBeUndefined();
				expect(provider.requests).toHaveLength(beforeClosing);
				await Bun.write(path.join(cwd, missingReportPath), acceptedReport);
				await clearNativeDraft(tui, "/dev next");
				await tui("submit", "closing-error-dialogue 不修复也不重试");
				await tui("expect", "text", "closing-error-dialogue", "--timeout", "30000");
				await idle();
				expect(await Bun.file(path.join(cwd, "openspec/specs/greeting")).text()).toBe(
					"deliberate-sync-obstruction\n",
				);
				await tui("submit", "repair closing 明确只移除同步路径障碍，不修改已批准材料");
				await tui("expect", "text", "native-closing-fault-repaired", "--timeout", "30000");
				await idle();
				expect((await state()).run?.archivedChangePath).toBeUndefined();
				const beforeRetry = provider.requests.length;
				await tui("submit", "/dev next");
				await eventually(state, value => !!value.run?.archivedChangePath);
				await idle();
				expect(provider.requests).toHaveLength(beforeRetry);
			},
		);
	},
	300_000,
);

test.skipIf(!tuiTest)(
	"missing native history preserves the valid Dev run and single candidate uses the ordinary next entry",
	async () => {
		await withTui({}, [100, 28], async ({ cwd, provider, tui, state, stage, idle, restart }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const original = (await stage("requirements")).run!;
			await tui("submit", "/dev");
			await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
			await fs.unlink(original.sessions.requirements!.sessionFile!);
			await restart();
			const beforeRestore = provider.requests.length;
			await tui("submit", "/dev");
			await stage("requirements");
			expect((await state()).run?.runId).toBe(original.runId);
			expect(provider.requests).toHaveLength(beforeRestore);
			await tui("submit", "请依据保留的正式文件继续澄清，不批准。");
			// Recovery has no stage handoff, so continuationText cannot identify
			// it as ordinary stage dialogue. Wait for this replacement session's
			// actual reply before accepting the native idle row.
			await tui("expect", "text", `${MARKER}_HISTORY_RECOVERY_DIALOGUE`, "--timeout", "30000");
			await idle();
			expect((await state()).run?.runId).toBe(original.runId);
			expect((await state()).run?.phase).toBe("requirements");
			await tui("submit", "/dev next");
			await stage("solution");
			const solutionPath = (entry(provider, "solution").outputPaths as string[])[0]!;
			const candidates = await Bun.file(path.join(cwd, solutionPath)).json();
			expect(candidates.candidates.length).toBeGreaterThan(1);
			candidates.candidates = candidates.candidates.slice(0, 1);
			await Bun.write(path.join(cwd, solutionPath), JSON.stringify(candidates, null, 2));
			await tui("submit", "/dev next");
			await stage("planning");
			expect(entry(provider, "planner").candidateId).toBe(candidates.candidates[0].id);
		});
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"native move exits Dev before changing cwd and reentry restores only the destination workspace",
	async () => {
		await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle }) => {
			const other = path.join(path.dirname(cwd), "other-project");
			await fs.mkdir(other);
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const original = await stage("requirements");
			const originalMessages = nativeMessageEntries(await nativeTranscript(original.run!, "requirements"));
			// /move reloads native skills and may summarize their routing hints.
			// Exclude only that single-message metadata request, not agent turns.
			const agentRequests = () =>
				provider.requests.filter(
					request =>
						!(
							request.messages.length === 1 &&
							request.messages[0]?.role === "user" &&
							contentText(request.messages[0].content).startsWith(
								"Compress into one routing hint of at most 12 words:",
							) &&
							contentText(request.messages[0].content).includes("\n\nSkill:") &&
							!request.tools?.length
						),
				);
			const calls = agentRequests().length;
			await tui("submit", `/move "${other}"`);
			await tui("expect", "text", "Moved to", "--timeout", "30000");
			expect(await state()).toEqual(original);
			expect(agentRequests()).toHaveLength(calls);
			expect(await tui("text")).not.toContain("Dev ·");
			await tui("submit", "/dev");
			await idle();
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Up", "Enter");
			await eventually(
				async () => {
					const file = Bun.file(path.join(other, ".omp/dev/state.json"));
					return (await file.exists()) ? (file.json() as Promise<State>) : undefined;
				},
				value => value?.team === true,
			);
			expect(await state()).toEqual(original);
			await tui("submit", `/move "${cwd}"`);
			await tui("expect", "text", "Moved to", "--timeout", "30000");
			await tui("submit", "/dev");
			const recovered = await stage("requirements");
			expect(recovered.team).toBe(original.team);
			const { sessions: originalSessions, ...originalRun } = original.run!;
			const { sessions: recoveredSessions, ...recoveredRun } = recovered.run!;
			expect(recoveredRun).toEqual(originalRun);
			expect(Object.keys(recoveredSessions).sort()).toEqual(Object.keys(originalSessions).sort());
			for (const role of Object.keys(originalSessions) as Array<keyof SpecSavedRun["sessions"]>) {
				expect(recoveredSessions[role]?.role).toBe(originalSessions[role]?.role);
				expect(recoveredSessions[role]?.sessionId).toBe(originalSessions[role]?.sessionId);
				expect(recoveredSessions[role]?.sessionFile).toBe(originalSessions[role]?.sessionFile);
			}
			expect(nativeMessageEntries(await nativeTranscript(recovered.run!, "requirements"))).toEqual(originalMessages);
			expect(agentRequests()).toHaveLength(calls);
		});
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"native compact affects only the visible requirements session and keeps stage decisions and ordinary history separate",
	async () => {
		await withTui(
			{
				async setup(cwd) {
					await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
					await Bun.write(path.join(cwd, ".omp/config.yml"), "compaction:\n  keepRecentTokens: 1\n");
				},
			},
			[120, 36],
			async ({ provider, tui, state, stage, idle }) => {
				await tui("submit", "/session");
				await tui("expect", "text", "Session Info", "--timeout", "30000");
				const rootSessionId = (await tui("text")).match(/\bID:\s*([a-f0-9-]{36})/iu)?.[1];
				expect(rootSessionId).toBeString();
				await tui("key", "press", "Escape");
				await tui("submit", "/dev");
				await idle();
				await tui("submit", `/dev new ${REQUIREMENT}`);
				const original = (await stage("requirements")).run!;
				await tui("submit", "压缩前的需求澄清：只讨论，不批准。");
				await tui("expect", "text", `${MARKER}_REQUIREMENTS_DIALOGUE`, "--timeout", "30000");
				await idle();
				await tui("submit", "/compact");
				await eventually(
					() => nativeTranscript(original, "requirements"),
					text =>
						text.split("\n").some(line => line && (JSON.parse(line) as { type?: string }).type === "compaction"),
				);
				await idle();
				expect((await state()).run?.runId).toBe(original.runId);
				expect((await state()).run?.phase).toBe("requirements");
				expect((await state()).run?.approvals).toEqual({});
				expect((await state()).run?.sessions.requirements?.sessionId).toBe(
					original.sessions.requirements?.sessionId,
				);
				expect((await state()).run?.sessions.requirements?.sessionFile).toBe(
					original.sessions.requirements?.sessionFile,
				);
				expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(false);
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				expect(await tui("text", "--full")).not.toContain("压缩前的需求澄清");
				const calls = provider.requests.length;
				await tui("submit", "/session");
				await tui("expect", "text", "Session Info", "--timeout", "30000");
				expect((await tui("text")).match(/\bID:\s*([a-f0-9-]{36})/iu)?.[1]).toBe(rootSessionId);
				expect(provider.requests).toHaveLength(calls);
				await tui("key", "press", "Escape");
			},
		);
	},
	180_000,
);
