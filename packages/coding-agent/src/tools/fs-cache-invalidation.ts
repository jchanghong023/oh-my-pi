import { invalidateFsScanCache } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

/** Post-commit changes, or possible partial writes explicitly marked uncertain. */
const mutationListeners = new Set<(paths: readonly string[], uncertaintyReason?: string) => void>();

export function subscribeFsMutation(
	listener: (paths: readonly string[], uncertaintyReason?: string) => void,
): () => void {
	mutationListeners.add(listener);
	return () => mutationListeners.delete(listener);
}

function notifyMutation(paths: readonly string[], uncertaintyReason?: string): void {
	const context = logger.getLogContext();
	logger.withLogContext(
		{
			operation_id: context.operation_id ?? `fs-mutation-${crypto.randomUUID()}`,
			mutation_id: crypto.randomUUID(),
		},
		() => {
			const started = performance.now();
			const fields = {
				component: "fs_cache_invalidation",
				stage: "mutation_notify",
				path_count: paths.length,
				listener_count: mutationListeners.size,
				index_uncertain: uncertaintyReason !== undefined,
				uncertainty_source:
					uncertaintyReason === undefined
						? undefined
						: context.mutation_source === "ast_edit"
							? "ast_edit_apply_failure"
							: "caller",
				...(uncertaintyReason !== undefined
					? { candidate_count: paths.length, reported_written_count: "unknown", possible_partial_write: true }
					: {}),
			};
			logger.info("Filesystem mutation notification started", {
				...fields,
				event: "fs_mutation_notify_started",
				result: "started",
			});
			let notifiedCount = 0;
			let failedCount = 0;
			let firstFailure: Record<string, unknown> | undefined;
			// A successful source mutation must never be reported as failed by indexing.
			for (const listener of mutationListeners) {
				try {
					listener(paths, uncertaintyReason);
					notifiedCount++;
				} catch (error) {
					failedCount++;
					firstFailure ??= logger.diagnosticError(error);
				}
			}
			const resultFields = {
				...fields,
				event: failedCount ? "fs_mutation_notify_failed" : "fs_mutation_notify_completed",
				result: failedCount ? "observer_failed" : "completed",
				elapsed_ms: performance.now() - started,
				notified_listener_count: notifiedCount,
				failed_listener_count: failedCount,
				...firstFailure,
			};
			if (failedCount) logger.warn("Filesystem mutation observers failed after source change", resultFields);
			else if (uncertaintyReason !== undefined)
				logger.warn("Filesystem mutation index coverage uncertain", resultFields);
			else logger.info("Filesystem mutation notification completed", resultFields);
		},
	);
}

/** Also used by native AST edits after their deferred apply actually commits. */
export function invalidateFsScanAfterWrites(paths: readonly string[]): void {
	for (const path of paths) invalidateFsScanCache(path);
	if (paths.length) notifyMutation(paths);
}

/** Failed multi-file writes may have committed only a subset of their candidates. */
export function invalidateFsScanAfterUncertainWrites(paths: readonly string[], reason: string): void {
	for (const path of paths) invalidateFsScanCache(path);
	notifyMutation(paths, reason);
}

/**
 * Invalidate shared filesystem scan caches after a content write/update.
 */
export function invalidateFsScanAfterWrite(path: string): void {
	invalidateFsScanCache(path);
	notifyMutation([path]);
}

/**
 * Invalidate shared filesystem scan caches after deleting a file.
 */
export function invalidateFsScanAfterDelete(path: string): void {
	invalidateFsScanCache(path);
	notifyMutation([path]);
}

/**
 * Invalidate shared filesystem scan caches after a rename/move.
 *
 * Some watchers care about the disappearance at the old path; others about the
 * appearance at the new one. Bust both to keep callers honest.
 */
export function invalidateFsScanAfterRename(oldPath: string, newPath: string): void {
	invalidateFsScanCache(oldPath);
	if (newPath !== oldPath) invalidateFsScanCache(newPath);
	notifyMutation(newPath === oldPath ? [oldPath] : [oldPath, newPath]);
}
