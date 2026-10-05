import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { YAML } from "bun";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder } from "../src/modes/rpc/rpc-frame";
import { e2eApiKey } from "./utilities";

// Requirement 4.1 acceptance E2E (rpc-ui-protocol.md): model-driven approval
// flow against the real `omp --mode rpc-ui` entry. Requires an Anthropic API
// key (skipped otherwise — the protocol-level behavior is covered by
// rpc-fork-permission.test.ts and rpc-fork-protocol.test.ts).

type RpcFrame = Record<string, unknown>;

async function readFixtureYaml(file: string) {
	const parsed = YAML.parse(await fs.readFile(file, "utf-8"));
	if (!isRecord(parsed)) throw new Error("Invalid fixture document");
	return {
		raw: parsed,
		providers: isRecord(parsed.providers) ? parsed.providers : {},
		skills: isRecord(parsed.skills) ? parsed.skills : {},
		enabledModels: Array.isArray(parsed.enabledModels) ? parsed.enabledModels : [],
		disabledModels: Array.isArray(parsed.disabledModels) ? parsed.disabledModels : [],
	};
}

interface ServerHandle {
	send: (frame: object) => void;
	next: (predicate?: (frame: RpcFrame) => boolean) => Promise<RpcFrame>;
	dispose: () => Promise<void>;
}

async function spawnRpcServer(
	cwd: string,
	agentDir: string,
	options?: { projectMode?: boolean; provider?: string; model?: string },
): Promise<ServerHandle> {
	const env = options?.projectMode
		? {
				PATH: Bun.env.PATH,
				SystemRoot: Bun.env.SystemRoot,
				TEMP: Bun.env.TEMP,
				TMP: Bun.env.TMP,
				HOME: agentDir,
				USERPROFILE: agentDir,
				CLAUDE_CONFIG_DIR: path.join(agentDir, "claude"),
				OMP_AUTH_BROKER_URL: "",
				OMP_AUTH_BROKER_TOKEN: "",
			}
		: Bun.env;
	const child = Bun.spawn(
		[
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc-ui",
			...(options?.projectMode ? ["--rpc-project"] : []),
			"--no-extensions",
			"--no-skills",
			"--provider",
			options?.provider ?? "anthropic",
			"--model",
			options?.model ?? "claude-sonnet-4-5",
		],
		{
			cwd,
			env: { ...env, PI_NO_TITLE: "1", PI_CODING_AGENT_DIR: agentDir } as unknown as Record<
				string,
				string | undefined
			>,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrPromise = new Response(child.stderr).text();
	const queue: RpcFrame[] = [];
	let readerDone = false;
	let readerError: unknown;
	const decoder = new RpcFrameDecoder();
	let protocolChunkingEnabled = false;
	const lines = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>);
	const pump = (async () => {
		try {
			for await (const line of lines) {
				if (isRecord(line) && line.type === "rpc_chunk" && !protocolChunkingEnabled) {
					throw new Error("Server chunked an RPC frame before protocol negotiation");
				}
				const frame = decoder.push(line);
				if (!isRecord(frame)) continue;
				if (
					frame.type === "response" &&
					frame.command === "negotiate_protocol" &&
					frame.success === true &&
					isRecord(frame.data) &&
					(frame.data.protocolVersion === 2 || frame.data.protocolVersion === 3)
				) {
					protocolChunkingEnabled = true;
				}
				queue.push(frame);
			}
		} catch (error) {
			readerError = error;
		} finally {
			readerDone = true;
		}
	})();
	const send = (frame: object): void => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	const next = async (predicate?: (frame: RpcFrame) => boolean): Promise<RpcFrame> => {
		const match = predicate ?? (frame => frame.type === "response");
		for (let waited = 0; waited < 1200; waited++) {
			const index = queue.findIndex(match);
			if (index !== -1) return queue.splice(index, 1)[0]!;
			if (readerDone) throw new Error(`RPC stream ended early: ${await stderrPromise} ${String(readerError ?? "")}`);
			await Bun.sleep(100);
		}
		throw new Error("Timed out waiting for RPC frame");
	};
	return {
		send,
		next,
		dispose: async () => {
			try {
				child.stdin.end();
			} catch {}
			child.kill();
			await child.exited.catch(() => {});
			await pump.catch(() => {});
			await stderrPromise.catch(() => {});
		},
	};
}

async function negotiate(handler: ServerHandle): Promise<void> {
	await handler.next(frame => frame.type === "ready");
	handler.send({ id: "neg", type: "negotiate_protocol", protocolVersion: 3 });
	await expect(handler.next()).resolves.toMatchObject({ data: { protocolVersion: 3 } });
}

const isPermissionRequest = (frame: RpcFrame): boolean =>
	frame.type === "permission_request" && isRecord(frame) && typeof frame.id === "string";

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("rpc-ui approval E2E (4.1, live server)", () => {
	test("always-ask bash call raises permission_request; allow_once completes the turn", async () => {
		await using cwdDir = await TempDir.create("rpc-approval-cwd-");
		await using agentDir = await TempDir.create("rpc-approval-agent-");
		const handler = await spawnRpcServer(path.resolve(cwdDir.path()), path.resolve(agentDir.path()));
		try {
			await negotiate(handler);
			handler.send({ id: "am", type: "set_approval_mode", mode: "always-ask" });
			await expect(handler.next()).resolves.toMatchObject({
				command: "set_approval_mode",
				success: true,
				data: { approvalMode: "always-ask" },
			});

			handler.send({
				id: "p1",
				type: "prompt",
				message: "Use the bash tool to run exactly this command: echo rpc-e2e-ok. Do not run anything else.",
			});
			const request = await handler.next(isPermissionRequest);
			expect(request.toolName).toBe("bash");
			expect(request.approvalMode).toBe("always-ask");
			expect(request.tier).toBe("exec");
			expect((request.input as { command?: string }).command).toContain("echo rpc-e2e-ok");

			handler.send({ type: "permission_response", id: request.id, option: "allow_once" });
			const result = await handler.next(frame => frame.type === "prompt_result" && frame.id === "p1");
			expect(result).toMatchObject({ status: "completed" });
		} finally {
			await handler.dispose();
		}
	}, 300_000);

	test("allow_always persists across process restart: no further permission_request", async () => {
		await using cwdDir = await TempDir.create("rpc-allow-always-cwd-");
		await using agentDir = await TempDir.create("rpc-allow-always-agent-");
		const absCwd = path.resolve(cwdDir.path());
		const absAgent = path.resolve(agentDir.path());
		const runBashTurn = async (expectPermission: boolean) => {
			const handler = await spawnRpcServer(absCwd, absAgent);
			try {
				await negotiate(handler);
				handler.send({ id: "am", type: "set_approval_mode", mode: "always-ask" });
				await handler.next();
				handler.send({
					id: "p1",
					type: "prompt",
					message:
						"Use the bash tool to run exactly this command: echo allow-always-check. Do not run anything else.",
				});
				if (expectPermission) {
					const request = await handler.next(isPermissionRequest);
					handler.send({ type: "permission_response", id: request.id, option: "allow_always" });
				} else {
					// The tool must run without any permission_request; wait past the
					// point where the request would have arrived by racing the turn.
					const race = await Promise.race([
						handler.next(isPermissionRequest).then(frame => ({ kind: "permission" as const, frame })),
						handler
							.next(frame => frame.type === "prompt_result" && frame.id === "p1")
							.then(frame => ({ kind: "result" as const, frame })),
					]);
					expect(race.kind).toBe("result");
					expect(race.frame).toMatchObject({ status: "completed" });
					return;
				}
				const result = await handler.next(frame => frame.type === "prompt_result" && frame.id === "p1");
				expect(result).toMatchObject({ status: "completed" });
			} finally {
				await handler.dispose();
			}
		};

		await runBashTurn(true);
		// Same process family: allow_always is persisted via tools.approval.bash.
		await runBashTurn(false);
		// Fresh process: persistence must survive the restart (config hot reload).
		await runBashTurn(false);
	}, 600_000);
});

describe("rpc-ui project plan approval E2E (O15, local provider)", () => {
	test("actual xd://propose binds byte revisions and consumes approval exactly once", async () => {
		await using cwdDir = await TempDir.create("rpc-plan-project-cwd-");
		await using agentDir = await TempDir.create("rpc-plan-project-agent-");
		const cwd = path.resolve(cwdDir.path());
		const agentPath = path.resolve(agentDir.path());
		const requests: Record<string, unknown>[] = [];
		const modelId = "rpc-plan-audit";
		const originalPlan = "# RPC audit\n\nExecute the original draft.\n";
		const revisedPlan = "# RPC audit\n\nExecute the revised bytes exactly once.\n";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body: unknown = await request.json();
				if (!isRecord(body)) return new Response("Invalid model request", { status: 400 });
				requests.push(body);
				const turn = requests.length;
				const tools = Array.isArray(body.tools) ? body.tools : [];
				// Builtins travel under their native `_`-prefixed wire name
				// (`_write`); accept either so the check follows the request.
				const writeTool = tools.find(
					(tool): tool is Record<string, unknown> =>
						isRecord(tool) && (tool.name === "write" || tool.name === "_write"),
				);
				if (turn <= 2 && !writeTool) return new Response("Plan write tool was not enabled", { status: 400 });
				const writeWireName = writeTool ? (writeTool.name as string) : "write";
				const toolInput =
					turn === 1
						? { path: "local://rpc-audit-plan.md", content: originalPlan }
						: { path: "xd://propose", content: "rpc-audit" };
				const toolCall = turn <= 2;
				const block = toolCall
					? { type: "tool_use", id: `rpc_audit_tool_${turn}`, name: writeWireName, input: {} }
					: { type: "text", text: "" };
				const events = [
					{
						type: "message_start",
						message: {
							id: `rpc_audit_message_${turn}`,
							type: "message",
							role: "assistant",
							model: modelId,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 1, output_tokens: 0 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: block },
					{
						type: "content_block_delta",
						index: 0,
						delta: toolCall
							? { type: "input_json_delta", partial_json: JSON.stringify(toolInput) }
							: { type: "text_delta", text: turn === 3 ? "Plan ready for review." : "Approved plan executed." },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: toolCall ? "tool_use" : "end_turn", stop_sequence: null },
						usage: { output_tokens: 1 },
					},
					{ type: "message_stop" },
				];
				return new Response(
					events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		});
		const company = { baseUrl: "https://ignored.invalid", apiKey: "retain-company-fields" };
		const zcode = { baseUrl: "https://ignored-zcode.invalid", auth: "none", apiKey: "retain-zcode-key" };
		const modelsPath = path.join(agentPath, "models.yml");
		const settingsPath = path.join(agentPath, "config.yml");
		await fs.writeFile(
			settingsPath,
			JSON.stringify({
				skills: { enableClaudeUser: false, ignoredSkills: ["retained-name"] },
				auth: { broker: { token: "do-not-publish-raw-user-secret" } },
				theme: { dark: "titanium" },
			}),
		);
		await fs.writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					company,
					"zcode-api": zcode,
					"rpc-plan-audit": {
						api: "anthropic-messages",
						baseUrl: server.url.href,
						apiKey: "local-probe-only",
						models: [
							{
								id: modelId,
								name: "RPC plan audit",
								reasoning: false,
								input: ["text"],
								contextWindow: 32768,
								maxTokens: 256,
							},
							{
								id: "rpc-plan-secondary",
								name: "RPC secondary model",
								reasoning: false,
								input: ["text"],
								contextWindow: 32768,
								maxTokens: 256,
							},
						],
					},
				},
			}),
		);
		let handler: ServerHandle | undefined;
		try {
			handler = await spawnRpcServer(cwd, agentPath, {
				projectMode: true,
				provider: "rpc-plan-audit",
				model: modelId,
			});
			const ready = await handler.next(frame => frame.type === "ready");
			// Snapshot reused primitives before toMatchObject: bun's expect.any
			// matchers overwrite the asserted fields on the received object.
			const processStamp = { processInstanceId: ready.processInstanceId };
			expect(ready).toMatchObject({ mode: "rpc-ui-project", processInstanceId: expect.any(String) });
			const activeHandler = handler;
			const command = async (id: string, type: string, data: Record<string, unknown> = {}) => {
				activeHandler.send({ ...processStamp, ...data, id, type });
				return activeHandler.next(frame => frame.type === "response" && frame.id === id);
			};
			expect(await command("negotiate", "negotiate_protocol", { protocolVersion: 3 })).toMatchObject({
				success: true,
				data: { protocolVersion: 3 },
			});
			expect(
				await command("config", "upsert_provider", {
					provider: { name: "unrelated-config", baseUrl: "http://127.0.0.1", api: "anthropic-messages" },
				}),
			).toMatchObject({ success: true });
			const persistedModels = await readFixtureYaml(modelsPath);
			expect(persistedModels.providers.company).toEqual(company);
			expect(persistedModels.providers["zcode-api"]).toEqual(zcode);
			const initialSettings = await command("initial-settings", "get_settings", { scope: "user" });
			if (!isRecord(initialSettings.data) || !Array.isArray(initialSettings.data.entries)) {
				throw new Error("get_settings omitted field revisions");
			}
			expect(JSON.stringify(initialSettings.data)).not.toContain("do-not-publish-raw-user-secret");
			const entries = initialSettings.data.entries.filter(isRecord);
			const source = entries.find(entry => entry.key === "skills.enableClaudeUser");
			const ignored = entries.find(entry => entry.key === "skills.ignoredSkills");
			const theme = entries.find(entry => entry.key === "theme.dark");
			if (!source || !ignored || !theme) throw new Error("get_settings omitted registered user fields");
			const sourceRevision = source.revision;
			expect(source).toMatchObject({ userValue: false, revision: expect.any(String) });
			const externallyEdited = await readFixtureYaml(settingsPath);
			externallyEdited.skills.enableClaudeUser = true;
			await fs.writeFile(settingsPath, JSON.stringify(externallyEdited.raw));
			expect(
				await command("stale-source", "set_skill_source_enabled", {
					source: "claude:user",
					enabled: false,
					scope: "user",
					expectedRevision: sourceRevision,
				}),
			).toMatchObject({ success: false, code: "stale_revision" });
			expect((await readFixtureYaml(settingsPath)).skills.enableClaudeUser).toBe(true);
			expect(
				await command("ignore-name", "set_skill_ignored", {
					name: "audit-name",
					ignored: true,
					scope: "user",
					expectedRevision: ignored.revision,
				}),
			).toMatchObject({ success: true, data: { revision: expect.any(String) } });
			expect(
				await command("same-theme", "set_settings", {
					key: "theme.dark",
					value: "titanium",
					scope: "user",
					expectedRevision: theme.revision,
				}),
			).toMatchObject({ success: true, data: { userValue: "titanium", revision: expect.any(String) } });
			const changedSettings = await readFixtureYaml(settingsPath);
			expect(changedSettings.skills.enableClaudeUser).toBe(true);
			expect(changedSettings.skills.ignoredSkills).toEqual(["retained-name", "audit-name"]);
			const selector = `rpc-plan-audit/${modelId}`;
			const checkModelListed = async (id: string, expected: boolean): Promise<void> => {
				const listed = await command(id, "list_providers");
				if (!isRecord(listed.data) || !Array.isArray(listed.data.providers)) {
					throw new Error("list_providers omitted its model rows");
				}
				const provider = listed.data.providers.find(
					(row: unknown) => isRecord(row) && row.provider === "rpc-plan-audit",
				);
				if (!isRecord(provider) || !Array.isArray(provider.models)) throw new Error("Audit provider missing");
				expect(provider.models.some((model: unknown) => isRecord(model) && model.id === modelId)).toBe(expected);
			};
			const saveModelField = async (id: string, key: "enabledModels" | "disabledModels", value: string[]) => {
				const settings = await command(`${id}-settings`, "get_settings", { scope: "user" });
				if (!isRecord(settings.data) || !Array.isArray(settings.data.entries)) throw new Error("Settings missing");
				const entry = settings.data.entries.find((row: unknown) => isRecord(row) && row.key === key);
				if (!isRecord(entry)) throw new Error(`${key} user field missing`);
				expect(
					await command(id, "set_settings", {
						key,
						value,
						scope: "user",
						expectedRevision: entry.revision,
					}),
				).toMatchObject({ success: true, data: { revision: expect.any(String) } });
			};
			for (const [label, patterns] of [
				["last", [selector]],
				["wildcard", ["rpc-plan-audit/*"]],
				["all", []],
			] as const) {
				await saveModelField(`select-${label}`, "enabledModels", [...patterns]);
				expect(
					await command(`disable-${label}`, "set_model_enabled", {
						provider: "rpc-plan-audit",
						modelId,
						enabled: false,
					}),
				).toMatchObject({ success: true });
				const disabled = await readFixtureYaml(settingsPath);
				expect(disabled.enabledModels).toEqual([...patterns]);
				expect(disabled.disabledModels).toContain(selector);
				await checkModelListed(`disabled-rows-${label}`, false);
				expect(
					await command(`enable-${label}`, "set_model_enabled", {
						provider: "rpc-plan-audit",
						modelId,
						enabled: true,
					}),
				).toMatchObject({ success: true });
				const enabled = await readFixtureYaml(settingsPath);
				expect(enabled.enabledModels).toEqual([...patterns]);
				expect(enabled.disabledModels).not.toContain(selector);
				await checkModelListed(`enabled-rows-${label}`, true);
			}
			const secondarySelector = "rpc-plan-audit/rpc-plan-secondary";
			await saveModelField("restrict-to-secondary", "enabledModels", [secondarySelector]);
			expect(
				await command("disable-for-dual-enable", "set_model_enabled", {
					provider: "rpc-plan-audit",
					modelId,
					enabled: false,
				}),
			).toMatchObject({ success: true });
			expect(
				await command("dual-field-enable", "set_model_enabled", {
					provider: "rpc-plan-audit",
					modelId,
					enabled: true,
				}),
			).toMatchObject({
				success: true,
				data: {
					revisions: { enabledModels: expect.any(String), disabledModels: expect.any(String) },
				},
			});
			const dualEnabled = await readFixtureYaml(settingsPath);
			expect(dualEnabled.enabledModels).toEqual([secondarySelector, selector]);
			expect(dualEnabled.disabledModels).not.toContain(selector);
			await checkModelListed("dual-enabled-rows", true);
			await saveModelField("restore-all-models", "enabledModels", []);
			await saveModelField("broad-negative", "disabledModels", ["rpc-plan-audit/*"]);
			const beforeBroadEnable = await fs.readFile(settingsPath, "utf-8");
			expect(
				await command("enable-under-broad-negative", "set_model_enabled", {
					provider: "rpc-plan-audit",
					modelId,
					enabled: true,
				}),
			).toMatchObject({ success: false, code: "unsupported" });
			expect(await fs.readFile(settingsPath, "utf-8")).toBe(beforeBroadEnable);
			await saveModelField("restore-negative-models", "disabledModels", []);
			const created = await command("create", "create_session", { name: "RPC plan audit" });
			if (!isRecord(created.data)) throw new Error("create_session omitted its summary");
			const stamp = { sessionId: created.data.sessionId, sessionGeneration: created.data.sessionGeneration };
			expect(created).toMatchObject({
				success: true,
				data: { sessionId: expect.any(String), sessionGeneration: expect.any(String) },
			});
			expect(await command("plan-on", "set_plan_mode", { ...stamp, enabled: true })).toMatchObject({
				success: true,
			});
			expect(await command("no-proposal", "get_plan_state", stamp)).toMatchObject({
				success: true,
				data: { enabled: true, pendingApproval: false },
			});
			expect(await command("invalid-approval", "approve_plan", { ...stamp, decision: "approve" })).toMatchObject({
				success: false,
				code: "plan_not_pending",
			});
			expect(requests).toHaveLength(0);
			expect(
				await command("draft", "prompt", { ...stamp, message: "Draft and propose the RPC audit plan." }),
			).toMatchObject({ success: true });
			expect(await handler.next(frame => frame.type === "prompt_result" && frame.id === "draft")).toMatchObject({
				status: "completed",
			});
			// Draft takes 4 requests: write the plan, propose, a text-only wrap-up
			// turn, and the capped plan-mode decision reminder that wrap-up turn
			// provokes (upstream plan-mode convergence, not an extra proposal).
			expect(requests).toHaveLength(4);
			const pending = await command("pending", "get_plan_state", stamp);
			if (!isRecord(pending.data)) throw new Error("Plan approval state is missing");
			const pendingApprovalId = pending.data.approvalId;
			const pendingRevision = pending.data.revision;
			expect(pending).toMatchObject({
				success: true,
				data: {
					pendingApproval: true,
					approvalId: expect.any(String),
					revision: expect.any(String),
					planFilePath: "local://rpc-audit-plan.md",
				},
			});
			const listed = await command("waiting", "list_sessions");
			if (!isRecord(listed.data) || !Array.isArray(listed.data.sessions))
				throw new Error("Session directory is missing");
			expect(
				listed.data.sessions.find(summary => isRecord(summary) && summary.sessionId === stamp.sessionId),
			).toMatchObject({
				runState: "waiting_interaction",
			});
			const plan = await command("read-plan", "read_plan", { ...stamp, path: pending.data.planFilePath });
			if (!isRecord(plan.data) || typeof plan.data.path !== "string")
				throw new Error("read_plan omitted its local path");
			expect(path.isAbsolute(plan.data.path)).toBe(true);
			expect(plan.data.content).toBe(originalPlan);
			await fs.writeFile(plan.data.path, revisedPlan);
			expect(
				await command("stale", "approve_plan", {
					...stamp,
					decision: "approve",
					approvalId: pendingApprovalId,
					expectedRevision: pendingRevision,
				}),
			).toMatchObject({ success: false, code: "plan_approval_conflict" });
			expect(requests).toHaveLength(4);
			const refreshed = await command("refreshed", "get_plan_state", stamp);
			if (!isRecord(refreshed.data)) throw new Error("Refreshed approval state is missing");
			expect(refreshed.data.revision).not.toBe(pendingRevision);
			const approval = {
				...stamp,
				decision: "approve",
				approvalId: refreshed.data.approvalId,
				expectedRevision: refreshed.data.revision,
			};
			expect(await command("approve", "approve_plan", approval)).toMatchObject({
				success: true,
				data: { dispatched: true },
			});
			const duplicate = await command("duplicate", "approve_plan", approval);
			expect(duplicate.success).toBe(false);
			expect(["plan_not_pending", "plan_approval_conflict"]).toContain(String(duplicate.code));
			expect(await handler.next(frame => frame.type === "prompt_result" && frame.id === "approve")).toMatchObject({
				status: "completed",
			});
			expect(requests).toHaveLength(5);
			expect(JSON.stringify(requests[4]!.messages)).toContain("Execute the revised bytes exactly once.");
			expect(await command("consumed", "get_plan_state", stamp)).toMatchObject({
				success: true,
				data: { enabled: false, pendingApproval: false },
			});
		} finally {
			await handler?.dispose();
			server.stop(true);
		}
	}, 180_000);
});
