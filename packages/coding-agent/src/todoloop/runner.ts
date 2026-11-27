import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobDetails } from "../async/job-manager";
import type { EvalHandleSnapshot, EvalHandleState } from "../eval/handle-bridge";
import { buildTodoLoopGroupPrompt, buildTodoLoopScoutPrompt, type TodoLoopPreviousAttempt } from "./context";
import { TodoLoopNative } from "./native";
import {
	readTodoLoop,
	validateTodoLoopChange,
	type TodoLoopGroup,
	type TodoLoopSnapshot,
	type TodoLoopTask,
} from "./parser";

export interface TodoLoopState {
	phase:
		| "checking"
		| "running"
		| "retrying"
		| "completed"
		| "failed"
		| "file_error"
		| "stopping"
		| "stopped"
		| "settlement_failed";
	filePath: string;
	/** Original valid input, retained only in memory for diagnosis or explicit recovery. */
	originalContent?: string;
	completed: number;
	total: number;
	completedGroups: number;
	totalGroups: number;
	group?: TodoLoopGroup;
	current?: TodoLoopTask;
	attempt: number;
	reason?: string;
}

export interface TodoLoopAttemptEvent {
	type: "start" | "update" | "end";
	id: string;
	/** Absent for shared-background preparation, which is not a group attempt. */
	group?: TodoLoopGroup;
	attempt: number;
	details?: AsyncJobDetails;
	text?: string;
	error?: string;
	status?: EvalHandleState;
}

export interface TodoLoopRunOptions {
	filePath: string;
	cwd: string;
	signal?: AbortSignal;
	onState?: (state: TodoLoopState) => void;
	onAttempt?: (event: TodoLoopAttemptEvent) => void;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Presentation never owns job control or file validation. */
function notify<T>(observer: ((value: T) => void) | undefined, value: T): void {
	try {
		observer?.(value);
	} catch (error) {
		logger.warn("TodoLoop presentation observer failed", { error });
	}
}

/** Fixed host TypeScript orchestration over the session's existing eval bridges. */
export async function runTodoLoop(options: TodoLoopRunOptions, native: TodoLoopNative): Promise<TodoLoopState> {
	const filePath = path.resolve(options.cwd, options.filePath);
	let snapshot: TodoLoopSnapshot | undefined;
	let originalContent: string | undefined;
	let group: TodoLoopGroup | undefined;
	let attempt = 0;
	let phase: TodoLoopState["phase"] = "checking";
	const state = (nextPhase: TodoLoopState["phase"], reason?: string): TodoLoopState => {
		phase = nextPhase;
		const value: TodoLoopState = {
			phase,
			filePath,
			originalContent,
			completed: snapshot?.tasks.filter(task => task.done).length ?? 0,
			total: snapshot?.tasks.length ?? 0,
			completedGroups: snapshot?.groups.filter(item => item.tasks.every(task => task.done)).length ?? 0,
			totalGroups: snapshot?.groups.length ?? 0,
			group,
			current: group?.tasks.find(task => !task.done),
			attempt,
			reason,
		};
		notify(options.onState, value);
		return value;
	};
	const reread = async (activeGroupId?: string): Promise<void> => {
		const fresh = await readTodoLoop(filePath);
		originalContent ??= fresh.content;
		if (snapshot) validateTodoLoopChange(snapshot, fresh, activeGroupId);
		snapshot = fresh;
		if (group) group = fresh.groups.find(item => item.id === group?.id);
	};
	state("checking");
	try {
		await reread();
	} catch (error) {
		return state("file_error", errorText(error));
	}
	const execute = async (id: string, activeGroup?: TodoLoopGroup): Promise<EvalHandleSnapshot | TodoLoopState> => {
		const event = (type: TodoLoopAttemptEvent["type"], fields: Partial<TodoLoopAttemptEvent> = {}): void => {
			notify(options.onAttempt, { type, id, group: activeGroup, attempt, ...fields });
		};
		let cancelError: unknown;
		let announced = false;
		const cancel = (): void => {
			state("stopping");
			try {
				native.cancel(id);
			} catch (error) {
				cancelError = error;
			}
		};
		let result: EvalHandleSnapshot | undefined;
		let executionError: string | undefined;
		let fileError: string | undefined;
		let acceptingProgress = false;
		let progress = Promise.resolve();
		const onProgress = (details?: AsyncJobDetails): void => {
			if (!acceptingProgress) return;
			event("update", { details });
			// Native wait owns cadence. Serialize reads against the latest accepted snapshot.
			progress = progress
				.then(async () => {
					if (fileError) return;
					await reread(activeGroup?.id);
					state(phase);
				})
				.catch(error => {
					fileError = errorText(error);
					cancel();
				});
		};
		options.signal?.addEventListener("abort", cancel, { once: true });
		try {
			// The handle may have registered just before cancellation reached us.
			// Settle it in either case, but only present attempts that started.
			if (options.signal?.aborted) {
				cancel();
			} else {
				state("running");
				if (!options.signal?.aborted) {
					announced = true;
					event("start");
				}
			}
			if (announced) {
				acceptingProgress = true;
				try {
					result = await native.wait(id, options.signal, onProgress);
					if (result.status === "running") {
						executionError = "Native wait returned before the agent completed.";
						cancel();
					}
				} catch (error) {
					executionError = errorText(error);
					cancel();
				}
			}
			await native.settle(id);
			acceptingProgress = false;
			await progress;
			if (cancelError) throw cancelError;
		} catch (error) {
			acceptingProgress = false;
			await progress;
			if (announced)
				event("end", {
					error: errorText(error),
					details: native.session.asyncJobManager?.getJob(id)?.latestDetails,
				});
			return state("settlement_failed", errorText(error));
		} finally {
			acceptingProgress = false;
			await progress;
			options.signal?.removeEventListener("abort", cancel);
		}
		const job = native.job(id);
		const text = result?.text ?? job.resultText;
		const error = result?.error ?? executionError ?? job.errorText;
		if (announced) {
			event("end", { text: activeGroup ? text : undefined, error, status: job.status, details: job.latestDetails });
		}
		if (fileError) return state("file_error", fileError);
		try {
			await reread(activeGroup?.id);
		} catch (error) {
			return state("file_error", errorText(error));
		}
		if (options.signal?.aborted) return state("stopped");
		return { kind: "agent", id, status: job.status, text, error, data: result?.data };
	};

	if (options.signal?.aborted) return state("stopped");
	if (snapshot!.groups.every(item => item.tasks.every(task => task.done))) return state("completed");
	let preparationPrompt: string;
	try {
		preparationPrompt = await buildTodoLoopScoutPrompt(filePath, options.cwd);
	} catch (error) {
		if (options.signal?.aborted) return state("stopped");
		return state("failed", `TodoLoop background preparation failed: ${errorText(error)}`);
	}
	try {
		await reread();
	} catch (error) {
		return state(options.signal?.aborted ? "stopped" : "file_error", errorText(error));
	}
	if (options.signal?.aborted) return state("stopped");
	let preparationId: string;
	try {
		preparationId = await native.start(preparationPrompt, "TodoLoop shared background", options.signal, {
			agent: "scout",
		});
	} catch (error) {
		if (options.signal?.aborted) return state("stopped");
		return state("failed", `TodoLoop background dispatch failed: ${errorText(error)}`);
	}
	const preparation = await execute(preparationId);
	if ("phase" in preparation) return preparation;
	if (preparation.status !== "completed" || preparation.error) {
		return state("failed", preparation.error ?? "TodoLoop background preparation failed.");
	}
	const context = preparation.text?.trim();
	if (!context) return state("failed", "TodoLoop background preparation returned no usable result.");

	let previous: TodoLoopPreviousAttempt | undefined;
	for (;;) {
		if (options.signal?.aborted) return state("stopped");
		try {
			await reread();
		} catch (error) {
			return state("file_error", errorText(error));
		}
		const next = snapshot!.groups.find(item => item.tasks.some(task => !task.done));
		if (!next) return state("completed");
		if (next.id !== group?.id) {
			attempt = 0;
			previous = undefined;
		}
		group = next;
		let prompt: string;
		try {
			prompt = await buildTodoLoopGroupPrompt({
				filePath,
				cwd: options.cwd,
				group,
				attempt: attempt + 1,
				previous,
			});
			await reread();
		} catch (error) {
			return state(options.signal?.aborted ? "stopped" : "file_error", errorText(error));
		}
		if (options.signal?.aborted) return state("stopped");
		let id: string;
		try {
			id = await native.start(prompt, `TodoLoop group ${group.id} · ${attempt + 1}/3`, options.signal, { context });
		} catch (error) {
			if (options.signal?.aborted) return state("stopped");
			return state("failed", `TodoLoop group ${group.id} dispatch failed: ${errorText(error)}`);
		}
		attempt++;
		const activeGroup = group;
		const execution = await execute(id, activeGroup);
		if ("phase" in execution) return execution;
		const { text, error } = execution;
		const remaining = group!.tasks.filter(task => !task.done);
		if (remaining.length === 0) continue;
		previous = {
			text,
			error,
			observation: `Group ${activeGroup.id} still has unchecked tasks ${remaining.map(task => task.label ?? task.id).join(", ")} after attempt ${attempt}.`,
		};
		const reason = error ? `${previous.observation} ${error}` : previous.observation;
		if (attempt >= 3) return state("failed", reason);
		state("retrying", reason);
	}
}
