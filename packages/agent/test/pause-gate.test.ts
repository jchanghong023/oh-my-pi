import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, agentLoop } from "@oh-my-pi/pi-agent-core";
import { AgentPauseGate, agentPauseGate } from "@oh-my-pi/pi-agent-core/pause";
import { SpeculativeOperationCoordinator } from "@oh-my-pi/pi-agent-core/speculative-execution";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeEchoTool(executed: string[]): AgentTool {
	const toolSchema = type({ msg: "string" });
	const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			executed.push(params.msg);
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return echoTool as AgentTool;
}

function makeConcurrentEchoTool(
	executed: string[],
	beforeExecute: (message: string) => void | Promise<void>,
): AgentTool {
	const toolSchema = type({ msg: "string" });
	const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		concurrency: "shared",
		async execute(_toolCallId, params) {
			await beforeExecute(params.msg);
			executed.push(params.msg);
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return echoTool as AgentTool;
}

const echoCall = (msg: string) => ({ type: "toolCall" as const, name: "echo", arguments: { msg } });
type LoopOptions = Omit<Partial<AgentLoopConfig>, "model" | "convertToLlm">;

function runLoop(mock: MockModel, tools: AgentTool[] = [], options: LoopOptions = {}, signal?: AbortSignal) {
	return agentLoop(
		[createUserMessage("hi")],
		{ systemPrompt: ["Test"], messages: [], tools },
		{ model: mock.model, convertToLlm: identityConverter, ...options },
		signal,
		mock.stream,
	).result();
}

function observeGateWait() {
	const parked = Promise.withResolvers<void>();
	const originalWait = agentPauseGate.waitUntilResumed;
	agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
		parked.resolve();
		return originalWait.call(agentPauseGate, signal);
	};
	return {
		parked: parked.promise,
		restore() {
			agentPauseGate.waitUntilResumed = originalWait;
		},
	};
}

function observePauseGate(expectedWaiters = 1) {
	const gate = new AgentPauseGate();
	const parked = Promise.withResolvers<void>();
	const waitUntilResumed = gate.waitUntilResumed.bind(gate);
	let waiters = 0;
	gate.waitUntilResumed = (signal?: AbortSignal) => {
		if (++waiters >= expectedWaiters) parked.resolve();
		return waitUntilResumed(signal);
	};
	return { gate, parked: parked.promise };
}

describe("agentPauseGate", () => {
	afterEach(() => {
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	it("holds the next model call while paused and releases it on resume", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		expect(agentPauseGate.pause()).toBe(true);
		expect(agentPauseGate.pause()).toBe(false); // already engaged

		const result = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream).result();
		await parked.promise;
		expect(mock.calls.length).toBe(0); // parked before the first provider call

		try {
			expect(agentPauseGate.resume()).toBeGreaterThanOrEqual(0);
			const messages = await result;
			expect(mock.calls.length).toBe(1);
			expect(messages[messages.length - 1].role).toBe("assistant");
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("holds tool execution at the tool boundary when paused mid-turn", async () => {
		const executed: string[] = [];
		// Signal exactly when the loop parks on the gate. A test-local manual
		// patch (not vi.spyOn) so a sibling file's restoreAllMocks cannot remove
		// it, and a gate regression that never parks hangs this await (test
		// timeout) instead of racing past a vacuous assertion.
		const toolBoundary = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			toolBoundary.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		const mock = createMockModel({
			responses: [
				() => {
					// Engage the gate while the model response is being produced: the
					// turn's tool batch must park before the tool starts.
					agentPauseGate.pause();
					return { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "frozen" } }] };
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [makeEchoTool(executed)] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		try {
			const result = agentLoop([createUserMessage("run echo")], context, config, undefined, mock.stream).result();
			await toolBoundary.promise;
			expect(executed).toEqual([]); // tool parked, not started
			expect(mock.calls.length).toBe(1); // and no follow-up model call either

			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["frozen"]);
			expect(mock.calls.length).toBe(2);
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("lets an external abort unwind a parked run without releasing the gate", async () => {
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const abortController = new AbortController();

		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		agentPauseGate.pause();
		const result = agentLoop(
			[createUserMessage("hi")],
			context,
			config,
			abortController.signal,
			mock.stream,
		).result();
		await parked.promise;
		abortController.abort("user interrupt");

		// The run must terminate as aborted promptly (not stay parked until
		// resume). The provider request itself carries the aborted signal, so
		// whether the transport is entered at all is an implementation detail.
		try {
			const messages = await result;
			const last = messages[messages.length - 1];
			expect(last.role).toBe("assistant");
			if (last.role === "assistant") {
				expect(last.stopReason).toBe("aborted");
			}
			expect(agentPauseGate.paused).toBe(true); // aborting one run never resumes the process
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("re-parks a waiter when the gate is re-engaged in the same tick as resume", async () => {
		agentPauseGate.pause();
		let released = false;
		const waiter = agentPauseGate.waitUntilResumed().then(() => {
			released = true;
		});

		agentPauseGate.resume();
		agentPauseGate.pause(); // re-engage before the waiter's microtask runs
		await Promise.resolve();
		expect(released).toBe(false);

		agentPauseGate.resume();
		await waiter;
		expect(released).toBe(true);
	});

	it("reports pause state transitions to onChange subscribers", () => {
		const transitions: boolean[] = [];
		const unsubscribe = agentPauseGate.onChange(paused => transitions.push(paused));
		agentPauseGate.pause();
		agentPauseGate.resume();
		unsubscribe();
		agentPauseGate.pause();
		agentPauseGate.resume();
		expect(transitions).toEqual([true, false]);
	});

	it("acknowledges a provider-boundary pause before executing a returned tool", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>(),
			resumed = Promise.withResolvers<void>();
		const transitions: boolean[] = [],
			executed: string[] = [];
		const mock = createMockModel({
			responses: [
				async () => {
					started.resolve();
					await release.promise;
					return { content: [echoCall("once")] };
				},
				{ content: ["done"] },
			],
		});
		const result = runLoop(mock, [makeEchoTool(executed)], {
			onPauseChange: value => {
				transitions.push(value);
				if (value) paused.resolve();
				else if (transitions.includes(true)) resumed.resolve();
			},
		});
		let finished = false;
		void result.then(() => {
			finished = true;
		});
		await started.promise;
		agentPauseGate.pause();
		release.resolve();
		await paused.promise;
		expect(executed).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		expect(finished).toBe(false);
		agentPauseGate.resume();
		await result;
		await resumed.promise;
		expect(executed).toEqual(["once"]);
		expect(transitions).toContain(true);
		expect(transitions.at(-1)).toBe(false);
	});

	it("waits for a running parallel tool before acknowledging and releasing the next", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>();
		const transitions: boolean[] = [],
			executed: string[] = [];
		const mock = createMockModel({
			responses: [{ content: [echoCall("first"), echoCall("second")] }, { content: ["done"] }],
		});
		const gateWait = observeGateWait();
		try {
			const result = runLoop(
				mock,
				[
					makeConcurrentEchoTool(executed, async msg => {
						if (msg === "first") {
							agentPauseGate.pause();
							started.resolve();
							await release.promise;
						}
					}),
				],
				{
					onPauseChange: value => {
						transitions.push(value);
						if (value) paused.resolve();
					},
				},
			);
			await started.promise;
			await gateWait.parked;
			expect(transitions).not.toContain(true);
			expect(executed).toEqual([]);
			release.resolve();
			await paused.promise;
			expect(transitions).toContain(true);
			expect(executed).toEqual(["first"]);
			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["first", "second"]);
			expect(mock.calls).toHaveLength(2);
		} finally {
			gateWait.restore();
		}
	});

	it("pauses after asynchronous beforeModelCall preparation and before the provider call", async () => {
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>(),
			mock = createMockModel({ responses: [{ content: ["done"] }] });
		const result = runLoop(mock, [], {
			beforeModelCall: async () => {
				entered.resolve();
				await release.promise;
			},
			onPauseChange: value => {
				if (value) paused.resolve();
			},
		});
		await entered.promise;
		agentPauseGate.pause();
		release.resolve();
		await paused.promise;
		expect(mock.calls).toHaveLength(0);
		agentPauseGate.resume();
		await result;
		expect(mock.calls).toHaveLength(1);
	});

	it("clears Agent pause acknowledgement on re-pause and abort", async () => {
		const gateWait = observeGateWait();
		try {
			const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
			const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
			agentPauseGate.pause();
			const prompt = agent.prompt("hi");
			await gateWait.parked;
			expect(agent.isPaused).toBe(true);
			expect(agent.state.isStreaming).toBe(true);
			agentPauseGate.resume();
			expect(agent.isPaused).toBe(false);
			agentPauseGate.pause();
			expect(agent.isPaused).toBe(true);
			await Promise.resolve();
			expect(agent.isPaused).toBe(true);
			agent.abort();
			expect(agent.isPaused).toBe(false);
			await prompt;
			expect(agent.state.isStreaming).toBe(false);
		} finally {
			gateWait.restore();
		}
	});
});

describe("explicit root pause gates", () => {
	it("parks a root and shared-gate descendant without freezing an independent root or ordinary default Agent", async () => {
		const { gate, parked } = observePauseGate(2);
		const rootModel = createMockModel({ responses: [{ content: ["root done"] }] });
		const childModel = createMockModel({ responses: [{ content: ["never sent"] }] });
		const siblingModel = createMockModel({ responses: [{ content: ["sibling done"] }] });
		const defaultModel = createMockModel({ responses: [{ content: ["ordinary done"] }] });
		const root = new Agent({ pauseGate: gate, initialState: { model: rootModel.model }, streamFn: rootModel.stream });
		const child = new Agent({
			pauseGate: gate,
			initialState: { model: childModel.model },
			streamFn: childModel.stream,
		});
		const sibling = new Agent({
			pauseGate: new AgentPauseGate(),
			initialState: { model: siblingModel.model },
			streamFn: siblingModel.stream,
		});
		const ordinary = new Agent({ initialState: { model: defaultModel.model }, streamFn: defaultModel.stream });
		const runs: Promise<unknown>[] = [];
		gate.pause();
		try {
			const rootRun = root.prompt("root");
			const childRun = child.prompt("descendant");
			runs.push(rootRun, childRun);
			await parked;
			expect(rootModel.calls).toHaveLength(0);
			expect(childModel.calls).toHaveLength(0);
			const siblingRun = sibling.prompt("independent root");
			const ordinaryRun = ordinary.prompt("ordinary singleton default");
			runs.push(siblingRun, ordinaryRun);
			await Promise.all([siblingRun, ordinaryRun]);
			expect(siblingModel.calls).toHaveLength(1);
			expect(defaultModel.calls).toHaveLength(1);
			expect(rootModel.calls).toHaveLength(0);
			child.abort();
			await childRun;
			expect(child.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
			expect(gate.paused).toBe(true);
			expect(rootModel.calls).toHaveLength(0);
			gate.resume();
			await rootRun;
			expect(rootModel.calls).toHaveLength(1);
		} finally {
			root.abort();
			child.abort();
			sibling.abort();
			ordinary.abort();
			gate.resume();
			await Promise.allSettled(runs);
		}
	});

	it("holds the paused root's physical tool boundary while another root finishes its tool and follow-up model", async () => {
		const gate = new AgentPauseGate();
		const paused = Promise.withResolvers<void>();
		const rootExecuted: string[] = [];
		const siblingExecuted: string[] = [];
		const rootModel = createMockModel({
			responses: [
				() => {
					gate.pause();
					return { content: [echoCall("root")] };
				},
				{ content: ["root done"] },
			],
		});
		const siblingModel = createMockModel({
			responses: [{ content: [echoCall("sibling")] }, { content: ["sibling done"] }],
		});
		const controller = new AbortController();
		const runs: Promise<unknown>[] = [];
		try {
			const rootRun = runLoop(
				rootModel,
				[makeEchoTool(rootExecuted)],
				{
					pauseGate: gate,
					onPauseChange: value => {
						if (value) paused.resolve();
					},
				},
				controller.signal,
			);
			runs.push(rootRun);
			await paused.promise;
			const siblingRun = runLoop(siblingModel, [makeEchoTool(siblingExecuted)], { pauseGate: new AgentPauseGate() });
			runs.push(siblingRun);
			await siblingRun;
			expect(siblingExecuted).toEqual(["sibling"]);
			expect(siblingModel.calls).toHaveLength(2);
			expect(rootExecuted).toEqual([]);
			expect(rootModel.calls).toHaveLength(1);
			gate.resume();
			await rootRun;
			expect(rootExecuted).toEqual(["root"]);
			expect(rootModel.calls).toHaveLength(2);
		} finally {
			controller.abort();
			gate.resume();
			await Promise.allSettled(runs);
		}
	});

	it("gates speculative physical file reads by root, and aborts only the parked candidate without executing it", async () => {
		using temp = TempDir.createSync("@pi-speculative-pause-");
		const file = temp.join("input.txt");
		await fs.writeFile(file, "real speculative file bytes");
		const { gate, parked } = observePauseGate(2);
		const abort = new AbortController();
		const executed: string[] = [];
		const schema = type({ path: "string", owner: "string" });
		const tool: AgentTool<typeof schema> = {
			name: "read",
			label: "Read",
			description: "Read a native file",
			parameters: schema,
			speculation: {
				finalized: {
					assess: ({ args }) => ({
						eligible: true,
						effect: {
							kind: "local_read",
							resources: [{ scheme: "file", path: String(args.path), access: "read" }],
						},
					}),
					async execute({ args }) {
						executed.push(String(args.owner));
						return {
							kind: "result",
							isError: false,
							result: {
								content: [{ type: "text", text: await fs.readFile(String(args.path), "utf8") }],
							},
						};
					},
				},
			},
			async execute(_id, args) {
				return { content: [{ type: "text", text: await fs.readFile(args.path, "utf8") }] };
			},
		};
		const model = createMockModel({ responses: [] }).model;
		const makeCoordinator = (pauseGate: AgentPauseGate, signal?: AbortSignal) =>
			new SpeculativeOperationCoordinator(
				{ enabled: true, host: { authorize: () => ({ allowed: true }) } },
				{
					context: { systemPrompt: [], messages: [], tools: [tool] },
					loopConfig: { model, convertToLlm: identityConverter, pauseGate },
					signal,
				},
			);
		const root = makeCoordinator(gate);
		const descendant = makeCoordinator(gate, abort.signal);
		const sibling = makeCoordinator(new AgentPauseGate());
		const idleSignals = [root, descendant, sibling].map(coordinator => {
			const idle = Promise.withResolvers<void>();
			coordinator.onIdle = () => idle.resolve();
			return { coordinator, idle: idle.promise };
		});
		const admit = (coordinator: SpeculativeOperationCoordinator, owner: string) =>
			coordinator.admit({
				candidateId: owner,
				parentToolCallId: "streaming-parent",
				dependencies: [],
				tool,
				source: "eval_shadow",
				toolCall: { type: "toolCall", id: `${owner}-read`, name: "read", arguments: { path: file, owner } },
			});
		gate.pause();
		try {
			const rootRead = await admit(root, "root");
			const childRead = await admit(descendant, "descendant");
			if (!rootRead || !childRead) throw new Error("Native speculative reads were not admitted");
			await Promise.all([root.finalizeAdmissions(), descendant.finalizeAdmissions()]);
			await Promise.race([
				parked,
				rootRead.outcome.then(() => {
					throw new Error("Root speculative read completed before reaching its pause gate");
				}),
				childRead.outcome.then(() => {
					throw new Error("Descendant speculative read completed before reaching its pause gate");
				}),
			]);
			const siblingRead = await admit(sibling, "sibling");
			if (!siblingRead) throw new Error("Sibling speculative read was not admitted");
			await sibling.finalizeAdmissions();
			const result = await siblingRead.outcome;
			expect(result.result.content).toEqual([{ type: "text", text: "real speculative file bytes" }]);
			expect(executed).toEqual(["sibling"]);
			abort.abort(new Error("Descendant aborted"));
			await expect(childRead.outcome).rejects.toThrow("Descendant aborted");
			expect(gate.paused).toBe(true);
			expect(executed).toEqual(["sibling"]);
			gate.resume();
			expect((await rootRead.outcome).result.content).toEqual([
				{ type: "text", text: "real speculative file bytes" },
			]);
			expect(executed).toEqual(["sibling", "root"]);
		} finally {
			abort.abort();
			gate.resume();
			await Promise.all([
				root.close("test cleanup"),
				descendant.close("test cleanup"),
				sibling.close("test cleanup"),
			]);
			await Promise.all(
				idleSignals.map(({ coordinator, idle }) => (coordinator.isRunning ? idle : Promise.resolve())),
			);
		}
	});
});
