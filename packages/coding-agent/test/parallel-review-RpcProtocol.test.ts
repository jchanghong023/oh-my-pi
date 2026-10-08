import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcLoopController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-loop";
import { RpcUserInputGate } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

describe("queued RPC loop admission", () => {
	for (const interruption of ["stop", "session change", "stop reset"] as const) {
		test(`${interruption} cancels loop work waiting behind a host operation`, async () => {
			const gate = new RpcUserInputGate();
			const dialog = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const queued = Promise.withResolvers<void>();
			const blocker = gate.enqueue(async () => {
				started.resolve();
				await dialog.promise;
			});
			await started.promise;
			let transcript = "source";
			const delivered: string[] = [];
			const session = {
				settings: Settings.isolated({ "loop.mode": interruption === "stop reset" ? "reset" : "prompt" }),
				sessionManager: { getSessionId: () => transcript },
				isDisposed: false,
				isStreaming: false,
				isCompacting: false,
				hasPostPromptWork: false,
				hasAdmittedSubmission: false,
				queuedMessageCount: 0,
				isSessionTransitioning: false,
				waitForIdle: async () => {},
				getVibeModeState: () => undefined,
			};
			// The repeat may be accepted after an already-read transition frame,
			// so sequence invalidation alone cannot cancel it.
			const change: RpcCommand = { type: "new_session" };
			gate.accept(change);
			const controller = new RpcLoopController(session as unknown as AgentSession, {
				output: () => {},
				reset: async (current = () => true) => {
					queued.resolve();
					return gate.enqueue(async () => {
						if (!current()) return false;
						delivered.push("reset");
						return true;
					});
				},
				onContinuationDropped: () => {},
				submit: async (text, current = () => true) => {
					const command: RpcCommand = { type: "prompt", message: text };
					gate.accept(command);
					queued.resolve();
					await gate.enqueue(async () => {
						if (gate.isCurrent(command) && current()) delivered.push(`${transcript}:${text}`);
					});
				},
			});
			try {
				await controller.handle("1");
				controller.capturePrompt("source task");
				controller.observe({ type: "agent_end", isTerminal: true, messages: [] });
				await queued.promise;
				if (interruption !== "session change") controller.pause();
				else {
					controller.clear();
					transcript = "destination";
					gate.commitSessionChange(change);
				}
				dialog.resolve();
				await blocker;
				await gate.enqueue(async () => {});
				expect(delivered).toEqual([]);
			} finally {
				controller.clear();
				dialog.resolve();
				await blocker;
			}
		});
	}
});
