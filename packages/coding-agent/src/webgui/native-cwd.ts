import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import { rebindMemoryBackendForCwd } from "../hindsight/backend";
import type { AgentSession } from "../session/agent-session";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import {
	acquireBrowserProject,
	readBrowserProject,
	resolveBrowserProjectRoot,
	type BrowserProjectLease,
} from "./project-registry";
import { readWebGuiSessionInfo } from "./session-source";

const hosts = new WeakMap<AgentSession, NativeCwdHost>();

/** One native session and its original terminal lease, plus any admitted continuation roots. */
export class NativeCwdHost {
	readonly #session: AgentSession;
	readonly #leases = new Map<string, BrowserProjectLease>();
	#transition?: Promise<void>;
	#exiting = false;

	constructor(session: AgentSession, lease: BrowserProjectLease) {
		if (hosts.has(session)) throw new Error("The native session already has a WebGUI host");
		this.#session = session;
		this.#leases.set(normalizePathForComparison(lease.root), lease);
		hosts.set(session, this);
	}

	resume(path: string, cwd: string, id: string, signal: AbortSignal, assertOwner: () => void): Promise<void> {
		if (this.#exiting || this.#transition) throw new Error("The native workspace is busy or exiting");
		const operation = this.#resume(path, cwd, id, signal, assertOwner);
		this.#transition = operation;
		void operation.then(
			() => {
				this.#transition = undefined;
			},
			() => {
				this.#transition = undefined;
			},
		);
		return operation;
	}

	async #rebind(cwd: string): Promise<void> {
		// SDK tools, prompts and children resolve cwd from this same SessionManager.
		// Do not mutate the process directory or invoke the terminal's mode-guarded adapter.
		await this.#session.settings.reloadForCwd(cwd);
		await rebindMemoryBackendForCwd(this.#session);
		clearClaudePluginRootsCache();
		this.#session.setTitleSystemPrompt(
			await resolvePromptInput(discoverTitleSystemPromptFile(cwd), "title system prompt"),
		);
		await this.#session.refreshSkillsAndCommands();
	}

	async #resume(path: string, cwd: string, id: string, signal: AbortSignal, assertOwner: () => void): Promise<void> {
		const session = this.#session;
		const previousId = session.sessionId;
		const guard = () => {
			signal.throwIfAborted();
			assertOwner();
			if (this.#exiting || session.isDisposed) throw new Error("The native workspace is exiting");
		};
		const beforeSwitch = () => {
			guard();
			if (session.sessionId !== previousId || session.isStreaming || session.isSessionTransitioning)
				throw new Error("The native session changed or became busy before recovery");
		};
		const previousManagerId = session.sessionManager.getSessionId();
		beforeSwitch();
		const root = normalizePathForComparison(await resolveBrowserProjectRoot(cwd));
		beforeSwitch();
		let added: BrowserProjectLease | undefined;
		try {
			if (!this.#leases.has(root)) {
				added = await acquireBrowserProject(cwd, "webgui");
				this.#leases.set(root, added);
				beforeSwitch();
				if (normalizePathForComparison(added.root) !== root)
					throw new Error("The target project changed during workspace admission");
				await added.activate(() => readWebGuiSessionInfo(session), { allowLan: true, nativeSession: session });
			}
			const targetLease = this.#leases.get(root);
			const assertTarget = () => {
				const target = targetLease ? readBrowserProject(targetLease.projectId) : null;
				if (!target || target.phase !== "active" || target.nativeSession !== session || target.mode !== "webgui")
					throw new Error("The admitted native workspace is no longer active");
			};
			assertTarget();
			beforeSwitch();
			// Keep a real rollback journal even when the original session was still in memory.
			await session.sessionManager.ensureOnDisk();
			beforeSwitch();
			const previousPath = session.sessionManager.getSessionFile();
			if (!previousPath) throw new Error("The native session has no recovery journal");
			const previousCwd = session.sessionManager.getCwd();
			let committed = false;
			try {
				const switched = await session.switchSession(path, {
					onCwdChange: async newCwd => {
						// switchSession also invokes this callback after restoring its snapshot on failure.
						if (session.sessionManager.getSessionId() === previousManagerId) {
							await this.#rebind(newCwd);
							return true;
						}
						guard();
						assertTarget();
						if (
							session.sessionManager.getSessionId() !== id ||
							normalizePathForComparison(await resolveBrowserProjectRoot(newCwd)) !== root
						)
							throw new Error("The native history changed before workspace admission");
						await this.#rebind(newCwd);
						guard();
						return true;
					},
				});
				if (!switched) throw new Error("Native session recovery was cancelled");
				committed = true;
				guard();
				if (session.sessionId !== id) throw new Error("The requested native history was not restored");
			} catch (error) {
				if (committed) {
					try {
						const restored = await session.switchSession(previousPath, {
							onCwdChange: async newCwd => {
								await this.#rebind(newCwd);
								return true;
							},
						});
						if (!restored) throw new Error("Native workspace rollback was cancelled");
						if (session.sessionId !== previousId || session.sessionManager.getCwd() !== previousCwd)
							throw new Error("Native workspace rollback restored a different session");
					} catch (rollback) {
						session.beginDispose();
						throw new AggregateError(
							[error, rollback],
							"Native workspace rollback failed; the session is unavailable",
						);
					}
				}
				throw error;
			}
		} catch (error) {
			if (added && !session.isDisposed) {
				await added.close();
				this.#leases.delete(root);
			}
			throw error;
		}
	}

	/** Exit settles recovery/model mutations and releases every root, never only the current cwd. */
	async close(): Promise<void> {
		this.#exiting = true;
		for (const lease of this.#leases.values()) await lease.markExiting();
		await this.#transition?.catch(() => {});
		for (const lease of this.#leases.values()) await lease.markExiting();
		await Promise.allSettled(
			[...this.#leases.values()].flatMap(lease => [
				...(readBrowserProject(lease.projectId)?.pendingModelSelections ?? []),
			]),
		);
		const results = await Promise.allSettled([...this.#leases.values()].map(lease => lease.close()));
		const failures = results.filter(result => result.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map(result => result.reason),
				"Native workspace settlement failed",
			);
		this.#leases.clear();
		if (hosts.get(this.#session) === this) hosts.delete(this.#session);
	}
}

export function nativeCwdHost(session: AgentSession): NativeCwdHost | undefined {
	return hosts.get(session);
}
