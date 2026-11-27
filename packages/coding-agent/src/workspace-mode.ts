import * as os from "node:os";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isRecord, prompt, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { type LocalProtocolOptions, resolveLocalRoot } from "./internal-urls/local-protocol";
import workspaceModeActivePrompt from "./prompts/system/workspace-mode-active.md" with { type: "text" };
import type { CustomMessage } from "./session/messages";
import type { SessionEntry } from "./session/session-entries";

export interface WorkspaceModeScope {
	projectRoot: string | null;
	allowedRoots: string[];
}

export interface WorkspaceModeState {
	enabled: boolean;
	inheritedScope?: WorkspaceModeScope;
}

export const WORKSPACE_MODE_STATE_TYPE = "workspace_mode_state";
export const WORKSPACE_MODE_CONTEXT_TYPE = "workspace-mode-context";

/** Entries must be the active branch, in session order, not the complete session tree. */
export function restoreWorkspaceModeState(entries: readonly SessionEntry[]): WorkspaceModeState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== WORKSPACE_MODE_STATE_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data) || typeof data.enabled !== "boolean") return { enabled: false };
		if (data.inheritedScope === undefined) return { enabled: data.enabled };
		const scope = data.inheritedScope;
		if (
			!isRecord(scope) ||
			(scope.projectRoot !== null && typeof scope.projectRoot !== "string") ||
			!Array.isArray(scope.allowedRoots) ||
			!scope.allowedRoots.every((root): root is string => typeof root === "string" && root.length > 0)
		) {
			return { enabled: false };
		}
		return {
			enabled: data.enabled,
			inheritedScope: { projectRoot: scope.projectRoot, allowedRoots: [...scope.allowedRoots] },
		};
	}
	return { enabled: false };
}

/** Inherited scopes never discover or trust a repository from the child's cwd. */
export async function resolveWorkspaceModeScope(
	cwd: string,
	localOptions: LocalProtocolOptions,
	inheritedScope?: WorkspaceModeScope,
): Promise<WorkspaceModeScope> {
	let projectRoot = inheritedScope?.projectRoot ?? null;
	if (!inheritedScope) {
		try {
			projectRoot = vcs.gitInfo(cwd)?.repoRoot ?? null;
		} catch {
			// A broken .git pointer grants no project write root.
		}
	}
	const canonicalProjectRoot =
		inheritedScope || projectRoot === null
			? projectRoot
			: resolveEquivalentPath(projectRoot, { throughMissing: true });
	const roots = inheritedScope ? inheritedScope.allowedRoots : canonicalProjectRoot ? [canonicalProjectRoot] : [];
	// A child's inherited roots are a snapshot. Resolve only the child's new roots.
	const allowedRoots: string[] = [];
	const seen = new Set<string>();
	const localRoots = [os.tmpdir(), resolveLocalRoot(localOptions)].map(root =>
		resolveEquivalentPath(root, { throughMissing: true }),
	);
	for (const canonical of [...roots, ...localRoots]) {
		const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
		if (seen.has(key)) continue;
		seen.add(key);
		allowedRoots.push(canonical);
	}
	return { projectRoot: canonicalProjectRoot, allowedRoots };
}

export function buildWorkspaceModeMessage(scope: WorkspaceModeScope): CustomMessage {
	return {
		role: "custom",
		customType: WORKSPACE_MODE_CONTEXT_TYPE,
		content: prompt.render(workspaceModeActivePrompt, {
			projectRoot: scope.projectRoot,
			allowedRoots: scope.allowedRoots,
		}),
		display: false,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

export function isWorkspaceModeContext(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === WORKSPACE_MODE_CONTEXT_TYPE;
}
