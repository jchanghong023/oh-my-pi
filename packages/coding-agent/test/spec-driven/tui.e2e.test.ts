import { expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { SpecSavedRun } from "../../src/spec-driven/types";
import inventory from "../../src/spec-driven/vendor/inventory.json";
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
	type ModelRequest,
} from "./provider-fixture";
import {
	clearNativeDraft,
	entry,
	eventually,
	expectNativeFailure,
	nativeDraftMatches,
	nativeDraftSnapshot,
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
						files.map(async file => ({
							path: file,
							lines: (await Bun.file(path.join(cwd, file)).text()).split("\n").filter(line => line.trim()),
						})),
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
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Down", "Escape");
			expect((await state()).team).toBe(false);
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Home", "Enter");
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
				await tui("submit", "/dev next");
				await tui("expect", "text", "ENOENT", "--timeout", "30000");
				await idle();
				expect(await Bun.file(path.join(cwd, missingReportPath)).exists()).toBe(false);
				expect((await state()).run?.phase).toBe("executing");
				expect((await state()).run?.archivedChangePath).toBeUndefined();
				expect(provider.requests).toHaveLength(callsBeforeMissingReport);
				expect((await state()).run?.sessions.executor?.sessionId).toBe(execution.sessions.executor?.sessionId);
				await clearNativeDraft(tui, "/dev next");
				await tui("submit", "repair 请补齐报告但不要批准");
				await tui("expect", "text", "executor-repair-still-blocked", "--timeout", "30000");
				await idle();
				expect(attempts).toBeGreaterThan(0);
				broken = false;
				await tui("submit", "repair 重试报告，保留未完成项");
				await tui("expect", "text", "executor-repair-complete", "--timeout", "30000");
				await idle();
				expect((await state()).run?.sessions.executor?.sessionId).toBe(execution.sessions.executor?.sessionId);
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
	"requirements native attachment and followup queue retain exact input without handoff replay",
	async () => {
		const release = Promise.withResolvers<void>();
		let held = false;
		await withTui(
			{
				async delay(request, signal) {
					if (continuationText(request) !== "held-native-dialogue" || held) return;
					held = true;
					await Promise.race([
						release.promise,
						new Promise<void>((_, reject) => {
							signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						}),
					]);
				},
			},
			[100, 28],
			async ({ cwd, provider, tui, state, idle, stage }) => {
				const image = path.join(cwd, "requirement.png");
				await Bun.write(
					image,
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
						"base64",
					),
				);
				await tui("submit", "/dev");
				await idle();
				const calls = provider.requests.length;
				// Raw PTY bracketed paste uses the real editor's file-image attachment path.
				await tui("write", `\u001b[200~${image}\u001b[201~`);
				await tui("expect", "text", "#[0-9]+", "--regex", "--timeout", "30000");
				await tui("type", "unclaimed-image-draft");
				await tui("key", "press", "Enter");
				await tui("expect", "text", "当前无阶段 Agent", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				await tui("expect", "text", "#[0-9]+", "--regex", "--timeout", "30000");
				expect(await tui("text")).toContain("unclaimed-image-draft");
				// Keep the rejected draft's inline image token: clearing the draft
				// intentionally deletes the attachment under the native composer contract.
				await tui("key", "press", "Home");
				await tui("type", `/dev new ${REQUIREMENT} `);
				await tui("key", "press", "Enter");
				const requirements = (await stage("requirements")).run!;
				const initial = provider.requests.find(request => rolePayload(request)?.specDrivenRole === "requirements")!;
				expect(
					initial.messages
						.flatMap(message => (Array.isArray(message.content) ? message.content : []))
						.filter(
							part => typeof part === "object" && part !== null && "type" in part && part.type === "image_url",
						),
				).toHaveLength(1);
				expect(userTexts(initial).at(-1)).toContain("unclaimed-image-draft");
				await tui("submit", "held-native-dialogue");
				await eventually(async () => held, Boolean);
				await tui("type", "queued-native-followup");
				await tui("key", "press", "Ctrl+Enter");
				release.resolve();
				await tui("expect", "text", "queued-native-followup", "--timeout", "30000");
				await eventually(
					async () => provider.requests,
					requests => requests.some(request => continuationText(request) === "queued-native-followup"),
				);
				await idle();
				expect((await state()).run?.sessions.requirements?.sessionId).toBe(
					requirements.sessions.requirements?.sessionId,
				);
				const queued = provider.requests.findLast(
					request => continuationText(request) === "queued-native-followup",
				)!;
				expect(stageContexts(queued)).toHaveLength(1);
				expect(userTexts(queued)).toContain("held-native-dialogue");
				expect(provider.requests.some(teamStage)).toBe(false);
				await tui("resize", "120", "36");
				expect(await tui("text")).toContain("Dev ·");
			},
		);
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"six public Dev entries reject ordinary-mode use, retired commands and malformed decisions without model work",
	async () => {
		await withTui({}, [100, 28], async ({ provider, tui, state, idle }) => {
			const calls = provider.requests.length;
			for (const command of ["config", `new ${REQUIREMENT}`, "next", "back", "drop"]) {
				await tui("submit", `/dev ${command}`);
				await tui("expect", "text", "请先输入 /dev", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect(await state()).toEqual({ team: false });
				await clearNativeDraft(tui, `/dev ${command}`);
				expect(await tui("text")).not.toContain("Dev ·");
			}
			await tui("submit", "/dev");
			await idle();
			for (const command of [
				"help",
				"start",
				"status",
				"answer",
				"confirm-spec",
				"choose",
				"confirm-plan",
				"revise-plan",
				"accept",
				"repair",
				"amend",
				"change-solution",
				"cancel-message",
				"pause",
				"resume",
				"cancel",
				"unknown-review-command",
			]) {
				await tui("submit", `/dev ${command}`);
				await tui("expect", "text", `未知 /dev 子命令：${command}`, "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect((await state()).run).toBeUndefined();
				await clearNativeDraft(tui, `/dev ${command}`);
			}
			for (const command of ["new", "config surplus", "back surplus", "drop surplus", "next pure normalizer"]) {
				await tui("submit", `/dev ${command}`);
				await tui("expect", "text", "用法：/dev", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect((await state()).run).toBeUndefined();
				await clearNativeDraft(tui, `/dev ${command}`);
			}
			for (const command of ["/dev next", "/dev back", "/goal set forbidden-hidden-root-goal"]) {
				await tui("submit", command);
				await tui("expect", "text", "请先|没有|不能执行|不允许|尚无", "--regex", "--timeout", "30000");
				await tui("wait", "idle", "--timeout", "30000");
				expect(await tui("text")).toContain(command);
				expect(provider.requests).toHaveLength(calls);
				expect((await state()).run).toBeUndefined();
				await clearNativeDraft(tui, command);
			}
		});
	},
	300_000,
);

for (const role of ["requirements", "solution", "planner", "executor"] as const) {
	for (const kind of ["missing", "malformed", "unknown"] as const) {
		test.skipIf(!tuiTest)(
			`native TUI next preserves ${role} on ${kind} formal material and retains editor focus`,
			async () => {
				await withTui({ fileFailure: { role, kind } }, [100, 28], async ({ provider, tui, state, stage, idle }) => {
					await tui("submit", "/dev");
					await idle();
					await tui("submit", `/dev new ${REQUIREMENT}`);
					await stage("requirements");
					if (role !== "requirements") {
						await tui("submit", "/dev next");
						await stage("solution");
					}
					if (role === "planner" || role === "executor") {
						await tui("submit", "/dev next pure");
						await stage("planning");
					}
					if (role === "executor") {
						await tui("submit", "/dev next");
						await stage("executing");
					}
					const before = await state();
					const calls = provider.requests.length;
					const transcript = await nativeTranscript(before.run!, role);
					await tui("submit", role === "solution" ? "/dev next pure" : "/dev next");
					const material =
						role === "requirements"
							? `openspec/changes/${before.run!.changeId}`
							: (entry(provider, role).outputPaths as string[])[0]!;
					const reason =
						kind !== "malformed"
							? /ENOENT|Missing native specification/
							: role === "requirements"
								? /Specification validation failed|Empty specification artifact/
								: role === "solution"
									? /valid JSON/
									: role === "planner"
										? /Empty specification artifact/
										: /Completion report requires/;
					await expectNativeFailure(tui, reason, material, role === "solution" ? "/dev next pure" : "/dev next");
					await idle();
					expect(await state()).toEqual(before);
					expect(provider.requests).toHaveLength(calls);
					expect(await nativeTranscript(before.run!, role)).toBe(transcript);
					await clearNativeDraft(tui);
					await tui("type", `retained-${role}-${kind}-draft`);
					await tui("expect", "text", `retained-${role}-${kind}-draft`, "--timeout", "30000");
					expect(provider.requests).toHaveLength(calls);
				});
			},
			180_000,
		);
	}
}

test.skipIf(!tuiTest)(
	"native candidate decisions reject missing and invalid IDs, detect changed approval bytes and back only one stage",
	async () => {
		await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await stage("requirements");
			for (const raw of ["可以", "继续", "同意"]) {
				await tui("submit", raw);
				await tui("expect", "text", `${MARKER}_REQUIREMENTS_DIALOGUE: ${raw}`, "--timeout", "30000");
				await idle();
				expect((await state()).run?.phase).toBe("requirements");
				expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(false);
			}
			const calls = provider.requests.length;
			await tui("submit", "/dev next pure");
			await tui("expect", "text", "只有方案阶段允许", "--timeout", "30000");
			expect((await state()).run?.phase).toBe("requirements");
			expect(provider.requests).toHaveLength(calls);
			await clearNativeDraft(tui, "/dev next pure");
			await tui("submit", "/dev next");
			await stage("solution");
			const solution = await state();
			const solutionCalls = provider.requests.length;
			const solutionPath = (entry(provider, "solution").outputPaths as string[])[0]!;
			const completeSolution = await Bun.file(path.join(cwd, solutionPath)).text();
			const valid = JSON.parse(completeSolution).candidates[0];
			for (const [candidates, reason] of [
				[[], /at least one candidate/],
				[[valid, valid], /Duplicate solution candidate ID/],
				[[{ ...valid, id: "invalid id" }], /whitespace-free id/],
				[[{ ...valid, title: "" }], /nonempty title\/content/],
				[[{ ...valid, content: "" }], /nonempty title\/content/],
			] as const) {
				await Bun.write(path.join(cwd, solutionPath), JSON.stringify({ candidates }));
				await tui("submit", "/dev next pure");
				await expectNativeFailure(tui, reason, solutionPath, "/dev next pure");
				await idle();
				expect(await state()).toEqual(solution);
				expect(provider.requests).toHaveLength(solutionCalls);
				await clearNativeDraft(tui);
			}
			await Bun.write(path.join(cwd, solutionPath), completeSolution);
			for (const command of ["/dev next", "/dev next nonexistent"]) {
				await tui("submit", command);
				await tui("expect", "text", "请选择有效方案 ID", "--timeout", "30000");
				expect(await state()).toEqual(solution);
				expect(provider.requests).toHaveLength(solutionCalls);
				await clearNativeDraft(tui, command);
			}
			const proposal = (entry(provider, "requirements").outputPaths as string[])[0]!;
			const original = await Bun.file(path.join(cwd, proposal)).text();
			await Bun.write(path.join(cwd, proposal), `${original}\nExternal approved material edit.\n`);
			await tui("submit", "/dev next pure");
			await tui("expect", "text", "变化", "--timeout", "30000");
			expect(await state()).toEqual(solution);
			expect(provider.requests).toHaveLength(solutionCalls);
			await Bun.write(path.join(cwd, proposal), original);
			await clearNativeDraft(tui, "/dev next pure");
			await tui("submit", "/dev next normalizer");
			const planning = (await stage("planning")).run!;
			expect(entry(provider, "planner").candidateId).toBe("normalizer");
			const beforeBack = provider.requests.length;
			await tui("submit", "/dev back");
			await stage("solution");
			expect(provider.requests).toHaveLength(beforeBack);
			expect((await state()).run?.sessions.planner?.sessionId).toBe(planning.sessions.planner?.sessionId);
			expect((await state()).run?.approvals.solution).toBeUndefined();
			await tui("submit", "/dev back");
			await stage("requirements");
			expect(provider.requests).toHaveLength(beforeBack);
			expect(await Bun.file(path.join(cwd, proposal)).text()).toBe(original);
			expect(await Bun.file(path.join(cwd, (entry(provider, "planner").outputPaths as string[])[0]!)).exists()).toBe(
				true,
			);
		});
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"real TUI owners share a Git subtree, survive process restart and clear only corrupt Dev state",
	async () => {
		await withTui(
			{
				async setup(cwd) {
					const child = Bun.spawn(["git", "init", "--quiet", cwd], { stdout: "pipe", stderr: "pipe" });
					const error = await new Response(child.stderr).text();
					if (await child.exited) throw new Error(`Cannot prepare real Git worktree: ${error}`);
					await fs.mkdir(path.join(cwd, "src/nested"), { recursive: true });
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state, idle, stage, open, restart }) => {
				const preserved = path.join(cwd, "owner-note.txt");
				await Bun.write(preserved, "unrelated user change\n");
				await tui("submit", "/dev");
				await idle();
				await tui("submit", "/dev config");
				await tui("expect", "text", "方案 Team", "--timeout", "30000");
				await tui("key", "press", "Home", "Enter");
				await eventually(state, value => value.team);
				const peer = await open(path.join(cwd, "src/nested"));
				const beforeOccupied = await state();
				const calls = provider.requests.length;
				await peer.tui("submit", "/dev");
				await peer.tui("expect", "text", "Dev 工作区已被占用", "--timeout", "30000");
				expect(await peer.tui("text", "--full")).toContain("ordinary-root-beacon");
				expect(await state()).toEqual(beforeOccupied);
				expect(provider.requests).toHaveLength(calls);
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await clearNativeDraft(peer.tui);
				await peer.tui("submit", "/dev");
				await eventually(
					() => peer.tui("text"),
					screen => screen.split("\n").some(line => line.includes("Dev ·") && /Team[\s:：]+开/u.test(line)),
				);
				expect((await state()).team).toBe(true);
				expect(await Bun.file(path.join(cwd, "src/nested/.omp/dev/state.json")).exists()).toBe(false);
				await peer.tui("submit", "/dev");
				await peer.tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await peer.close();
				await restart();
				const beforeRestore = provider.requests.length;
				await tui("submit", "/dev");
				await idle();
				expect(provider.requests).toHaveLength(beforeRestore);
				expect(await state()).toEqual(beforeOccupied);
				await tui("submit", `/dev new ${REQUIREMENT}`);
				const saved = (await stage("requirements")).run!;
				const savedRequirementsTranscript = await nativeTranscript(saved, "requirements");
				expect((await state()).team).toBe(true);
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await restart();
				const callsBeforeRunRestore = provider.requests.length;
				await tui("submit", "/dev");
				const recovered = (await stage("requirements")).run!;
				expect(provider.requests).toHaveLength(callsBeforeRunRestore);
				expect((await state()).run?.runId).toBe(saved.runId);
				expect(Object.keys(recovered.sessions).sort()).toEqual(Object.keys(saved.sessions).sort());
				for (const role of Object.keys(saved.sessions) as Array<keyof SpecSavedRun["sessions"]>) {
					expect(recovered.sessions[role]?.role).toBe(saved.sessions[role]?.role);
					expect(recovered.sessions[role]?.sessionId).toBe(saved.sessions[role]?.sessionId);
					expect(recovered.sessions[role]?.sessionFile).toBe(saved.sessions[role]?.sessionFile);
				}
				expect(nativeMessageEntries(await nativeTranscript(recovered, "requirements"))).toEqual(
					nativeMessageEntries(savedRequirementsTranscript),
				);
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await Bun.write(path.join(cwd, ".omp/dev/state.json"), "{broken-old-dev-state");
				await tui("submit", "/dev");
				await tui("expect", "text", "旧 Dev 状态无法恢复，已清除", "--timeout", "30000");
				await idle();
				expect((await state()).team).toBe(false);
				expect((await state()).run).toBeUndefined();
				expect(provider.requests).toHaveLength(callsBeforeRunRestore);
				expect(await Bun.file(preserved).text()).toBe("unrelated user change\n");
				expect(await nativeTranscript(saved, "requirements")).toContain(REQUIREMENT);
				for (const file of entry(provider, "requirements").outputPaths as string[])
					expect(await Bun.file(path.join(cwd, file.replace("*", "greeting"))).exists()).toBe(true);
			},
		);
	},
	300_000,
);

for (const stop of ["Escape", "/dev", "/dev drop"] as const) {
	test.skipIf(!tuiTest)(
		`native busy next/back are rejected and ${stop} isolates late provider results and queued input`,
		async () => {
			const release = Promise.withResolvers<void>();
			let held = false;
			let returned = false;
			await withTui(
				{
					async delay(request) {
						if (continuationText(request) !== "late-old-stage-beacon" || held) return;
						held = true;
						// Deliberately ignore transport abort to exercise a real late HTTP
						// response after native cancellation, not a forged session event.
						await release.promise;
						returned = true;
					},
				},
				[100, 28],
				async ({ provider, tui, state, stage, idle }) => {
					await tui("submit", "/dev");
					await idle();
					await tui("submit", `/dev new ${REQUIREMENT}`);
					const old = (await stage("requirements")).run!;
					await tui("submit", "late-old-stage-beacon");
					await eventually(async () => held, Boolean);
					const calls = provider.requests.length;
					for (const command of ["/dev next", "/dev back"]) {
						await tui("submit", command);
						await tui("expect", "text", "尚未结清", "--timeout", "30000");
						expect((await state()).run?.phase).toBe("requirements");
						expect(provider.requests).toHaveLength(calls);
						await clearNativeDraft(tui, command);
					}
					const queuedText = "cancelled-old-stage-queued-input";
					await tui("type", queuedText);
					await tui("key", "press", "Ctrl+Enter");
					// The follow-up must actually leave the composer and enter the
					// native pending band before Stop, not race its async admission.
					await eventually(
						() => nativeDraftSnapshot(tui),
						({ screen, cursor }) => nativeDraftMatches(screen, "", cursor) && screen.includes(queuedText),
					);
					expect(provider.requests).toHaveLength(calls);
					if (stop === "Escape") await tui("key", "press", "Escape");
					else await tui("submit", stop);
					release.resolve();
					await eventually(async () => returned, Boolean);
					if (stop === "Escape") {
						// Ordinary Escape returns queued user input to the editor.
						// Prove its exact restoration before clearing it for /dev drop.
						await clearNativeDraft(tui, queuedText);
					}
					if (stop === "/dev") {
						await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
						await eventually(
							() => nativeDraftSnapshot(tui),
							({ screen, cursor }) => nativeDraftMatches(screen, "", cursor),
						);
						await tui("submit", "/dev");
						await stage("requirements");
					} else await idle();
					if (stop !== "/dev drop") {
						await tui("submit", "/dev drop");
						await idle();
					}
					await eventually(state, value => !value.run && !value.team);
					expect((await state()).team).toBe(false);
					expect((await state()).run).toBeUndefined();
					await eventually(
						() => nativeDraftSnapshot(tui),
						({ screen, cursor }) => nativeDraftMatches(screen, "", cursor),
					);
					await tui("submit", `/dev new ${REQUIREMENT}`);
					const current = (await stage("requirements")).run!;
					expect(current.runId).not.toBe(old.runId);
					expect(current.changeId).not.toBe(old.changeId);
					const transcript = await nativeTranscript(current, "requirements");
					expect(transcript).not.toContain("late-old-stage-beacon");
					expect(transcript).not.toContain("cancelled-old-stage-queued-input");
					expect(
						provider.requests.some(request => continuationText(request) === "cancelled-old-stage-queued-input"),
					).toBe(false);
				},
			);
		},
		180_000,
	);
}

test.skipIf(!tuiTest)(
	"native Team ordinary Escape cancels owned work and only manual back next restarts discussion",
	async () => {
		const cleanup = Promise.withResolvers<void>();
		const held = new Set<ModelRequest>();
		const aborted = new Set<ModelRequest>();
		const returned = new Set<ModelRequest>();
		const lateMarker = "cancelled-team-proposal-must-not-survive";
		let hold = true;
		try {
			await withTui(
				{
					async delay(request, signal) {
						if (!hold || !teamStage(request)) return;
						held.add(request);
						// No timer releases this request. Only a real client disconnect
						// (or final cleanup after an assertion fails) opens the barrier.
						await new Promise<void>(resolve => {
							const onAbort = () => {
								aborted.add(request);
								resolve();
							};
							if (signal.aborted) onAbort();
							else signal.addEventListener("abort", onAbort, { once: true });
							void cleanup.promise.then(() => {
								signal.removeEventListener("abort", onAbort);
								resolve();
							});
						});
					},
					reply(request) {
						const reply = respond(request);
						if (held.has(request)) {
							returned.add(request);
							// Attempt a genuine late HTTP result after transport abort;
							// the replacement discussion must never consume this proposal.
							const data = reply.tool?.args.data;
							if (isRecord(data) && typeof data.proposal === "string") data.proposal += `\n${lateMarker}`;
						}
						return reply;
					},
				},
				[120, 36],
				async ({ cwd, provider, tui, state, stage, idle }) => {
					await tui("submit", "/dev");
					await idle();
					await tui("submit", "/dev config");
					await tui("expect", "text", "方案 Team", "--timeout", "30000");
					await tui("key", "press", "Home", "Enter");
					await eventually(state, value => value.team);
					await tui("submit", `/dev new ${REQUIREMENT}`);
					await stage("requirements");
					await tui("submit", "/dev next");
					const running = await eventually(state, value => value.run?.phase === "solution");
					await eventually(
						async () => held.size,
						count => count > 0,
					);
					expect(running.run?.sessions.solution?.sessionFile).toBeTruthy();
					const requirementsTranscript = await nativeTranscript(running.run!, "requirements");
					expect(await tui("text")).toContain("运行中");
					// Do not wait for solution idle: the native owner is still working.
					await tui("key", "press", "Escape");
					await eventually(
						async () => ({ held: held.size, aborted: aborted.size }),
						value => value.held > 0 && value.aborted === value.held,
					);
					await eventually(
						async () => returned.size,
						count => count === held.size,
					);
					await idle();
					expect(await state()).toEqual(running);
					const teamCalls = provider.requests.filter(request => teamStage(request));
					expect(new Set(teamCalls.map(teamStage))).toEqual(new Set(["proposal"]));
					expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(
						false,
					);
					const solutionPath = running.run!.paths!.solution;
					expect(await Bun.file(path.join(cwd, solutionPath)).exists()).toBe(false);
					const stoppedCalls = provider.requests.length;
					// Cancellation restores the failed control command in the editor.
					// Prove that draft is present before clearing it for navigation.
					await clearNativeDraft(tui, "/dev next");
					await tui("submit", "/dev");
					await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
					await tui("submit", "/dev");
					const reentered = await stage("solution");
					// Reentry recreates runtime actors. An empty solution session may
					// also be recreated because Team was stopped before its first prompt.
					expect(reentered.team).toBe(running.team);
					expect(reentered.run?.runId).toBe(running.run?.runId);
					expect(reentered.run?.phase).toBe(running.run?.phase);
					expect(reentered.run?.changeId).toBe(running.run?.changeId);
					expect(reentered.run?.approvals).toEqual(running.run?.approvals);
					expect(reentered.run?.paths).toEqual(running.run?.paths);
					expect(reentered.run?.sessions.requirements?.sessionId).toBe(
						running.run?.sessions.requirements?.sessionId,
					);
					expect(reentered.run?.sessions.requirements?.sessionFile).toBe(
						running.run?.sessions.requirements?.sessionFile,
					);
					expect(nativeMessageEntries(await nativeTranscript(reentered.run!, "requirements"))).toEqual(
						nativeMessageEntries(requirementsTranscript),
					);
					expect(provider.requests).toHaveLength(stoppedCalls);
					await tui("submit", "/dev back");
					await stage("requirements");
					expect(provider.requests).toHaveLength(stoppedCalls);
					hold = false;
					await tui("submit", "/dev next");
					const restarted = await stage("solution");
					expect(restarted.run?.runId).toBe(running.run?.runId);
					expect(restarted.team).toBe(true);
					expect(provider.requests.filter(request => teamStage(request)).length).toBeGreaterThan(teamCalls.length);
					expect(new Set(provider.requests.filter(request => teamStage(request)).map(teamStage))).toEqual(
						new Set(["proposal", "alignment", "review", "synthesis"]),
					);
					expect(await Bun.file(path.join(cwd, solutionPath)).text()).not.toContain(lateMarker);
					expect(await nativeTranscript(restarted.run!, "solution")).not.toContain(lateMarker);
				},
			);
		} finally {
			cleanup.resolve();
		}
	},
	300_000,
);

for (const outcome of ["failure", "cancel"] as const) {
	test.skipIf(!tuiTest)(
		`native Team ${outcome} has no single-agent fallback or automatic discussion replay`,
		async () => {
			let held = false;
			let fail = outcome === "failure";
			await withTui(
				{
					fail: request => (fail && teamStage(request) ? "fixture-team-unavailable" : undefined),
					async delay(request, signal) {
						if (outcome !== "cancel" || !teamStage(request) || held) return;
						held = true;
						await new Promise<void>((_, reject) => {
							if (signal.aborted) reject(signal.reason);
							else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						});
					},
				},
				[120, 36],
				async ({ provider, tui, state, stage, idle }) => {
					await tui("submit", "/dev");
					await idle();
					await tui("submit", "/dev config");
					await tui("expect", "text", "方案 Team", "--timeout", "30000");
					await tui("key", "press", "Home", "Enter");
					await eventually(state, value => value.team);
					await tui("submit", `/dev new ${REQUIREMENT}`);
					await stage("requirements");
					await tui("submit", "/dev next");
					await eventually(state, value => value.run?.phase === "solution");
					if (outcome === "cancel") {
						await eventually(async () => held, Boolean);
						await tui("submit", "/dev drop");
						await eventually(state, value => !value.run && !value.team);
						await idle();
						expect((await state()).team).toBe(false);
						expect((await state()).run).toBeUndefined();
						expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(
							false,
						);
						return;
					}
					// The fixed error row reports terminal Team failure; its full
					// per-member provider cause can require the scrollable details.
					await expectNativeFailure(tui, /Team failed:/, "fixture-team-unavailable", "/dev next");
					await idle();
					expect((await state()).run?.phase).toBe("solution");
					expect((await state()).team).toBe(true);
					expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(
						false,
					);
					const failedCalls = provider.requests.filter(request => teamStage(request)).length;
					await tui("submit", "只解释当前 Team 失败，不重跑讨论，不批准。");
					// Team failed before the native stage handoff; its first ordinary
					// reply therefore has no rolePayload/continuationText marker.
					await tui("expect", "text", `${MARKER}_CHAT_READY`, "--timeout", "30000");
					await idle();
					expect(provider.requests.filter(request => teamStage(request))).toHaveLength(failedCalls);
					expect((await state()).run?.phase).toBe("solution");
					await tui("submit", "/dev");
					await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
					await tui("submit", "/dev");
					await stage("solution");
					expect(provider.requests.filter(request => teamStage(request))).toHaveLength(failedCalls);
					await tui("submit", "/dev back");
					await stage("requirements");
					fail = false;
					await tui("submit", "/dev next");
					await stage("solution");
					expect(provider.requests.filter(request => teamStage(request)).length).toBeGreaterThan(failedCalls);
					expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(
						true,
					);
				},
			);
		},
		300_000,
	);
}

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
			await tui("key", "press", "Home", "Enter");
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
	"ordinary native work and Plan mode block Dev entry without stopping unrelated work or clearing root history",
	async () => {
		let held = false;
		let aborted = false;
		let delaySettled = false;
		await withTui(
			{
				async delay(request, signal) {
					if (rolePayload(request) || !userTexts(request).at(-1)?.endsWith("held-ordinary-work")) return;
					held = true;
					try {
						await new Promise<void>((_, reject) => {
							const abort = () => {
								aborted = true;
								reject(signal.reason);
							};
							if (signal.aborted) abort();
							else signal.addEventListener("abort", abort, { once: true });
						});
					} finally {
						delaySettled = true;
					}
				},
			},
			[100, 28],
			async ({ provider, tui, state, idle }) => {
				await tui("submit", "held-ordinary-work");
				await eventually(async () => held, Boolean);
				const calls = provider.requests.length;
				const original = await state();
				await tui("submit", "/dev");
				await tui("expect", "text", "普通会话仍有原生输入或任务", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect(await state()).toEqual(original);
				await clearNativeDraft(tui, "/dev");
				expect(aborted).toBe(false);
				expect(delaySettled).toBe(false);
				await tui("key", "press", "Escape");
				await eventually(async () => aborted && delaySettled, Boolean);
				await tui("submit", "/plan");
				await tui("expect", "text", "Plan mode enabled.", "--timeout", "30000");
				await tui("submit", "/dev");
				await tui("expect", "text", "请先退出 Plan、Goal 或 Vibe 模式", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect(await state()).toEqual(original);
				expect(await tui("text", "--full")).toContain("ordinary-root-beacon");
				await clearNativeDraft(tui, "/dev");
				await tui("submit", "/plan");
				await tui("expect", "text", "Plan mode paused.", "--timeout", "30000");
				await tui("submit", "/plan");
				await tui("expect", "text", "Plan mode disabled", "--timeout", "30000");
				await tui("submit", "/dev");
				await idle();
				expect(provider.requests).toHaveLength(calls);
			},
		);
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"real atomic state publication failures reject configuration and phase advancement without starting dependent work",
	async () => {
		await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle }) => {
			const statePath = path.join(cwd, ".omp/dev/state.json");
			async function obstruct(work: () => Promise<void>): Promise<void> {
				const errors: unknown[] = [];
				if (process.platform === "win32") {
					const kernel = dlopen("kernel32.dll", {
						CreateFileW: {
							args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
							returns: FFIType.ptr,
						},
						CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
						GetLastError: { args: [], returns: FFIType.u32 },
					});
					try {
						const name = new Uint16Array([...statePath.split("").map(character => character.charCodeAt(0)), 0]);
						// Allow real reads/writes, but deny atomic rename/delete while
						// leaving the active native journal and its directory untouched.
						const handle = kernel.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, 0x80, null);
						if (!handle || Number(handle) === -1 || Number(handle) === Number(0xffffffffffffffffn))
							throw new Error(`Cannot acquire fixture save obstruction: ${kernel.symbols.GetLastError()}`);
						try {
							await work();
						} catch (error) {
							errors.push(error);
						} finally {
							if (!kernel.symbols.CloseHandle(handle))
								errors.push(new Error("Cannot release fixture save obstruction"));
						}
					} finally {
						kernel.close();
					}
				} else {
					const backup = `${statePath}.fixture-backup-${crypto.randomUUID()}`;
					await fs.rename(statePath, backup);
					let occupied = false;
					try {
						await fs.mkdir(statePath);
						occupied = true;
						await work();
					} catch (error) {
						errors.push(error);
					} finally {
						try {
							if (occupied) await fs.rmdir(statePath);
							await fs.rename(backup, statePath);
						} catch (cleanupError) {
							errors.push(cleanupError);
						}
					}
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "Dev fixture work and restoration failed");
			}
			await tui("submit", "/dev");
			await idle();
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Down", "Enter");
			await eventually(() => Bun.file(statePath).exists(), Boolean);
			const saved = await state();
			const calls = provider.requests.length;
			await obstruct(async () => {
				await tui("submit", "/dev config");
				await tui("expect", "text", "方案 Team", "--timeout", "30000");
				await tui("key", "press", "Home", "Enter");
				await expectNativeFailure(tui, /EBUSY|ENOENT|EISDIR|EPERM|EACCES|EEXIST|ENOTDIR/);
				expect(provider.requests).toHaveLength(calls);
			});
			expect(await state()).toEqual(saved);
			await clearNativeDraft(tui, "/dev config");
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const original = await stage("requirements");
			await tui("expect", "text", "文件已写入。请检查实际交付文件", "--timeout", "30000");
			await idle();
			const beforeNext = provider.requests.length;
			await obstruct(async () => {
				await tui("submit", "/dev next");
				await expectNativeFailure(tui, /EBUSY|ENOENT|EISDIR|EPERM|EACCES|EEXIST|ENOTDIR/, ".omp/dev", "/dev next");
				expect(provider.requests).toHaveLength(beforeNext);
			});
			expect(await state()).toEqual(original);
			await clearNativeDraft(tui);
			await tui("submit", "/dev next");
			await stage("solution");
			expect((await state()).team).toBe(false);
		});
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"a real provider authentication failure retains the created requirements run for explicit native continuation",
	async () => {
		await withTui({ authFailureOnce: true }, [100, 28], async ({ provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await tui("expect", "text", "Local mock authentication rejected", "--timeout", "30000");
			const failed = (await stage("requirements")).run!;
			expect(failed.sessions.requirements?.sessionId).toBeString();
			expect((await state()).team).toBe(false);
			await clearNativeDraft(tui, `/dev new ${REQUIREMENT}`);
			await tui("submit", "请继续澄清需求，不批准。");
			await tui("expect", "text", `${MARKER}_REQUIREMENTS_DIALOGUE`, "--timeout", "30000");
			await idle();
			expect((await state()).run?.runId).toBe(failed.runId);
			expect((await state()).run?.sessions.requirements?.sessionId).toBe(failed.sessions.requirements?.sessionId);
			expect(provider.requests.filter(request => rolePayload(request)?.specDrivenRole === "solution")).toHaveLength(
				0,
			);
		});
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"requirements native wiki remains read-only and an authorized document hardlink cannot mutate a business alias",
	async () => {
		let proposal = "";
		let blockedCall = "";
		await withTui(
			{
				wikiQuery: "deterministic-greeting-contract",
				dialogue(request) {
					if (continuationText(request) !== "probe-linked-document") return respond(request);
					const lastUser = request.messages.findLastIndex(
						message => message.role === "user" && contentText(message.content) === "probe-linked-document",
					);
					const result = request.messages.slice(lastUser + 1).find(message => message.role === "tool");
					if (result) {
						blockedCall = result.tool_call_id ?? "";
						return { text: "native-linked-document-probe-settled" };
					}
					const write = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === "write")?.function;
					if (!write)
						throw new Error("Requirements write must be exercised at the real native permission boundary");
					return {
						tool: {
							name: write.name,
							args: {
								i: "Probing document alias restriction",
								path: proposal,
								content: "unauthorized alias mutation\n",
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
				const run = (await stage("requirements")).run!;
				const originalTranscript = await nativeTranscript(run, "requirements");
				expect(originalTranscript).toContain("deterministic-greeting-contract");
				expect(originalTranscript).toContain('"toolName":"wiki"');
				proposal = (entry(provider, "requirements").outputPaths as string[])[0]!;
				const original = await Bun.file(path.join(cwd, proposal)).text();
				const business = path.join(cwd, "business-note.txt");
				await Bun.write(business, "user-owned business content\n");
				await fs.unlink(path.join(cwd, proposal));
				await fs.link(business, path.join(cwd, proposal));
				await tui("submit", "probe-linked-document");
				await tui("expect", "text", "native-linked-document-probe-settled", "--timeout", "30000");
				await idle();
				expect(await Bun.file(business).text()).toBe("user-owned business content\n");
				expect(blockedCall).toBeString();
				const rows = (await nativeTranscript(run, "requirements"))
					.trim()
					.split("\n")
					.map(line => JSON.parse(line) as { message?: { toolCallId?: string; isError?: boolean } });
				expect(rows.some(row => row.message?.toolCallId === blockedCall && row.message.isError)).toBe(true);
				expect((await state()).run?.phase).toBe("requirements");
				await fs.unlink(path.join(cwd, proposal));
				await Bun.write(path.join(cwd, proposal), original);
				await tui("submit", "/dev next");
				await stage("solution");
				expect(await Bun.file(business).text()).toBe("user-owned business content\n");
			},
		);
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"new initialization failure preserves saved Team and unrelated files and permits a fresh requirements run",
	async () => {
		await withTui({}, [100, 28], async ({ cwd, provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Home", "Enter");
			const configured = await eventually(state, value => value.team);
			await Bun.write(path.join(cwd, "user-source.txt"), "preserve user work\n");
			await Bun.write(path.join(cwd, "openspec"), "real initializer path obstruction\n");
			const calls = provider.requests.length;
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await expectNativeFailure(tui, /OpenSpec change creation failed/, "openspec", `/dev new ${REQUIREMENT}`);
			await idle();
			expect(await state()).toEqual(configured);
			expect(provider.requests).toHaveLength(calls);
			expect(await Bun.file(path.join(cwd, "user-source.txt")).text()).toBe("preserve user work\n");
			await fs.unlink(path.join(cwd, "openspec"));
			await clearNativeDraft(tui);
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await stage("requirements");
			expect((await state()).team).toBe(true);
			expect(await Bun.file(path.join(cwd, "user-source.txt")).text()).toBe("preserve user work\n");
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

function nativeReadResult(request: ModelRequest, target: string): string {
	const call = request.messages
		.flatMap(message => (message.role === "assistant" ? (message.tool_calls ?? []) : []))
		.find(value => {
			if (!isRecord(value) || !isRecord(value.function) || typeof value.function.arguments !== "string")
				return false;
			if (typeof value.function.name !== "string" || value.function.name.replace(/^_/u, "") !== "read") return false;
			const args: unknown = JSON.parse(value.function.arguments);
			return isRecord(args) && args.path === target;
		});
	if (!isRecord(call) || typeof call.id !== "string") throw new Error(`No real native read call for ${target}`);
	const result = request.messages.find(message => message.role === "tool" && message.tool_call_id === call.id);
	if (!result) throw new Error(`No real native read result for ${target}`);
	return contentText(result.content);
}

for (const location of ["directory", "absent", "file", "parent-only"] as const) {
	test.skipIf(!tuiTest)(
		`ordinary TUI discovers OpenSpec only at a direct directory and scopes manual resource grants (${location})`,
		async () => {
			await withTui(
				{
					async setup(cwd) {
						if (location === "directory") await fs.mkdir(path.join(cwd, "openspec"));
						if (location === "file") await Bun.write(path.join(cwd, "openspec"), "not a directory\n");
						if (location === "parent-only") await fs.mkdir(path.join(path.dirname(cwd), "openspec"));
					},
				},
				[120, 36],
				async ({ cwd, provider, tui, state }) => {
					const openSpec = inventory.skills.filter(skill => skill.source === "openspec");
					const ordinary = provider.requests.at(-1)!;
					const ordinaryContext = ordinary.messages.map(message => contentText(message.content)).join("\n");
					for (const skill of openSpec) {
						if (location === "directory") expect(ordinaryContext).toContain(skill.name);
						else expect(ordinaryContext).not.toContain(skill.name);
						expect(ordinaryContext).not.toContain(`name: ${skill.name}`);
					}
					const ordinarySkills = new Set([
						"systematic-debugging",
						"verification-before-completion",
						"writing-skills",
					]);
					const manualOnly = inventory.skills.filter(
						skill =>
							skill.source === "jch" || (skill.source === "superpowers" && !ordinarySkills.has(skill.name)),
					);
					const deniedPaths = manualOnly.map(skill => `skill://${skill.name}:raw`);
					for (const skill of openSpec) {
						await tui("submit", "/new");
						await tui("expect", "text", "New session started", "--timeout", "30000");
						const selectedPath = `skill://${skill.name}:raw`;
						await tui(
							"submit",
							`${location === "directory" ? "请按需读取已发现的 OpenSpec 技能，不实施、不同步、不归档。" : `/skill:${skill.name}`} ${MARKER}\nOMP_SPEC_MANUAL_RESOURCE ${JSON.stringify({ path: selectedPath, deniedPaths })}`,
						);
						await tui("expect", "text", `${MARKER}_CHAT_READY`, "--timeout", "30000");
						await tui("wait", "idle", "--timeout", "30000");
						const completed = provider.requests.at(-1)!;
						const selected = parseFrontmatter(nativeReadResult(completed, selectedPath), {
							source: selectedPath,
							repair: false,
							level: "off",
						});
						expect(selected.frontmatter.name).toBe(skill.name);
						expect(selected.frontmatter.description).toBeString();
						const denied = nativeReadResult(completed, deniedPaths.join(";"));
						for (const other of manualOnly) expect(denied).toContain(`Skill access denied: ${other.name}`);
						expect((await state()).run).toBeUndefined();
						expect(await Bun.file(path.join(cwd, ".omp/dev/state.json")).exists()).toBe(false);
					}
					// A new native branch cannot borrow the previous explicit invocation.
					if (location !== "directory") {
						await tui("submit", "/new");
						await tui("expect", "text", "New session started", "--timeout", "30000");
						const selectedPath = `skill://${openSpec[0]!.name}:raw`;
						await tui(
							"submit",
							`仅探测未授权读取。\nOMP_SPEC_MANUAL_RESOURCE ${JSON.stringify({ path: selectedPath, deniedPaths })}`,
						);
						await tui("expect", "text", `${MARKER}_CHAT_READY`, "--timeout", "30000");
						await tui("wait", "idle", "--timeout", "30000");
						expect(nativeReadResult(provider.requests.at(-1)!, selectedPath)).toContain(
							`Skill access denied: ${openSpec[0]!.name}`,
						);
					}
					expect(provider.requests.every(request => !rolePayload(request))).toBe(true);
				},
			);
		},
		300_000,
	);
}

for (const action of ["retry", "drop"] as const) {
	test.skipIf(!tuiTest)(
		`real archive destination conflict preserves accepted execution and ${action} does not invent synchronization progress`,
		async () => {
			await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle }) => {
				await tui("submit", "/dev");
				await idle();
				await tui("submit", `/dev new ${REQUIREMENT}`);
				await stage("requirements");
				await tui("submit", "/dev next");
				await stage("solution");
				await tui("submit", "/dev next pure");
				await stage("planning");
				await tui("submit", "/dev next");
				const executing = (await stage("executing")).run!;
				const report = (entry(provider, "executor").outputPaths as string[])[0]!;
				const originalReport = await Bun.file(path.join(cwd, report)).text();
				const date = new Date().toISOString().slice(0, 10);
				const destination = path.join(cwd, "openspec/changes/archive", `${date}-${executing.changeId}`);
				await fs.mkdir(destination, { recursive: true });
				const calls = provider.requests.length;
				await tui("submit", "/dev next");
				await expectNativeFailure(tui, /OpenSpec archive failed/, "archive_target_exists", "/dev next");
				await idle();
				const failed = (await state()).run!;
				expect(failed.phase).toBe("executing");
				expect(failed.sessions.executor?.sessionId).toBe(executing.sessions.executor?.sessionId);
				expect(failed.closing?.synced).not.toBe(true);
				expect(failed.archivedChangePath).toBeUndefined();
				expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).exists()).toBe(false);
				expect(provider.requests).toHaveLength(calls);
				await clearNativeDraft(tui);
				if (action === "retry") {
					await fs.rmdir(destination);
					await tui("submit", "/dev next");
					await eventually(state, value => !!value.run?.archivedChangePath);
					await idle();
					expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).text()).toContain(REQUIREMENT);
				} else {
					await tui("submit", "/dev drop");
					await eventually(state, value => !value.run && !value.team);
					await idle();
					expect((await state()).run).toBeUndefined();
					expect(await fs.readdir(destination)).toEqual([]);
					expect(
						await Bun.file(path.join(cwd, `openspec/changes/${executing.changeId}/proposal.md`)).exists(),
					).toBe(true);
					expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
				}
				expect(await Bun.file(path.join(cwd, report)).text()).toBe(originalReport);
				expect(provider.requests).toHaveLength(calls);
			});
		},
		180_000,
	);
}

test.skipIf(!tuiTest)(
	"a real non-file Dev state blocks drop and entry without claiming cleanup, and restoring the boundary permits drop retry",
	async () => {
		await withTui({}, [100, 28], async ({ cwd, provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const original = await stage("requirements");
			const statePath = path.join(cwd, ".omp/dev/state.json");
			const backup = `${statePath}.fixture-recovery`;
			const before = provider.requests.length;
			await fs.rename(statePath, backup);
			await fs.mkdir(statePath);
			try {
				await tui("submit", "/dev drop");
				// Bun's real directory-read error has EISDIR but no pathname.
				await expectNativeFailure(tui, /EISDIR|EPERM|EACCES/);
				await clearNativeDraft(tui, "/dev drop");
				expect((await fs.stat(statePath)).isDirectory()).toBe(true);
				expect(await Bun.file(backup).json()).toEqual(original);
				expect(provider.requests).toHaveLength(before);
				await tui("submit", `/dev new ${REQUIREMENT}`);
				await tui("expect", "text", "已有流程，请先丢弃", "--timeout", "30000");
				expect(provider.requests).toHaveLength(before);
				await clearNativeDraft(tui, `/dev new ${REQUIREMENT}`);
				await tui("type", "cleanup-error-keeps-native-editor");
				await tui("expect", "text", "cleanup-error-keeps-native-editor", "--timeout", "30000");
				expect(await nativeTranscript(original.run!, "requirements")).toContain(REQUIREMENT);
			} finally {
				await fs.rmdir(statePath);
				await fs.rename(backup, statePath);
			}
			await clearNativeDraft(tui);
			await tui("submit", "/dev drop");
			await eventually(state, value => !value.run && !value.team);
			await idle();
			expect((await state()).team).toBe(false);
			expect((await state()).run).toBeUndefined();
			expect(provider.requests).toHaveLength(before);
			expect(await nativeTranscript(original.run!, "requirements")).toContain(REQUIREMENT);
			await tui("submit", "/dev");
			await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
			await fs.rename(statePath, backup);
			await fs.mkdir(statePath);
			try {
				await tui("submit", "/dev");
				// Entry failed before Dev acquired the UI; this is an ordinary
				// root error, not the fixed Dev error row checked by the helper.
				await eventually(
					() => tui("text"),
					screen => !screen.includes("Dev ·") && /EISDIR|EPERM|EACCES/.test(screen),
				);
				expect(await tui("text", "--full")).toContain("ordinary-root-beacon");
				expect((await fs.stat(statePath)).isDirectory()).toBe(true);
				expect(provider.requests).toHaveLength(before);
				await clearNativeDraft(tui, "/dev");
				await tui("type", "failed-entry-keeps-root-editor");
				await tui("expect", "text", "failed-entry-keeps-root-editor", "--timeout", "30000");
			} finally {
				await fs.rmdir(statePath);
				await fs.rename(backup, statePath);
			}
			await clearNativeDraft(tui);
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const fresh = (await stage("requirements")).run!;
			expect(fresh.runId).not.toBe(original.run!.runId);
		});
	},
	180_000,
);

test.skipIf(!tuiTest || process.platform !== "win32")(
	"Windows real read-share handle prevents corrupt Dev state deletion until explicit entry retries cleanup",
	async () => {
		await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Home", "Enter");
			await eventually(state, value => value.team);
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const original = (await stage("requirements")).run!;
			await tui("submit", "/dev");
			await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
			const statePath = path.join(cwd, ".omp/dev/state.json");
			const corrupt = "{unrecoverable-state-with-a-real-delete-sharing-obstruction";
			await Bun.write(statePath, corrupt);
			const calls = provider.requests.length;
			const kernel = dlopen("kernel32.dll", {
				CreateFileW: {
					args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
					returns: FFIType.ptr,
				},
				CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
				GetLastError: { args: [], returns: FFIType.u32 },
			});
			try {
				const name = new Uint16Array([...statePath.split("").map(character => character.charCodeAt(0)), 0]);
				// GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING.
				// This is local to the isolated fixture file: reads work, but Windows
				// refuses unlink/rename while this real handle omits FILE_SHARE_DELETE.
				const handle = kernel.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, 0x80, null);
				if (!handle || Number(handle) === -1 || Number(handle) === Number(0xffffffffffffffffn))
					throw new Error(`Cannot acquire fixture deletion-sharing obstruction: ${kernel.symbols.GetLastError()}`);
				const handleErrors: unknown[] = [];
				try {
					await tui("submit", "/dev");
					// Corrupt-state cleanup failed during ordinary-root entry.
					await eventually(
						() => tui("text"),
						screen => !screen.includes("Dev ·") && /EBUSY|EPERM|EACCES|sharing|access.*denied/i.test(screen),
					);
					expect(await Bun.file(statePath).text()).toBe(corrupt);
					expect(provider.requests).toHaveLength(calls);
					expect(await tui("text", "--full")).toContain("ordinary-root-beacon");
					await clearNativeDraft(tui, "/dev");
					await tui("type", "failed-delete-keeps-root-input");
					await tui("expect", "text", "failed-delete-keeps-root-input", "--timeout", "30000");
					expect(await nativeTranscript(original, "requirements")).toContain(REQUIREMENT);
				} catch (error) {
					handleErrors.push(error);
				} finally {
					if (!kernel.symbols.CloseHandle(handle))
						handleErrors.push(new Error("Cannot release fixture file handle"));
				}
				if (handleErrors.length)
					throw new AggregateError(handleErrors, "Native file-sharing fixture or cleanup failed");
			} finally {
				kernel.close();
			}
			await clearNativeDraft(tui);
			await tui("submit", "/dev");
			await tui("expect", "text", "旧 Dev 状态无法恢复，已清除", "--timeout", "30000");
			await idle();
			expect((await state()).team).toBe(false);
			expect((await state()).run).toBeUndefined();
			expect(provider.requests).toHaveLength(calls);
			expect(await nativeTranscript(original, "requirements")).toContain(REQUIREMENT);
			for (const file of entry(provider, "requirements").outputPaths as string[])
				expect(await Bun.file(path.join(cwd, file.replace("*", "greeting"))).exists()).toBe(true);
			await tui("submit", "/dev drop");
			await eventually(state, value => !value.run && !value.team);
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const current = (await stage("requirements")).run!;
			expect(current.runId).not.toBe(original.runId);
		});
	},
	180_000,
);
