import { existsSync } from "node:fs";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { subscribeFsMutation } from "../tools/fs-cache-invalidation";
import { RepoService, resolveRepoRoot } from "./service";
import { repoIndexPath } from "./storage";

/** Session-owned index hints. Never creates an index or scans the source tree at query time. */
export class RepoLifecycle {
	readonly #agentDir: string;
	readonly #getCwd: () => string;
	#service?: RepoService;
	#cwd?: string;
	#root?: string;
	#indexPath?: string;
	#unsubscribe?: () => void;
	#disposed = false;
	#discoveryService?: RepoService;
	#discoveryRequested = false;

	constructor(options: { agentDir: string; getCwd: () => string }) {
		this.#agentDir = options.agentDir;
		this.#getCwd = options.getCwd;
	}

	/** Attach at session startup; only an already-existing database receives hints. */
	start(): void {
		if (this.#disposed || this.#unsubscribe) return;
		this.#unsubscribe = subscribeFsMutation(paths => this.#changed(paths));
		this.onSessionChange();
	}

	#current(): RepoService | undefined {
		if (this.#disposed) return undefined;
		const cwd = this.#getCwd();
		if (cwd !== this.#cwd) {
			this.#service?.close();
			this.#service = undefined;
			this.#cwd = cwd;
			this.#root = resolveRepoRoot(cwd);
			this.#indexPath = repoIndexPath(this.#agentDir, this.#root);
		}
		if (this.#service?.storage.recoveryError) {
			// An independently recovered index replaces its database file; reopen this
			// cached broken handle so subsequent edit hints reach the new generation.
			this.#service.close();
			this.#service = undefined;
		}
		if (this.#service) return this.#service;
		if (!this.#indexPath || !existsSync(this.#indexPath)) return undefined;
		this.#service = new RepoService({ agentDir: this.#agentDir, cwd, root: this.#root });
		return this.#service;
	}

	#safely(action: string, operation: () => void): void {
		try {
			operation();
		} catch (error) {
			logger.warn("Repository index maintenance hint failed", { action, error: String(error) });
			try {
				this.#service?.markUncertain(`Index maintenance hint failed (${action}); reconcile required`);
			} catch (uncertaintyError) {
				logger.warn("Repository index could not record uncertainty", { error: String(uncertaintyError) });
			}
		}
	}

	#changed(paths: readonly string[]): void {
		this.#safely("filesystem mutation", () => {
			const service = this.#current();
			if (service?.storage.state().generation) service.markChanged(paths.filter(path.isAbsolute));
		});
	}

	/** Called only after a session/cwd switch commits, not during a possible rollback. */
	onSessionChange(): void {
		this.#safely("session transition", () => {
			const service = this.#current();
			if (!service?.storage.state().generation) return;
			// A closed session may have missed edits (including in a non-Git tree).
			// Cheap VCS hints are candidates, never proof of full coverage.
			service.markUncertain(
				"Session transition may have missed external repository changes; reconcile to verify coverage",
			);
			this.#discover(service);
		});
	}

	/** Arbitrary code and shell commands can mutate files; command text is never parsed for paths. */
	commandExecuted(kind: "bash" | "eval", cwd?: string): void {
		this.#safely(`${kind} execution`, () => {
			const service = this.#current();
			if (!service?.storage.state().generation) return;
			service.markUncertain(`${kind} execution may have modified repository files; reconcile to verify coverage`);
			// Commands may run outside the session's working directory. The scope is
			// still marked uncertain; Git hints are merely candidates, not proof.
			if (cwd && (!path.isAbsolute(cwd) || path.relative(service.root, cwd).startsWith(".."))) return;
			this.#discover(service);
		});
	}

	#discover(service: RepoService): void {
		if (this.#discoveryService === service) {
			this.#discoveryRequested = true;
			return;
		}
		this.#discoveryRequested = false;
		this.#discoveryService = service;
		void service
			.discoverChanges()
			.catch(error => {
				if (this.#disposed || this.#discoveryService !== service) return;
				this.#safely("VCS discovery", () => service.markUncertain(`VCS hint discovery failed: ${String(error)}`));
			})
			.finally(() => {
				if (this.#discoveryService !== service) return;
				this.#discoveryService = undefined;
				if (this.#discoveryRequested && !this.#disposed && this.#service === service) this.#discover(service);
			});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#service?.close();
		this.#service = undefined;
	}
}
