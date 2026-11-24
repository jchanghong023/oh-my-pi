import { expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { composerBounds, expectVisibleDraft } from "../helpers/compact-screen-recording";
import { createMixedChildren } from "../helpers/mixed-session-children";
import { createMixedWorkspace } from "../helpers/mixed-session-workspace";
import { contentText, MARKER, respond, type ModelRequest, type Reply } from "./provider-fixture";
import { eventually, nativeDraftMatches, tuiTest, withTui } from "./tui-harness";

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
	const bash = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "bash")?.function;
	if (!bash) throw new Error(`Default tool ${action.name} is neither advertised nor reachable through bash`);
	const json = JSON.stringify(action.args).replaceAll("'", "'\\''");
	return { name: bash.name, args: { i: action.intent, command: `${action.name} --json '${json}'` } };
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
	const bashValidationDiagnostic = 'Validation failed for tool "bash"';
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
									html: '<form><p>MIXED_DECISION</p><label><input type="radio" name="continue" value="proceed" checked> Proceed</label><label><input type="radio" name="continue" value="cancel"> Cancel</label></form>',
								},
								intent: "Confirming mixed session continuation",
								verify: contains('"continue": "proceed"'),
							},
						],
						[
							{
								name: "bash",
								args: {},
								intent: "Checking invalid command arguments",
								verify: contains(bashValidationDiagnostic),
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
				// The inline form preserves the nonempty composer and lets sending its draft skip the ask.
				// Use the form-focus key instead of moving the cursor inside the draft.
				await tui("expect", "text", "Alt+E answers them", "--timeout", "60000");
				// At 28 rows the long draft and the bottom of the ask fit, but
				// the ask's heading can be above the viewport. Open room for it
				// without sending or clearing the draft.
				await tui("resize", "120", "48");
				await screen.waitForVisualHandoff();
				await screen.checkpoint("draft while the ask is pending", frame =>
					expectVisibleDraft(frame, "MIXED_DRAFT_END", 120, 48),
				);
				await tui("key", "press", "Alt+E");
				await tui("expect", "text", "MIXED_DECISION", "--timeout", "60000");
				await tui("expect", "text", "Proceed", "--timeout", "30000");
				await screen.checkpoint("tool confirmation modal", frame => {
					expect(frame.screen).toContain("MIXED_DECISION");
					expect(frame.screen).toContain("Proceed");
				});
				// Enter submits the single-question form without sending the composer draft.
				await tui("key", "press", "Enter");
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
				for (const diagnostic of [bashValidationDiagnostic, "Working directory does not exist"]) {
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
					text => text.includes(bashValidationDiagnostic) && text.includes("Working directory does not exist"),
				);
				expect(detailed).toContain(bashValidationDiagnostic);
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

test("compact PTY shows structured output from a mounted Bash tool command", async () => {
	if (!tuiTest) throw new Error("tui-test is required for the compact mounted command regression");
	const prompt = "Inspect the mounted command fixture";
	const marker = "MOUNTED_COMMAND_MATCH";
	const action: Action = {
		name: "ast_grep",
		args: { pat: "const $NAME = 7", path: "mounted.ts" },
		intent: "Searching the mounted fixture",
	};
	const release = Promise.withResolvers<void>();
	let dispatched = false;
	try {
		await withTui(
			{
				screenDiagnostics: true,
				configuration: {
					display: { mode: "compact" },
					tools: { commands: true },
					astGrep: { enabled: true },
				},
				setup: async cwd => {
					await Bun.write(path.join(cwd, "mounted.ts"), `const ${marker} = 7;\n`);
				},
				async reply(request) {
					const last = request.messages.findLast(message => message.role === "user");
					if (!contentText(last?.content).includes(prompt)) return respond(request);
					if (!dispatched) {
						dispatched = true;
						const tool = call(request, action);
						expect(tool.name.replace(/^_/u, "")).toBe("bash");
						return { tools: [tool] };
					}
					expect(result(request, action)).toContain(marker);
					await release.promise;
					return { text: "MOUNTED_COMMAND_DONE" };
				},
			},
			[120, 40],
			async ({ tui, screen }) => {
				await tui("submit", prompt);
				await eventually(
					() => screen.checkpoint("mounted Bash command output"),
					frame => frame.screen.includes("bash (ast_grep)") && frame.screen.includes(marker),
					30_000,
				);
				release.resolve();
				await tui("expect", "text", "MOUNTED_COMMAND_DONE", "--timeout", "30000");
				await screen.stop();
			},
		);
	} finally {
		release.resolve();
	}
}, 90_000);

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
					const transcript = await tui("text", "--full");
					expect(transcript).toContain("JUMP_OLD_ASSISTANT_REPLY");
					expect(transcript).toContain("JUMP_NEW_PROMPT");
					expectVisibleDraft(frame, "", 100, 40);
					const history = messages(await journal(file));
					expect(recordedResult(history, current.intent).isError).toBe(false);
					expect(
						history.filter(
							message =>
								message.role === "assistant" &&
								contentText(message.content).includes("JUMP_OLD_ASSISTANT_REPLY"),
						),
					).toHaveLength(1);
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

test("compact keeps the Write receipt and original Edit diffs through later tool and model activity", async () => {
	if (!tuiTest) throw new Error("tui-test is required for the compact empty-stream regression");
	const original = "const original = 0;";
	const writtenHead = "const written = 1;";
	const writtenTail = "const expansionSlot = 2;";
	const firstEdit = "const editedFirst = 3;";
	const draft = "CLI_UNSENT_DRAFT";
	const editLines = Array.from(
		{ length: 46 },
		(_, i) => `export const EDIT_CLI_${String(i + 1).padStart(2, "0")} = ${i + 1};`,
	);
	const editHead = editLines[0]!;
	const editTail = editLines.at(-1)!;
	const written = `${writtenHead}\n${writtenTail}\n`;
	const edited = `${firstEdit}\n${editLines.join("\n")}\n`;
	const writeReceipt = `Successfully wrote ${Buffer.byteLength(written)} bytes to retained-edit.ts`;
	const patchLine = (readOutput: string, line: number, oldText: string, newLines: readonly string[]) => {
		const header = readOutput.match(/\[retained-edit\.ts#[A-F0-9]{4}\]/u)?.[0];
		if (!header || !readOutput.includes(oldText))
			throw new Error(`Missing hashline header or ${oldText}: ${readOutput}`);
		return `*** Begin Patch\n${header}\nPUT ${line}.=${line}:\n${newLines.map(text => `+${text}`).join("\n")}\n*** End Patch\n`;
	};
	const actions: Action[] = [
		{
			name: "write",
			args: { path: "retained-edit.ts", content: written },
			intent: "Writing retained evidence",
		},
		{ name: "read", args: { path: "retained-edit.ts" }, intent: "Reading source before edit" },
		{
			name: "edit",
			args: {},
			intent: "Replacing the first retained line",
		},
		{ name: "read", args: { path: "retained-edit.ts" }, intent: "Reading source before second edit" },
		{
			name: "edit",
			args: {},
			intent: "Expanding the second retained line",
		},
		{
			name: "grep",
			args: { pattern: "CLI_GREPPED", path: "retained-search.txt" },
			intent: "Searching retained evidence",
		},
		{ name: "read", args: { path: "retained-read.txt" }, intent: "Reading retained evidence" },
	];
	const writeReturned = Promise.withResolvers<void>();
	const continueToRead = Promise.withResolvers<void>();
	const firstEditReturned = Promise.withResolvers<string>();
	const continueToSecondRead = Promise.withResolvers<void>();
	const secondEditReturned = Promise.withResolvers<string>();
	const continueToGrep = Promise.withResolvers<void>();
	const grepReturned = Promise.withResolvers<void>();
	const continueToFinalRead = Promise.withResolvers<void>();
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
					// Keep both reads in the journal to isolate display mode changes from history maintenance.
					compaction: { supersedeReads: false },
					// Skill optimization has an independent transient HUD row. This case
					// isolates redraws that have no visible status change.
					skills: { enabled: false },
					edit: { modelVariants: { "deepseek/chat-a": "hashline" } },
				},
				setup: async cwd => {
					await Promise.all([
						Bun.write(path.join(cwd, "retained-edit.ts"), `${original}\n`),
						Bun.write(path.join(cwd, "retained-search.txt"), "CLI_GREPPED\n"),
						Bun.write(path.join(cwd, "retained-read.txt"), "CLI_READ_RESULT\n"),
					]);
				},
				async reply(request) {
					if (!request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "read"))
						return respond(request);
					const users = request.messages.filter(message => message.role === "user");
					const last = contentText(users.at(-1)?.content);
					if (last.includes("CLI_FOLLOWING_TURN")) return { text: "CLI_FOLLOWING_DONE" };
					if (!last.includes("CLI_EDIT_PROMPT")) return respond(request);
					if (step > 0) {
						const output = result(request, actions[step - 1]!);
						if (step === 1) {
							expect(output).toContain(writeReceipt);
							writeReturned.resolve();
							await continueToRead.promise;
						}
						if (step === 2) actions[2]!.args.input = patchLine(output, 1, writtenHead, [firstEdit]);
						if (step === 3) {
							firstEditReturned.resolve(output);
							await continueToSecondRead.promise;
						}
						if (step === 4) {
							expect(output).toContain(firstEdit);
							actions[4]!.args.input = patchLine(output, 2, writtenTail, editLines);
						}
						if (step === 5) {
							secondEditReturned.resolve(output);
							await continueToGrep.promise;
						}
						if (step === 6) {
							expect(output).toContain("CLI_GREPPED");
							grepReturned.resolve();
							await continueToFinalRead.promise;
						}
						if (step === 7) expect(output).toContain("CLI_READ_RESULT");
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
				const fileCards = (text: string) =>
					text.match(/^[^\n]*╭─+[^\n]*retained-edit\.ts[^\n]*\n[\s\S]*?^ *╰─+[^\n]*/gmu) ?? [];
				const collapsedDiff = (text: string) => {
					const [card, extra] = fileCards(text);
					return (
						card !== undefined &&
						extra === undefined &&
						card.includes(`-2│${writtenTail}`) &&
						card.includes(`+│${editHead}`) &&
						!card.includes(editTail) &&
						!card.includes(writtenHead) &&
						!card.includes(original)
					);
				};
				await eventually(
					() => screen.checkpoint("initial reply"),
					frame => frame.screen.includes(`${MARKER}_CHAT_READY`),
				);
				await tui("submit", "CLI_EDIT_PROMPT");
				await writeReturned.promise;
				await eventually(
					() => screen.checkpoint("compact Write shows the receipt without a synthesized card"),
					({ screen: text }) =>
						text.split("\n").some(line => line.trimStart().startsWith("已完成 · write")) &&
						text.includes(writeReceipt) &&
						fileCards(text).length === 0 &&
						!text.includes(original) &&
						!text.includes(writtenHead),
				);
				continueToRead.resolve();
				const firstOutput = await firstEditReturned.promise;
				expect(firstOutput).toContain(`1:${firstEdit}`);
				expect(firstOutput).not.toContain(original);
				await eventually(
					() => screen.checkpoint("compact first Edit replaces the written line, not the pre-Write file"),
					({ screen: text }) => {
						const [card, extra] = fileCards(text);
						return (
							card !== undefined &&
							extra === undefined &&
							card.includes(`-1│${writtenHead}`) &&
							card.includes(`+│${firstEdit}`) &&
							!card.includes(`-2│${writtenTail}`) &&
							!card.includes(original)
						);
					},
				);
				continueToSecondRead.resolve();
				const secondOutput = await secondEditReturned.promise;
				expect(secondOutput).toContain(`${editLines.length + 1}:${editTail}`);
				expect(secondOutput).not.toContain(original);
				await eventually(
					() => screen.checkpoint("compact folds to the second Edit of the same file"),
					frame => collapsedDiff(frame.screen),
				);
				continueToGrep.resolve();
				await grepReturned.promise;
				await eventually(
					() => screen.checkpoint("grep output does not replace the current-turn diff"),
					frame => collapsedDiff(frame.screen) && frame.screen.includes("CLI_GREPPED"),
				);
				continueToFinalRead.resolve();
				await waiting.promise;
				expect(await Bun.file(path.join(cwd, "retained-edit.ts")).text()).toBe(edited);
				const hiddenTools =
					/retained-(?:edit\.ts|search\.txt)|EDIT_CLI_\d{2}|const (?:original|written|expansionSlot|editedFirst) =|CLI_GREPPED/u;
				await tui("type", draft);
				await eventually(
					() => screen.checkpoint("read output does not replace the current-turn diff"),
					frame => collapsedDiff(frame.screen) && frame.screen.includes("CLI_READ_RESULT"),
				);
				await tui("key", "press", "Ctrl+O");
				await eventually(
					() => screen.checkpoint("Ctrl+O expands both original Edit diffs in tool order"),
					({ screen: text }) => {
						const [, first, second, ...extra] = text.split("修改 retained-edit.ts");
						return (
							extra.length === 0 &&
							first !== undefined &&
							second !== undefined &&
							first.includes(`-1│${writtenHead}`) &&
							first.includes(`+│${firstEdit}`) &&
							!first.includes(editHead) &&
							second.includes(`-2│${writtenTail}`) &&
							second.includes(`+│${editHead}`) &&
							!second.includes(writtenHead) &&
							!text.includes(original)
						);
					},
				);
				await tui("key", "press", "End");
				await eventually(
					() => screen.checkpoint("the expanded diffs scroll to the second Edit's last change"),
					frame => frame.screen.includes(`+${editLines.length + 1}│${editTail}`),
				);
				await tui("key", "press", "Escape");
				const baseline = await eventually(
					() => screen.checkpoint("Esc restores the compact file card and the unsent draft"),
					frame =>
						collapsedDiff(frame.screen) &&
						frame.screen.includes("CLI_READ_RESULT") &&
						nativeDraftMatches(frame.screen, draft, frame.cursor),
				);
				expect(baseline.screen).not.toContain("本轮改动");
				const cardHead = fileCards(baseline.screen)[0]!.split("\n", 1)[0];
				expect(cardHead).not.toMatch(/\+46\b|-1\b/u);
				const markers = [`${MARKER}_CHAT_READY`, "CLI_EDIT_PROMPT", writtenTail, editHead, "CLI_READ_RESULT"];
				const rows = (text: string) =>
					markers.map(marker => {
						const matches = text
							.split("\n")
							.flatMap((line, row) => (line.includes(marker) ? [{ row, text: line.trim() }] : []));
						expect(matches).toHaveLength(1);
						return matches[0]!;
					});
				const composer = (frame: typeof baseline) => {
					expectVisibleDraft(frame, draft, 100, 80);
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
					expect(collapsedDiff(frame.screen)).toBe(true);
					expect(frame.screen).not.toContain("retained-search.txt");
					expect(frame.screen).not.toContain("CLI_HIDDEN_REASONING");
				};
				check(baseline);
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
				// The native journal proves the hidden delta was parsed and the tools' results survived the stream.
				const completed = (await eventually(async () => {
					for await (const file of new Bun.Glob("**/*.jsonl").scan(path.join(agentDir, "sessions"))) {
						const absolute = path.join(agentDir, "sessions", file);
						const history = messages(await journal(absolute));
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
							return { file: absolute, history };
					}
					return undefined;
				}, Boolean))!;
				const receipts = [
					writeReceipt,
					writtenHead,
					firstEdit,
					firstEdit,
					editTail,
					"CLI_GREPPED",
					"CLI_READ_RESULT",
				];
				for (const [index, marker] of receipts.entries()) {
					const output = recordedResult(completed.history, actions[index]!.intent);
					expect(output.isError).toBe(false);
					expect(contentText(output.content)).toContain(marker);
					if (index === 0) expect(output.details).not.toHaveProperty("diff");
				}
				const requests = provider.requests.length;
				await tui("key", "press", "Ctrl+C");
				await eventually(
					() => screen.checkpoint("clear the unsent draft before switching display modes"),
					frame => nativeDraftMatches(frame.screen, "", frame.cursor),
				);
				await tui("submit", "/display detailed");
				await tui("expect", "text", "detailed", "--timeout", "30000");
				const detailed = await eventually(
					() => screen.checkpoint("detailed edit initially collapsed"),
					frame =>
						frame.screen.includes(writtenHead) &&
						frame.screen.includes(firstEdit) &&
						frame.screen.includes(editHead) &&
						!frame.screen.includes(editTail) &&
						frame.screen.includes("retained-read.txt"),
				);
				expect(detailed.screen).toContain("retained-search.txt");
				expect(detailed.screen).not.toContain(original);
				await tui("key", "press", "Ctrl+O");
				await eventually(
					() => screen.checkpoint("detailed edit expanded"),
					frame => frame.screen.includes(writtenTail) && frame.screen.includes(editTail),
				);
				await tui("key", "press", "Ctrl+O");
				await eventually(
					() => screen.checkpoint("detailed edit collapsed again"),
					frame => frame.screen.includes(editHead) && !frame.screen.includes(editTail),
				);
				await tui("submit", "/display clean");
				await tui("expect", "text", "clean", "--timeout", "30000");
				const clean = await eventually(
					() => screen.checkpoint("clean hides tools and edit"),
					frame => !hiddenTools.test(frame.screen) && !frame.screen.includes("retained-read.txt"),
				);
				expect(clean.screen).not.toContain("CLI_READ_RESULT");
				await tui("key", "press", "Ctrl+O");
				await tui("expect", "text", "Tool activity is hidden", "--timeout", "30000");
				const cleanAfterToggle = await screen.checkpoint("clean expansion remains hidden");
				expect(cleanAfterToggle.screen).not.toMatch(hiddenTools);
				expect(cleanAfterToggle.screen).not.toContain("retained-read.txt");
				await tui("submit", "/display compact");
				await tui("expect", "text", "compact", "--timeout", "30000");
				const restored = await eventually(
					() => screen.checkpoint("compact restores the current-turn diff without reviving expired read output"),
					frame =>
						collapsedDiff(frame.screen) &&
						frame.screen.includes("Agent：上次读取完成") &&
						!frame.screen.includes("CLI_READ_RESULT"),
				);
				// After the bounded output preview closes, only the completed read activity remains.
				const readRows = restored.screen.split("\n").filter(line => line.includes("retained-read.txt"));
				expect(readRows).toHaveLength(1);
				expect(readRows[0]).toContain("Agent：上次读取完成");
				expect(readRows[0]).toContain("Reading retained evidence");
				expect(restored.screen).not.toContain("retained-search.txt");
				expect(provider.requests).toHaveLength(requests);
				expect(messages(await journal(completed.file))).toEqual(completed.history);
				expect(await Bun.file(path.join(cwd, "retained-edit.ts")).text()).toBe(edited);
				await tui("submit", "CLI_FOLLOWING_TURN");
				await eventually(
					() => screen.checkpoint("a new turn clears the diff without replaying file cards into history"),
					frame => frame.screen.includes("CLI_FOLLOWING_DONE") && !hiddenTools.test(frame.screen),
				);
				await screen.stop();
			},
		);
	} finally {
		continueToRead.resolve();
		continueToSecondRead.resolve();
		continueToGrep.resolve();
		continueToFinalRead.resolve();
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

test("compact PTY activity keeps path identity, output and thinking tails, and the draft", async () => {
	if (!tuiTest) throw new Error("tui-test is required for the compact activity regression");
	const [wide, narrow, height] = [112, 48, 40] as const;
	const prompt = "MIXED_ROOT_BEGIN compact activity";
	const draft = "ACTIVITY_UNSENT_DRAFT";
	const command = "bun ./compact-output.ts";
	const output = Array.from({ length: 12 }, (_, i) => `ACTIVITY_OUT_${String(i + 1).padStart(2, "0")}`);
	const sources = [
		{ parent: "north", intent: "Writing north fixture", evidence: "ACTIVITY_WRITE_A" },
		{ parent: "south", intent: "Writing south fixture", evidence: "ACTIVITY_WRITE_B" },
	].map(source => ({
		...source,
		file: `outer-project/very-long-layer/repeated-branch/${source.parent}/shared.txt`,
	}));
	const bash: Action = { name: "bash", args: { command, timeout: 90 }, intent: "Producing live output" };
	const writes: Action[] = sources.map(({ file, intent, evidence }) => ({
		name: "write",
		args: { path: file, content: evidence },
		intent,
	}));
	const startSecondWrite = Promise.withResolvers<void>();
	const startBash = Promise.withResolvers<void>();
	const print = Promise.withResolvers<void>();
	const quiet = Promise.withResolvers<void>();
	const exit = Promise.withResolvers<void>();
	const startThinking = Promise.withResolvers<void>();
	const stream = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let step = 0;
	const event = (delta: Record<string, unknown>, finish: string | null = null) =>
		encoder.encode(
			`data: ${JSON.stringify({
				id: "compact-activity",
				object: "chat.completion.chunk",
				created: 1,
				model: "chat-a",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`,
		);
	// Drive one real Bash call through silence, sustained progress and quiet
	// without tying either transition or process exit to a fixed delay.
	const gate = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/print") await print.promise;
			else if (pathname === "/quiet") await quiet.promise;
			else if (pathname === "/exit") await exit.promise;
			else return new Response(null, { status: 404 });
			return new Response(null, { status: 204 });
		},
	});
	try {
		await withTui(
			{
				screenDiagnostics: true,
				tuiTestBackend: "alacritty",
				configuration: {
					display: { mode: "compact", shimmer: "classic" },
					hideThinkingBlock: false,
					read: { toolResultPreview: true },
					tui: { motion: "full", tight: false },
				},
				setup: async (cwd, _agentDir, env) => {
					env.PI_TUI_NATIVE = "0";
					env.PI_MOTION = "full";
					await Bun.write(
						path.join(cwd, "compact-output.ts"),
						`const base = ${JSON.stringify(gate.url.href)};\n` +
							`await fetch(new URL("print", base));\n` +
							`const quiet = fetch(new URL("quiet", base)).then(() => true);\n` +
							`for (let tick = 0; ; tick++) {\n` +
							`  console.log("ACTIVITY_TICK_" + tick);\n` +
							`  if (await Promise.race([quiet, Bun.sleep(150).then(() => false)])) break;\n` +
							`}\n` +
							`console.log(${JSON.stringify(output.join("\n"))});\n` +
							`await fetch(new URL("exit", base));\n`,
					);
				},
				async reply(request) {
					const lastUser = request.messages.findLast(message => message.role === "user");
					if (!contentText(lastUser?.content).includes(prompt)) return respond(request);
					if (step === 1) await startSecondWrite.promise;
					if (step < writes.length) {
						return {
							text: step === 0 ? "ACTIVITY_HISTORY_START" : undefined,
							tools: [call(request, writes[step++]!)],
						};
					}
					if (step === writes.length) {
						step++;
						await startBash.promise;
						return { tools: [call(request, bash)] };
					}
					expect(result(request, bash)).toContain(output.at(-1)!);
					await startThinking.promise;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(active) {
								controller = active;
								active.enqueue(event({ role: "assistant" }));
								stream.resolve(active);
							},
							cancel() {
								controller = undefined;
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			},
			[wide, height],
			async ({ agentDir, cwd, tui, screen }) => {
				const actionRows = (text: string, label: string) =>
					text.split("\n").filter(line => line.trimStart().startsWith(label));
				const writeDone = "Agent：上次写入完成";
				const bashRunning = "Agent：正在执行";
				const modelThinking = "模型：正在思考";
				const observe = (label: string, matches: (text: string) => boolean) =>
					eventually(
						() => screen.checkpoint(label),
						frame => nativeDraftMatches(frame.screen, draft, frame.cursor) && matches(frame.screen),
						30_000,
					);
				type Cell = { x: number; y: number; char: string; fg: string; bg: string; bold: boolean; dim: boolean };
				// Reflow can move a row even after its text has appeared. Locate characters and
				// sample their styles from the same emulator response.
				const readCells = async (columns: number): Promise<Cell[][]> => {
					const raw = await tui("cells", "0", "0", `${columns}`, `${height}`, "--json");
					const { data } = JSON.parse(raw) as { data: { cells: Cell[] } };
					const rows: Cell[][] = Array.from({ length: height }, () => []);
					for (const cell of data.cells) rows[cell.y]![cell.x] = cell;
					return rows;
				};
				const cellRun = (row: Cell[], start: number, marker: string): Cell[] | undefined => {
					const run: Cell[] = [];
					let column = start;
					for (const char of marker) {
						const cell = row[column];
						if (cell?.char !== char) return undefined;
						run.push(cell);
						column += Bun.stringWidth(char);
					}
					return run;
				};
				const readRuns = (columns: number, ...markers: string[]) =>
					eventually(
						async () => {
							const rows = await readCells(columns);
							const runs = markers.map(marker => {
								for (let y = rows.length - 1; y >= 0; y--) {
									const row = rows[y]!;
									for (let x = 0; x < row.length; x++) {
										const run = cellRun(row, x, marker);
										if (run) return run;
									}
								}
								return undefined;
							});
							return runs.every(run => run !== undefined) ? runs : undefined;
						},
						result => result !== undefined,
						5_000,
					).then(runs => {
						if (runs === undefined) throw new Error(`Missing PTY cell runs: ${markers.join(", ")}`);
						return runs;
					});
				const style = ({ fg, bold, dim }: Cell) => JSON.stringify([fg, bold, dim]);
				const labelStyles = (cells: Cell[]) => cells.map(style).join("/");
				const bashRuns = async (marker: string) => {
					const [header, log, label, intent] = await readRuns(wide, "运行中", marker, bashRunning, bash.intent);
					expect(header![0]!.x).toBe(1);
					expect(log![0]!.x).toBe(header![0]!.x);
					expect(label![0]!.x).toBe(header![0]!.x);
					expect(intent![0]!.x).toBe(label![0]!.x + Bun.stringWidth(bashRunning) + 2);
					return { label: label!, intent: intent! };
				};
				const expectAlignedGutter = async (marker: string) => {
					// Require the activity label and intent to share the exact gutter and spacing.
					const labels = ["运行中", marker, `${bashRunning}  ${bash.intent}`] as const;
					const columns = 1 + Math.max(...labels.map(label => Bun.stringWidth(label)));
					const rows = await readCells(columns);
					const [header, body, status] = labels.map(label => rows.findIndex(row => cellRun(row, 1, label))) as [
						number,
						number,
						number,
					];
					expect(header).toBeGreaterThanOrEqual(0);
					expect(body).toBeGreaterThan(header);
					expect(status).toBeGreaterThan(body);
					for (const y of [header, body]) {
						const [gutter, content] = rows[y]!;
						expect(gutter?.bg).toBe(rows[status]![0]!.bg);
						expect(content!.bg).not.toBe(gutter!.bg);
					}
				};
				await tui("submit", prompt);
				await tui("type", draft);
				const settledForegrounds = new Set<string>();
				for (const [index, source] of sources.entries()) {
					const target = `${source.parent}/shared.txt`;
					const receipt = `Successfully wrote ${Buffer.byteLength(source.evidence)} bytes to ${source.file}`;
					const isCurrentWrite = (text: string, matches: (line: string) => boolean) => {
						const [row, extra] = actionRows(text, writeDone);
						return !!row && !extra && row.includes(target) && matches(row);
					};
					const full = await observe(
						`${target}: latest write shows both the activity and the tool receipt`,
						text =>
							isCurrentWrite(text, line => line.indexOf(source.intent) > line.indexOf(target)) &&
							text.includes(receipt),
					);
					// Plain Write returns a receipt, not an original Diff. Verify the change on disk.
					expect(full.screen).not.toContain(source.evidence);
					expect(await Bun.file(path.join(cwd, source.file)).text()).toBe(source.evidence);
					const [label, pathRun, intent] = await readRuns(wide, writeDone, target, source.intent);
					expect(pathRun![0]!.y).toBe(intent![0]!.y);
					expect(pathRun![0]!.x).toBeLessThan(intent![0]!.x);
					const settledStyle = style(pathRun![0]!);
					settledForegrounds.add(pathRun![0]!.fg);
					expect(style(label![0]!)).toBe(settledStyle);
					expect(style(intent![0]!)).toBe(settledStyle);
					await tui("resize", String(narrow), String(height));
					const files = await observe(`${target}: narrow activity preserves the parent and omits intent`, text =>
						isCurrentWrite(text, line => !line.includes("fixture")),
					);
					expectVisibleDraft(files, draft, narrow, height);
					const [narrowTarget] = await readRuns(narrow, target);
					expect(style(narrowTarget![0]!)).toBe(settledStyle);
					await tui("resize", String(wide), String(height));
					if (index === 0) startSecondWrite.resolve();
				}
				startBash.resolve();
				const silent = await observe("silent command identified before output", text =>
					actionRows(text, bashRunning).some(line => line.includes(command)),
				);
				expectVisibleDraft(silent, draft, wide, height);

				print.resolve();
				const tickPrefix = "ACTIVITY_TICK_";
				const lastTick = (text: string) => Number(Array.from(text.matchAll(/ACTIVITY_TICK_(\d+)/gu)).at(-1)?.[1]);
				const running = (text: string) =>
					text.split("\n").some(line => line.trimStart().startsWith("运行中") && line.includes(command)) &&
					actionRows(text, bashRunning).some(line => line.includes(bash.intent));
				const sampleProgress = () =>
					observe("Bash repeatedly updates its visible tail", text => running(text) && lastTick(text) >= 6);
				const firstProgress = await sampleProgress();
				const initial = await bashRuns(tickPrefix);
				const progressSweeps = new Set([labelStyles(initial.label)]);
				const staticIntent = labelStyles(initial.intent);
				const seenTicks = new Set([lastTick(firstProgress.screen)]);
				const started = performance.now();
				// Keep the active label sweeping while output advances; the intent must not sweep.
				await eventually(
					async () => {
						const frame = await sampleProgress();
						const rendered = await bashRuns(tickPrefix);
						progressSweeps.add(labelStyles(rendered.label));
						expect(labelStyles(rendered.intent)).toBe(staticIntent);
						expectVisibleDraft(frame, draft, wide, height);
						seenTicks.add(lastTick(frame.screen));
						return seenTicks.size >= 3 && progressSweeps.size >= 2 && performance.now() - started > 2_000;
					},
					Boolean,
					12_000,
				);

				quiet.resolve();
				const finalTail = output.at(-1)!;
				const observeTail = (label: string) => observe(label, text => running(text) && text.includes(finalTail));
				const tail = await observeTail("running Bash shows its bounded final tail");
				expect(actionRows(tail.screen, bashRunning)).toHaveLength(1);
				expect(tail.screen.split(command)).toHaveLength(2);
				for (const marker of output.slice(-5)) expect(tail.screen).toContain(marker);
				expect(tail.screen).not.toContain(output.at(-6)!);
				await bashRuns(finalTail);
				await expectAlignedGutter(finalTail);
				expectVisibleDraft(tail, draft, wide, height);

				const sweeps = new Set<string>();
				await eventually(
					async () => {
						const frame = await observeTail("Bash stays running while readable output is quiet");
						const rendered = await bashRuns(finalTail);
						expect(labelStyles(rendered.intent)).toBe(staticIntent);
						sweeps.add(labelStyles(rendered.label));
						expectVisibleDraft(frame, draft, wide, height);
						return sweeps.size;
					},
					count => count >= 2,
					10_000,
				);
				await tui("resize", String(narrow), String(height));
				const narrowTail = await observe("quiet Bash preview stays aligned at 48 columns", text => {
					const { lines, end } = composerBounds(text);
					return (
						end >= 0 &&
						Bun.stringWidth(lines[end]!.trimEnd()) === narrow &&
						running(text) &&
						text.includes(finalTail)
					);
				});
				await expectAlignedGutter(finalTail);
				expectVisibleDraft(narrowTail, draft, narrow, height);
				exit.resolve();
				startThinking.resolve();
				const active = await stream.promise;
				const empty = await observe("empty assistant stream keeps tool output", text =>
					text.includes(output.at(-1)!),
				);
				expectVisibleDraft(empty, draft, narrow, height);
				active.enqueue(event({ reasoning_content: "ACTIVITY_THINK_FIRST" }));
				await observe(
					"active thinking alongside retained tool output",
					text =>
						actionRows(text, modelThinking).some(line => line.includes("ACTIVITY_THINK_FIRST")) &&
						text.includes(output.at(-1)!),
				);
				active.enqueue(
					event({ reasoning_content: `\nACTIVITY_THINK_HEAD ${"detail ".repeat(20)}ACTIVITY_THINK_TAIL` }),
				);
				const thinking = await observe(
					"latest portion of active thinking at 48 columns",
					text =>
						actionRows(text, modelThinking).some(line => line.includes("ACTIVITY_THINK_TAIL")) &&
						text.includes(output.at(-1)!),
				);
				expect(thinking.screen).not.toContain("ACTIVITY_THINK_FIRST");
				expect(thinking.screen).not.toContain("ACTIVITY_THINK_HEAD");
				const [thinkingProse] = await readRuns(narrow, "ACTIVITY_THINK_TAIL");
				expect(thinkingProse!.every(cell => !cell.dim && !settledForegrounds.has(cell.fg))).toBe(true);
				expectVisibleDraft(thinking, draft, narrow, height);

				active.enqueue(event({ content: "ACTIVITY_HISTORY_DONE" }));
				active.enqueue(event({}, "stop"));
				active.enqueue(encoder.encode("data: [DONE]\n\n"));
				active.close();
				controller = undefined;
				const finished = await observe(
					"finished assistant history after preview clears",
					text => text.includes("ACTIVITY_HISTORY_DONE") && !text.includes(output.at(-1)!),
				);
				expect(finished.screen).not.toContain("ACTIVITY_THINK_TAIL");
				expectVisibleDraft(finished, draft, narrow, height);
				const transcript = await tui("text", "--full");
				expect(transcript).toContain(prompt);
				expect(transcript).toContain("ACTIVITY_HISTORY_START");
				expect(transcript).toContain("ACTIVITY_HISTORY_DONE");

				const file = await rootJournal(agentDir);
				const history = messages(await journal(file));
				const executed = recordedResult(history, bash.intent);
				expect(executed.isError).toBe(false);
				for (const marker of output) expect(contentText(executed.content)).toContain(marker);
				for (const source of sources) {
					expect(recordedResult(history, source.intent).isError).toBe(false);
					expect(await Bun.file(path.join(cwd, source.file)).text()).toContain(source.evidence);
				}
			},
		);
	} finally {
		startSecondWrite.resolve();
		startBash.resolve();
		print.resolve();
		quiet.resolve();
		exit.resolve();
		startThinking.resolve();
		if (controller && controller.desiredSize !== null) {
			try {
				controller.close();
			} catch {
				// Cancellation can race teardown; preserve the original failure.
			}
		}
		gate.stop(true);
	}
}, 120_000);
