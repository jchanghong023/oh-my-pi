import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let tempDir: TempDir;
let state: SettingsTestState;
let authStorage: AuthStorage;
let session: AgentSession | undefined;

beforeEach(async () => {
	state = beginSettingsTest();
	tempDir = TempDir.createSync("omp-sdk-command-discovery-");
	setAgentDir(tempDir.join("agent"));
	authStorage = createInMemoryAuthStorage();
	await Bun.write(
		tempDir.join("agent", "commands", "external-fixture", "index.js"),
		`await Bun.write(${JSON.stringify(tempDir.join("imported.txt"))}, "imported");
export default () => ({ name: "external-fixture", description: "External command", execute() {} });`,
	);
});

afterEach(async () => {
	try {
		await session?.dispose();
	} finally {
		session = undefined;
		authStorage.close();
		restoreSettingsTestState(state);
		await tempDir.remove();
	}
});

async function createSession(restrictToolNames: boolean): Promise<AgentSession> {
	const result = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.join("agent"),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		model: buildModel({
			id: "command-discovery-model",
			name: "Command discovery fixture",
			provider: "command-discovery-fixture",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		}),
		settings: Settings.isolated({ "compaction.enabled": false }),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		disableExtensionDiscovery: true,
		restrictToolNames,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		preloadedCustomToolPaths: [],
		toolNames: ["read"],
		enableMCP: false,
		enableLsp: false,
	});
	session = result.session;
	return session;
}

describe("SDK custom command discovery", () => {
	it("retains bundled commands without executing external commands when discovery is disabled", async () => {
		const current = await createSession(false);
		expect(current.customCommands.map(({ command }) => command.name).sort()).toEqual(["annotate", "green", "review"]);
		expect(await Bun.file(tempDir.join("imported.txt")).exists()).toBe(false);
	});

	it("keeps restricted sessions free of bundled and external commands", async () => {
		const current = await createSession(true);
		expect(current.customCommands).toEqual([]);
		expect(await Bun.file(tempDir.join("imported.txt")).exists()).toBe(false);
	});
});
