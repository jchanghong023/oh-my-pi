import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isValidJsonSchema, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { createZCodeAutomationTools, type ZCodeAutomationToolContext } from "../../src/modes/zcode/automation";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession, type CreateAgentSessionResult } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const automation = {
	automationId: "host-persisted-id",
	title: "Every 31 hours",
	cronExpr: "49 * * * *",
	prompt: "Write the report",
	enabled: true,
	lifecycleStatus: "active",
	runCount: 0,
	recurring: true,
	scheduleRule: { unit: "hourly", interval: 31, hour: 0, minute: 49, anchorAt: 1000 },
};
function fixture(automationTurn = false) {
	const requests: { method: string; params: unknown }[] = [];
	const context: ZCodeAutomationToolContext = {
		execution: () => ({
			sessionId: "actual-session",
			modelSelection: { providerId: "local", modelId: "actual-model" },
			automationTurn,
		}),
		request: async (method, params) => {
			requests.push({ method, params });
			if (method === "automation/checkTaskBinding") return { bound: false };
			if (method === "automation/list") return { automations: [automation] };
			if (method === "automation/delete") return { deleted: true };
			return { automation };
		},
	};
	const call = async (name: string, params: unknown, signal?: AbortSignal) => {
		const tool = createZCodeAutomationTools(context).find(tool => tool.name === name)!;
		return tool.execute("tool-call", params as never, undefined, {} as never, signal);
	};
	return { requests, call, context };
}

describe("Host-owned native automation tools", () => {
	test("accepts native schema consumers and rejects malformed inputs before Host effects", async () => {
		const f = fixture();
		const tools = createZCodeAutomationTools(f.context);
		const create = tools.find(tool => tool.name === "CronCreate");
		if (!create) throw new Error("Missing native automation tool");
		for (const tool of tools) expect(isValidJsonSchema(toolWireSchema(tool))).toBe(true);
		const valid = { delayMinutes: 5, title: "Later", prompt: "Work" };
		expect(
			validateToolArguments(create, {
				type: "toolCall",
				id: "valid",
				name: create.name,
				arguments: valid,
			}),
		).toEqual(valid);
		for (const invalid of [
			{ delayMinutes: 0, title: "Later", prompt: "Work" },
			{ delayMinutes: 1.5, title: "Later", prompt: "Work" },
			{ cron: "0 * * * *", title: "Later", prompt: "Work", interval: 201 },
		]) {
			expect(() =>
				validateToolArguments(create, {
					type: "toolCall",
					id: "invalid",
					name: create.name,
					arguments: invalid,
				}),
			).toThrow();
			await expect(f.call("CronCreate", invalid)).rejects.toThrow();
		}
		await expect(f.call("CronCreate", { ...valid, targetTaskId: "other" })).rejects.toThrow();
		await expect(f.call("CronList", { id: "unexpected" })).rejects.toThrow();
		await expect(f.call("CronDelete", {})).rejects.toThrow();
		expect(f.requests).toEqual([]);
		await expect(f.call("CronCreate", { delayMinutes: 5, title: "   ", prompt: "Work" })).rejects.toThrow();
		await f.call("CronCreate", { delayMinutes: 5, title: " Later ", prompt: " Work " });
		expect(f.requests.at(-1)?.params).toMatchObject({ title: "Later", prompt: "Work" });
	});
	test("declares approval tiers and returns actual Host identity and scheduleRule", async () => {
		const f = fixture();
		const tools = createZCodeAutomationTools(f.context);
		expect(tools.find(tool => tool.name === "CronCreate")?.approval).toBe("write");
		expect(tools.find(tool => tool.name === "CronList")?.approval).toBe("read");
		const result = await f.call("CronCreate", {
			cron: "49 * * * *",
			title: "Every 31 hours",
			prompt: "Write the report",
			intervalUnit: "hourly",
			interval: 31,
		});
		expect(f.requests.at(-1)).toEqual({
			method: "automation/create",
			params: {
				cronExpr: "49 * * * *",
				title: "Every 31 hours",
				prompt: "Write the report",
				recurring: true,
				intervalUnit: "hourly",
				interval: 31,
				targetTaskId: "actual-session",
				modelSelection: { providerId: "local", modelId: "actual-model" },
			},
		});
		expect(result.details).toMatchObject({
			automation: { automationId: "host-persisted-id", scheduleRule: automation.scheduleRule },
		});
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected structured automation text result");
		expect(JSON.parse(content.text)).toEqual(result.details);
	});
	test("leaves relative clock calculation entirely with Host", async () => {
		const f = fixture();
		await f.call("CronCreate", { delayMinutes: 5, title: "In five minutes", prompt: "Remind me" });
		expect(f.requests.at(-1)?.params).toMatchObject({
			cronExpr: "* * * * *",
			relativeDelayMinutes: 5,
			recurring: false,
		});
		expect(f.requests.at(-1)?.params).not.toHaveProperty("scheduleRule");
	});
	test("rejects scheduled mutations before any Host call", async () => {
		for (const name of ["CronCreate", "CronUpdate", "CronDelete"]) {
			const f = fixture(true);
			await expect(f.call(name, {})).rejects.toThrow("scheduled automation");
			expect(f.requests).toEqual([]);
		}
	});
	test("bound sessions and malformed Host receipts do not fabricate successful creation", async () => {
		const f = fixture();
		f.context.request = async () => ({ bound: true });
		await expect(f.call("CronCreate", { delayMinutes: 5, title: "Later", prompt: "Do work" })).rejects.toThrow(
			"already bound",
		);
		f.context.request = async method =>
			method === "automation/checkTaskBinding" ? { bound: false } : { automation: { automationId: "fake-only-id" } };
		await expect(f.call("CronCreate", { delayMinutes: 5, title: "Later", prompt: "Do work" })).rejects.toThrow();
	});
	test("rejects model-owned session targets and contradictory schedules", async () => {
		const f = fixture();
		for (const extra of [
			{ targetTaskId: "other" },
			{ modelSelection: {} },
			{ recurring: true },
			{ cron: "0 * * * *" },
			{ intervalUnit: "hourly", interval: 31 },
		]) {
			await expect(
				f.call("CronCreate", { delayMinutes: 5, title: "Later", prompt: "Do work", ...extra }),
			).rejects.toThrow();
		}
		expect(f.requests).toEqual([]);
	});
	test("binding failures and cancellation never dispatch creation", async () => {
		const f = fixture();
		f.context.request = async () => {
			throw new Error("Host unavailable");
		};
		await expect(f.call("CronCreate", { cron: "0 * * * *", title: "Hourly", prompt: "Do work" })).rejects.toThrow(
			"Host unavailable",
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			f.call("CronCreate", { delayMinutes: 5, title: "Later", prompt: "Do work" }, controller.signal),
		).rejects.toThrow();
		expect(f.requests).toEqual([]);
	});
	test("cancellation during binding cannot submit a late mutation", async () => {
		const f = fixture();
		const controller = new AbortController();
		f.context.request = async method => {
			f.requests.push({ method, params: {} });
			controller.abort();
			return { bound: false };
		};
		await expect(
			f.call("CronCreate", { delayMinutes: 5, title: "Later", prompt: "Do work" }, controller.signal),
		).rejects.toThrow();
		expect(f.requests.map(request => request.method)).toEqual(["automation/checkTaskBinding"]);
	});
	test("list/update/delete preserve actual Host results and interval carrier", async () => {
		const f = fixture();
		expect((await f.call("CronList", {})).details).toMatchObject({ automations: [automation] });
		await f.call("CronUpdate", {
			id: "host-persisted-id",
			title: "Every 31 hours",
			intervalUnit: "hourly",
			interval: 31,
		});
		expect(f.requests.at(-1)?.params).toMatchObject({
			automationId: "host-persisted-id",
			recurring: true,
			maxRuns: null,
			intervalUnit: "hourly",
			interval: 31,
		});
		expect((await f.call("CronDelete", { id: "host-persisted-id" })).details).toMatchObject({
			deleted: true,
			id: "host-persisted-id",
		});
	});
	test("native SDK registration preserves signals, Host effects and failures for every automation tool", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-zcode-automation-"));
		const authStorage = await AuthStorage.create(":memory:");
		let native: CreateAgentSessionResult | undefined;
		try {
			const f = fixture();
			const signals: Array<AbortSignal | undefined> = [];
			const request = f.context.request;
			f.context.request = async (method, params, signal) => {
				signals.push(signal);
				return request(method, params, signal);
			};
			const tools = createZCodeAutomationTools(f.context);
			native = await createAgentSession({
				cwd: root,
				agentDir: root,
				sessionManager: SessionManager.inMemory(root),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.yml")),
				settings: Settings.isolated({ "compaction.enabled": false }),
				model: getBundledModel("openai", "gpt-4o-mini"),
				bindProcessState: false,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: tools.map(tool => tool.name),
				customTools: tools,
				restrictToolNames: true,
				allowRestrictedCustomTools: true,
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "SubAgent",
			});
			const registered = native;
			const controller = new AbortController();
			const call = async (name: string, params: Record<string, unknown>) => {
				const tool = registered.session.getToolByName(name);
				if (!tool) throw new Error(`Missing SDK-registered automation tool: ${name}`);
				return tool.execute(
					"native-automation-call",
					params,
					controller.signal,
					() => {},
					registered.getToolContext(),
				);
			};
			expect((await call("CronCreate", { delayMinutes: 5, title: "Later", prompt: "Work" })).details).toMatchObject({
				automation: { automationId: automation.automationId },
			});
			expect((await call("CronList", {})).details).toMatchObject({ automations: [automation] });
			expect((await call("CronUpdate", { id: automation.automationId, title: "Updated" })).details).toMatchObject({
				automation: { automationId: automation.automationId },
			});
			expect((await call("CronDelete", { id: automation.automationId })).details).toMatchObject({ deleted: true });
			expect(f.requests.map(entry => entry.method)).toEqual([
				"automation/checkTaskBinding",
				"automation/create",
				"automation/list",
				"automation/update",
				"automation/delete",
			]);
			expect(signals).toHaveLength(5);
			expect(signals.every(signal => signal === controller.signal)).toBe(true);
			const hostFailure = new Error("Host denied automation");
			f.context.request = async () => {
				throw hostFailure;
			};
			await expect(call("CronDelete", { id: automation.automationId })).rejects.toThrow(hostFailure.message);
			f.context.request = async (method, params, signal) => {
				expect(signal).toBe(controller.signal);
				f.requests.push({ method, params });
				controller.abort();
				return { bound: false };
			};
			await expect(call("CronCreate", { delayMinutes: 5, title: "Later", prompt: "Work" })).rejects.toThrow();
			expect(f.requests.map(entry => entry.method)).toEqual([
				"automation/checkTaskBinding",
				"automation/create",
				"automation/list",
				"automation/update",
				"automation/delete",
				"automation/checkTaskBinding",
			]);
			await expect(call("CronDelete", { id: automation.automationId })).rejects.toThrow();
			expect(f.requests).toHaveLength(6);
		} finally {
			await native?.session.dispose();
			authStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
