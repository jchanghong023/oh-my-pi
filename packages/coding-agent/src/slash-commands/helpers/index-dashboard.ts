import { createHash } from "node:crypto";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { KnowledgeService } from "../../knowledge/service";
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
	runtime: RpcSlashCommandRuntime,
	run: (scope: IndexCommandScope) => Promise<void>,
): SlashCommandResult {
	const session = runtime.session;
	const sessionId = session.sessionId;
	const generation = session.sessionGeneration;
	const manager = session.sessionManager;
	const controller = new AbortController();
	const signal = runtime.signal ? AbortSignal.any([runtime.signal, controller.signal]) : controller.signal;
	const command = "/knowledge";
	const started = performance.now();
	let stage = "dashboard";
	let cancelled = false;
	const attached = (): boolean => {
		if (
			session.isDisposed ||
			session.sessionId !== sessionId ||
			session.sessionGeneration !== generation ||
			session.sessionManager !== manager
		) {
			controller.abort();
			return false;
		}
		return true;
	};
	const current = (): boolean => attached() && !signal.aborted;
	const output = async (text: string, outputStage = stage, allowCancelled = false): Promise<void> => {
		if (!(allowCancelled ? attached() : current())) return;
		try {
			await runtime.output(text);
		} catch (error) {
			logger.warn("RPC index dashboard output failed", {
				component: "rpc",
				event:
					outputStage === "progress_output"
						? "rpc_index_progress_output_failed"
						: "rpc_index_dashboard_output_failed",
				command,
				stage: outputStage,
				result: "failed",
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
		}
	};
	let lastPhase: string | undefined;
	let lastProgressAt = 0;
	const progress = (phase: string, completed: number, total: number): void => {
		if (!current()) return;
		const now = Date.now();
		if (lastPhase === phase && now - lastProgressAt < 200 && completed !== total) return;
		lastPhase = phase;
		lastProgressAt = now;
		void output(`${command}: ${phase} ${completed}/${total}`, "progress_output");
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
						await output(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
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
						if (result === "cancelled") await output(`${command} cancelled.`, "cancel_output", true);
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

/** RPC dialogs replace the terminal dashboard; all indexing remains in KnowledgeService. */
export function handleRpcKnowledgeDashboard(runtime: RpcSlashCommandRuntime): SlashCommandResult {
	return runIndexDashboard(runtime, async scope => {
		scope.stage("knowledge_service_create");
		const service = new KnowledgeService({ agentDir: runtime.settings.getAgentDir(), cwd: runtime.cwd });
		try {
			scope.stage("knowledge_list");
			const indexes = await service.list({ signal: scope.signal });
			if (!scope.current()) return;
			scope.stage("index_output");
			await scope.output(
				indexes.length
					? [
							"Knowledge indexes:",
							...indexes.map(
								index =>
									`${line(index.name)}: ${index.documentCount} documents, ${index.sectionCount} sections · ${line(index.rootPath)}`,
							),
						].join("\n")
					: "No knowledge indexes.",
			);
			if (!scope.current()) return;
			scope.stage("action_select");
			const action = await runtime.ui.select(
				"Knowledge indexes",
				[
					...(indexes.length ? ["Search knowledge indexes", "Grep knowledge indexes"] : []),
					"New knowledge index",
					...(indexes.length ? ["Delete knowledge index"] : []),
				],
				{ signal: scope.signal },
			);
			if (!scope.current() || !action) return scope.cancel();
			if (action === "New knowledge index") {
				scope.stage("directory_input");
				const directory = (
					await runtime.ui.input("Markdown directory", runtime.cwd, { signal: scope.signal })
				)?.trim();
				if (!scope.current() || !directory) return scope.cancel();
				scope.stage("index_name_input");
				const name = (await runtime.ui.input("Knowledge index name", undefined, { signal: scope.signal }))?.trim();
				if (!scope.current() || !name) return scope.cancel();
				scope.stage("knowledge_init");
				const result = await service.init(directory, name, {
					signal: scope.signal,
					onProgress: value => scope.progress(value.phase, value.completed, value.total),
				});
				if (!scope.current()) return;
				scope.stage("index_output");
				await scope.output(`Created knowledge index ${line(result.index.name)}: ${result.processed} documents.`);
				if (!scope.current()) return;
			} else if (action === "Delete knowledge index") {
				const labels = indexes.map((index, position) => `${position + 1}. ${line(index.name)}`);
				scope.stage("index_select");
				const selected = await runtime.ui.select("Delete knowledge index", labels, { signal: scope.signal });
				if (!scope.current() || selected === undefined) return scope.cancel();
				const index = indexes[labels.indexOf(selected)];
				if (!index) return;
				scope.stage("delete_confirm");
				const confirmed = await runtime.ui.confirm(
					"Delete knowledge index?",
					`${line(index.name)}\nSource files are preserved.`,
					{ signal: scope.signal },
				);
				if (!scope.current() || !confirmed) return scope.cancel();
				scope.stage("knowledge_remove");
				await service.remove(index.name, { signal: scope.signal });
				if (!scope.current()) return;
				scope.stage("index_output");
				await scope.output(`Deleted knowledge index ${line(index.name)}. Source files are preserved.`);
				if (!scope.current()) return;
			} else if (action === "Search knowledge indexes" || action === "Grep knowledge indexes") {
				const mode = action === "Grep knowledge indexes" ? "grep" : "search";
				scope.stage("query_input");
				const input = await runtime.ui.input(action, undefined, { signal: scope.signal });
				const query = mode === "grep" ? input : input?.trim();
				if (!scope.current() || query === undefined || (mode === "search" && !query)) return scope.cancel();
				let cursor: string | undefined;
				let pageStart = 0;
				while (scope.current()) {
					scope.stage("knowledge_search");
					const result = await service.search(query, {
						limit: 20,
						cursor,
						signal: scope.signal,
						mode,
						case: true,
					});
					if (!scope.current()) return;
					scope.stage("index_output");
					await scope.output(
						[
							`Section hits: ${result.total} · showing ${result.sections.length ? pageStart + 1 : 0}-${pageStart + result.sections.length}`,
							...(result.technicalName
								? [
										`Full name: ${line(result.technicalName)} · exact-name matches: ${result.exactNameMatches}`,
										...(result.exactNameMatches === 0 ? ["未找到完整名称命中"] : []),
									]
								: []),
							result.cursor ? "More results available. Select Next page to continue." : "Results exhausted.",
						].join("\n"),
					);
					if (!scope.current() || !result.sections.length) return;
					const labels = result.sections.map(
						(section, position) =>
							`${pageStart + position + 1}. [${section.matchKind}] [${line(section.index)}] ${line(section.path)}:${section.lineStart}-${section.lineEnd} ${line(section.headingPath)}`,
					);
					while (scope.current()) {
						scope.stage("section_select");
						const selected = await runtime.ui.select(
							"Knowledge sections",
							[...labels, ...(result.cursor ? ["Next page"] : []), "Done browsing"],
							{ signal: scope.signal },
						);
						if (!scope.current() || selected === undefined) return scope.cancel();
						if (selected === "Done browsing") return;
						if (selected === "Next page" && result.cursor) {
							cursor = result.cursor;
							pageStart += result.sections.length;
							break;
						}
						const section = result.sections[labels.indexOf(selected)];
						if (!section) return;
						scope.stage("section_output");
						await scope.output(
							`[${section.matchKind}] [${line(section.index)}] ${line(section.path)}:${section.lineStart}-${section.lineEnd} ${line(section.headingPath)}\nsha256=${section.documentHash} · sectionId=${section.sectionId}\n\n${section.text}`,
						);
						if (!scope.current()) return;
					}
				}
			}
		} finally {
			const previous = scope.stage("knowledge_close");
			await service.close();
			scope.stage(previous);
		}
	});
}
