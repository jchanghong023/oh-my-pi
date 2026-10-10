import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
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
		this.#unsubscribe = subscribeFsMutation((paths, uncertaintyReason) => this.#changed(paths, uncertaintyReason));
		this.onSessionChange();
	}

	#current(): RepoService | undefined {
		if (this.#disposed) return undefined;
		const cwd = this.#getCwd();
		if (cwd !== this.#cwd) {
			this.#service?.close();
			this.#service = undefined;
			this.#cwd = undefined;
			this.#root = undefined;
			this.#indexPath = undefined;
			// Invalidate the old cwd before resolution so a missing new directory
			// retries on the next hint, even if the session returns to the old cwd.
			const root = resolveRepoRoot(cwd);
			this.#cwd = cwd;
			this.#root = root;
			this.#indexPath = repoIndexPath(this.#agentDir, root);
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
		const context = logger.getLogContext();
		logger.withLogContext(
			{
				operation_id: context.operation_id ?? `repo-hint-${randomUUID()}`,
				repo_hint_source: action,
			},
			() => {
				const started = performance.now();
				logger.info("Repository lifecycle hint started", {
					component: "repo_lifecycle",
					event: "repo_hint",
					stage: "notification",
					result: "started",
					source: action,
				});
				try {
					operation();
					logger.info("Repository lifecycle hint completed", {
						component: "repo_lifecycle",
						event: "repo_hint",
						stage: "notification",
						result: "completed",
						source: action,
						elapsed_ms: performance.now() - started,
					});
				} catch (error) {
					logger.warn("Repository index maintenance hint failed", {
						component: "repo_lifecycle",
						event: "repo_hint",
						stage: "notification",
						result: "failed",
						source: action,
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					try {
						this.#service?.markUncertain(`Index maintenance hint failed (${action}); reconcile required`);
					} catch (uncertaintyError) {
						logger.warn("Repository index could not record uncertainty", {
							component: "repo_lifecycle",
							event: "repo_hint",
							stage: "uncertainty",
							result: "failed",
							...logger.diagnosticError(uncertaintyError),
						});
					}
				}
			},
		);
	}

	#changed(paths: readonly string[], uncertaintyReason?: string): void {
		this.#safely("filesystem mutation", () => {
			const service = this.#current();
			logger.info("Repository filesystem hint received", {
				component: "repo_lifecycle",
				event: "repo_notification",
				stage: "filesystem",
				result: "received",
				notification_count: paths.length,
				uncertainty_present: Boolean(uncertaintyReason),
				index_available: Boolean(service),
			});
			if (!service?.storage.state().generation) {
				logger.info("Repository hint has no published index", {
					component: "repo_lifecycle",
					event: "repo_notification",
					stage: "filesystem",
					result: "missing",
				});
				return;
			}
			service.markChanged(paths.filter(path.isAbsolute));
			if (uncertaintyReason) service.markUncertain(uncertaintyReason);
		});
	}

	/** Called only after a session/cwd switch commits, not during a possible rollback. */
	onSessionChange(): void {
		this.#safely("session transition", () => {
			const service = this.#current();
			if (!service?.storage.state().generation) {
				logger.info("Repository hint has no published index", {
					component: "repo_lifecycle",
					event: "repo_notification",
					stage: "session",
					result: "missing",
				});
				return;
			}
			// A closed session may have missed edits (including in a non-Git tree).
			// Cheap VCS hints are candidates, never proof of full coverage.
			service.markUncertain(
				"Session transition may have missed external repository changes; reconcile to verify coverage",
			);
			this.#discover(service, "session");
		});
	}

	/**
	 * Arbitrary code and shell commands can mutate files; command text is never
	 * parsed for paths. `git` reports the built-in JCH git slash commands, which
	 * run git directly and bypass the bash/eval tool pipeline.
	 */
	commandExecuted(kind: "bash" | "eval" | "git", cwd?: string): void {
		this.#safely(`${kind} execution`, () => {
			const service = this.#current();
			if (!service?.storage.state().generation) {
				logger.info("Repository hint has no published index", {
					component: "repo_lifecycle",
					event: "repo_notification",
					stage: "command",
					result: "missing",
					source: kind,
				});
				return;
			}
			service.markUncertain(`${kind} execution may have modified repository files; reconcile to verify coverage`);
			// Commands may run outside the session's working directory. The scope is
			// still marked uncertain; Git hints are merely candidates, not proof.
			// win32 path.relative across drive letters returns an absolute path.
			if (cwd) {
				const rel = path.relative(service.root, cwd);
				if (!path.isAbsolute(cwd) || path.isAbsolute(rel) || rel.startsWith("..")) {
					logger.info("Repository Git discovery skipped outside scope", {
						component: "repo_lifecycle",
						event: "repo_discovery_hint",
						stage: "scope",
						result: "outside_scope",
						source: kind,
					});
					return;
				}
			}
			this.#discover(service, kind);
		});
	}

	#discover(service: RepoService, source: "session" | "bash" | "eval" | "git" | "coalesced"): void {
		if (this.#discoveryService === service) {
			this.#discoveryRequested = true;
			logger.info("Repository discovery hint coalesced", {
				component: "repo_lifecycle",
				event: "repo_discovery_hint",
				stage: "queue",
				result: "coalesced",
				source,
			});
			return;
		}
		this.#discoveryRequested = false;
		this.#discoveryService = service;
		const started = performance.now();
		let result = "completed";
		logger.info("Repository lifecycle discovery started", {
			component: "repo_lifecycle",
			event: "repo_discovery_hint",
			stage: "discover",
			result: "started",
			source,
		});
		void service
			.discoverChanges()
			.catch(error => {
				result = this.#disposed ? "closed" : this.#discoveryService !== service ? "stale" : "failed";
				logger[result === "failed" ? "warn" : "info"]("Repository lifecycle discovery rejected", {
					component: "repo_lifecycle",
					event: "repo_discovery_hint",
					stage: "discover",
					result,
					source,
					elapsed_ms: performance.now() - started,
					...logger.diagnosticError(error),
				});
				if (this.#disposed || this.#discoveryService !== service) return;
				this.#safely("VCS discovery", () => service.markUncertain(`VCS hint discovery failed: ${String(error)}`));
			})
			.finally(() => {
				logger.info("Repository lifecycle discovery ended", {
					component: "repo_lifecycle",
					event: "repo_discovery_hint",
					stage: "discover",
					result: this.#disposed ? "closed" : this.#discoveryService !== service ? "stale" : result,
					source,
					elapsed_ms: performance.now() - started,
				});
				if (this.#discoveryService !== service) return;
				this.#discoveryService = undefined;
				if (this.#discoveryRequested && !this.#disposed && this.#service === service)
					this.#discover(service, "coalesced");
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
