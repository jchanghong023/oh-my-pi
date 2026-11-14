import { expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { expectVisibleDraft } from "../helpers/compact-screen-recording";
import { createMixedChildren } from "../helpers/mixed-session-children";
import { createMixedWorkspace } from "../helpers/mixed-session-workspace";
import { contentText, MARKER, respond, type ModelRequest, type Reply } from "./provider-fixture";
import { eventually, tuiTest, withTui } from "./tui-harness";

interface Action {
	name: string;
	args: Record<string, unknown>;
	intent: string;
	verify?: (text: string) => void;
}
interface ObservedResult {
	name: string;
	intent: string;
	text: string;
}

function call(request: ModelRequest, action: Action): { name: string; args: Record<string, unknown> } {
	const args = { ...action.args, i: action.intent };
	const direct = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === action.name)?.function;
	if (direct) return { name: direct.name, args };
	const write = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "write")?.function;
	if (!write) throw new Error(`Default tool ${action.name} is neither advertised nor reachable through write`);
	return { name: write.name, args: { i: action.intent, path: `xd://${action.name}`, content: JSON.stringify(args) } };
}

function result(request: ModelRequest, action: Action): string {
	for (const message of request.messages.toReversed()) {
		if (message.role !== "assistant") continue;
		for (const item of message.tool_calls ?? []) {
			if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.function)) continue;
			if (typeof item.function.arguments !== "string") continue;
			const args: unknown = JSON.parse(item.function.arguments);
			if (!isRecord(args) || args.i !== action.intent) continue;
			const output = request.messages.findLast(entry => entry.role === "tool" && entry.tool_call_id === item.id);
			if (!output) throw new Error(`Missing real result for ${action.intent}`);
			return contentText(output.content);
		}
	}
	throw new Error(`Missing real call for ${action.intent}`);
}

async function journal(file: string): Promise<Record<string, unknown>[]> {
	const entries: unknown[] = Bun.JSONL.parse(await Bun.file(file).text());
	return entries.filter(isRecord);
}

function messages(entries: Record<string, unknown>[]): AgentMessage[] {
	return entries.flatMap(entry =>
		entry.type === "message" && isRecord(entry.message) ? [entry.message as unknown as AgentMessage] : [],
	);
}

async function rootJournal(agentDir: string): Promise<string> {
	for await (const file of new Bun.Glob("**/*.jsonl").scan(path.join(agentDir, "sessions"))) {
		const absolute = path.join(agentDir, "sessions", file);
		if (
			messages(await journal(absolute)).some(
				message => message.role === "user" && contentText(message.content).includes("MIXED_ROOT_BEGIN"),
			)
		)
			return absolute;
	}
	throw new Error("The submitted mixed-session input was not persisted");
}

function recordedResult(history: AgentMessage[], intent: string) {
	const id = history
		.flatMap(message => (message.role === "assistant" ? message.content : []))
		.find(block => block.type === "toolCall" && isRecord(block.arguments) && block.arguments.i === intent);
	if (!id || id.type !== "toolCall") throw new Error(`No persisted ${intent} call`);
	const output = history.find(message => message.role === "toolResult" && message.toolCallId === id.id);
	if (!output || output.role !== "toolResult") throw new Error(`No persisted ${intent} result`);
	return output;
}

function recordedCallIds(history: AgentMessage[]): string[] {
	return history.flatMap(message =>
		message.role === "assistant"
			? message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))
			: [],
	);
}

// One real CLI conversation: only model/search HTTP replies are simulated.
// All default tools, task children, edits, IRC, compaction and terminal input execute normally.
test("compact mixed long session preserves input, tool effects and peer messages across compaction", async () => {
	if (!tuiTest) throw new Error("tui-test is required for the compact mixed-session acceptance test");
	await using workspace = createMixedWorkspace();
	const children = createMixedChildren();
	const allowTools = Promise.withResolvers<void>();
	const waitingForChildren = Promise.withResolvers<void>();
	const compactionStarted = Promise.withResolvers<void>();
	const allowSummary = Promise.withResolvers<void>();
	const visibilityReached = Promise.withResolvers<void>();
	const allowVisibility = Promise.withResolvers<void>();
	const observed: ObservedResult[] = [];
	const tableMarkers = Array.from({ length: 80 }, (_, i) => `MIXED_ROW_${String(i + 1).padStart(3, "0")}`);
	const table = `| Item | Evidence |\n| --- | --- |\n${tableMarkers.map(marker => `| ${marker} | 正文和工具反馈不得丢失 |`).join("\n")}\n`;
	const input = `MIXED_ROOT_BEGIN\n${Array.from({ length: 300 }, (_, i) => `需求 ${String(i + 1).padStart(3, "0")}：在同一长会话中读取、编辑、检索并收取子代理结果。`).join("\n")}\nMIXED_ROOT_END`;
	const draft = `MIXED_DRAFT_BEGIN ${Array.from({ length: 80 }, (_, i) => `未提交草稿 ${i + 1}：后台消息和工具刷新不能覆盖输入。`).join(" ")} MIXED_DRAFT_END`;
	const resume = `MIXED_RESUME_BEGIN ${draft} MIXED_RESUME_END`;
	const summary =
		"## Goal\nComplete the mixed-session changes.\n## Progress\nMIXED_COMPACT_SUMMARY: inspected long-context.txt and completed pre-compaction work; MixedAlpha and MixedBeta are editing src/alpha.ts and src/beta.ts.\n## Critical Context\nBoth children are still running. Keep both job handles and IRC messages, collect their final replies after resuming, and validate the files.\n";
	let pending: Action[] = [];
	let batch = 0;
	let started = false;
	let postCompaction = false;
	let postValidationStep = 0;
	let visibilityStarted = false;
	let summaryObserved = false;
	let maxContextText = "";
	let steps: Action[][] = [];

	try {
		await withTui(
			{
				screenDiagnostics: true,
				configuration: {
					...workspace.configuration,
					async: { enabled: true },
					edit: { modelVariants: { "deepseek/chat-a": "hashline" } },
				},
				setup: async (cwd, agentDir) => {
					await workspace.setup(cwd, agentDir);
					const contains = (marker: string) => (text: string) => expect(text).toContain(marker);
					steps = [
						[
							{
								name: "read",
								args: { path: "long-context.txt:1-500:raw" },
								intent: "Reading first context half",
								verify: contains("MIXED_LONG_LINE_0001"),
							},
						],
						[
							{
								name: "read",
								args: { path: "long-context.txt:501-1000:raw" },
								intent: "Reading second context half",
								verify: contains("MIXED_LONG_LINE_1000"),
							},
						],
						[
							{
								name: "write",
								args: { path: "notes.txt", content: "MIXED_NATIVE_WRITE\n" },
								intent: "Writing mixed session evidence",
							},
						],
						[
							{
								name: "ask",
								args: {
									questions: [
										{
											id: "continue",
											question: "MIXED_DECISION",
											options: [{ label: "Proceed" }, { label: "Cancel" }],
											recommended: 0,
										},
									],
								},
								intent: "Confirming mixed session continuation",
								verify: contains("Proceed"),
							},
						],
						[
							{
								name: "bash",
								args: {},
								intent: "Checking invalid command arguments",
								verify: contains("The tool was not run"),
							},
						],
						[
							{
								name: "bash",
								args: { command: "echo MUST_NOT_EXECUTE", cwd: "missing-working-directory" },
								intent: "Checking unavailable working directory",
								verify: contains("Working directory does not exist"),
							},
						],
						[
							{
								name: "bash",
								args: {
									// Build the markers from char codes so the command argument (shown verbatim by the
									// compact dock) does not contain them; only the real stderr output may leak them.
									command: `bun -e ${JSON.stringify(
										`console.error(String.fromCharCode(${Array.from("MIXED_COMMAND_FAILURE_ONE", c => c.charCodeAt(0)).join(",")}));` +
											`console.error(String.fromCharCode(${Array.from("MIXED_COMMAND_FAILURE_TWO", c => c.charCodeAt(0)).join(",")}));` +
											"process.exit(7)",
									)}`,
								},
								intent: "Exercising real command failure",
								verify: contains("MIXED_COMMAND_FAILURE_TWO"),
							},
						],
						[
							{
								name: "todo",
								args: { op: "init", items: ["Finish pre-compaction mixed work"] },
								intent: "Tracking mixed session milestone",
							},
						],
						[
							{
								name: "task",
								args: {
									context: "Edit the assigned source and coordinate with Main using the real agent URL tools.",
									tasks: [
										{
											name: "MixedAlpha",
											task: "MIXED_CHILD_ALPHA",
											solutionSpace: "Change alpha from one to eleven in its assigned source",
										},
										{
											name: "MixedBeta",
											task: "MIXED_CHILD_BETA",
											solutionSpace: "Change beta from two to twenty two in its assigned source",
										},
									],
								},
								intent: "Delegating concurrent source edits",
								verify: contains("MixedAlpha"),
							},
						],
						[
							{
								name: "write",
								args: { path: "agent://MixedAlpha", content: "MIXED_PARENT_ALPHA" },
								intent: "Coordinating with first child",
								verify: contains("Delivered"),
							},
							{
								name: "write",
								args: { path: "agent://MixedBeta", content: "MIXED_PARENT_BETA" },
								intent: "Coordinating with second child",
								verify: contains("Delivered"),
							},
						],
						[
							{
								name: "todo",
								args: { op: "done", task: "Finish pre-compaction mixed work" },
								intent: "Completing pre-compaction mixed milestone",
							},
						],
					];
				},
				async reply(request): Promise<Reply> {
					if (
						request.messages.some(
							message =>
								message.role === "system" &&
								contentText(message.content).includes("Summarize user–AI coding-assistant conversations"),
						)
					) {
						summaryObserved = true;
						children.startCompaction();
						await children.messagesDuringCompaction;
						compactionStarted.resolve();
						await allowSummary.promise;
						return { text: summary };
					}
					const child = children.reply(request);
					if (child !== undefined) return await child;
					if (!request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "read"))
						return { text: "Mixed session" };
					const text = request.messages.map(message => contentText(message.content)).join("\n");
					if (!started && !text.includes("MIXED_ROOT_BEGIN")) return respond(request);
					started = true;
					if (text.length > maxContextText.length) maxContextText = text;
					let visibilityReadComplete = false;
					if (pending.length) {
						const visibilityResult = pending.some(action => action.intent === "Exercising visible peer failure");
						visibilityReadComplete = pending.some(
							action => action.intent === "Reading mixed visibility evidence",
						);
						for (const action of pending) {
							const text = result(request, action);
							action.verify?.(text);
							observed.push({ name: action.name, intent: action.intent, text });
						}
						pending = [];
						if (visibilityResult) {
							visibilityReached.resolve();
							await allowVisibility.promise;
						}
					}
					if (text.includes("MIXED_RESUME_BEGIN")) postCompaction = true;
					if (postCompaction) {
						expect(text).toContain("MIXED_COMPACT_SUMMARY");
						const peer = /MIXED_(ALPHA|BETA)_POST_COMPACT_PEER/u.exec(text);
						if (peer && !visibilityStarted) {
							visibilityStarted = true;
							pending = [
								{
									name: "read",
									args: { path: "notes.txt" },
									intent: "Reading mixed visibility evidence",
									verify: value => expect(value).toContain("MIXED_NATIVE_WRITE"),
								},
							];
							return {
								text: "MIXED_EXPLANATION_FIRST: A real peer message and tool results share this turn.",
								tools: pending.map(action => call(request, action)),
							};
						}
						if (visibilityReadComplete) {
							const diagnostic = Array.from("MIXED_VISIBLE_FAILURE", character => character.charCodeAt(0)).join(
								",",
							);
							pending = [
								{
									name: "bash",
									args: {
										command: `bun -e ${JSON.stringify(`console.error(String.fromCharCode(${diagnostic}));process.exit(7)`)}`,
									},
									intent: "Exercising visible peer failure",
									verify: value => {
										expect(value).toContain("MIXED_VISIBLE_FAILURE");
										expect(value).toContain("Command exited with code 7");
									},
								},
								{
									name: "todo",
									args: { op: "append", phase: "Mixed visibility", items: ["MIXED_VISIBILITY_TODO"] },
									intent: "Tracking visible mixed evidence",
								},
							];
							return {
								text: "MIXED_EXPLANATION_LAST: The final explanation line must remain readable after Read.",
								tools: pending.map(action => call(request, action)),
							};
						}
						if (!text.includes("MIXED_ALPHA_DONE") || !text.includes("MIXED_BETA_DONE")) {
							waitingForChildren.resolve();
							pending = [
								{
									name: "wait",
									args: {},
									intent: `Collecting mixed child results ${observed.filter(item => item.name === "wait").length}`,
								},
							];
							return { tools: pending.map(action => call(request, action)) };
						}
						if (postValidationStep === 0) {
							postValidationStep++;
							const code =
								"const a=await Bun.file('src/alpha.ts').text();const b=await Bun.file('src/beta.ts').text();if(!a.includes('= 11;')||!b.includes('= 22;'))process.exit(9);console.log('MIXED_REAL_VALIDATION_OK')";
							pending = [
								{
									name: "todo",
									args: { op: "done", task: "MIXED_VISIBILITY_TODO" },
									intent: "Completing visible mixed evidence",
								},
								{
									name: "bash",
									args: { command: `bun -e ${JSON.stringify(code)}` },
									intent: "Validating changes after compaction",
									verify: value => expect(value).toContain("MIXED_REAL_VALIDATION_OK"),
								},
							];
							return { tools: pending.map(action => call(request, action)) };
						}
						if (postValidationStep === 1) {
							postValidationStep++;
							pending = [
								{
									name: "bash",
									args: { command: "echo MIXED_FOLLOWING_CALL_TWO" },
									intent: "Checking second post-compaction call",
									verify: value => expect(value).toContain("MIXED_FOLLOWING_CALL_TWO"),
								},
							];
							return { tools: pending.map(action => call(request, action)) };
						}
						return { text: `${table.replaceAll("MIXED_ROW_", "MIXED_AFTER_ROW_")}\nMIXED_SESSION_DONE` };
					}
					if (batch === 1) await allowTools.promise;
					if (batch === steps.length - 2) await children.ready;
					if (batch === steps.length) return { text: "MIXED_PRECOMPACT_READY" };
					pending = steps[batch++]!;
					return { ...(batch === 1 ? { text: table } : {}), tools: pending.map(action => call(request, action)) };
				},
			},
			[100, 28],
			async ({ cwd, agentDir, provider, tui, screen }) => {
				screen.start();
				await screen.checkpoint("startup", frame => expectVisibleDraft(frame, "", 100, 28));
				await tui("write", `\x1b[200~${input}\x1b[201~`);
				await tui("expect", "text", "Paste inline", "--timeout", "30000");
				await screen.checkpoint("paste choice modal", frame => expect(frame.screen).toContain("Paste inline"));
				await tui("key", "press", "Down", "Down", "Enter");
				await tui("expect", "text", "#1", "--timeout", "30000");
				await screen.checkpoint("paste inserted", frame => expectVisibleDraft(frame, "#1", 100, 28));
				await tui("resize", "120", "36");
				await screen.waitForVisualHandoff();
				await screen.checkpoint("pasted input after resize", frame => expectVisibleDraft(frame, "#1", 120, 36));
				await tui("key", "press", "Enter");
				await tui("expect", "text", "MIXED_ROW_080", "--timeout", "60000");
				await screen.checkpoint("streamed table", frame => {
					const visible = Array.from(frame.screen.matchAll(/MIXED_ROW_(\d{3})/gu), match => Number(match[1]));
					expect(visible.length).toBeGreaterThan(0);
					expect(new Set(visible).size).toBe(visible.length);
					expect(visible).toEqual([...visible].sort((a, b) => a - b));
					expect(visible.at(-1)).toBe(80);
				});
				await tui("type", draft);
				await tui("expect", "text", "MIXED_DRAFT_END", "--timeout", "30000");
				await screen.checkpoint("background draft", frame => expectVisibleDraft(frame, "MIXED_DRAFT_END", 120, 36));
				await tui("resize", "100", "28");
				await screen.waitForVisualHandoff();
				await tui("expect", "text", "MIXED_DRAFT_END", "--timeout", "30000");
				await screen.checkpoint("draft after shrinking viewport", frame =>
					expectVisibleDraft(frame, "MIXED_DRAFT_END", 100, 28),
				);
				allowTools.resolve();
				await tui("expect", "text", "MIXED_DECISION", "--timeout", "60000");
				await tui("expect", "text", "Proceed", "--timeout", "30000");
				await screen.checkpoint("tool confirmation modal", frame => {
					expect(frame.screen).toContain("MIXED_DECISION");
					expect(frame.screen).toContain("Proceed");
				});
				await tui("key", "press", "Down", "Enter");
				// Leave room for the transcript beside the long draft and both child docks.
				await tui("resize", "120", "48");
				await screen.waitForVisualHandoff();
				await tui("expect", "text", "MIXED_PRECOMPACT_READY", "--timeout", "60000");
				await tui("expect", "text", "MIXED_DRAFT_END", "--timeout", "30000");
				await screen.checkpoint("tools and child docks settled", frame =>
					expectVisibleDraft(frame, "MIXED_DRAFT_END", 120, 48),
				);
				expect(maxContextText).toContain(input);
				expect(maxContextText).toContain("MIXED_LONG_LINE_0001");
				expect(maxContextText).toContain("MIXED_LONG_LINE_1000");
				expect(maxContextText).not.toContain("MIXED_DRAFT_BEGIN");
				const file = await rootJournal(agentDir);
				await tui("key", "press", "Ctrl+C");
				await eventually(
					() => tui("text"),
					text => !text.includes("MIXED_DRAFT_END"),
				);
				await screen.checkpoint("draft explicitly cleared", frame => expectVisibleDraft(frame, "", 120, 48));
				await tui("resize", "120", "80");
				await screen.waitForVisualHandoff();
				await eventually(
					() => tui("text", "--full"),
					text => text.match(/MIXED_ROW_\d{3}/gu)?.length === tableMarkers.length,
				);
				const before = await tui("text", "--full");
				expect(Array.from(before.match(/MIXED_ROW_\d{3}/gu) ?? [])).toEqual(tableMarkers);
				expect(before).not.toContain("MIXED_COMMAND_FAILURE_ONE");
				expect(before).not.toContain("MIXED_COMMAND_FAILURE_TWO");
				// These are invocation/argument failures, not diagnostics from a process that ran.
				for (const diagnostic of ["The tool was not run", "Working directory does not exist"]) {
					expect(before).not.toContain(diagnostic);
				}
				const beforeDisplayRequests = provider.requests.length;
				const beforeDisplayCalls = recordedCallIds(messages(await journal(file)));
				const beforeDisplayObserved = observed.length;
				await tui("submit", "/display detailed");
				await tui("expect", "text", "detailed", "--timeout", "30000");
				await screen.checkpoint("detailed display rebuild", frame => expectVisibleDraft(frame, "", 120, 80));
				const detailed = await eventually(
					() => tui("text", "--full"),
					text => text.includes("The tool was not run") && text.includes("Working directory does not exist"),
				);
				expect(detailed).toContain("The tool was not run");
				expect(detailed).toContain("Working directory does not exist");
				expect(detailed).toContain("missing-working-directory");
				await tui("submit", "/display compact");
				await tui("expect", "text", "compact", "--timeout", "30000");
				await screen.checkpoint("compact display rebuild", frame => expectVisibleDraft(frame, "", 120, 80));
				expect(provider.requests).toHaveLength(beforeDisplayRequests);
				expect(recordedCallIds(messages(await journal(file)))).toEqual(beforeDisplayCalls);
				expect(observed).toHaveLength(beforeDisplayObserved);
				await tui("submit", "/compact soft");
				await compactionStarted.promise;
				await screen.checkpoint("real compaction in progress", frame => expectVisibleDraft(frame, "", 120, 80));
				allowSummary.resolve();
				await eventually(
					() => journal(file),
					entries =>
						entries.some(
							entry =>
								entry.type === "compaction" &&
								typeof entry.summary === "string" &&
								entry.summary.includes("MIXED_COMPACT_SUMMARY"),
						),
				);
				expect(summaryObserved).toBe(true);
				await screen.checkpoint("compaction persisted", frame => expectVisibleDraft(frame, "", 120, 80));
				await tui("type", resume);
				await tui("expect", "text", "MIXED_RESUME_END", "--timeout", "30000");
				await screen.checkpoint("post-compaction draft", frame =>
					expectVisibleDraft(frame, "MIXED_RESUME_END", 120, 80),
				);
				await tui("resize", "120", "36");
				await screen.waitForVisualHandoff();
				await tui("expect", "text", "MIXED_RESUME_END", "--timeout", "30000");
				await screen.checkpoint("post-compaction draft resized", frame =>
					expectVisibleDraft(frame, "MIXED_RESUME_END", 120, 36),
				);
				await tui("key", "press", "Enter");
				await waitingForChildren.promise;
				await screen.checkpoint("waiting for child results");
				// Release the children only after a real parent wait is in flight, so
				// post-compaction IRC interrupts it and reaches the model as its own turn.
				let collectingWaitId: string | undefined;
				await eventually(
					() => journal(file),
					entries => {
						const current = messages(entries);
						const calls = current.flatMap(message =>
							message.role === "assistant"
								? message.content.filter(
										block =>
											block.type === "toolCall" &&
											isRecord(block.arguments) &&
											typeof block.arguments.i === "string" &&
											block.arguments.i.startsWith("Collecting mixed child results "),
									)
								: [],
						);
						const last = calls.at(-1);
						if (
							last?.type !== "toolCall" ||
							current.some(message => message.role === "toolResult" && message.toolCallId === last.id)
						)
							return false;
						collectingWaitId = last.id;
						return true;
					},
				);
				children.finishCompaction();
				await visibilityReached.promise;
				const visibilityResult = recordedResult(messages(await journal(file)), "Exercising visible peer failure");
				expect(visibilityResult.isError).toBe(true);
				expect(visibilityResult.details).toMatchObject({ exitCode: 7 });
				await screen.waitForVisualHandoff("mixed peer and failure");
				await screen.checkpoint("draft after failed tool", frame => {
					expectVisibleDraft(frame, "", 120, 36);
				});
				allowVisibility.resolve();
				await tui("expect", "text", "MIXED_SESSION_DONE", "--timeout", "60000");
				await screen.checkpoint("post-compaction answer", frame => {
					expect(frame.screen).toContain("MIXED_SESSION_DONE");
					const visible = Array.from(frame.screen.matchAll(/MIXED_AFTER_ROW_(\d{3})/gu), match =>
						Number(match[1]),
					);
					expect(visible.length).toBeGreaterThan(0);
					expect(new Set(visible).size).toBe(visible.length);
					expect(visible).toEqual([...visible].sort((a, b) => a - b));
				});
				// The 80-row table exceeds the 36-row viewport; expand it before
				// checking every rendered row rather than relying on terminal scrollback.
				await tui("resize", "120", "200");
				await screen.waitForVisualHandoff();
				const afterMarkers = tableMarkers.map(marker => marker.replace("MIXED_ROW_", "MIXED_AFTER_ROW_"));
				const completed = await eventually(
					() => tui("text", "--full"),
					text => text.match(/MIXED_AFTER_ROW_\d{3}/gu)?.length === afterMarkers.length,
				);
				expect(Array.from(completed.match(/MIXED_AFTER_ROW_\d{3}/gu) ?? [])).toEqual(afterMarkers);
				await tui("resize", "120", "36");
				await screen.waitForVisualHandoff();
				const firstFollowup = observed.findIndex(item => item.intent === "Validating changes after compaction");
				const secondFollowup = observed.findIndex(item => item.intent === "Checking second post-compaction call");
				expect(firstFollowup).toBeGreaterThanOrEqual(0);
				expect(secondFollowup).toBe(firstFollowup + 1);
				const durable = await journal(file);
				const history = messages(durable);
				expect(
					history.filter(message => message.role === "user" && contentText(message.content) === input),
				).toHaveLength(1);
				expect(
					history.filter(message => message.role === "user" && contentText(message.content) === resume),
				).toHaveLength(1);
				expect(durable.filter(entry => entry.type === "compaction")).toHaveLength(1);
				// Wait no longer embeds IRC in details.waited: it ends with interrupted=true,
				// then the session persists and injects each incoming message separately.
				const waitResultIndex = durable.findIndex(
					entry =>
						entry.type === "message" &&
						isRecord(entry.message) &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === collectingWaitId,
				);
				expect(waitResultIndex).toBeGreaterThan(durable.findIndex(entry => entry.type === "compaction"));
				const waitEntry = durable[waitResultIndex]!;
				expect(waitEntry.message).toMatchObject({ details: { op: "wait", interrupted: true } });
				const nextAssistantIndex = durable.findIndex(
					(entry, index) =>
						index > waitResultIndex &&
						entry.type === "message" &&
						isRecord(entry.message) &&
						entry.message.role === "assistant",
				);
				const consumedPeers = durable.flatMap((entry, index) => {
					if (entry.type !== "custom_message" || entry.customType !== "irc:incoming" || !isRecord(entry.details))
						return [];
					const { from, message: body } = entry.details;
					if (
						typeof from !== "string" ||
						typeof body !== "string" ||
						!/^Mixed(?:Alpha|Beta)$/u.test(from) ||
						body !== `MIXED_${from.slice("Mixed".length).toUpperCase()}_POST_COMPACT_PEER`
					)
						return [];
					expect(index).toBeGreaterThan(waitResultIndex);
					return [{ from, body, index }];
				});
				expect(consumedPeers.map(peer => peer.from).sort()).toEqual(["MixedAlpha", "MixedBeta"]);
				expect(consumedPeers.some(peer => peer.index < nextAssistantIndex)).toBe(true);
				const validationRequest = provider.requests.find(request =>
					request.messages.some(
						message =>
							message.role === "tool" && contentText(message.content).includes("MIXED_REAL_VALIDATION_OK"),
					),
				);
				for (const peer of consumedPeers) {
					expect(
						validationRequest?.messages.some(
							message =>
								message.role === "user" &&
								contentText(message.content).includes(peer.from) &&
								contentText(message.content).includes(peer.body),
						),
					).toBe(true);
				}
				for (const marker of [
					"MIXED_ALPHA_DURING_COMPACT",
					"MIXED_BETA_DURING_COMPACT",
					"MIXED_ALPHA_DONE",
					"MIXED_BETA_DONE",
				]) {
					expect(
						provider.requests
							.findLast(request =>
								request.messages.some(message => contentText(message.content).includes("MIXED_RESUME_BEGIN")),
							)
							?.messages.map(message => contentText(message.content))
							.join("\n"),
					).toContain(marker);
				}
				expect(recordedResult(history, "Checking invalid command arguments").isError).toBe(true);
				expect(recordedResult(history, "Checking unavailable working directory").isError).toBe(true);
				const failure = recordedResult(history, "Exercising real command failure");
				expect(failure.isError).toBe(true);
				expect(failure.details).toMatchObject({ exitCode: 7 });
				expect(await Bun.file(path.join(cwd, "src/alpha.ts")).text()).toBe("export const alpha = 11;\n");
				expect(await Bun.file(path.join(cwd, "src/beta.ts")).text()).toBe("export const beta = 22;\n");
				expect(await Bun.file(path.join(cwd, "notes.txt")).text()).toBe("MIXED_NATIVE_WRITE\n");
				for (const record of Object.values(children.records))
					expect(record).toEqual({
						parentMessage: true,
						fileModified: true,
						readyNotified: true,
						duringNotified: true,
						finalReply: true,
					});
				const requestCount = provider.requests.length;
				const callIds = recordedCallIds(history);
				const observedCount = observed.length;
				await tui("submit", "/display detailed");
				await tui("expect", "text", "detailed", "--timeout", "30000");
				await screen.checkpoint("post-compaction detailed rebuild", frame =>
					expectVisibleDraft(frame, "", 120, 36),
				);
				await tui("submit", "/display compact");
				await tui("expect", "text", "compact", "--timeout", "30000");
				await screen.checkpoint("post-compaction compact rebuild", frame => expectVisibleDraft(frame, "", 120, 36));
				await tui("resize", "120", "200");
				await screen.waitForVisualHandoff();
				const rebuilt = await eventually(
					() => tui("text", "--full"),
					text => text.match(/MIXED_AFTER_ROW_\d{3}/gu)?.length === afterMarkers.length,
				);
				expect(Array.from(rebuilt.match(/MIXED_AFTER_ROW_\d{3}/gu) ?? [])).toEqual(afterMarkers);
				expect(rebuilt).toContain("MIXED_SESSION_DONE");
				expect(provider.requests).toHaveLength(requestCount);
				expect(recordedCallIds(messages(await journal(file)))).toEqual(callIds);
				expect(observed).toHaveLength(observedCount);
				await screen.stop();
				await tui("key", "press", "Ctrl+D");
				await tui("wait", "exit");
				expect(await tui("state")).toMatch(/^exited: 0\r?$/mu);
			},
		);
	} finally {
		allowTools.resolve();
		allowSummary.resolve();
		allowVisibility.resolve();
		children.dispose();
	}
}, 180_000);

test("resumed compact transcript stays in place while successive tools finish and the model waits", async () => {
	if (!tuiTest) throw new Error("tui-test is required for the compact resumed-session regression");
	const actions: Action[] = [
		{ name: "read", args: { path: "jump-first.txt" }, intent: "Reading jump first" },
		{ name: "grep", args: { pattern: "JUMP_EVIDENCE", path: "jump-second.txt" }, intent: "Searching jump second" },
	];
	const reached = actions.map(() => Promise.withResolvers<void>());
	const release = actions.map(() => Promise.withResolvers<void>());
	let step = 0;
	try {
		await withTui(
			{
				screenDiagnostics: true,
				configuration: { display: { mode: "compact" }, read: { toolResultPreview: true } },
				setup: async cwd => {
					await Promise.all([
						Bun.write(path.join(cwd, "jump-first.txt"), "JUMP_FIRST_EVIDENCE\n"),
						Bun.write(path.join(cwd, "jump-second.txt"), "JUMP_EVIDENCE\n"),
					]);
				},
				async reply(request) {
					if (!request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "read"))
						return respond(request);
					const users = request.messages.filter(message => message.role === "user");
					const last = contentText(users.at(-1)?.content);
					if (last.includes("MIXED_ROOT_BEGIN"))
						return {
							text: [
								"## Earlier investigation",
								"",
								"- Checked the restored session and its previous context.",
								"- Read the files involved in the reported display behavior.",
								"- Compared the compact activity and transcript layout.",
								"- Reviewed how the active session is restored.",
								"- Noted the visible output and the waiting model state.",
								"- Kept the existing conversation and tool history intact.",
								"- Prepared a focused reproduction for the next request.",
								"",
								"JUMP_OLD_ASSISTANT_REPLY",
							].join("\n"),
						};
					if (!last.includes("JUMP_NEW_PROMPT")) return respond(request);
					if (step > 0) {
						const completed = step - 1;
						const evidence = ["JUMP_FIRST_EVIDENCE", "JUMP_EVIDENCE"][completed]!;
						expect(result(request, actions[completed]!)).toContain(evidence);
						reached[completed]!.resolve();
						await release[completed]!.promise;
					}
					if (step === actions.length) return { text: "JUMP_DONE" };
					return { tools: [call(request, actions[step++]!)] };
				},
			},
			[100, 40],
			async ({ agentDir, tui, screen }) => {
				screen.start();
				const waitForReply = async (marker: string) => {
					await eventually(
						() => screen.checkpoint(`waiting for ${marker} to finish`),
						frame =>
							frame.screen.includes(marker) && !/等待模型响应…|模型回复中…|生成工具调用…/u.test(frame.screen),
					);
				};
				// Idle sessions need not render an "等待输入" label.
				await waitForReply(`${MARKER}_CHAT_READY`);
				await tui("submit", "MIXED_ROOT_BEGIN");
				await waitForReply("JUMP_OLD_ASSISTANT_REPLY");
				const file = await eventually(async () => {
					try {
						return await rootJournal(agentDir);
					} catch {
						return "";
					}
				}, Boolean);
				await eventually(
					() => journal(file),
					entries =>
						messages(entries).some(
							message =>
								message.role === "assistant" &&
								contentText(message.content).includes("JUMP_OLD_ASSISTANT_REPLY"),
						),
				);
				const header = (await journal(file)).find(entry => entry.type === "session");
				if (typeof header?.id !== "string") throw new Error("Persisted session has no id");
				await tui("submit", `/resume ${header.id}`);
				await tui("expect", "text", "Resumed session", "--timeout", "30000");
				await tui("submit", "JUMP_NEW_PROMPT");

				for (let index = 0; index < actions.length; index++) {
					await reached[index]!.promise;
					const current = actions[index]!;
					const frame = await eventually(
						() => screen.checkpoint(`tool ${index + 1} awaiting model`),
						value => value.screen.includes(current.intent),
					);
					expect(frame.screen).not.toContain("JUMP_TS_LINE_");
					release[index]!.resolve();
				}
				await tui("expect", "text", "JUMP_DONE", "--timeout", "30000");
				await screen.stop();
			},
		);
	} finally {
		for (const gate of release) gate.resolve();
	}
}, 120_000);

test("retained real edit does not move when the next assistant stream is empty or hidden", async () => {
	if (!tuiTest) throw new Error("tui-test is required for the compact empty-stream regression");
	const edited = Array.from(
		{ length: 46 },
		(_, i) => `export const EDIT_CLI_${String(i + 1).padStart(2, "0")} = ${i + 1};`,
	).join("\n");
	const actions: Action[] = [
		{ name: "read", args: { path: "retained-edit.ts" }, intent: "Reading source before edit" },
		{
			name: "edit",
			args: {},
			intent: "Editing retained evidence",
		},
		{
			name: "grep",
			args: { pattern: "CLI_GREPPED", path: "retained-search.txt" },
			intent: "Searching retained evidence",
		},
		{ name: "read", args: { path: "retained-read.txt" }, intent: "Reading retained evidence" },
	];
	const waiting = Promise.withResolvers<void>();
	const startStream = Promise.withResolvers<void>();
	const opened = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const encoder = new TextEncoder();
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let step = 0;
	const event = (delta: Record<string, unknown>, finish: string | null = null) =>
		encoder.encode(
			`data: ${JSON.stringify({
				id: "retained-empty-stream",
				object: "chat.completion.chunk",
				created: 1,
				model: "chat-a",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`,
		);
	try {
		await withTui(
			{
				screenDiagnostics: true,
				configuration: {
					display: { mode: "compact" },
					hideThinkingBlock: true,
					edit: { modelVariants: { "deepseek/chat-a": "hashline" } },
				},
				setup: async cwd => {
					await Promise.all([
						Bun.write(path.join(cwd, "retained-edit.ts"), "const original = 0;\n"),
						Bun.write(path.join(cwd, "retained-search.txt"), "CLI_GREPPED\n"),
						Bun.write(path.join(cwd, "retained-read.txt"), "CLI_READ_RESULT\n"),
					]);
				},
				async reply(request) {
					if (!request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "read"))
						return respond(request);
					const users = request.messages.filter(message => message.role === "user");
					const last = contentText(users.at(-1)?.content);
					if (!last.includes("CLI_EDIT_PROMPT")) return respond(request);
					if (step > 0) {
						const output = result(request, actions[step - 1]!);
						if (step === 1) {
							const header = output.match(/\[retained-edit\.ts#[A-F0-9]{4}\]/u)?.[0];
							if (!header || !output.includes("const original = 0;"))
								throw new Error(`Missing source hashline or content: ${output}`);
							actions[1]!.args.input = `*** Begin Patch\n${header}\nPUT 1.=1:\n${edited
								.split("\n")
								.map(line => `+${line}`)
								.join("\n")}\n*** End Patch\n`;
						}
						if (step === 3) expect(output).toContain("CLI_GREPPED");
						if (step === 4) expect(output).toContain("CLI_READ_RESULT");
					}
					if (step < actions.length) return { tools: [call(request, actions[step++]!)] };
					waiting.resolve();
					await startStream.promise;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								streamController = controller;
								controller.enqueue(event({ role: "assistant" }));
								opened.resolve(controller);
							},
							cancel() {
								streamController = undefined;
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			},
			[100, 80],
			async ({ agentDir, cwd, provider, tui, screen }) => {
				screen.start();
				await eventually(
					() => screen.checkpoint("initial reply"),
					frame => frame.screen.includes(`${MARKER}_CHAT_READY`),
				);
				await tui("submit", "CLI_EDIT_PROMPT");
				await waiting.promise;
				expect(await Bun.file(path.join(cwd, "retained-edit.ts")).text()).toBe(`${edited}\n`);
				const collapsed = await eventually(
					() => screen.checkpoint("compact edit initially collapsed"),
					frame =>
						frame.screen.includes("EDIT_CLI_01") &&
						!frame.screen.includes("EDIT_CLI_46") &&
						frame.screen.includes("CLI_READ_RESULT"),
				);
				expect(collapsed.screen).not.toContain("retained-search.txt");
				expect(collapsed.screen).toContain("CLI_READ_RESULT");
				await tui("key", "press", "Ctrl+O");
				const expanded = await eventually(
					() => screen.checkpoint("compact edit expanded"),
					frame => frame.screen.includes("EDIT_CLI_01") && frame.screen.includes("EDIT_CLI_46"),
				);
				expect(expanded.screen).not.toContain("retained-search.txt");
				expect(expanded.screen).toContain("CLI_READ_RESULT");
				await tui("key", "press", "Ctrl+O");
				await eventually(
					() => screen.checkpoint("compact edit collapsed again"),
					frame => frame.screen.includes("EDIT_CLI_01") && !frame.screen.includes("EDIT_CLI_46"),
				);
				await tui("key", "press", "Ctrl+O");
				const baseline = await eventually(
					() => screen.checkpoint("retained edit before assistant stream"),
					frame => frame.screen.includes("CLI_EDIT_PROMPT") && frame.screen.includes("EDIT_CLI_46"),
				);
				const editMarkers = Array.from(baseline.screen.matchAll(/EDIT_CLI_\d{2}/gu), match => match[0]);
				expect(editMarkers.length).toBeGreaterThan(1);
				const markers = ["CLI_EDIT_PROMPT", ...editMarkers];
				const rows = (text: string) =>
					markers.map(marker => {
						const matches = text
							.split("\n")
							.flatMap((line, row) => (line.includes(marker) ? [{ row, text: line.trim() }] : []));
						expect(matches).toHaveLength(1);
						return matches[0]!;
					});
				const composer = (frame: typeof baseline) => {
					expectVisibleDraft(frame, "", 100, 80);
					const lines = frame.screen.split("\n");
					const top = lines.findLastIndex(line => line.startsWith("╭── "));
					const bottom = lines.findIndex((line, index) => index > top && line.startsWith("╰─"));
					return { top, bottom, cursor: frame.cursor };
				};
				const expected = rows(baseline.screen);
				const inputGeometry = composer(baseline);
				const check = (frame: typeof baseline) => {
					expect(rows(frame.screen)).toEqual(expected);
					expect(composer(frame)).toEqual(inputGeometry);
					expect(frame.screen).not.toContain("CLI_HIDDEN_REASONING");
				};
				startStream.resolve();
				const controller = await opened.promise;
				for (let tick = 0; tick < 6; tick++) {
					await Bun.sleep(150);
					await screen.checkpoint(`empty assistant stream tick ${tick + 1}`, check);
				}
				controller.enqueue(event({ reasoning_content: "CLI_HIDDEN_REASONING" }));
				for (let tick = 0; tick < 6; tick++) {
					await Bun.sleep(150);
					await screen.checkpoint(`hidden reasoning tick ${tick + 1}`, check);
				}
				controller.enqueue(event({ content: "CLI_EDIT_DONE" }));
				controller.enqueue(event({}, "stop"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
				streamController = undefined;
				await tui("expect", "text", "CLI_EDIT_DONE", "--timeout", "30000");
				// The completed native journal proves the hidden SSE delta reached and
				// was parsed by the client, even though it never appeared on screen.
				await eventually(async () => {
					for await (const file of new Bun.Glob("**/*.jsonl").scan(path.join(agentDir, "sessions"))) {
						const history = messages(await journal(path.join(agentDir, "sessions", file)));
						if (
							history.some(
								message => message.role === "user" && contentText(message.content).includes("CLI_EDIT_PROMPT"),
							) &&
							history.some(
								message =>
									message.role === "assistant" &&
									message.content.some(
										block => block.type === "thinking" && block.thinking.includes("CLI_HIDDEN_REASONING"),
									),
							)
						)
							return true;
					}
					return false;
				}, Boolean);
				const requests = provider.requests.length;
				await tui("submit", "/display detailed");
				await tui("expect", "text", "detailed", "--timeout", "30000");
				const detailed = await eventually(
					() => screen.checkpoint("detailed edit initially collapsed"),
					frame =>
						frame.screen.includes("EDIT_CLI_01") &&
						!frame.screen.includes("EDIT_CLI_46") &&
						frame.screen.includes("retained-read.txt"),
				);
				expect(detailed.screen).toContain("retained-search.txt");
				await tui("key", "press", "Ctrl+O");
				await eventually(
					() => screen.checkpoint("detailed edit expanded"),
					frame => frame.screen.includes("EDIT_CLI_46"),
				);
				await tui("key", "press", "Ctrl+O");
				await eventually(
					() => screen.checkpoint("detailed edit collapsed again"),
					frame => frame.screen.includes("EDIT_CLI_01") && !frame.screen.includes("EDIT_CLI_46"),
				);
				await tui("submit", "/display clean");
				await tui("expect", "text", "clean", "--timeout", "30000");
				const clean = await eventually(
					() => screen.checkpoint("clean hides tools and edit"),
					frame => !frame.screen.includes("EDIT_CLI_01") && !frame.screen.includes("retained-read.txt"),
				);
				expect(clean.screen).not.toContain("retained-search.txt");
				await tui("key", "press", "Ctrl+O");
				await tui("expect", "text", "Tool activity is hidden", "--timeout", "30000");
				const cleanAfterToggle = await screen.checkpoint("clean expansion remains hidden");
				expect(cleanAfterToggle.screen).not.toContain("EDIT_CLI_01");
				expect(cleanAfterToggle.screen).not.toContain("retained-read.txt");
				await tui("submit", "/display compact");
				await tui("expect", "text", "compact", "--timeout", "30000");
				await eventually(
					() => screen.checkpoint("compact edit restored"),
					frame => frame.screen.includes("EDIT_CLI_01") && !frame.screen.includes("retained-read.txt"),
				);
				expect(provider.requests).toHaveLength(requests);
				expect(await Bun.file(path.join(cwd, "retained-edit.ts")).text()).toBe(`${edited}\n`);
				await screen.stop();
			},
		);
	} finally {
		startStream.resolve();
		if (streamController && streamController.desiredSize !== null) {
			try {
				streamController.close();
			} catch {
				// Cancellation can race teardown; preserve the original failure.
			}
		}
	}
}, 120_000);
