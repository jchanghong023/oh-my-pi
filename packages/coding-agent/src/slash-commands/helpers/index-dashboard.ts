import { createHash } from "node:crypto";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { DocsService } from "../../docs/service";
import { RepoService } from "../../repo/service";
import type { RepoProgress } from "../../repo/types";
import { formatRepoStatusLines } from "../../tools/repo";
import type { RpcSlashCommandRuntime, SlashCommandResult } from "../types";

interface IndexCommandScope {
	signal: AbortSignal;
	current: () => boolean;
	output: (text: string) => Promise<void>;
	progress: (phase: string, completed: number, total: number) => void;
	stage: (value: string) => string;
	cancel: () => void;
}

/** Keep dialogs and index maintenance attached to the session that opened them. */
function runIndexDashboard(
	name: string,
	runtime: RpcSlashCommandRuntime,
	run: (scope: IndexCommandScope) => Promise<void>,
): SlashCommandResult {
	const session = runtime.session;
	const sessionId = session.sessionId;
	const generation = session.sessionGeneration;
	const manager = session.sessionManager;
	const controller = new AbortController();
	const signal = runtime.signal ? AbortSignal.any([runtime.signal, controller.signal]) : controller.signal;
	const command = name === "/wiki" || name === "/repo" ? name : "unknown";
	const started = performance.now();
	let stage = "dashboard";
	let cancelled = false;
	const current = (): boolean => {
		if (
			session.isDisposed ||
			session.sessionId !== sessionId ||
			session.sessionGeneration !== generation ||
			session.sessionManager !== manager
		) {
			controller.abort();
		}
		return !signal.aborted;
	};
	const output = async (text: string): Promise<void> => {
		if (current()) await runtime.output(text);
	};
	let lastPhase: string | undefined;
	let lastProgressAt = 0;
	const progress = (phase: string, completed: number, total: number): void => {
		if (!current()) return;
		const now = Date.now();
		if (lastPhase === phase && now - lastProgressAt < 200 && completed !== total) return;
		lastPhase = phase;
		lastProgressAt = now;
		void output(`${name}: ${phase} ${completed}/${total}`).catch(error => {
			logger.warn("RPC index progress output failed", {
				component: "rpc",
				event: "rpc_index_progress_output_failed",
				command,
				stage: "progress_output",
				result: "failed",
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
		});
	};
	runtime.runCommandInBackground(() => {
		const inherited = logger.getLogContext();
		return logger.withLogContext(
			{
				operation_id: inherited.operation_id ?? `rpc-index-${crypto.randomUUID()}`,
				session_id:
					inherited.session_id ??
					(/^[A-Za-z0-9_-]{1,96}$/.test(sessionId)
						? sessionId
						: createHash("sha256").update(sessionId).digest("hex").slice(0, 24)),
				session_generation: generation,
				parent_call_id: inherited.call_id,
				call_id: `rpc-index-dashboard-${crypto.randomUUID()}`,
			},
			async () => {
				let failed = false;
				let failure: unknown;
				let failureStage: string | undefined;
				const fields = () => ({
					component: "rpc",
					command,
					stage: failureStage ?? stage,
					elapsed_ms: performance.now() - started,
				});
				logger.info("RPC index dashboard started", {
					...fields(),
					event: "rpc_index_dashboard_started",
					result: "started",
				});
				try {
					if (!current()) return;
					await run({
						signal,
						current,
						output,
						progress,
						stage: value => {
							const previous = stage;
							stage = value;
							return previous;
						},
						cancel: () => {
							cancelled = true;
						},
					});
				} catch (error) {
					if (current() && !(error instanceof Error && error.name === "AbortError")) {
						failed = true;
						failure = error;
						failureStage = stage;
						await output(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
					} else {
						cancelled = true;
					}
				} finally {
					if (failed) {
						logger.error("RPC index dashboard failed", {
							...fields(),
							event: "rpc_index_dashboard_failed",
							result: "failed",
							...logger.diagnosticError(failure),
						});
					} else {
						const result = cancelled || !current() ? "cancelled" : "completed";
						logger.info("RPC index dashboard ended", {
							...fields(),
							event: `rpc_index_dashboard_${result}`,
							result,
						});
					}
				}
			},
		);
	});
	return { consumed: true };
}

function line(value: string): string {
	return sanitizeText(value)
		.replaceAll("\t", "    ")
		.replace(/[\r\n]+/g, " ");
}

/** RPC dialogs replace the terminal dashboard; all indexing remains in DocsService. */
export function handleRpcWikiDashboard(runtime: RpcSlashCommandRuntime): SlashCommandResult {
	return runIndexDashboard("/wiki", runtime, async scope => {
		scope.stage("docs_service_create");
		const service = new DocsService({ agentDir: runtime.settings.getAgentDir(), cwd: runtime.cwd });
		try {
			scope.stage("docs_list");
			const indexes = service.list();
			scope.stage("index_output");
			await scope.output(
				indexes.length
					? [
							"Document indexes:",
							...indexes.map(
								index =>
									`${line(index.name)}: ${index.documentCount} documents, ${index.sectionCount} sections · ${line(index.rootPath)}`,
							),
						].join("\n")
					: "No document indexes.",
			);
			if (!scope.current()) return;
			scope.stage("action_select");
			const action = await runtime.ui.select(
				"Document indexes",
				[
					...(indexes.length ? ["Search document indexes"] : []),
					"New document index",
					...(indexes.length ? ["Delete document index"] : []),
				],
				{ signal: scope.signal },
			);
			if (!scope.current() || !action) return scope.cancel();
			if (action === "New document index") {
				scope.stage("directory_input");
				const directory = (
					await runtime.ui.input("Markdown directory", runtime.cwd, { signal: scope.signal })
				)?.trim();
				if (!scope.current() || !directory) return scope.cancel();
				scope.stage("index_name_input");
				const name = (await runtime.ui.input("Document index name", undefined, { signal: scope.signal }))?.trim();
				if (!scope.current() || !name) return scope.cancel();
				scope.stage("docs_init");
				const result = await service.init(directory, name, {
					signal: scope.signal,
					onProgress: value => scope.progress(value.phase, value.completed, value.total),
				});
				scope.stage("index_output");
				await scope.output(`Created document index ${line(result.index.name)}: ${result.processed} documents.`);
			} else if (action === "Delete document index") {
				const labels = indexes.map((index, position) => `${position + 1}. ${line(index.name)}`);
				scope.stage("index_select");
				const selected = await runtime.ui.select("Delete document index", labels, { signal: scope.signal });
				if (!scope.current() || selected === undefined) return scope.cancel();
				const index = indexes[labels.indexOf(selected)];
				if (!index) return;
				scope.stage("delete_confirm");
				const confirmed = await runtime.ui.confirm(
					"Delete document index?",
					`${line(index.name)}\nSource files are preserved.`,
					{ signal: scope.signal },
				);
				if (!scope.current() || !confirmed) return scope.cancel();
				scope.stage("docs_remove");
				service.remove(index.name);
				scope.stage("index_output");
				await scope.output(`Deleted document index ${line(index.name)}. Source files are preserved.`);
			} else if (action === "Search document indexes") {
				scope.stage("query_input");
				const query = (
					await runtime.ui.input("Search document indexes", undefined, { signal: scope.signal })
				)?.trim();
				if (!scope.current() || !query) return scope.cancel();
				scope.stage("docs_search");
				const result = service.search(query, { limit: 20 });
				scope.stage("index_output");
				await scope.output(`Section hits: ${result.total ?? result.sections.length}`);
				if (!scope.current() || !result.sections.length) return;
				const labels = result.sections.map(
					(section, position) =>
						`${position + 1}. [${line(section.index)}] ${line(section.path)}:${section.lineStart}-${section.lineEnd} ${line(section.headingPath)}`,
				);
				scope.stage("section_select");
				const selected = await runtime.ui.select("Document sections", labels, { signal: scope.signal });
				if (!scope.current() || selected === undefined) return scope.cancel();
				const section = result.sections[labels.indexOf(selected)];
				if (section) {
					scope.stage("section_output");
					await scope.output(
						`[${line(section.index)}] ${line(section.path)}:${section.lineStart}-${section.lineEnd} ${line(section.headingPath)}\n\n${section.text}`,
					);
				}
			}
		} finally {
			const previous = scope.stage("docs_close");
			service.close();
			scope.stage(previous);
		}
	});
}

/** User-confirmed repository maintenance uses the same service as the TUI panel. */
export function handleRpcRepoDashboard(runtime: RpcSlashCommandRuntime): SlashCommandResult {
	return runIndexDashboard("/repo", runtime, async scope => {
		scope.stage("repo_service_create");
		const service = new RepoService({ agentDir: runtime.settings.getAgentDir(), cwd: runtime.cwd });
		// Closing aborts the service's in-flight/lock-waiting operation, including removal.
		const close = () => {
			const previous = scope.stage("repo_close");
			service.close();
			scope.stage(previous);
		};
		scope.signal.addEventListener("abort", close, { once: true });
		try {
			let exists = false;
			const statusStarted = performance.now();
			try {
				scope.stage("repo_status");
				const status = await service.status();
				exists = status.exists;
				scope.stage("index_output");
				await scope.output(formatRepoStatusLines(status).join("\n"));
			} catch (error) {
				const failedStage = scope.stage("status_error_output");
				logger.error("RPC repository dashboard status failed", {
					component: "rpc",
					event: "rpc_index_dashboard_stage_failed",
					command: "/repo",
					stage: failedStage,
					result: "failed",
					elapsed_ms: performance.now() - statusStarted,
					...logger.diagnosticError(error),
				});
				await scope.output(
					`Root: ${line(service.root)}\nUnable to read repository index status: ${line(String(error))}`,
				);
			}
			if (!scope.current()) return;
			const recovery = Boolean(service.storage.recoveryError);
			scope.stage("action_select");
			const action = await runtime.ui.select(
				"Repository index",
				[
					...(!exists && !recovery ? ["Build repository index"] : []),
					...(exists ? ["Update repository index"] : []),
					"Rebuild repository index",
					...(exists || recovery ? ["Delete repository index"] : []),
				],
				{ signal: scope.signal },
			);
			if (!scope.current() || !action) return scope.cancel();
			if (action !== "Update repository index") {
				if (!["Build repository index", "Rebuild repository index", "Delete repository index"].includes(action))
					return;
				scope.stage("maintenance_confirm");
				const confirmed = await runtime.ui.confirm(`${action}?`, `Root: ${line(service.root)}`, {
					signal: scope.signal,
				});
				if (!scope.current() || !confirmed) return scope.cancel();
			}
			const options = {
				signal: scope.signal,
				onProgress: (value: RepoProgress) => scope.progress(value.phase, value.processed, value.total),
			};
			if (action === "Delete repository index") {
				scope.stage("repo_remove");
				await service.remove();
				scope.stage("index_output");
				await scope.output("Deleted repository index. Project files are preserved.");
			} else {
				scope.stage(
					action === "Build repository index"
						? "repo_build"
						: action === "Update repository index"
							? "repo_reconcile"
							: recovery
								? "repo_recover"
								: "repo_rebuild",
				);
				const status =
					action === "Build repository index"
						? await service.build(options)
						: action === "Update repository index"
							? await service.reconcile(options)
							: recovery
								? await service.recover(options)
								: await service.rebuild(options);
				scope.stage("index_output");
				await scope.output(`${action} complete.\n${formatRepoStatusLines(status).join("\n")}`);
			}
		} finally {
			scope.signal.removeEventListener("abort", close);
			close();
		}
	});
}
