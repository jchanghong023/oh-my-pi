import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AUTO_THINKING, shouldDisableReasoning, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import type { ExecutionModelRequestRecovery, ExecutionRequestAuthResolver } from "./execution-model";

export type ExecutionStreamDispatch = (
	model: Model,
	context: Context,
	options?: SimpleStreamOptions,
	resolveRequestAuth?: ExecutionRequestAuthResolver,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** Recover only the failing provider request. The agent loop and its completed tools are never replayed. */
export function streamWithExecutionRecovery(
	dispatch: ExecutionStreamDispatch,
	model: Model,
	context: Context,
	options: SimpleStreamOptions | undefined,
	recover: ExecutionModelRequestRecovery,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const run = async () => {
		let currentModel = model;
		let currentOptions = options;
		let resolveRequestAuth: ExecutionRequestAuthResolver | undefined;
		for (;;) {
			options?.signal?.throwIfAborted();
			let failed: unknown;
			try {
				const inner = await dispatch(currentModel, context, currentOptions, resolveRequestAuth);
				for await (const event of inner) {
					if (event.type === "error" && event.error.stopReason !== "aborted" && !options?.signal?.aborted) {
						failed = event.error;
						break;
					}
					outer.push(event);
				}
				if (failed === undefined) return;
			} catch (error) {
				failed = error;
			}
			options?.signal?.throwIfAborted();
			const replacement = await recover({ model: currentModel, error: failed, signal: options?.signal });
			if (!replacement) {
				if (failed && typeof failed === "object" && "role" in failed && failed.role === "assistant") {
					outer.push({ type: "error", reason: "error", error: failed as AssistantMessage });
				} else outer.fail(failed);
				return;
			}
			currentModel = replacement.model;
			resolveRequestAuth = replacement.resolveRequestAuth;
			const thinking = replacement.thinkingLevel === AUTO_THINKING ? undefined : replacement.thinkingLevel;
			// Credentials (including seeded key resolvers and arbitrary auth headers)
			// belong to the failed request, never to its replacement provider.
			currentOptions = {
				...options,
				apiKey: undefined,
				credentialId: undefined,
				oauthIdentity: undefined,
				requestAuth: undefined,
				headers: undefined,
				...(replacement.thinkingLevel === undefined
					? {}
					: {
							reasoning: toReasoningEffort(thinking),
							forceReasoningOff: shouldDisableReasoning(thinking),
						}),
			};
		}
	};
	void run().catch(error => {
		if (!outer.done) outer.fail(error);
	});
	return outer;
}
