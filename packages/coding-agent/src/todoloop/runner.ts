import * as path from "node:path";
import type { AsyncJobDetails } from "../async/job-manager";
import type { EvalHandleSnapshot, EvalHandleState } from "../eval/handle-bridge";
import { buildTodoLoopGroupPrompt, type TodoLoopPreviousAttempt } from "./context";
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
	group: TodoLoopGroup;
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

/** Fixed host TypeScript orchestration over the session's existing eval bridges. */
export async function runTodoLoop(options: TodoLoopRunOptions, native: TodoLoopNative): Promise<TodoLoopState> {
	const filePath = path.resolve(options.cwd, options.filePath);
	let snapshot: TodoLoopSnapshot | undefined;
	let group: TodoLoopGroup | undefined;
	let attempt = 0;
	let phase: TodoLoopState["phase"] = "checking";
	const state = (nextPhase: TodoLoopState["phase"], reason?: string): TodoLoopState => {
		phase = nextPhase;
		const value: TodoLoopState = {
			phase,
			filePath,
			completed: snapshot?.tasks.filter(task => task.done).length ?? 0,
			total: snapshot?.tasks.length ?? 0,
			completedGroups: snapshot?.groups.filter(item => item.tasks.every(task => task.done)).length ?? 0,
			totalGroups: snapshot?.groups.length ?? 0,
			group,
			current: group?.tasks.find(task => !task.done),
			attempt,
			reason,
		};
		options.onState?.(value);
		return value;
	};
	const reread = async (activeGroupId?: string): Promise<void> => {
		const fresh = await readTodoLoop(filePath);
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
		let id: string;
		try {
			const prompt = await buildTodoLoopGroupPrompt({
				filePath,
				cwd: options.cwd,
				group,
				attempt: attempt + 1,
				previous,
			});
			await reread();
			if (options.signal?.aborted) return state("stopped");
			id = await native.start(prompt, `TodoLoop group ${group.id} · ${attempt + 1}/3`, options.signal);
		} catch (error) {
			return state(options.signal?.aborted ? "stopped" : "file_error", errorText(error));
		}
		attempt++;
		const activeGroup = group;
		const event = (type: TodoLoopAttemptEvent["type"], fields: Partial<TodoLoopAttemptEvent> = {}): void => {
			options.onAttempt?.({ type, id, group: activeGroup, attempt, ...fields });
		};
		state("running");
		event("start");
		let cancelError: unknown;
		const cancel = (): void => {
			state("stopping");
			try {
				native.cancel(id);
			} catch (error) {
				cancelError = error;
			}
		};
		options.signal?.addEventListener("abort", cancel, { once: true });
		if (options.signal?.aborted) cancel();
		let result: EvalHandleSnapshot | undefined;
		let executionError: string | undefined;
		let fileError: string | undefined;
		let acceptingProgress = true;
		let progress = Promise.resolve();
		const onProgress = (details?: AsyncJobDetails): void => {
			if (!acceptingProgress) return;
			event("update", { details });
			// Native wait owns cadence. Serialize reads against the latest accepted snapshot.
			progress = progress
				.then(async () => {
					if (fileError) return;
					await reread(activeGroup.id);
					state(phase);
				})
				.catch(error => {
					fileError = errorText(error);
					cancel();
				});
		};
		try {
			try {
				result = await native.wait(id, options.signal, onProgress);
				if (result.status === "running") {
					executionError = "Native wait returned before the group agent completed.";
					cancel();
				}
			} catch (error) {
				executionError = errorText(error);
				cancel();
			}
			await native.settle(id);
			acceptingProgress = false;
			await progress;
			if (cancelError) throw cancelError;
		} catch (error) {
			acceptingProgress = false;
			await progress;
			event("end", { error: errorText(error), details: native.session.asyncJobManager?.getJob(id)?.latestDetails });
			return state("settlement_failed", errorText(error));
		} finally {
			acceptingProgress = false;
			await progress;
			options.signal?.removeEventListener("abort", cancel);
		}
		const job = native.job(id);
		const text = result?.text ?? job.resultText;
		const error = result?.error ?? executionError ?? job.errorText;
		event("end", { text, error, status: job.status, details: job.latestDetails });
		if (fileError) return state("file_error", fileError);
		try {
			await reread(activeGroup.id);
		} catch (error) {
			return state("file_error", errorText(error));
		}
		if (options.signal?.aborted) return state("stopped");
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
