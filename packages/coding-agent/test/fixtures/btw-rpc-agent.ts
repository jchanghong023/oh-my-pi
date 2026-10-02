import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real SDK session and RPC dispatch with a persisted session; only the model is scripted.
// The side channel is scripted at `runEphemeralTurn` (the provider stream is covered by
// AgentSession tests): a question containing "slow" streams one chunk, then waits for
// cancellation; "fail" rejects; anything else streams two chunks naming the number of
// replayed context messages, so follow-ups are observable.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const settings = await Settings.init({ inMemory: true, cwd });
const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
	authStorage,
	modelRegistry,
	settings,
	model: getBundledModel("anthropic", "claude-sonnet-4-5"),
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
});
session.agent.streamFn = createMockModel({ handler: () => ({ content: ["Main answer."] }) }).stream;
session.runEphemeralTurn = async args => {
	const reply = (text: string) => ({
		replyText: text,
		assistantMessage: {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		},
	});
	if (args.promptText.includes("fail")) throw new Error("provider exploded");
	if (args.promptText.includes("slow")) {
		args.onTextDelta?.("Thinking");
		const { promise, reject } = Promise.withResolvers<never>();
		args.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		return promise;
	}
	const text = `Answer with ${args.history?.length ?? 0} context messages.`;
	args.onTextDelta?.(text.slice(0, 7));
	await Bun.sleep(5);
	args.onTextDelta?.(text.slice(7));
	return reply(text);
};
await runRpcMode(session);
