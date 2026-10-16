import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

// Real cli.ts --mode rpc-ui coverage for the command catalog, local command
// routing, host-owned dialogs and automatic loop dispatch with a scripted
// loopback provider. No real model or ZCode GUI integration is exercised.
type RpcFrame = Record<string, unknown>;

interface RpcCommandServer {
	readonly next: (predicate: (frame: RpcFrame) => boolean) => Promise<RpcFrame>;
	readonly send: (frame: object) => void;
	readonly request: (frame: { id: string; type: string; [key: string]: unknown }) => Promise<RpcFrame>;
	readonly seen: readonly RpcFrame[];
	readonly closeStdin: () => void;
	readonly exited: Promise<number>;
}

interface CommandServerOptions {
	provider: string;
	model: string;
	modelsYaml: string;
	tools?: string;
}

async function withCommandServer(
	run: (server: RpcCommandServer, cwd: string) => Promise<void>,
	options?: CommandServerOptions,
): Promise<void> {
	await using root = await TempDir.create("@rpc-ui-command-entry-");
	const cwd = path.resolve(root.join("project"));
	const sessionDir = path.resolve(root.join("sessions"));
	const home = path.resolve(root.join("home"));
	const configRoot = path.resolve(root.join("config"));
	const offlineState = getOfflineShmState({ OMP_CONFIG_ROOT: configRoot, OMP_OFFLINE: "1" });
	// Explicit test preparation, not production restoration from the persistent root.
	const agentDir = path.join(offlineState?.runtimeRoot ?? configRoot, "agent");
	await using _runtimeCleanup = {
		[Symbol.asyncDispose]: async () => {
			if (offlineState) await fs.rm(path.dirname(offlineState.runtimeRoot), { recursive: true, force: true });
		},
	};
	for (const dir of [cwd, sessionDir, agentDir, home, configRoot])
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await Bun.write(
		path.join(agentDir, "config.yml"),
		[
			"modelRoles: {}",
			"advisor:",
			"  enabled: false",
			"eval:",
			"  js: true",
			"  py: false",
			"  autoProvision: false",
			"skills:",
			"  enableCodexUser: false",
			"  enableClaudeUser: false",
			"  enableClaudeProject: false",
			"  enablePiUser: false",
			"  enablePiProject: true",
			"  enableAgentsUser: false",
			"  enableAgentsProject: false",
			"",
		].join("\n"),
	);
	await Bun.write(
		path.join(cwd, ".omp", "skills", "rpc-command-fixture", "SKILL.md"),
		"---\nname: rpc-command-fixture\ndescription: Isolated RPC command fixture.\n---\nUse this fixture only when explicitly invoked.\n",
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		options?.modelsYaml ?? "providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:9\n",
	);
	const child = Bun.spawn(
		[
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-ui",
			"--no-rules",
			...(options?.tools ? ["--tools", options.tools] : ["--no-tools"]),
			"--session-dir",
			sessionDir,
			"--provider",
			options?.provider ?? "anthropic",
			"--model",
			options?.model ?? "claude-sonnet-4-5",
		],
		{
			cwd,
			env: {
				...Bun.env,
				HOME: home,
				USERPROFILE: home,
				OMP_CONFIG_ROOT: configRoot,
				PI_CONFIG_DIR: ".omp",
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
				PI_NO_TITLE: "1",
				PI_CODING_AGENT_DIR: agentDir,
				OMP_OFFLINE: "1",
				ANTHROPIC_API_KEY: "test-key",
			} as unknown as Record<string, string | undefined>,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderr = new Response(child.stderr).text();
	const seen: RpcFrame[] = [];
	const queue: RpcFrame[] = [];
	let done = false;
	let readerError: unknown;
	const pump = (async () => {
		try {
			for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
				if (!isRecord(frame)) continue;
				seen.push(frame);
				queue.push(frame);
			}
		} catch (error) {
			readerError = error;
		} finally {
			done = true;
		}
	})();
	const next = async (predicate: (frame: RpcFrame) => boolean): Promise<RpcFrame> => {
		const deadline = Date.now() + 120_000;
		for (;;) {
			const index = queue.findIndex(predicate);
			if (index >= 0) return queue.splice(index, 1)[0]!;
			if (done) throw readerError ?? new Error(`RPC stream ended: ${await stderr}`);
			if (Date.now() > deadline) throw new Error("Timed out waiting for RPC command frame");
			await Bun.sleep(50);
		}
	};
	const send = (frame: object) => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	const server: RpcCommandServer = {
		next,
		send,
		request: async frame => {
			send(frame);
			return await next(response => response.type === "response" && response.id === frame.id);
		},
		seen,
		closeStdin: () => child.stdin.end(),
		exited: child.exited,
	};
	try {
		await next(frame => frame.type === "ready");
		expect(await server.request({ id: "negotiate", type: "negotiate_protocol", protocolVersion: 3 })).toMatchObject({
			success: true,
			data: { protocolVersion: 3 },
		});
		if (offlineState) {
			const current = await server.request({ id: "fixture-path", type: "get_state" });
			if (!isRecord(current.data) || typeof current.data.sessionFile !== "string")
				throw new Error("Missing effective RPC session file");
			const relative = path.relative(offlineState.runtimeRoot, current.data.sessionFile);
			expect(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(false);
		}
		await run(server, cwd);
	} finally {
		server.closeStdin();
		await Promise.race([child.exited, Bun.sleep(30_000)]);
		if (child.exitCode === null) child.kill();
		await child.exited;
		await pump.catch(() => {});
	}
}

function commandOutputSince(server: RpcCommandServer, start: number): string {
	return server.seen
		.slice(start)
		.filter(frame => frame.type === "command_output")
		.map(frame => String(frame.text))
		.join("\n");
}

describe("rpc-ui command entry (rpc-ui-protocol.md)", () => {
	test("required commands and an isolated project skill are usable and complete through protocol v3", async () => {
		await withCommandServer(async server => {
			const catalog = await server.request({ id: "catalog", type: "get_available_commands" });
			expect(catalog.success).toBe(true);
			if (!isRecord(catalog.data) || !Array.isArray(catalog.data.commands))
				throw new Error("Missing command catalog");
			const names = [
				"wiki",
				"repo",
				"team",
				"plan",
				"loop",
				"goal",
				"advisor",
				"ultrathink",
				"orchestrate",
				"workflowz",
				"fullsend",
				"compact",
				"skill:rpc-command-fixture",
			];
			for (const name of names) {
				expect(catalog.data.commands.find(command => isRecord(command) && command.name === name)).toMatchObject({
					execution: "omp",
					availability: { available: true },
				});
				const text = `/${name}`;
				const completion = await server.request({
					id: `complete-${name}`,
					type: "complete_command",
					text,
					cursor: text.length,
				});
				expect(completion.success).toBe(true);
				if (!isRecord(completion.data) || !Array.isArray(completion.data.items)) {
					throw new Error("Missing command completion");
				}
				expect(completion.data.items).toContainEqual(
					expect.objectContaining({ label: name, insertText: `${text} ` }),
				);
			}
			expect(catalog.data.commands.find(command => isRecord(command) && command.name === "git")).toMatchObject({
				execution: "tui",
				availability: { available: false, reason: "tui_only" },
			});
			expect(server.seen.some(frame => frame.type === "agent_start")).toBe(false);
		});
	}, 300_000);

	test("jch-workflowzbatch completion dispatches a literal user task and rejects invalid counts locally", async () => {
		const requests: RpcFrame[] = [];
		const model = "rpc-batch-model";
		const modelServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
					return new Response("not found", { status: 404 });
				}
				const body: unknown = await request.json();
				if (!isRecord(body)) return new Response("invalid request", { status: 400 });
				requests.push(body);
				const base = { id: "chatcmpl-batch", object: "chat.completion.chunk", created: 0, model };
				const chunks = [
					{
						...base,
						choices: [
							{ index: 0, delta: { role: "assistant", content: "RPC_BATCH_ACCEPTED" }, finish_reason: null },
						],
					},
					{
						...base,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					},
				];
				return new Response(
					`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			await withCommandServer(
				async server => {
					const catalog = await server.request({ id: "batch-catalog", type: "get_available_commands" });
					if (!isRecord(catalog.data) || !Array.isArray(catalog.data.commands)) {
						throw new Error("Missing command catalog");
					}
					expect(
						catalog.data.commands.find(command => isRecord(command) && command.name === "jch-workflowzbatch"),
					).toMatchObject({ execution: "omp", availability: { available: true } });
					const prefix = "/jch-workflowzb";
					const completion = await server.request({
						id: "batch-completion",
						type: "complete_command",
						text: prefix,
						cursor: prefix.length,
					});
					if (!isRecord(completion.data) || !Array.isArray(completion.data.items)) {
						throw new Error("Missing command completion");
					}
					const item = completion.data.items.find(item => isRecord(item) && item.label === "jch-workflowzbatch");
					if (!isRecord(item) || typeof item.insertText !== "string") throw new Error("Missing batch completion");
					const task = [
						"修复fork仓自有的bug。",
						"```ts",
						"const s = `a  ",
						"b`;",
						"```",
						"",
						"",
						"| padded | cells |",
						"保留 <T>、{{targetItems}} 和 $&",
					].join("\r\n");
					expect(
						await server.request({
							id: "batch-run",
							type: "prompt",
							message: `${item.insertText}200 30 ${task}`,
						}),
					).toMatchObject({ success: true });
					expect(
						await server.next(frame => frame.type === "prompt_result" && frame.id === "batch-run"),
					).toMatchObject({ status: "completed", agentInvoked: true });
					const messages = requests.flatMap(body =>
						Array.isArray(body.messages) ? body.messages.filter(isRecord) : [],
					);
					const user = messages.findLast(message => message.role === "user");
					if (!user) throw new Error("Provider did not receive user input");
					const text =
						typeof user.content === "string"
							? user.content
							: Array.isArray(user.content)
								? user.content
										.filter(isRecord)
										.map(part => String(part.text ?? ""))
										.join("")
								: "";
					expect(text.slice(-task.length)).toBe(task);
					expect(text).not.toContain("/jch-workflowzbatch");
					const starts = server.seen.filter(frame => frame.type === "agent_start").length;
					const requestCount = requests.length;
					const outputStart = server.seen.length;
					expect(
						await server.request({
							id: "batch-invalid",
							type: "prompt",
							message: "/jch-workflowzbatch 200 0 修复",
						}),
					).toMatchObject({ success: true, data: { agentInvoked: false } });
					expect(await server.request({ id: "batch-settled", type: "get_state" })).toMatchObject({
						success: true,
						data: { isStreaming: false },
					});
					expect(commandOutputSince(server, outputStart)).toContain("用法：/jch-workflowzbatch");
					expect(requests).toHaveLength(requestCount);
					expect(server.seen.filter(frame => frame.type === "agent_start")).toHaveLength(starts);
				},
				{
					provider: "rpc-batch",
					model,
					tools: "read,task,eval",
					modelsYaml: [
						"providers:",
						"  rpc-batch:",
						`    baseUrl: http://127.0.0.1:${modelServer.port}/v1`,
						"    auth: none",
						"    api: openai-completions",
						"    models:",
						`      - id: ${model}`,
						"        reasoning: false",
						"",
					].join("\n"),
				},
			);
		} finally {
			modelServer.stop(true);
		}
	}, 300_000);

	test("local commands use host dialogs, refuse terminal UI and stay responsive when a dialog is aborted", async () => {
		await withCommandServer(async (server, cwd) => {
			server.send({ id: "wiki", type: "prompt", message: "/wiki" });
			const wiki = await server.next(frame => frame.type === "extension_ui_request" && frame.method === "select");
			expect(wiki.options).toContain("New document index");
			server.send({ type: "extension_ui_response", id: wiki.id, cancelled: true });
			expect(await server.next(frame => frame.type === "response" && frame.id === "wiki")).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});

			server.send({ id: "repo", type: "prompt", message: "/repo" });
			const repo = await server.next(frame => frame.type === "extension_ui_request" && frame.method === "select");
			expect(repo.options).toContain("Build repository index");
			server.send({ type: "extension_ui_response", id: repo.id, value: "Build repository index" });
			const build = await server.next(frame => frame.type === "extension_ui_request" && frame.method === "confirm");
			expect(build.message).toEqual(expect.stringContaining(cwd));
			server.send({ type: "extension_ui_response", id: build.id, confirmed: false });
			expect(await server.next(frame => frame.type === "response" && frame.id === "repo")).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			// Refusing the root confirmation leaves the index unbuilt.
			server.send({ id: "repo-after-refusal", type: "prompt", message: "/repo" });
			const unchangedRepo = await server.next(
				frame => frame.type === "extension_ui_request" && frame.method === "select",
			);
			expect(unchangedRepo.options).toContain("Build repository index");
			expect(unchangedRepo.options).not.toContain("Update repository index");
			server.send({ type: "extension_ui_response", id: unchangedRepo.id, cancelled: true });
			expect(
				await server.next(frame => frame.type === "response" && frame.id === "repo-after-refusal"),
			).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});

			server.send({ id: "wiki-rebind", type: "prompt", message: "/wiki" });
			const rebindDialog = await server.next(
				frame => frame.type === "extension_ui_request" && frame.method === "select",
			);
			const beforeRebind = await server.request({ id: "dialog-before-rebind", type: "get_state" });
			if (!isRecord(beforeRebind.data) || typeof beforeRebind.data.sessionFile !== "string") {
				throw new Error("Missing session file for directory rebind");
			}
			const rebindStart = server.seen.length;
			expect(
				await server.request({
					id: "dialog-rebind",
					type: "open_session",
					sessionDir: path.dirname(beforeRebind.data.sessionFile),
				}),
			).toMatchObject({ success: true, data: { sessionId: beforeRebind.data.sessionId, cancelled: false } });
			expect(
				server.seen
					.slice(rebindStart)
					.some(frame => frame.type === "extension_ui_request" && frame.method === "cancel"),
			).toBe(false);
			server.send({ type: "extension_ui_response", id: rebindDialog.id, value: "New document index" });
			const directoryInput = await server.next(
				frame => frame.type === "extension_ui_request" && frame.method === "input",
			);
			expect(directoryInput.title).toBe("Markdown directory");
			server.send({ type: "extension_ui_response", id: directoryInput.id, cancelled: true });
			expect(await server.next(frame => frame.type === "response" && frame.id === "wiki-rebind")).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			server.send({ id: "wiki-abort", type: "prompt", message: "/wiki" });
			const pending = await server.next(frame => frame.type === "extension_ui_request" && frame.method === "select");
			expect(await server.request({ id: "abort", type: "abort" })).toMatchObject({ success: true });
			expect(
				await server.next(
					frame =>
						frame.type === "extension_ui_request" && frame.method === "cancel" && frame.targetId === pending.id,
				),
			).toMatchObject({ targetId: pending.id });
			// A late answer cannot revive the aborted dialog or launch a model turn.
			server.send({ type: "extension_ui_response", id: pending.id, value: "New document index" });
			expect(await server.request({ id: "alive", type: "get_state" })).toMatchObject({
				success: true,
				data: { isStreaming: false },
			});

			let start = server.seen.length;
			expect(await server.request({ id: "goal-show", type: "prompt", message: "/goal show" })).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			expect(commandOutputSince(server, start)).toMatch(/no goal/i);
			const budget = await server.request({ id: "goal-budget", type: "prompt", message: "/goal budget invalid" });
			expect(budget).toMatchObject({ success: false });
			expect(String(budget.error)).toMatch(/goal|budget/i);

			start = server.seen.length;
			expect(await server.request({ id: "plan-on", type: "prompt", message: "/plan" })).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			expect(commandOutputSince(server, start)).toMatch(/plan mode enabled/i);
			expect(await server.request({ id: "plan-pause", type: "prompt", message: "/plan" })).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			await server.next(frame => frame.type === "command_output" && /plan mode paused/i.test(String(frame.text)));
			expect(await server.request({ id: "plan-off", type: "prompt", message: "/plan" })).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			await server.next(frame => frame.type === "command_output" && /plan mode disabled/i.test(String(frame.text)));

			start = server.seen.length;
			expect(await server.request({ id: "loop-on", type: "prompt", message: "/loop 2" })).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			expect(commandOutputSince(server, start)).toMatch(/loop.*enabled/i);
			start = server.seen.length;
			expect(await server.request({ id: "loop-off", type: "prompt", message: "/loop" })).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			expect(commandOutputSince(server, start)).toMatch(/loop.*disabled/i);
			expect(await server.request({ id: "loop-invalid", type: "prompt", message: "/loop 0" })).toMatchObject({
				success: false,
				error: expect.stringContaining("positive integer"),
			});

			start = server.seen.length;
			expect(
				await server.request({ id: "advisor-status", type: "prompt", message: "/advisor status" }),
			).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			expect(commandOutputSince(server, start)).toMatch(/advisor.*disabled/i);
			start = server.seen.length;
			const configure = await server.request({
				id: "advisor-configure",
				type: "prompt",
				message: "/advisor configure",
			});
			expect(configure).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			expect(commandOutputSince(server, start)).toMatch(/only available.*interactive TUI/i);
			expect(await server.request({ id: "terminal-only", type: "prompt", message: "/git" })).toMatchObject({
				success: false,
				error: expect.stringContaining("interactive TUI"),
			});
			expect(server.seen.some(frame => frame.type === "agent_start")).toBe(false);
			server.closeStdin();
			expect(await server.exited).toBe(0);
		});
	}, 300_000);

	test("reopening an active plan preserves its turn and mode, while real open and new session cancel the old turn", async () => {
		const model = "rpc-plan-rebind-model";
		const started = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
		const releases = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
		let requestCount = 0;
		const modelServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
					return new Response("not found", { status: 404 });
				}
				const index = requestCount++;
				// The seed completes normally; only the subsequent active-plan turns are controlled.
				if (index > 0) {
					started[index - 1]!.resolve();
					await releases[index - 1]!.promise;
				}
				const base = { id: `chatcmpl-plan-${index}`, object: "chat.completion.chunk", created: 0, model };
				const chunks = [
					{
						...base,
						choices: [
							{ index: 0, delta: { role: "assistant", content: "Inspection complete." }, finish_reason: null },
						],
					},
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
				];
				return new Response(
					`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			await withCommandServer(
				async server => {
					// Sessions persist lazily after an assistant response. Seed through public RPC before
					// blocking the plan turn so open_session can resolve the actual saved session.
					expect(
						await server.request({
							id: "plan-rebind-seed",
							type: "prompt",
							message: "Seed the session before inspecting plan rebind behavior.",
						}),
					).toMatchObject({ success: true });
					expect(
						await server.next(frame => frame.type === "prompt_result" && frame.id === "plan-rebind-seed"),
					).toMatchObject({ status: "completed", agentInvoked: true });
					const seeded = await server.request({ id: "plan-rebind-seeded", type: "get_state" });
					expect(seeded).toMatchObject({ success: true, data: { isStreaming: false } });
					if (!isRecord(seeded.data)) throw new Error("Missing seeded session state");
					expect(
						await server.request({
							id: "plan-rebind-run",
							type: "prompt",
							message: "/plan Inspect rebind behavior",
						}),
					).toMatchObject({ success: true });
					await started[0]!.promise;
					const active = await server.request({ id: "plan-rebind-active", type: "get_state" });
					expect(active).toMatchObject({ success: true, data: { isStreaming: true } });
					if (!isRecord(active.data) || typeof active.data.sessionFile !== "string") {
						throw new Error("Active plan lacks its session file");
					}
					const sessionFile = active.data.sessionFile;
					const sessionId = active.data.sessionId;
					const readModes = async () => {
						const modes: RpcFrame[] = [];
						for await (const entry of readJsonl<unknown>(Bun.file(sessionFile).stream())) {
							if (isRecord(entry) && entry.type === "mode_change") modes.push(entry);
						}
						return modes;
					};
					const modesBefore = await readModes();
					expect(modesBefore.at(-1)).toMatchObject({ mode: "plan" });
					expect(
						await server.request({
							id: "plan-rebind",
							type: "open_session",
							sessionDir: path.dirname(sessionFile),
						}),
					).toMatchObject({ success: true, data: { sessionId, sessionFile, cancelled: false, resumed: true } });
					expect(await server.request({ id: "plan-rebind-after", type: "get_state" })).toMatchObject({
						success: true,
						data: { sessionId, sessionFile, isStreaming: true, dumpTools: active.data.dumpTools },
					});
					expect(await readModes()).toEqual(modesBefore);
					expect(server.seen.some(frame => frame.type === "prompt_result" && frame.id === "plan-rebind-run")).toBe(
						false,
					);
					releases[0]!.resolve();
					expect(
						await server.next(frame => frame.type === "prompt_result" && frame.id === "plan-rebind-run"),
					).toMatchObject({ status: "completed", agentInvoked: true });

					// A different directory really creates a new session and detaches the old mode.
					const fresh = await server.request({
						id: "plan-open-fresh",
						type: "open_session",
						sessionDir: path.join(path.dirname(path.dirname(sessionFile)), "fresh-sessions"),
					});
					expect(fresh).toMatchObject({ success: true, data: { cancelled: false, resumed: false } });
					if (!isRecord(fresh.data)) throw new Error("Missing fresh session identity");
					expect(fresh.data.sessionId).not.toBe(sessionId);
					expect(await server.request({ id: "plan-open-fresh-state", type: "get_state" })).toMatchObject({
						success: true,
						data: { sessionId: fresh.data.sessionId, isStreaming: false, dumpTools: seeded.data.dumpTools },
					});
					const start = server.seen.length;
					expect(
						await server.request({
							id: "plan-switch-run",
							type: "prompt",
							message: "/plan Inspect real switching",
						}),
					).toMatchObject({ success: true });
					await started[1]!.promise;
					expect(commandOutputSince(server, start)).toMatch(/plan mode enabled/i);
					expect(
						await server.request({
							id: "plan-open-saved",
							type: "open_session",
							sessionDir: path.dirname(sessionFile),
						}),
					).toMatchObject({ success: true, data: { sessionId, sessionFile, cancelled: false, resumed: true } });
					expect(
						await server.next(frame => frame.type === "prompt_result" && frame.id === "plan-switch-run"),
					).toMatchObject({ status: "aborted", agentInvoked: true });
					expect(await server.request({ id: "plan-switch-settled", type: "get_state" })).toMatchObject({
						success: true,
						data: { sessionId, isStreaming: false },
					});

					// The saved session restores its plan. A new session must detach that active plan too.
					expect(
						await server.request({
							id: "plan-new-run",
							type: "prompt",
							message: "Inspect new session switching.",
						}),
					).toMatchObject({ success: true });
					await started[2]!.promise;
					expect(await server.request({ id: "plan-new-active", type: "get_state" })).toMatchObject({
						success: true,
						data: { sessionId, sessionFile, isStreaming: true, dumpTools: active.data.dumpTools },
					});
					expect(await server.request({ id: "plan-new", type: "new_session" })).toMatchObject({
						success: true,
						data: { cancelled: false },
					});
					expect(
						await server.next(frame => frame.type === "prompt_result" && frame.id === "plan-new-run"),
					).toMatchObject({ status: "aborted", agentInvoked: true });
					const newState = await server.request({ id: "plan-new-settled", type: "get_state" });
					expect(newState).toMatchObject({
						success: true,
						data: { isStreaming: false, dumpTools: seeded.data.dumpTools },
					});
					if (!isRecord(newState.data)) throw new Error("Missing new session identity");
					expect(newState.data.sessionId).not.toBe(sessionId);
					expect(newState.data.sessionFile).not.toBe(sessionFile);
					const newPlanStart = server.seen.length;
					expect(await server.request({ id: "plan-new-enable", type: "prompt", message: "/plan" })).toMatchObject({
						success: true,
						data: { agentInvoked: false },
					});
					expect(commandOutputSince(server, newPlanStart)).toMatch(/plan mode enabled/i);
				},
				{
					provider: "rpc-plan-rebind",
					model,
					tools: "read",
					modelsYaml: [
						"providers:",
						"  rpc-plan-rebind:",
						`    baseUrl: http://127.0.0.1:${modelServer.port}/v1`,
						"    auth: none",
						"    api: openai-completions",
						"    models:",
						`      - id: ${model}`,
						"        reasoning: false",
						"",
					].join("\n"),
				},
			);
		} finally {
			for (const release of releases) release.resolve();
			modelServer.stop(true);
		}
	}, 300_000);

	test("loop prompts stop at their limit, and deleting that session reports rollover without reviving old dialogs", async () => {
		const requests: RpcFrame[] = [];
		const requestStarts: number[] = [];
		const responseEnds: number[] = [];
		const model = "rpc-loop-model";
		const prompt = "3D modeling regression fixture";
		let firstRequest = Promise.withResolvers<void>();
		let releaseFirst = Promise.withResolvers<void>();
		const modelServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (pathname.endsWith("/models")) {
					return Response.json({ object: "list", data: [{ id: model, object: "model", owned_by: "rpc-loop" }] });
				}
				if (!pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
				const body: unknown = await request.json();
				if (!isRecord(body)) return new Response("invalid request", { status: 400 });
				requests.push(body);
				requestStarts.push(performance.now());
				if (requests.length === 1) {
					firstRequest.resolve();
					await releaseFirst.promise;
				}
				// The real CLI child owns its clock; a slow turn distinguishes end-to-start from start-to-start timing.
				if (requests.length === 3) await Bun.sleep(1_200);
				responseEnds.push(performance.now());
				const text = `loop-reply-${requests.length}`;
				const base = { id: `chatcmpl-loop-${requests.length}`, object: "chat.completion.chunk", created: 0, model };
				const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
				if (!body.stream) {
					return Response.json({
						...base,
						object: "chat.completion",
						choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
						usage,
					});
				}
				const chunks = [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					{ ...base, choices: [], usage },
				];
				return new Response(
					`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		});
		try {
			await withCommandServer(
				async server => {
					// Materialize a real conversation before testing already-open directory rebinding.
					expect(
						await server.request({ id: "loop-seed", type: "prompt", message: "Persist the loop fixture" }),
					).toMatchObject({ success: true });
					await firstRequest.promise;
					releaseFirst.resolve();
					await server.next(frame => frame.type === "agent_end" && frame.isTerminal !== false);
					expect(
						await server.next(frame => frame.type === "prompt_result" && frame.id === "loop-seed"),
					).toMatchObject({ status: "completed" });
					requests.length = 0;
					requestStarts.length = 0;
					responseEnds.length = 0;
					const loopFrameStart = server.seen.length;
					firstRequest = Promise.withResolvers<void>();
					releaseFirst = Promise.withResolvers<void>();

					expect(
						await server.request({ id: "loop-run", type: "prompt", message: `/loop 1 ${prompt}` }),
					).toMatchObject({
						success: true,
					});
					await firstRequest.promise;
					const active = await server.request({ id: "loop-active", type: "get_state" });
					expect(active).toMatchObject({ success: true, data: { isStreaming: true } });
					if (!isRecord(active.data) || typeof active.data.sessionFile !== "string") {
						throw new Error("Active loop lacks its session file");
					}
					expect(
						await server.request({
							id: "loop-rebind",
							type: "open_session",
							sessionDir: path.dirname(active.data.sessionFile),
						}),
					).toMatchObject({ success: true, data: { sessionId: active.data.sessionId, cancelled: false } });
					expect(await server.request({ id: "loop-after-rebind", type: "get_state" })).toMatchObject({
						success: true,
						data: { sessionId: active.data.sessionId, isStreaming: true },
					});
					releaseFirst.resolve();
					await server.next(frame => frame.type === "agent_end" && frame.isTerminal !== false);
					await server.next(frame => frame.type === "agent_end" && frame.isTerminal !== false);
					const limited = await server.next(
						frame => frame.type === "command_output" && /loop limit reached/i.test(String(frame.text)),
					);
					expect(limited.text).toEqual(expect.stringContaining("disabled"));
					// The TUI count limits automatic repetitions; the initial prompt is separate.
					expect(requests).toHaveLength(2);
					const userTasks: string[] = [];
					for (const body of requests) {
						if (!Array.isArray(body.messages)) throw new Error("Provider request lacks messages");
						const user = body.messages.findLast(message => isRecord(message) && message.role === "user");
						if (!isRecord(user)) throw new Error("Provider request lacks a user prompt");
						const text =
							typeof user.content === "string"
								? user.content
								: Array.isArray(user.content)
									? user.content
											.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
											.join("")
									: "";
						// Shared session context prepends date/cwd reminders to model input.
						// Compare the delivered user task after those harness-owned blocks.
						userTasks.push(text.replace(/^(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/, ""));
					}
					expect(userTasks).toEqual([prompt, prompt]);
					const replies = server.seen
						.slice(loopFrameStart)
						.filter(
							frame =>
								frame.type === "message_end" && isRecord(frame.message) && frame.message.role === "assistant",
						)
						.map(frame => {
							const message = frame.message as RpcFrame;
							if (!Array.isArray(message.content)) throw new Error("Assistant frame lacks content");
							return message.content
								.filter(part => isRecord(part) && part.type === "text")
								.map(part => String(part.text))
								.join("");
						});
					expect(replies).toEqual(["loop-reply-1", "loop-reply-2"]);
					expect(
						await server.request({ id: "loop-interval", type: "prompt", message: `/loop 2 1s ${prompt}` }),
					).toMatchObject({ success: true });
					await server.next(frame => frame.type === "agent_end" && frame.isTerminal !== false);
					await server.next(frame => frame.type === "agent_end" && frame.isTerminal !== false);
					await server.next(
						frame => frame.type === "command_output" && /loop limit reached/i.test(String(frame.text)),
					);
					expect(requests).toHaveLength(4);
					expect(requestStarts[3]! - responseEnds[2]!).toBeGreaterThanOrEqual(1_000);
					const settled = await server.request({ id: "loop-settled", type: "get_state" });
					expect(settled).toMatchObject({
						success: true,
						data: { isStreaming: false, queuedMessageCount: 0 },
					});
					if (
						!isRecord(settled.data) ||
						typeof settled.data.sessionId !== "string" ||
						typeof settled.data.sessionFile !== "string"
					) {
						throw new Error("Completed session lacks its persisted identity");
					}
					const oldSessionId = settled.data.sessionId;
					const oldSessionFile = settled.data.sessionFile;
					expect(await Bun.file(oldSessionFile).exists()).toBe(true);
					server.send({ id: "wiki-before-delete", type: "prompt", message: "/wiki" });
					const dialog = await server.next(
						frame => frame.type === "extension_ui_request" && frame.method === "select",
					);
					const deleteStart = server.seen.length;
					expect(await server.request({ id: "delete", type: "prompt", message: "/session delete" })).toMatchObject(
						{
							success: true,
							data: { agentInvoked: false },
						},
					);
					expect(commandOutputSince(server, deleteStart)).toContain(`Session deleted: ${oldSessionFile}`);
					expect(await Bun.file(oldSessionFile).exists()).toBe(false);
					await server.next(
						frame =>
							frame.type === "extension_ui_request" && frame.method === "cancel" && frame.targetId === dialog.id,
					);
					// The legitimate rollover's result reaches its new session, but a
					// different command's late dialog answer cannot follow it there.
					server.send({ type: "extension_ui_response", id: dialog.id, value: "New document index" });
					const fresh = await server.request({ id: "after-delete", type: "get_state" });
					expect(fresh).toMatchObject({ success: true, data: { isStreaming: false, queuedMessageCount: 0 } });
					if (!isRecord(fresh.data)) throw new Error("Missing fresh session state");
					expect(fresh.data.sessionId).not.toBe(oldSessionId);
					expect(
						server.seen
							.slice(deleteStart)
							.some(frame => frame.type === "extension_ui_request" && frame.method === "input"),
					).toBe(false);
					expect(server.seen.slice(deleteStart).some(frame => frame.type === "agent_start")).toBe(false);
				},
				{
					provider: "rpc-loop",
					model,
					modelsYaml: [
						"providers:",
						"  rpc-loop:",
						`    baseUrl: http://127.0.0.1:${modelServer.port}/v1`,
						"    auth: none",
						"    api: openai-completions",
						"    models:",
						`      - id: ${model}`,
						"        name: RPC Loop Fixture",
						"        reasoning: false",
						"",
					].join("\n"),
				},
			);
		} finally {
			releaseFirst.resolve();
			modelServer.stop(true);
		}
	}, 300_000);
});
