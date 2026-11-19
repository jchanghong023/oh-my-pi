import { expect, test } from "bun:test";
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
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-slash-command-"));
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
	return {
		session,
		settings,
		async [Symbol.asyncDispose]() {
			await session.dispose();
			await registry.awaitBackgroundRefresh();
			auth.close();
			await fs.rm(cwd, { recursive: true, force: true });
		},
	};
}

test("dispatches the ordinary context command and clears its composer text", async () => {
	await using f = await fixture();
	let text = "/context";
	let contextReports = 0;
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
		settings: f.settings,
		editor,
		handleContextCommand: () => {
			contextReports++;
		},
	} as unknown as InteractiveModeContext;

	expect(await executeBuiltinSlashCommand("/context", { ctx })).toBe(true);
	expect(contextReports).toBe(1);
	expect(text).toBe("");
});
