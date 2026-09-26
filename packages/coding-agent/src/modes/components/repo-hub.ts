import { type Component, matchesKey, type TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import { RepoService } from "../../repo/service";
import type { RepoProgress, RepoStatus } from "../../repo/types";

export interface RepoHubCallbacks {
	onCancel: () => void;
}

type Confirmation = "build" | "rebuild" | "delete" | "cancel-close";
type Operation = "build" | "update" | "rebuild" | "delete";

/** User-provided paths and errors must not inject terminal controls or extra panel rows. */
function line(text: string): string {
	return sanitizeText(text).replaceAll("\t", "    ").replace(/\n+/g, " ");
}

export class RepoHubComponent implements Component {
	#status?: RepoStatus;
	#error?: string;
	#statusError?: string;
	#confirmation?: Confirmation;
	#operation?: Operation;
	#abort?: AbortController;
	#progress?: RepoProgress;
	#work?: Promise<void>;
	#disposed = false;
	#refreshVersion = 0;

	private constructor(
		private readonly tui: TUI,
		private readonly service: RepoService,
		private readonly callbacks: RepoHubCallbacks,
	) {}

	static async create(
		tui: TUI,
		cwd: string,
		settings: Settings,
		callbacks: RepoHubCallbacks,
	): Promise<RepoHubComponent> {
		const hub = new RepoHubComponent(tui, new RepoService({ agentDir: settings.getAgentDir(), cwd }), callbacks);
		// A damaged index can throw on status, but the panel must remain open so
		// the user can explicitly recover it with rebuild or remove it.
		await hub.#refresh();
		return hub;
	}

	invalidate(): void {}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abort?.abort();
		if (this.#work) void this.#work.finally(() => this.service.close());
		else this.service.close();
	}

	async #refresh(): Promise<void> {
		const version = ++this.#refreshVersion;
		try {
			const status = await this.service.status();
			if (!this.#disposed && version === this.#refreshVersion) {
				this.#status = status;
				this.#statusError = undefined;
			}
		} catch (error) {
			if (!this.#disposed && version === this.#refreshVersion) {
				this.#status = undefined;
				this.#statusError = line(
					`Unable to read repository index status: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (!this.#disposed && version === this.#refreshVersion) this.tui.requestRender();
	}

	#start(operation: Exclude<Operation, "delete">): void {
		if (this.#operation || this.#disposed) return;
		const controller = new AbortController();
		this.#abort = controller;
		this.#operation = operation;
		this.#error = undefined;
		const options = {
			signal: controller.signal,
			onProgress: (progress: RepoProgress) => {
				if (this.#disposed || this.#operation !== operation) return;
				this.#progress = progress;
				this.tui.requestRender();
			},
		};
		const work =
			operation === "build"
				? this.service.build(options)
				: operation === "update"
					? this.service.reconcile(options)
					: this.service.storage.recoveryError
						? this.service.recover(options)
						: this.service.rebuild(options);
		const pending = work
			.catch(error => {
				if (this.#operation === operation && !(error instanceof Error && error.name === "AbortError"))
					this.#error = line(error instanceof Error ? error.message : String(error));
			})
			.then(async () => {
				if (this.#operation !== operation) return;
				this.#abort = undefined;
				this.#progress = undefined;
				this.#operation = undefined;
				if (!this.#disposed) await this.#refresh();
			})
			.finally(() => {
				if (this.#work === pending) this.#work = undefined;
			});
		this.#work = pending;
		this.tui.requestRender();
	}

	#remove(): void {
		if (this.#disposed || this.#operation === "delete") return;
		// Abort the current maintenance operation and wait for its rollback and
		// lock release before deleting. No queued build may publish after removal.
		const previous = this.#work;
		this.#abort?.abort();
		this.#operation = "delete";
		this.#progress = undefined;
		this.#error = undefined;
		const pending = (async () => {
			try {
				await previous;
				await this.service.remove();
			} catch (error) {
				this.#error = line(error instanceof Error ? error.message : String(error));
			} finally {
				this.#abort = undefined;
				this.#operation = undefined;
				if (!this.#disposed) await this.#refresh();
			}
		})().finally(() => {
			if (this.#work === pending) this.#work = undefined;
		});
		this.#work = pending;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (this.#confirmation) {
			const confirmation = this.#confirmation;
			if (data.toLowerCase() === "y") {
				this.#confirmation = undefined;
				if (confirmation === "cancel-close") {
					this.#abort?.abort();
					void (this.#work ?? Promise.resolve()).finally(() => this.callbacks.onCancel());
				} else if (confirmation === "delete") this.#remove();
				else this.#start(confirmation === "build" ? "build" : "rebuild");
			} else if (data.toLowerCase() === "n" || matchesKey(data, "escape")) this.#confirmation = undefined;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.#operation) this.#confirmation = "cancel-close";
			else this.callbacks.onCancel();
		} else if (data === "c" && this.#abort) this.#abort.abort();
		else if (
			data === "d" &&
			this.#operation !== "delete" &&
			(this.#status?.exists || this.service.storage.recoveryError || this.#statusError)
		)
			this.#confirmation = "delete";
		else if (this.#operation) return;
		else if (data === "b" && !this.#status?.exists && !this.service.storage.recoveryError)
			this.#confirmation = "build";
		else if (data === "u" && this.#status?.exists) this.#start("update");
		else if (data === "r") this.#confirmation = "rebuild";
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const root = line(this.service.root);
		const lines = [
			theme.bold(theme.fg("accent", "Repository index")),
			`Root: ${root}`,
			"b build  u update (full reconcile)  r rebuild  d delete  c cancel  Esc close",
		];
		const status = this.#status;
		if (status) {
			if (!status.exists) lines.push("No repository index. Press b to build.");
			else
				lines.push(`Files: ${status.fileCount}  Symbols: ${status.symbolCount}  Generation: ${status.generation}`);
			lines.push(
				`Coverage: ${status.incomplete ? "incomplete" : "complete"}${status.unchecked ? " (unchecked)" : ""}${status.needsReconcile ? " (full reconciliation needed)" : ""}`,
				`Pending: ${status.pendingCount}${status.pendingTruncated ? "+" : ""}`,
				`Failures: ${status.failureCount}${status.failuresTruncated ? "+" : ""}`,
				`Last full check: ${status.lastFullCheck === null ? "never" : new Date(status.lastFullCheck).toISOString()}`,
				`Exclusions: ${status.exclusions.map(line).join(", ") || "none"}`,
			);
			for (const pathname of status.pendingPaths.slice(0, 3)) lines.push(`  pending ${line(pathname)}`);
			if (status.pendingCount > 3) lines.push(`  … ${status.pendingCount - 3} more pending paths`);
			for (const failure of status.failures.slice(0, 3))
				lines.push(`  ${failure.kind}: ${line(failure.path)} — ${line(failure.message)}`);
			if (status.failureCount > 3) lines.push(`  … ${status.failureCount - 3} more failures`);
			for (const reason of status.uncertainReasons.slice(0, 2)) lines.push(`  unchecked: ${line(reason)}`);
			if (status.uncertainCount > 2) lines.push(`  … ${status.uncertainCount - 2} more unchecked reasons`);
		} else if (this.service.storage.recoveryError) {
			lines.push(theme.fg("warning", "Index schema unreadable. Press r to rebuild and recover, or d to delete."));
		} else lines.push("Status unavailable. Press r to rebuild or d to delete.");
		if (this.#confirmation === "build") lines.push(theme.fg("warning", `Build repository index for ${root}? y/N`));
		else if (this.#confirmation === "rebuild")
			lines.push(theme.fg("warning", `Rebuild repository index for ${root}? y/N`));
		else if (this.#confirmation === "delete")
			lines.push(theme.fg("warning", `Delete repository index for ${root}? y/N`));
		else if (this.#confirmation === "cancel-close")
			lines.push(
				theme.fg(
					"warning",
					this.#operation === "delete"
						? "Delete in progress. Close after deletion? y/N"
						: "Indexing active. Cancel and close? y/N",
				),
			);
		if (this.#progress)
			lines.push(
				`Progress: ${this.#progress.phase} ${this.#progress.processed}/${this.#progress.total} ${line(this.#progress.path ?? "")}`,
			);
		else if (this.#operation === "delete") lines.push("Deleting repository index…");
		if (this.#error) lines.push(theme.fg("error", this.#error));
		if (this.#statusError) lines.push(theme.fg("error", this.#statusError));
		return lines.map(value => truncateToWidth(value, width));
	}
}
