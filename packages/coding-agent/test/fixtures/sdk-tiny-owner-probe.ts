import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";

const cwd = process.env.OMP_CONFIG_ROOT;
if (!cwd) throw new Error("Expected an isolated configuration root");
const authStorage = await AuthStorage.create(":memory:");
const modelRegistry = new ModelRegistry(authStorage);
const sessions: AgentSession[] = [];
const observations: number[] = [];
const originalTerminate = tinyTitleClient.terminate;
let terminations = 0;
tinyTitleClient.terminate = async () => {
	terminations++;
};
try {
	for (const id of ["first", "second"]) {
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			agentId: `tiny-owner-${id}`,
			authStorage,
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(cwd),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);
	}
	await sessions[0].dispose();
	observations.push(terminations);
	await sessions[1].dispose();
	observations.push(terminations);
	await sessions[0].dispose();
	observations.push(terminations);
} finally {
	for (const session of sessions) await session.dispose();
	tinyTitleClient.terminate = originalTerminate;
	authStorage.close();
}
process.stdout.write(JSON.stringify(observations));
