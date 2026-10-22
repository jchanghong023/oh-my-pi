import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ToolRestrictions } from "../../src/session/tool-restrictions";
import { Settings } from "../../src/config/settings";
import { createXdevState, resolveBuiltinToolPlan, type Tool, type ToolSession } from "../../src/tools";
import { dispatchXdevTool, listXdevTools } from "../../src/tools/xdev";

function counterTool(name: string, run: () => void): Tool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		async execute() {
			run();
			return { content: [{ type: "text", text: "executed" }], details: {} };
		},
	};
}

describe("caller tool admission restrictions", () => {
	it("preserves real callable schemas, provider declarations and private method context while enforcing admission", async () => {
		class StatefulTool {
			name = "schema_counter";
			label = "Schema counter";
			description = "Accumulate a validated amount";
			parameters = type({ amount: "number" });
			#total = 0;

			get total(): number {
				return this.#total;
			}

			currentTotal(): number {
				return this.#total;
			}

			async execute(_id: string, params: { amount: number }) {
				this.#total += this.parameters.assert(params).amount;
				return { content: [{ type: "text" as const, text: String(this.#total) }], details: { total: this.#total } };
			}
		}

		const original = new StatefulTool();
		const policy = new ToolRestrictions({ allowlist: [original.name] });
		const wrapped = policy.wrap(original);
		expect(wrapped.parameters).toBe(original.parameters);
		expect(wrapped.parameters.assert).toBe(original.parameters.assert);
		expect(wrapped.parameters.toJsonSchema).toBe(original.parameters.toJsonSchema);
		expect(wrapped.parameters({ amount: 3 })).toEqual({ amount: 3 });
		expect(() => wrapped.parameters.assert({ amount: "invalid" })).toThrow();
		const model = buildModel({
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});
		expect(convertTools([wrapped], true, model)).toMatchObject([
			{
				type: "function",
				name: original.name,
				parameters: {
					type: "object",
					properties: { amount: { type: "number" } },
					required: ["amount"],
				},
			},
		]);

		const execute = wrapped.execute;
		await expect(execute("allowed", { amount: 3 })).resolves.toMatchObject({ details: { total: 3 } });
		const currentTotal = wrapped.currentTotal;
		expect(currentTotal()).toBe(3);
		expect(wrapped.total).toBe(3);
		const release = policy.beginInput([original.name]);
		try {
			await expect(execute("denied", { amount: 7 })).rejects.toThrow("denied");
			expect(original.total).toBe(3);
		} finally {
			release();
		}
		await expect(execute("restored", { amount: 2 })).resolves.toMatchObject({ details: { total: 5 } });
		expect(original.parameters).toBe(wrapped.parameters);
	});

	it("never widens an explicit caller allowlist with convenience tools", async () => {
		const policy = new ToolRestrictions({ allowlist: ["read", "checkpoint"] });
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({ "checkpoint.enabled": true }),
			skipPythonPreflight: true,
			toolRestrictions: policy,
		} as ToolSession;
		const plan = await resolveBuiltinToolPlan(session, ["read", "checkpoint"]);
		expect(plan.names).toEqual(["read", "checkpoint"]);
	});

	it("does not contaminate a tool instance shared by two sessions or child snapshots", async () => {
		let calls = 0;
		const shared = counterTool("read", () => calls++);
		const parent = new ToolRestrictions();
		const release = parent.beginInput(["read"]);
		const child = new ToolRestrictions(parent.snapshot());
		const peer = new ToolRestrictions();
		await expect(parent.wrap(shared).execute("parent", {})).rejects.toThrow("denied");
		await peer.wrap(shared).execute("peer", {});
		release();
		await parent.wrap(shared).execute("later", {});
		await expect(child.wrap(shared).execute("child", {})).rejects.toThrow("denied");
		expect(calls).toBe(2);
	});

	it("isolates concurrent asynchronous inputs and replaces only the promoted input", async () => {
		const policy = new ToolRestrictions({ denylist: ["edit"] });
		const { promise: barrier, resolve: resume } = Promise.withResolvers<void>();
		const first = policy.runInput(["bash"], async () => {
			await barrier;
			expect(policy.allows("bash")).toBe(false);
			expect(policy.allows("write")).toBe(true);
			policy.replaceCurrentInput(["read"]);
			expect(policy.allows("bash")).toBe(true);
			expect(policy.allows("read")).toBe(false);
			expect(policy.allows("edit")).toBe(false);
			return new ToolRestrictions(policy.snapshot());
		});
		const second = policy.runInput(["write"], async () => {
			expect(policy.allows("bash")).toBe(true);
			expect(policy.allows("write")).toBe(false);
			resume();
			await first;
			expect(policy.allows("read")).toBe(true);
			expect(policy.allows("write")).toBe(false);
		});
		const child = await first;
		await second;
		expect(policy.allows("read")).toBe(true);
		expect(policy.allows("write")).toBe(true);
		expect(child.allows("read")).toBe(false);
		expect(() => policy.replaceCurrentInput(["read"])).toThrow("active input scope");
	});

	it("enforces alias-normalized deny precedence before side effects", async () => {
		let calls = 0;
		const policy = new ToolRestrictions({ allowlist: ["search", "read"], denylist: ["GREP"] });
		const denied = policy.wrap(counterTool("grep", () => calls++));
		expect(policy.filter([denied, counterTool("read", () => {})]).map(tool => tool.name)).toEqual(["read"]);
		await expect(denied.execute("denied", {})).rejects.toThrow("denied");
		expect(policy.allows("search")).toBe(false);
		expect(policy.allows("xd://grep")).toBe(false);
		expect(calls).toBe(0);
	});

	it("executes allowed tools and isolates other sessions and subsequent inputs", async () => {
		let calls = 0;
		const policy = new ToolRestrictions();
		const other = new ToolRestrictions();
		const tool = policy.wrap(counterTool("extension_tool", () => calls++));
		const release = policy.beginInput(["extension_tool"]);
		await expect(tool.execute("blocked", {})).rejects.toThrow("denied");
		await other.wrap(counterTool("extension_tool", () => calls++)).execute("other", {});
		release();
		release();
		await tool.execute("next", {});
		expect(calls).toBe(2);
	});

	it("releasing or cancelling one input never clears another input policy", () => {
		const policy = new ToolRestrictions();
		const controller = new AbortController();
		const first = policy.beginInput(["bash"], controller.signal);
		const second = policy.beginInput(["write"]);
		controller.abort();
		expect(policy.allows("bash")).toBe(true);
		expect(policy.allows("write")).toBe(false);
		first();
		expect(policy.allows("write")).toBe(false);
		second();
		expect(policy.allows("write")).toBe(true);
	});

	it("rejects expired input admission without changing policy", () => {
		const policy = new ToolRestrictions({ denylist: ["bash"] });
		const controller = new AbortController();
		controller.abort();
		expect(() => policy.beginInput(["read"], controller.signal)).toThrow();
		expect(policy.allows("read")).toBe(true);
		expect(policy.allows("bash")).toBe(false);
	});

	it("does not grant tools outside explicit allowlists including MCP names", async () => {
		let calls = 0;
		const policy = new ToolRestrictions({ allowlist: ["read", "mcp__local_lookup"] });
		expect(policy.allows("wiki")).toBe(false);
		expect(policy.allows("repo")).toBe(false);
		expect(policy.allows("write")).toBe(false);
		expect(new ToolRestrictions({ allowlist: [] }).allows("read")).toBe(false);
		await policy.wrap(counterTool("mcp__local_lookup", () => calls++)).execute("allowed", {});
		await expect(policy.wrap(counterTool("mcp__local_delete", () => calls++)).execute("denied", {})).rejects.toThrow(
			"denied",
		);
		expect(calls).toBe(1);
	});

	it("denies mounted-device discovery and previously captured execution handles", async () => {
		let calls = 0;
		const policy = new ToolRestrictions();
		const tool = policy.wrap(counterTool("mcp__local_delete", () => calls++));
		const session = { toolRestrictions: policy, isToolActive: () => true } as unknown as ToolSession;
		const state = createXdevState(session, new Map([[tool.name, tool]]), new Set(), new Set([tool.name]));
		expect(state.resolve?.(tool.name)).toBe(tool);
		const release = policy.beginInput([tool.name]);
		expect(state.resolve?.(tool.name)).toBeUndefined();
		await expect(tool.execute("captured", {})).rejects.toThrow("denied");
		expect(calls).toBe(0);
		expect(listXdevTools(state)).toEqual([]);
		const denied = await dispatchXdevTool(state, tool.name, "{}", "xd-denied");
		expect(denied.result.isError).toBe(true);
		release();
		await tool.execute("restored", {});
		expect(calls).toBe(1);
	});
});
