import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
}

async function withCommandServer(
	run: (server: RpcCommandServer, cwd: string) => Promise<void>,
	options?: CommandServerOptions,
): Promise<void> {
	await using root = await TempDir.create("@rpc-ui-command-entry-");
	const cwd = path.resolve(root.join("project"));
	const sessionDir = path.resolve(root.join("sessions"));
	const agentDir = path.resolve(root.join("agent"));
	const home = path.resolve(root.join("home"));
	const configRoot = path.resolve(root.join("config"));
	for (const dir of [cwd, sessionDir, agentDir, home, configRoot]) await fs.mkdir(dir, { recursive: true });
	await Bun.write(
		path.join(agentDir, "config.yml"),
		[
			"modelRoles: {}",
			"advisor:",
			"  enabled: false",
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
			"--no-tools",
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
		await run(server, cwd);
	} finally {
		server.closeStdin();
		await Promise.race([child.exited, Bun.sleep(30_000)]);
		if (child.exitCode === null) child.kill();
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

	test("a loop's automatic prompt reaches the provider through the real input gate and stops at its limit", async () => {
		const requests: RpcFrame[] = [];
		const model = "rpc-loop-model";
		const prompt = "RPC loop dispatch fixture";
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
					expect(
						await server.request({ id: "loop-run", type: "prompt", message: `/loop 1 ${prompt}` }),
					).toMatchObject({
						success: true,
					});
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
					expect(await server.request({ id: "loop-settled", type: "get_state" })).toMatchObject({
						success: true,
						data: { isStreaming: false, queuedMessageCount: 0 },
					});
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
			modelServer.stop(true);
		}
	}, 300_000);
});
