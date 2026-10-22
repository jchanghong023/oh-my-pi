import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { ModelRegistry } from "../../src/config/model-registry";
import { AuthStorage } from "../../src/session/auth-storage";
import { ZCodeSessionManager } from "../../src/modes/zcode/sessions";
import { makeOmpWorkflowDriver, type OmpWorkflowDriver } from "../../src/modes/zcode/workflows/driver";
import { createOmpWorkflowWorld } from "../../src/modes/zcode/workflows/world";
import {
	InMemoryJournalStore,
	WorkflowEngine,
	type WorkflowReportSink,
} from "../../src/modes/zcode/workflows/vendor/dynamic-workflow/index";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { cfgToolsApproval } from "../../src/tools/settings";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

const modelRequestSchema = z
	.object({
		model: z.string(),
		messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()),
		tools: z
			.array(
				z
					.object({
						function: z
							.object({
								name: z.string(),
								parameters: z
									.object({
										type: z.string().optional(),
										properties: z.record(z.string(), z.unknown()).optional(),
									})
									.passthrough(),
							})
							.passthrough(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();
type ModelRequest = z.infer<typeof modelRequestSchema>;
async function fixture(
	reply?: (request: ModelRequest) => { text?: string; result?: unknown; hold?: boolean },
	toolNames: string[] = [],
) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-driver-"));
	cleanup.push(() => fs.rm(cwd, { recursive: true, force: true }));
	cleanup.push(async () => {
		HistoryStorage.close();
		closeSessionIndex();
		AgentStorage.close();
		closeModelCache();
	});
	const requests: ModelRequest[] = [];
	const held = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<void>();
	const endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/chat/completions")
				return new Response("Unexpected access", { status: 500 });
			const parsed = modelRequestSchema.safeParse(await request.json());
			if (!parsed.success) return new Response("Invalid model request", { status: 400 });
			const body = parsed.data;
			requests.push(body);
			const response = reply?.(body) ?? { text: "native actor response" };
			const typed = "result" in response;
			const submit = typed ? body.tools?.find(tool => tool.function.name === "submit_result") : undefined;
			if (
				typed &&
				(!submit ||
					submit.function.parameters.type !== "object" ||
					!submit.function.parameters.properties ||
					!("result" in submit.function.parameters.properties))
			) {
				return new Response("The typed result tool was not declared", { status: 400 });
			}
			const delta = typed
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `submit-${requests.length}`,
								type: "function",
								function: {
									name: submit!.function.name,
									arguments: JSON.stringify({ result: response.result }),
								},
							},
						],
					}
				: { role: "assistant", content: response.text };
			const chunk = (data: unknown, finish: string | null) =>
				`data: ${JSON.stringify({
					id: "workflow-local",
					object: "chat.completion.chunk",
					created: 1,
					model: body.model,
					choices: [{ index: 0, delta: data, finish_reason: finish }],
				})}\n\n`;
			if (response.hold) {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant", content: "waiting" }, null)));
						held.resolve();
					},
					cancel() {
						cancelled.resolve();
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			}
			return new Response(chunk(delta, null) + chunk({}, typed ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	cleanup.push(async () => endpoint.stop(true));
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir);
	const models = path.join(agentDir, "models.yml");
	await fs.writeFile(
		models,
		`providers:\n  workflow-local:\n    baseUrl: http://127.0.0.1:${endpoint.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: selected\n        reasoning: false\n`,
	);
	const authStorage = await AuthStorage.create(":memory:");
	cleanup.push(async () => authStorage.close());
	const registry = new ModelRegistry(authStorage, models);
	const model = registry.find("workflow-local", "selected");
	if (!model) throw new Error("Local workflow model was not loaded");
	const sessions = new ZCodeSessionManager({
		cwd,
		agentDir,
		sessionOptions: {
			model,
			authStorage,
			modelRegistry: registry,
			toolNames,
			restrictToolNames: true,
			skills: [],
			extensions: [],
			disableExtensionDiscovery: true,
		},
	});
	cleanup.push(() => sessions.dispose());
	const parent = await sessions.create();
	return { cwd, parent, sessions, requests, held: held.promise, cancelled: cancelled.promise };
}

function unusedSink(): WorkflowReportSink {
	const unexpected = () => {
		throw new Error("No ask should be dispatched");
	};
	return {
		askSubmitAttempted: unexpected,
		askTurnEnded: unexpected,
		askProgress: unexpected,
		askStats: unexpected,
		askFailed: unexpected,
		stopRun: unexpected,
		runStalled: unexpected,
		askWaiting: unexpected,
		askExecuting: unexpected,
		askMutating: unexpected,
		concurrencyChanged: unexpected,
	};
}

describe("OMP workflow native driver", () => {
	it("settles a constant through the real engine without any actor or model request", async () => {
		const { parent, sessions, requests } = await fixture();
		const journal = new InMemoryJournalStore();
		const driver = makeOmpWorkflowDriver(parent, unusedSink(), journal, {
			runId: "constant",
			sessions,
			emit: () => {},
		});
		const engine = new WorkflowEngine({
			runId: "constant",
			driver,
			caps: { maxConcurrency: 2 },
			askSpecs: new Map(),
			validate: () => {
				throw new Error("A constant has no schema validation");
			},
		});
		engine.complete({ answer: 42 });
		expect(await engine.settled).toEqual({ status: "completed", artifact: { answer: 42 } });
		await driver.closed;
		expect(journal.listActors("constant", { withPersona: false })).toEqual([]);
		expect(requests).toEqual([]);
		expect(parent.session.isDisposed).toBe(false);
	});

	it("returns actual process output and nonzero exit status as a world.run value", async () => {
		const { parent } = await fixture(undefined, ["bash"]);
		const world = createOmpWorkflowWorld(parent);
		const result = await world.read("run", [
			process.execPath,
			["-e", "process.stdout.write('real-output'); process.stderr.write('real-error'); process.exit(7)"],
		]);
		expect(result).toEqual({ exitCode: 7, stdout: "real-output", stderr: "real-error" });
	});

	it("rejects native denied world effects before creating files or reading artifact sources", async () => {
		const { parent, cwd } = await fixture(undefined, ["bash", "read"]);
		cfgToolsApproval.override(parent.settings, { bash: "deny", read: "deny" });
		const world = createOmpWorkflowWorld(parent);
		const target = path.join(cwd, "must-not-exist.txt");
		await expect(
			world.read("run", [
				process.execPath,
				["-e", `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'unexpected')`],
			]),
		).rejects.toThrow();
		await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
		await fs.writeFile(path.join(cwd, "source.bin"), Buffer.from([0, 255]));
		await expect(world.read("read", ["source.bin"])).rejects.toThrow();
		await expect(
			world.publish({
				runId: "denied",
				siteId: "s",
				ordinal: 1,
				op: "file",
				id: "source",
				version: 1,
				path: "source.bin",
			}),
		).rejects.toThrow();
		expect(parent.session.isDisposed).toBe(false);
	});

	it("does not allocate actors for world-only work and disposal never closes the parent", async () => {
		const { parent, sessions, cwd } = await fixture(undefined, ["read"]);
		await fs.writeFile(path.join(cwd, "result.txt"), "actual bytes\n");
		const driver = makeOmpWorkflowDriver(parent, unusedSink(), new InMemoryJournalStore(), {
			runId: "read-only",
			sessions,
			emit: () => {},
		});
		expect(await driver.executeWorldRead("read", ["result.txt"])).toBe("actual bytes\n");
		driver.dispose();
		await driver.closed;
		expect(sessions.get(parent.id)).toBe(parent);
		expect(parent.session.isDisposed).toBe(false);
	});

	it("constructs distinct SDK actor contexts and closes only actors it owns", async () => {
		const { parent, sessions } = await fixture();
		const driver = makeOmpWorkflowDriver(parent, unusedSink(), new InMemoryJournalStore(), {
			runId: "actors",
			sessions,
			emit: () => {},
		});
		const [a, b] = await Promise.all([
			driver.createActorSession({ siteId: "a", ordinal: 1 }, { name: "A" }),
			driver.createActorSession({ siteId: "b", ordinal: 1 }, { name: "B" }),
		]);
		const left = sessions.get(a.id)!;
		const right = sessions.get(b.id)!;
		expect(left.session).not.toBe(right.session);
		expect(left.settings).not.toBe(right.settings);
		expect(left.registry).not.toBe(right.registry);
		expect(left.settings).not.toBe(parent.settings);
		expect(left.cwd).toBe(parent.cwd);
		driver.dispose();
		await driver.closed;
		expect(sessions.get(a.id)).toBeUndefined();
		expect(sessions.get(b.id)).toBeUndefined();
		expect(parent.session.isDisposed).toBe(false);
	});

	it("publishes real markdown and binary artifacts through the native session owner", async () => {
		const { parent, cwd } = await fixture(undefined, ["read"]);
		const world = createOmpWorkflowWorld(parent);
		const markdown = await world.publish({
			runId: "r",
			siteId: "s",
			ordinal: 1,
			op: "markdown",
			id: "report",
			version: 1,
			content: "# Actual result\n",
		});
		const artifactId = markdown.uri!.slice("artifact://".length);
		const target = await parent.session.sessionManager.getArtifactPath(artifactId);
		expect(await fs.readFile(target!, "utf8")).toBe("# Actual result\n");
		const bytes = Buffer.from([0, 255, 1, 128]);
		await fs.writeFile(path.join(cwd, "data.bin"), bytes);
		const binary = await world.publish({
			runId: "r",
			siteId: "s",
			ordinal: 2,
			op: "file",
			id: "binary",
			version: 1,
			path: "data.bin",
		});
		const binaryPath = await parent.session.sessionManager.getArtifactPath(binary.uri!.slice("artifact://".length));
		expect(await fs.readFile(binaryPath!)).toEqual(bytes);
		expect(binary.bytes).toBe(bytes.length);
		await expect(world.read("read", ["../outside"])).rejects.toThrow();
		await expect(
			world.publish({
				runId: "r",
				siteId: "s",
				ordinal: 3,
				op: "file",
				id: "outside",
				version: 1,
				path: "../outside",
			}),
		).rejects.toThrow();
	});

	it("executes an untyped ask with the selected SDK model and returns its actual text", async () => {
		const { parent, sessions, requests } = await fixture();
		const done = Promise.withResolvers<string>();
		const sink = {
			...unusedSink(),
			askExecuting: () => {},
			askProgress: () => {},
			askStats: () => {},
			askTurnEnded: (_instance: unknown, text: string) => done.resolve(text),
			askFailed: (_instance: unknown, error: Error) => done.reject(error),
		};
		const driver = makeOmpWorkflowDriver(parent, sink, new InMemoryJournalStore(), {
			runId: "actual-ask",
			sessions,
			emit: () => {},
		});
		const actor = await driver.createActorSession({ siteId: "actor", ordinal: 1 }, { name: "reader" });
		driver.startAsk(actor, { siteId: "ask", ordinal: 1 }, { typed: false, instructions: "Read this actual ask" });
		expect(await done.promise).toBe("native actor response");
		expect(requests.length).toBe(1);
		expect(requests[0]!.model).toBe("selected");
		expect(JSON.stringify(requests[0]!.messages)).toContain("Read this actual ask");
		expect(parent.session.messages).toHaveLength(0);
		driver.dispose();
		await driver.closed;
	});

	it("passes typed submissions to engine validation and delivers a real rejection for repair", async () => {
		let submitted = 0;
		const { parent, sessions, requests } = await fixture(() => ({
			result: ++submitted === 1 ? { count: "bad" } : { count: 2 },
		}));
		const done = Promise.withResolvers<unknown>();
		const sink: WorkflowReportSink = {
			...unusedSink(),
			askExecuting: () => {},
			askProgress: () => {},
			askStats: () => {},
			askSubmitAttempted: (instance, result) => {
				if (submitted === 1)
					driver.respondToSubmit(instance, {
						kind: "reject",
						violations: [{ path: "$.count", expected: "number", got: "string" }],
					});
				else {
					driver.respondToSubmit(instance, { kind: "accept" });
					done.resolve(result);
				}
			},
			askFailed: (_instance, error) => done.reject(error),
		};
		const driver: OmpWorkflowDriver = makeOmpWorkflowDriver(parent, sink, new InMemoryJournalStore(), {
			runId: "typed-ask",
			sessions,
			emit: () => {},
		});
		cleanup.push(async () => {
			driver.dispose();
			await driver.closed;
		});
		const actor = await driver.createActorSession({ siteId: "actor", ordinal: 1 }, { name: "typed" });
		const toolResults: Array<{ isError: boolean; text: string }> = [];
		const submitToolResultSchema = z.object({
			content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
		});
		const unsubscribe = sessions.get(actor.id)!.session.subscribe(event => {
			if (event.type === "tool_execution_end" && event.toolName === "submit_result") {
				const result = submitToolResultSchema.parse(event.result);
				toolResults.push({
					isError: event.isError === true,
					text: result.content.map(block => block.text).join("\n"),
				});
			}
		});
		cleanup.push(async () => unsubscribe());
		driver.startAsk(
			actor,
			{ siteId: "ask", ordinal: 1 },
			{
				typed: true,
				instructions: "Return count",
				schema: { type: "object", properties: { count: { type: "number" } } },
			},
		);
		expect(await done.promise).toEqual({ count: 2 });
		expect(requests[0]!.tools?.some(tool => tool.function.name === "submit_result")).toBe(true);
		expect(JSON.stringify(requests[1]!.messages)).toContain("$.count");
		expect(parent.session.messages).toHaveLength(0);
		driver.dispose();
		await driver.closed;
		expect(requests).toHaveLength(2);
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0]).toMatchObject({ isError: true });
		expect(toolResults[0]!.text).toContain("$.count");
		expect(toolResults[1]).toEqual({ isError: false, text: "Result accepted." });
		expect(sessions.get(actor.id)).toBeUndefined();
		expect(parent.session.isDisposed).toBe(false);
	});

	it("cancels the real HTTP ask without stopping another actor or its parent", async () => {
		const { parent, sessions, held, cancelled } = await fixture(request =>
			JSON.stringify(request.messages).includes("HOLD_WORKFLOW") ? { hold: true } : { text: "other actor finished" },
		);
		const done = Promise.withResolvers<string>();
		const sink: WorkflowReportSink = {
			...unusedSink(),
			askExecuting: () => {},
			askProgress: () => {},
			askStats: () => {},
			askTurnEnded: (_instance, text) => done.resolve(text),
			askFailed: (_instance, error) => done.reject(error),
		};
		const driver = makeOmpWorkflowDriver(parent, sink, new InMemoryJournalStore(), {
			runId: "cancel-ask",
			sessions,
			emit: () => {},
		});
		const [left, right] = await Promise.all([
			driver.createActorSession({ siteId: "left", ordinal: 1 }, {}),
			driver.createActorSession({ siteId: "right", ordinal: 1 }, {}),
		]);
		const instance = { siteId: "held", ordinal: 1 };
		driver.startAsk(left, instance, { typed: false, instructions: "HOLD_WORKFLOW" });
		await held;
		driver.startAsk(right, { siteId: "other", ordinal: 1 }, { typed: false, instructions: "Finish independently" });
		driver.cancelAsk(instance);
		await cancelled;
		expect(await done.promise).toBe("other actor finished");
		expect(sessions.get(right.id)!.session.isDisposed).toBe(false);
		expect(parent.session.isDisposed).toBe(false);
		driver.dispose();
		await driver.closed;
	});
});
