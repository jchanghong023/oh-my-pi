import type { CompletedSet } from './types.js';
import type { ArtifactGraph } from './graph.js';
/**
 * Detects which artifacts are completed by checking file existence in the change directory.
 * Returns a Set of completed artifact IDs.
 *
 * @param graph - The artifact graph to check
 * @param changeDir - The change directory to scan for files
 * @returns Set of artifact IDs whose generated files exist
 */
export declare function detectCompleted(graph: ArtifactGraph, changeDir: string): CompletedSet;
//# sourceMappingURL=state.d.ts.map