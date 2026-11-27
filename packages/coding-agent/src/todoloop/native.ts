import type { AsyncJob, AsyncJobDetails } from "../async/job-manager";
import { runEvalAgent } from "../eval/agent-bridge";
import { runEvalCancel, runEvalWait, type EvalHandleSnapshot } from "../eval/handle-bridge";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { getBundledAgent } from "../task/agents";
import type { ToolSession } from "../tools";

/** Native eval handles remain the only executor and cancellation authority. */
export class TodoLoopNative {
	constructor(readonly session: ToolSession) {}
	readonly #jobs = new Map<string, AsyncJob>();

	async start(
		prompt: string,
		label: string,
		signal?: AbortSignal,
		options?: { agent?: "task" | "scout"; context?: string },
	): Promise<string> {
		if (signal?.aborted) throw signal.reason;
		const agent = options?.agent ?? "task";
		const scout = agent === "scout" ? getBundledAgent(agent) : undefined;
		if (agent === "scout" && !scout?.tools?.length) {
			throw new Error("TodoLoop: bundled scout has no explicit read-only tool list.");
		}
		const handle = await runEvalAgent(
			{ agent, prompt, label, isolated: false },
			{
				session: this.session,
				signal,
				suppressDelivery: true,
				context: options?.context,
				// Use the native strict allowlist so ambient tools cannot widen the bundled scout.
				agentDefinition: scout ? { ...scout, restrictToolNames: true } : undefined,
			},
		);
		this.#jobs.set(handle.id, this.job(handle.id));
		return handle.id;
	}

	job(id: string): AsyncJob {
		const job = this.session.asyncJobManager?.getJob(id) ?? this.#jobs.get(id);
		if (!job) throw new Error(`TodoLoop: native job ${id} is unavailable`);
		return job;
	}

	cancel(id: string): void {
		const manager = this.session.asyncJobManager;
		if (!manager) throw new Error("TodoLoop: async job manager is unavailable");
		// Native wait may already have consumed and evicted a settled root.
		// Its descendants remain owned even when the root handle is gone.
		if (manager.getJob(id)?.status === "running") {
			runEvalCancel({ item: { kind: "agent", id } }, { session: this.session });
		}
		const owned = new Set([id]);
		for (;;) {
			const size = owned.size;
			for (const [child, parent] of manager.getAgentParentLinks()) if (owned.has(parent)) owned.add(child);
			if (owned.size === size) break;
		}
		for (const job of manager.getUnsettledJobs()) {
			if (job.ownerId && owned.has(job.ownerId)) manager.cancel(job.id);
		}
	}

	async wait(
		id: string,
		signal: AbortSignal | undefined,
		onProgress: (details?: AsyncJobDetails) => void,
	): Promise<EvalHandleSnapshot> {
		const result = await runEvalWait(
			{ items: [{ kind: "agent", id }] },
			{ session: this.session, signal, emitStatus: () => onProgress(this.job(id).latestDetails) },
		);
		const snapshot = result.items[0];
		if (!snapshot) throw new Error(`TodoLoop: native wait returned no result for ${id}`);
		return snapshot;
	}

	/** Await real work and strict ownership cleanup, retaining native read-only execution records. */
	async settle(id: string): Promise<void> {
		await this.job(id).promise;
		const manager = this.session.asyncJobManager;
		if (!manager) throw new Error("TodoLoop: async job manager is unavailable");
		const owned = new Set([id]);
		for (;;) {
			for (;;) {
				const size = owned.size;
				for (const [child, parent] of manager.getAgentParentLinks()) if (owned.has(parent)) owned.add(child);
				if (owned.size === size) break;
			}
			for (const ownerId of owned) manager.cancelAll({ ownerId });
			for (const ownerId of owned) {
				if (!(await manager.waitForOwnerJobs(ownerId)))
					throw new Error(`TodoLoop: work owned by ${ownerId} did not settle`);
			}
			// A cancelled body's finalizer may have registered another native child.
			let discovered = false;
			for (const [child, parent] of manager.getAgentParentLinks()) {
				if (owned.has(parent) && !owned.has(child)) {
					owned.add(child);
					discovered = true;
				}
			}
			if (!discovered) break;
		}
		const registry = this.session.agentRegistry ?? AgentRegistry.global();
		const lifecycle = this.session.agentLifecycle?.() ?? AgentLifecycleManager.global();
		const ref = registry.get(id);
		if (ref) {
			await lifecycle.releaseDescendants(ref, undefined, { strict: true, retainRecord: true });
			if (!(await lifecycle.release(id, ref, { strict: true, retainRecord: true }))) {
				throw new Error(`TodoLoop: native ownership changed during cleanup of ${id}`);
			}
		}
	}
}
