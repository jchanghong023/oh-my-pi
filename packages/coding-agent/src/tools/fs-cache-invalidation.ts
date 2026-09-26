import { invalidateFsScanCache } from "@oh-my-pi/pi-natives";
import * as logger from "@oh-my-pi/pi-utils/logger";

/** Post-commit local filesystem changes (not pre-write diagnostic version bumps). */
const mutationListeners = new Set<(paths: readonly string[]) => void>();

export function subscribeFsMutation(listener: (paths: readonly string[]) => void): () => void {
	mutationListeners.add(listener);
	return () => mutationListeners.delete(listener);
}

function notifyMutation(paths: readonly string[]): void {
	// A successful source mutation must never be reported as failed by indexing.
	for (const listener of mutationListeners) {
		try {
			listener(paths);
		} catch (error) {
			logger.warn("Filesystem mutation observer failed after source change", { error: String(error) });
		}
	}
}

/** Also used by native AST edits after their deferred apply actually commits. */
export function invalidateFsScanAfterWrites(paths: readonly string[]): void {
	for (const path of paths) invalidateFsScanCache(path);
	if (paths.length) notifyMutation(paths);
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
