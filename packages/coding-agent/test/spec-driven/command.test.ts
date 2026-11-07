import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import {
	BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS,
	handleDevCommand,
	type DevLaunchContext,
} from "../../src/slash-commands/builtin-spec-driven";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "../../src/slash-commands/builtin-registry";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dev-launch-command-"));
	const auth = createInMemoryAuthStorage();
	const settings = Settings.isolated();
	const registry = new ModelRegistry(auth, path.join(cwd, "isolated-models.yml"), { settings });
	const model = getBundledModel("deepseek", "deepseek-v4-flash");
	if (!model) throw new Error("Expected bundled model metadata");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["ordinary root session"], tools: [] } }),
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		modelRegistry: registry,
	});
	const output: string[] = [];
	const context: DevLaunchContext = {
		session,
		settings,
		cwd,
		output: text => {
			output.push(text);
		},
	};
	return {
		cwd,
		session,
		output,
		context,
		invoke: (args: string, text = args ? `/dev ${args}` : "/dev") =>
			handleDevCommand({ name: "dev", args, text }, context),
		async [Symbol.asyncDispose]() {
			await session.dispose();
			await registry.awaitBackgroundRefresh();
			auth.close();
			await fs.rm(cwd, { recursive: true, force: true });
		},
	};
}

describe("/dev exclusive native entry rejects retired terminal routing", () => {
	test("registers ordinary commands and routes Dev through the native exclusive entry under this module load order", async () => {
		await using f = await fixture();
		expect(BUILTIN_SLASH_COMMAND_DEFS.filter(command => command.name === "dev")).toHaveLength(1);
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("dev")).toBe(true);
		expect(lookupBuiltinSlashCommand("dev")?.allowArgs).toBe(true);
		let text = "/context";
		let contextReports = 0;
		let entryChecks = 0;
		const shutdowns = new Set<() => Promise<void>>();
		const editor = {
			getExpandedText: () => text,
			setText: (value: string) => {
				text = value;
			},
			setCollapsedText: (value: string) => {
				text = value;
			},
			pendingImages: [],
			pendingImageLinks: [],
			disableSubmit: false,
		};
		const ctx = {
			session: f.session,
			sessionManager: f.session.sessionManager,
			settings: f.context.settings,
			editor,
			handleContextCommand: () => {
				contextReports++;
			},
			showStatus: (value: string) => {
				f.output.push(value);
			},
			registerHostShutdown: (dispose: () => Promise<void>) => {
				shutdowns.add(dispose);
				return () => shutdowns.delete(dispose);
			},
			getDevWorkbenchEntryBlocker: () => {
				entryChecks++;
				return "An ordinary native operation is still active";
			},
		} as unknown as InteractiveModeContext;

		expect(await executeBuiltinSlashCommand("/context", { ctx })).toBe(true);
		expect(contextReports).toBe(1);
		expect(text).toBe("");
		text = "/dev next";
		expect(await executeBuiltinSlashCommand(text, { ctx })).toBe(true);
		expect(entryChecks).toBe(0);
		expect(shutdowns.size).toBe(0);
		expect(text).toBe("/dev next");

		text = "/dev";
		expect(await executeBuiltinSlashCommand(text, { ctx })).toBe(true);
		expect(entryChecks).toBe(1);
		expect(shutdowns.size).toBe(1);
		expect(ctx.isDevWorkbenchModeActive?.()).toBe(false);
		expect(editor.disableSubmit).toBe(false);
		expect(text).toBe("/dev");
		expect(f.output).toHaveLength(2);
		expect(f.output.every(message => message.length > 0)).toBe(true);

		text = "new ordinary draft";
		expect(await executeBuiltinSlashCommand("/dev", { ctx, draftDetached: true })).toBe(true);
		expect(entryChecks).toBe(2);
		expect(shutdowns.size).toBe(1);
		expect(text).toBe("/dev\n\nnew ordinary draft");
		expect(f.session.messages).toEqual([]);
		expect(f.session.isBusyForSnapshot).toBe(false);
		await expect(fs.stat(path.join(f.cwd, ".omp/dev-workbench"))).rejects.toMatchObject({ code: "ENOENT" });
		for (const shutdown of shutdowns) await shutdown();
	});

	test("invokes the host toggle exactly once per bare command and never for rejected arguments", async () => {
		await using f = await fixture();
		let toggles = 0;
		let active = false;
		f.context.toggleDevWorkbench = async () => {
			toggles++;
			active = !active;
		};
		expect(await f.invoke("")).toEqual({ consumed: true });
		expect(active).toBe(true);
		expect(toggles).toBe(1);
		expect(await f.invoke("next")).toEqual({ consumed: true, failed: true, errorCode: "invalid_params" });
		expect(active).toBe(true);
		expect(toggles).toBe(1);
		expect(await f.invoke("", "/dev   ")).toEqual({ consumed: true });
		expect(active).toBe(false);
		expect(toggles).toBe(2);
		expect(f.session.messages).toEqual([]);
		expect(f.session.isBusyForSnapshot).toBe(false);
	});

	test("consumes every retired verb without changing the ordinary session or creating Dev state", async () => {
		await using f = await fixture();
		expect(BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS.map(command => command.name)).toEqual(["dev"]);
		const ordinaryId = f.session.sessionId;
		const ordinaryModel = f.session.model;
		const ordinarySettings = f.session.settings;
		const ordinaryQueue = f.session.getQueuedInputMessages();
		const messages = structuredClone(f.session.messages);
		for (const args of [
			"new 完整需求",
			"business 业务描述",
			"finish-business",
			"next",
			"next one",
			"back",
			"drop",
			"config",
			"status",
			"--resume",
			"unknown",
			"next a b",
		]) {
			expect(await f.invoke(args)).toEqual({ consumed: true, failed: true, errorCode: "invalid_params" });
		}
		expect(f.session.sessionId).toBe(ordinaryId);
		expect(f.session.messages).toEqual(messages);
		expect(f.session.model).toBe(ordinaryModel);
		expect(f.session.settings).toBe(ordinarySettings);
		expect(f.session.getQueuedInputMessages()).toEqual(ordinaryQueue);
		await expect(fs.stat(path.join(f.cwd, "docs/dev-requirements"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(f.cwd, ".omp/dev-workbench"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("checks the submitted text rather than letting stale parsed args smuggle an old action", async () => {
		await using f = await fixture();
		for (const text of ["/dev:next", "/dev next\n仍然是旧参数", "/dev\tnew raw request", "/dev config "]) {
			expect(await f.invoke("", text)).toEqual({ consumed: true, failed: true, errorCode: "invalid_params" });
		}
		expect(f.session.messages).toEqual([]);
		expect(f.session.isBusyForSnapshot).toBe(false);
		await expect(fs.stat(path.join(f.cwd, ".omp/dev-workbench"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a generic host without the native TUI toggle reports a consumed error without launching or calling a model", async () => {
		await using f = await fixture();
		const ordinaryId = f.session.sessionId;
		const ordinaryModel = f.session.model;
		const ordinarySettings = f.session.settings;
		const ordinaryQueue = f.session.getQueuedInputMessages();
		for (const text of ["/dev", "/dev   "]) {
			expect(await f.invoke("", text)).toEqual({ consumed: true, failed: true, errorCode: "execution_failed" });
		}
		expect(f.output.length).toBe(2);
		expect(f.output.every(message => message.length > 0)).toBe(true);
		expect(f.session.messages).toEqual([]);
		expect(f.session.isBusyForSnapshot).toBe(false);
		expect(f.session.sessionId).toBe(ordinaryId);
		expect(f.session.model).toBe(ordinaryModel);
		expect(f.session.settings).toBe(ordinarySettings);
		expect(f.session.getQueuedInputMessages()).toEqual(ordinaryQueue);
		expect(f.session.sessionManager.getCwd()).toBe(f.cwd);
		await expect(fs.stat(path.join(f.cwd, ".omp/dev-workbench"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(f.cwd, "docs/dev-requirements"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
