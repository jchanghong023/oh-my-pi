import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { contentText, createProviderFixture, MARKER } from "../spec-driven/provider-fixture";
import { deadline, goalCliFixture } from "./goal-cli-fixture";
import {
	clearNativeDraft,
	eventually,
	nativeDraftMatches,
	nativeDraftSnapshot,
	tuiTest,
	repo,
	withTui,
} from "../spec-driven/tui-harness";

type Entry = Record<string, unknown>;
type PublicFixture = Awaited<ReturnType<typeof goalCliFixture>>;
type PersistedJournal = { file: string; entries: Entry[] };
const noticeType = "goal-auto-orchestrate-context";
const commands: Array<"goal" | "goal-autopilot"> = ["goal", "goal-autopilot"];

async function journals(agentDir: string): Promise<PersistedJournal[]> {
	const files = await fs.readdir(agentDir, { recursive: true });
	return Promise.all(
		files
			.filter(file => file.endsWith(".jsonl"))
			.map(async relative => {
				const file = path.join(agentDir, relative);
				const entries = (await fs.readFile(file, "utf8"))
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line) as Entry);
				return { file, entries };
			}),
	);
}

async function journal(agentDir: string, sessionId: string) {
	const found = (await journals(agentDir)).find(item =>
		item.entries.some(entry => entry.type === "session" && entry.id === sessionId),
	);
	if (!found) throw new Error(`No persisted journal for public session ${sessionId}`);
	return found;
}

function mode(entries: Entry[]) {
	const entry = entries.findLast(entry => entry.type === "mode_change");
	if (!entry) throw new Error("Public Goal operation did not persist a mode change");
	return entry;
}

function goal(entries: Entry[]): Entry & { mode: unknown; auto: boolean } {
	const current = mode(entries);
	if (!isRecord(current.data) || !isRecord(current.data.goal))
		throw new Error("No persisted Goal in the current mode");
	return { mode: current.mode, auto: current.data.autoOrchestrate === true, ...current.data.goal };
}

function notices(entries: Entry[]) {
	return entries.filter(entry => entry.type === "custom_message" && entry.customType === noticeType);
}

// One-shot public RPC consumer, not an imported session or a model substitute.
// Protocol v1 is deliberately retained so this exercises get_messages itself,
// rather than RpcClient's negotiated get_messages_page optimization.
async function queryPublicHistory(config: PublicFixture, file: string) {
	const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
	const child = Bun.spawn(
		[
			process.execPath,
			cli,
			"--mode",
			"rpc",
			"--session",
			file,
			"--cwd",
			config.cwd,
			"--model",
			"deepseek/chat-a",
			"--no-extensions",
			"--no-rules",
			"--no-title",
		],
		{
			cwd: config.cwd,
			env: config.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderr = new Response(child.stderr).text();
	try {
		for (const type of ["get_messages", "get_entries", "get_state"])
			child.stdin.write(`${JSON.stringify({ id: type, type })}\n`);
		const results = new Map<string, Entry>();
		const dumps: string[] = [];
		let dumped = false;
		child.stdin.write(`${JSON.stringify({ id: "dump", type: "prompt", message: "/dump" })}\n`);
		await deadline(
			(async () => {
				for await (const frame of readJsonl<unknown>(child.stdout)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "command_output" && typeof frame.text === "string") dumps.push(frame.text);
					if (frame.type === "response" && typeof frame.id === "string") {
						expect(frame).toMatchObject({ success: true, command: frame.id === "dump" ? "prompt" : frame.id });
						if (frame.id === "dump") {
							// Local slash commands complete in their response and do not
							// emit prompt_result (the runtime discards that prompt ticket).
							expect(frame.data).toMatchObject({ agentInvoked: false });
							dumped = true;
						} else {
							if (!isRecord(frame.data)) throw new Error(`Missing public ${frame.id} payload`);
							results.set(frame.id, frame.data);
						}
					}
					if (results.size === 3 && dumped) child.stdin.end();
				}
				if (results.size !== 3 || !dumped)
					throw new Error(`RPC ended before public history queries and dump: ${await stderr}`);
			})(),
		);
		expect(await deadline(child.exited)).toBe(0);
		return {
			messages: results.get("get_messages")!.messages as Entry[],
			entries: results.get("get_entries")!.entries as Entry[],
			state: results.get("get_state")!,
			dumps,
		};
	} finally {
		if (child.exitCode === null) {
			child.kill();
			await child.exited;
		}
	}
}

describe("Goal public management and history views", () => {
	// The same real notification is followed across transport consumers, not
	// four independently constructed strings that happen to share a marker.
	test("one auto notice retains user attribution and target identity in Provider, JSONL, dump, get_messages and get_entries", async () => {
		await using root = await TempDir.create("@goal-public-views-");
		await using provider = createProviderFixture({ reply: () => ({ text: "GOAL_PUBLIC_VIEWS_DONE" }) });
		const config = await goalCliFixture(root, provider.baseUrl);
		await Bun.write(
			path.join(config.agentDir, "config.yml"),
			JSON.stringify({
				modelRoles: { default: "deepseek/chat-a", smol: "deepseek/chat-a" },
				tools: { xdev: false },
				skills: { enabled: false },
				startup: { setupWizard: false },
				compaction: { enabled: false },
				goal: { continuationModes: [] },
			}),
		);
		const objective = "GOAL_PUBLIC_VIEWS Keep literal {{target}} & <user> text.\n\nPreserve  internal\t whitespace.";
		let sessionId: string;
		let saved: PersistedJournal;
		let count: number;
		const auth = await AuthStorage.create(root.join("auth.db"));
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			auth.keys.setRuntime("deepseek", "isolated-goal-public-key");
			const settings = Settings.isolated({
				modelRoles: { default: "deepseek/chat-a", smol: "deepseek/chat-a" },
				"tools.xdev": false,
				"async.enabled": false,
				"compaction.enabled": false,
				"providers.cacheWarming": "off",
				"goal.continuationModes": [],
			});
			const registry = new ModelRegistry(auth, path.join(config.agentDir, "models.yml"), { settings });
			const model = registry.find("deepseek", "chat-a");
			if (!model) throw new Error("Missing native Goal public-view fixture model");
			({ session } = await createAgentSession({
				cwd: config.cwd,
				agentDir: config.agentDir,
				authStorage: auth,
				modelRegistry: registry,
				model,
				settings,
				sessionManager: SessionManager.create(config.cwd, path.join(config.agentDir, "sessions")),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				extensions: [],
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				bindProcessState: false,
				workspaceTree: { rootPath: config.cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			}));
			await session.setActiveToolsByName(["read", "write", "goal"]);
			// Use the supported SDK Goal lifecycle, as in the adjacent auxiliary
			// consumers. CLI RPC below only consumes this session's persisted views.
			const state = await session.goalRuntime.createGoal({ objective, autoOrchestrate: true });
			await deadline(session.prompt(objective, { goalAutoOrchestrateInitialId: state.goal.id }));
			sessionId = session.sessionId;
			count = provider.requests.length;
			await session.dispose();
			session = undefined;
			saved = await journal(config.agentDir, sessionId);
		} finally {
			if (session) {
				await session.abort({ goalReason: "internal" });
				await session.dispose();
			}
			auth.close();
		}
		const views = await queryPublicHistory(config, saved.file);
		// Observe the real cold RPC restoration before the independent view
		// assertions, so a lost persisted mode flag is reported directly.
		expect(views.state.goal).toMatchObject({
			autoOrchestrate: true,
			enabled: false,
			goal: { id: goal(saved.entries).id, objective, status: "paused" },
		});
		const notice = notices(saved.entries);
		expect(notice).toHaveLength(1);
		const originalNotice = notice[0]!;
		expect(goal(saved.entries)).toMatchObject({ objective, mode: "goal", auto: true });
		expect(originalNotice.attribution).toBe("user");
		expect(originalNotice.content).toContain(objective);
		expect(originalNotice.details).toEqual({ source: "goal-auto-orchestrate", goalId: goal(saved.entries).id });
		// Identify the execution request by its real Goal tool schema,
		// independently of the notification whose exact bytes are asserted.
		const executionRequests = provider.requests.filter(request =>
			request.tools?.some(tool => isRecord(tool) && isRecord(tool.function) && tool.function.name === "goal"),
		);
		expect(executionRequests).toHaveLength(1);
		const request = executionRequests[0]!;
		try {
			expect(
				request.messages.flatMap(message =>
					Array.isArray(message.content)
						? message.content.flatMap((part: unknown) =>
								isRecord(part) && part.type === "text" && part.text === originalNotice.content
									? [{ role: message.role, content: part.text }]
									: [],
							)
						: [],
				),
			).toEqual([{ role: "user", content: originalNotice.content }]);
		} catch (error) {
			// Keep the received fixture bytes in failure output instead of
			// reducing the mismatch to []. Never print system prompts or headers.
			const fixtureMessages = request.messages
				.filter(message => message.role !== "system" && contentText(message.content).includes("GOAL_PUBLIC_VIEWS"))
				.map(message => ({ role: message.role, content: message.content }));
			throw new Error(
				`Goal fixture notification wire mismatch:\n${JSON.stringify(
					{
						expected: { role: "user", content: originalNotice.content },
						fixtureMessages,
						messageRoles: request.messages.map(message => message.role),
					},
					null,
					2,
				)}`,
				{ cause: error },
			);
		}
		const noticeContent = originalNotice.content;
		if (typeof noticeContent !== "string") throw new Error("Expected the persisted Goal notification text");
		expect(views.dumps.map(dump => dump.split(noticeContent).length)).toEqual([2]);
		const original = notices(saved.entries)[0]!;
		const entryViews = notices(views.entries);
		expect(entryViews).toEqual([original]);
		const messageViews = views.messages.filter(
			message => message.role === "custom" && message.customType === noticeType,
		);
		expect(messageViews).toHaveLength(1);
		const messageView = messageViews[0]!;
		expect({
			customType: messageView.customType,
			content: messageView.content,
			details: messageView.details,
			attribution: messageView.attribution,
			display: messageView.display,
		}).toEqual({
			customType: original.customType,
			content: original.content,
			details: original.details,
			attribution: "user",
			display: original.display,
		});
		expect(provider.requests).toHaveLength(count);
		expect(notices((await journal(config.agentDir, sessionId)).entries)).toEqual([original]);
	}, 90_000);

	test.each(commands)(
		"native TUI completes, manages and cold-restores %s through real keys",
		async origin => {
			if (!tuiTest)
				throw new Error("tui-test is required for the real Goal command/completion/cold-recovery contract");
			let turns = 0;
			await withTui(
				{
					configuration: {
						tools: { xdev: false },
						skills: { enabled: false },
						compaction: { enabled: false },
						goal: { continuationModes: [] },
					},
					reply: request => {
						const lastUser = request.messages.filter(message => message.role === "user").at(-1);
						return {
							text: contentText(lastUser?.content).includes("ordinary-root-beacon")
								? `${MARKER}_CHAT_READY`
								: `GOAL_PUBLIC_REPLY_${++turns}`,
						};
					},
				},
				[120, 40],
				async ({ tui, cwd, agentDir, provider }) => {
					const waitDraft = (text: string) =>
						eventually(
							() => nativeDraftSnapshot(tui),
							({ screen, cursor }) => nativeDraftMatches(screen, text, cursor),
						);
					const complete = async (text: string, candidate: string, completed: string) => {
						await waitDraft("");
						await tui("type", text);
						// Tab before the async popup is painted can merely open it (or
						// dismiss a stale prefix). Ghost text is not an accepted completion.
						const selected = new RegExp(`^❯\\s+(?:\\S+\\s+)?${candidate}(?:\\s|$)`, "mu");
						const ready = await eventually(
							() => nativeDraftSnapshot(tui),
							({ screen, cursor }) => nativeDraftMatches(screen, text, cursor) && selected.test(screen),
						);
						await tui("key", "press", "Tab");
						await waitDraft(completed);
						await clearNativeDraft(tui);
						return ready.screen;
					};
					const submit = async (text: string) => {
						// tui-test submit appends text and Enter without acknowledging
						// editor consumption. Keep each native key transition observable.
						await waitDraft("");
						await tui("type", text);
						await waitDraft(text);
						await tui("key", "press", "Enter");
					};
					const initialCalls = provider.requests.length;
					for (const prefix of commands) {
						const screen = await complete(prefix === "goal" ? "/goa" : "/goal-auto", prefix, `/${prefix}`);
						// The ambiguous prefix must expose both commands, while Tab
						// accepts the selected ordinary command rather than its alias.
						if (prefix === "goal") expect(screen).toContain("goal-autopilot");
						for (const [head, completion] of [
							["se", "set"],
							["sh", "show"],
							["pa", "pause"],
							["re", "resume"],
							["dr", "drop"],
							["bu", "budget"],
						]) {
							await complete(`/${prefix} ${head}`, completion, `/${prefix} ${completion}`);
						}
					}
					expect(provider.requests).toHaveLength(initialCalls);
					const objective = `GOAL_PUBLIC_${origin === "goal" ? "ORDINARY" : "AUTO"} preserve the terminal target`;
					await submit(`/${origin} ${objective}`);
					await tui("expect", "text", "GOAL_PUBLIC_REPLY_1", "--timeout", "30000");
					const saved = await eventually(
						async () =>
							(await journals(agentDir)).find(item =>
								item.entries.some(
									entry =>
										entry.type === "mode_change" &&
										isRecord(entry.data) &&
										isRecord(entry.data.goal) &&
										entry.data.goal.objective === objective,
								),
							),
						Boolean,
					);
					if (!saved) throw new Error("Native Goal did not persist its target");
					const sessionId = saved.entries.find(entry => entry.type === "session")!.id as string;
					const targetId = goal(saved.entries).id;
					const noticeBytes = notices(saved.entries).map(entry => JSON.stringify(entry));
					expect(noticeBytes).toHaveLength(origin === "goal-autopilot" ? 1 : 0);
					const read = async () => (await journal(agentDir, sessionId)).entries;
					const calls = provider.requests.length;
					for (const prefix of commands) {
						await submit(`/${prefix} show`);
						await tui("expect", "text", `Objective: ${objective}`, "--timeout", "30000");
						await submit(`/${prefix} budget 900000`);
						await eventually(read, entries => goal(entries).tokenBudget === 900000);
						await submit(`/${prefix} budget off`);
						await eventually(read, entries => goal(entries).tokenBudget === undefined);
						await submit(`/${prefix} pause`);
						await eventually(read, entries => goal(entries).status === "paused");
						await submit(`/${prefix} resume`);
						await eventually(read, entries => goal(entries).status === "active");
						await submit(`/${prefix} drop`);
						await tui("expect", "text", "Drop goal?", "--timeout", "30000");
						await tui("key", "press", "Escape");
						await eventually(
							() => nativeDraftSnapshot(tui),
							value => nativeDraftMatches(value.screen, "", value.cursor),
						);
						expect(goal(await read())).toMatchObject({
							id: targetId,
							objective,
							auto: origin === "goal-autopilot",
							status: "active",
						});
						expect(notices(await read()).map(entry => JSON.stringify(entry))).toEqual(noticeBytes);
					}
					expect(provider.requests).toHaveLength(calls);
					// `restart()` launches a greeting session; `/resume` after it is a
					// live switch that deliberately preserves active Goals. Cold restoration
					// must load the saved file at CLI startup, whose lifecycle pauses it.
					const root = path.dirname(path.dirname(agentDir));
					const coldEnv = {
						...Object.fromEntries(
							Object.entries(process.env).map(([key, value]) => [
								key,
								/(?:key|token|secret|password|credential|authorization|(?:^|_)auth(?:_|$))/i.test(key)
									? ""
									: value,
							]),
						),
						TZ: "UTC",
						OMP_CONFIG_ROOT: path.dirname(agentDir),
						PI_CODING_AGENT_DIR: agentDir,
						PI_CONFIG_DIR: ".omp",
						OMP_PROFILE: "default",
						PI_PROFILE: "",
						HOME: path.join(root, "home"),
						USERPROFILE: path.join(root, "home"),
						TEMP: path.join(root, "tmp"),
						TMP: path.join(root, "tmp"),
						OMP_OFFLINE: "0",
						PI_NO_TITLE: "1",
						PI_TEST_RUNTIME: "",
						NO_PROXY: "127.0.0.1,localhost",
						OPENSPEC_TELEMETRY: "0",
						DO_NOT_TRACK: "1",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
						GIT_CONFIG_COUNT: "0",
					};
					await tui("close");
					await tui(
						"run",
						"--cwd",
						repo,
						"--cols",
						"120",
						"--rows",
						"40",
						...Object.entries(coldEnv)
							.filter((entry): entry is [string, string] => entry[1] !== undefined)
							.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
						"--",
						Bun.which("bun") ?? process.execPath,
						"run",
						"dev",
						"--cwd",
						cwd,
						"--session",
						saved.file,
						"--no-extensions",
						"--no-rules",
						"--no-title",
						"--model",
						"deepseek/chat-a",
					);
					await eventually(read, entries => goal(entries).status === "paused");
					await tui("expect", "text", "GOAL_PUBLIC_REPLY_1", "--timeout", "30000");
					await submit("/goal-autopilot show");
					await tui("expect", "text", `Objective: ${objective}`, "--timeout", "30000");
					expect(goal(await read())).toMatchObject({
						id: targetId,
						objective,
						auto: origin === "goal-autopilot",
						status: "paused",
					});
					expect(notices(await read()).map(entry => JSON.stringify(entry))).toEqual(noticeBytes);
					expect(provider.requests).toHaveLength(calls);
					await submit("/goal-autopilot resume");
					await eventually(read, entries => goal(entries).status === "active");
					const replacement = origin === "goal" ? "goal-autopilot" : "goal";
					await submit(`/${replacement} set GOAL_PUBLIC_REPLACEMENT`);
					await tui("expect", "text", "GOAL_PUBLIC_REPLY_2", "--timeout", "30000");
					const replaced = await read();
					expect(goal(replaced)).toMatchObject({
						objective: "GOAL_PUBLIC_REPLACEMENT",
						auto: replacement === "goal-autopilot",
					});
					expect(goal(replaced).id).not.toBe(targetId);
					expect(notices(replaced)).toHaveLength(1);
					expect(
						notices(replaced)
							.slice(0, noticeBytes.length)
							.map(entry => JSON.stringify(entry)),
					).toEqual(noticeBytes);
					await submit(`/${origin} drop`);
					await tui("expect", "text", "Drop goal?", "--timeout", "30000");
					await tui("key", "press", "Home", "Enter");
					await tui("expect", "text", "Goal dropped.", "--timeout", "30000");
					const dropped = await read();
					expect(mode(dropped).mode).toBe("none");
					expect(notices(dropped)).toEqual(notices(replaced));
					expect(provider.requests).toHaveLength(calls + 1);
				},
			);
		},
		120_000,
	);
});
