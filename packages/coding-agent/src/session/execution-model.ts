import { AsyncLocalStorage } from "node:async_hooks";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/** Business constraints of a single execution; never persisted as session configuration. */
export interface ExecutionModelPolicies {
	memoryExtraction?: "skip";
	subagents?: { foregroundModel: "submission"; background: "deny" | "allow" };
}

export type ExecutionRequestAuthResolver = (
	model: Model,
	signal?: AbortSignal,
) => Promise<{ apiKey?: string; headers?: Record<string, string> } | undefined>;

/** Recovery replaces a failed provider request, never resubmits the user's input. */
export type ExecutionModelRequestRecovery = (request: {
	model: Model;
	error: unknown;
	signal?: AbortSignal;
}) => Promise<
	| {
			model: Model;
			thinkingLevel?: ConfiguredThinkingLevel;
			resolveRequestAuth?: ExecutionRequestAuthResolver;
	  }
	| undefined
>;

export interface ExecutionModelOptions {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	signal?: AbortSignal;
	policies?: ExecutionModelPolicies;
	resolveRequestAuth?: ExecutionRequestAuthResolver;
	recoverModelRequest?: ExecutionModelRequestRecovery;
}

export interface ExecutionModelContext {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	policies?: ExecutionModelPolicies;
	resolveRequestAuth?: ExecutionRequestAuthResolver;
	recoverModelRequest?: ExecutionModelRequestRecovery;
	releaseModel?: () => Promise<void>;
}

const executionContext = new AsyncLocalStorage<{ value: ExecutionModelContext; active: boolean }>();

/** Inherited by foreground task dispatch, but never exposed after its execution finishes. */
export function currentExecutionModel(): ExecutionModelContext | undefined {
	const context = executionContext.getStore();
	return context?.active ? context.value : undefined;
}

/** End only the submission's model lease before a later user input is dequeued. */
export async function releaseCurrentExecutionModel(): Promise<void> {
	await executionContext.getStore()?.value.releaseModel?.();
}

/** Detached work may use ordinary session auth, never the submission's ephemeral material. */
export function withoutExecutionModelContext<T>(run: () => T): T {
	return executionContext.exit(run);
}

export async function withExecutionModelContext<T>(value: ExecutionModelContext, run: () => Promise<T>): Promise<T> {
	let resolveRequestAuth = value.resolveRequestAuth;
	let recoverModelRequest = value.recoverModelRequest;
	let releaseModel = value.releaseModel;
	let releasePromise: Promise<void> | undefined;
	const scopedResolveRequestAuth: ExecutionRequestAuthResolver = async (model, signal) => {
		if (!context.active) throw new ExecutionModelContractError("Execution authorization scope has ended");
		const auth = await resolveRequestAuth?.(model, signal);
		if (!context.active) throw new ExecutionModelContractError("Execution authorization scope has ended");
		return auth;
	};
	const context: { value: ExecutionModelContext; active: boolean } = {
		value: {
			...value,
			resolveRequestAuth: resolveRequestAuth ? scopedResolveRequestAuth : undefined,
			recoverModelRequest: recoverModelRequest
				? async request => {
						if (!context.active) throw new ExecutionModelContractError("Execution recovery scope has ended");
						const recovery = await recoverModelRequest!(request);
						if (!context.active) throw new ExecutionModelContractError("Execution recovery scope has ended");
						if (recovery) {
							context.value.model = recovery.model;
							context.value.thinkingLevel = recovery.thinkingLevel;
							resolveRequestAuth = recovery.resolveRequestAuth;
							context.value.resolveRequestAuth = resolveRequestAuth ? scopedResolveRequestAuth : undefined;
							return { ...recovery, resolveRequestAuth: context.value.resolveRequestAuth };
						}
						return recovery;
					}
				: undefined,
			releaseModel: () => {
				if (releasePromise) return releasePromise;
				context.active = false;
				resolveRequestAuth = undefined;
				recoverModelRequest = undefined;
				const release = releaseModel;
				releaseModel = undefined;
				releasePromise = Promise.resolve().then(() => release?.());
				return releasePromise;
			},
		},
		active: true,
	};
	try {
		return await executionContext.run(context, run);
	} finally {
		await context.value.releaseModel?.();
	}
}

/** Raised before a submission is admitted when its execution contract cannot be honored. */
export class ExecutionModelContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionModelContractError";
	}
}
