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
			logger.warn("RPC index progress output failed", { command: name, error: String(error) });
		});
	};
	runtime.runCommandInBackground(async () => {
		if (!current()) return;
		try {
			await run({ signal, current, output, progress });
		} catch (error) {
			if (current() && !(error instanceof Error && error.name === "AbortError")) {
				await output(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
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
		const service = new DocsService({ agentDir: runtime.settings.getAgentDir(), cwd: runtime.cwd });
		try {
			const indexes = service.list();
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
			const action = await runtime.ui.select(
				"Document indexes",
				[
					...(indexes.length ? ["Search document indexes"] : []),
					"New document index",
					...(indexes.length ? ["Delete document index"] : []),
				],
				{ signal: scope.signal },
			);
			if (!scope.current() || !action) return;
			if (action === "New document index") {
				const directory = (
					await runtime.ui.input("Markdown directory", runtime.cwd, { signal: scope.signal })
				)?.trim();
				if (!scope.current() || !directory) return;
				const name = (await runtime.ui.input("Document index name", undefined, { signal: scope.signal }))?.trim();
				if (!scope.current() || !name) return;
				const result = await service.init(directory, name, {
					signal: scope.signal,
					onProgress: value => scope.progress(value.phase, value.completed, value.total),
				});
				await scope.output(`Created document index ${line(result.index.name)}: ${result.processed} documents.`);
			} else if (action === "Delete document index") {
				const labels = indexes.map((index, position) => `${position + 1}. ${line(index.name)}`);
				const selected = await runtime.ui.select("Delete document index", labels, { signal: scope.signal });
				if (!scope.current() || selected === undefined) return;
				const index = indexes[labels.indexOf(selected)];
				if (!index) return;
				const confirmed = await runtime.ui.confirm(
					"Delete document index?",
					`${line(index.name)}\nSource files are preserved.`,
					{ signal: scope.signal },
				);
				if (!scope.current() || !confirmed) return;
				service.remove(index.name);
				await scope.output(`Deleted document index ${line(index.name)}. Source files are preserved.`);
			} else if (action === "Search document indexes") {
				const query = (
					await runtime.ui.input("Search document indexes", undefined, { signal: scope.signal })
				)?.trim();
				if (!scope.current() || !query) return;
				const result = service.search(query, { limit: 20 });
				await scope.output(`Section hits: ${result.total ?? result.sections.length}`);
				if (!scope.current() || !result.sections.length) return;
				const labels = result.sections.map(
					(section, position) =>
						`${position + 1}. [${line(section.index)}] ${line(section.path)}:${section.lineStart}-${section.lineEnd} ${line(section.headingPath)}`,
				);
				const selected = await runtime.ui.select("Document sections", labels, { signal: scope.signal });
				if (!scope.current() || selected === undefined) return;
				const section = result.sections[labels.indexOf(selected)];
				if (section) {
					await scope.output(
						`[${line(section.index)}] ${line(section.path)}:${section.lineStart}-${section.lineEnd} ${line(section.headingPath)}\n\n${section.text}`,
					);
				}
			}
		} finally {
			service.close();
		}
	});
}

/** User-confirmed repository maintenance uses the same service as the TUI panel. */
export function handleRpcRepoDashboard(runtime: RpcSlashCommandRuntime): SlashCommandResult {
	return runIndexDashboard("/repo", runtime, async scope => {
		const service = new RepoService({ agentDir: runtime.settings.getAgentDir(), cwd: runtime.cwd });
		// Closing aborts the service's in-flight/lock-waiting operation, including removal.
		const close = () => service.close();
		scope.signal.addEventListener("abort", close, { once: true });
		try {
			let exists = false;
			try {
				const status = await service.status();
				exists = status.exists;
				await scope.output(formatRepoStatusLines(status).join("\n"));
			} catch (error) {
				await scope.output(
					`Root: ${line(service.root)}\nUnable to read repository index status: ${line(String(error))}`,
				);
			}
			if (!scope.current()) return;
			const recovery = Boolean(service.storage.recoveryError);
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
			if (!scope.current() || !action) return;
			if (action !== "Update repository index") {
				if (!["Build repository index", "Rebuild repository index", "Delete repository index"].includes(action))
					return;
				const confirmed = await runtime.ui.confirm(`${action}?`, `Root: ${line(service.root)}`, {
					signal: scope.signal,
				});
				if (!scope.current() || !confirmed) return;
			}
			const options = {
				signal: scope.signal,
				onProgress: (value: RepoProgress) => scope.progress(value.phase, value.processed, value.total),
			};
			if (action === "Delete repository index") {
				await service.remove();
				await scope.output("Deleted repository index. Project files are preserved.");
			} else {
				const status =
					action === "Build repository index"
						? await service.build(options)
						: action === "Update repository index"
							? await service.reconcile(options)
							: recovery
								? await service.recover(options)
								: await service.rebuild(options);
				await scope.output(`${action} complete.\n${formatRepoStatusLines(status).join("\n")}`);
			}
		} finally {
			scope.signal.removeEventListener("abort", close);
			service.close();
		}
	});
}
