/**
 * Fork-extension file search (requirement 5.7, rpc-ui-protocol.md).
 *
 * Backs the desktop `@` panel: fuzzy path search rooted at the session cwd (or
 * an explicit cwd), reusing the native `fuzzyFind` walker so the existing
 * ignore rules (gitignore/hidden policy) and the `fs-scan-cache` architecture
 * apply unchanged. Results are bounded by `limit` (default 1000) with an
 * explicit `truncated` flag.
 */
import * as path from "node:path";
import { fuzzyFind } from "@oh-my-pi/pi-natives";
import type { AgentSession } from "../../session/agent-session";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

const DEFAULT_SEARCH_LIMIT = 1000;
const MAX_SEARCH_LIMIT = 5000;

export class RpcForkSearchController {
	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
	) {
		host.registerCommand("search_paths", command => this.#searchPaths(command));
	}

	async #searchPaths(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { query, cwd, limit } = command as { query?: unknown; cwd?: unknown; limit?: unknown };
		if (typeof query !== "string") {
			return this.host.context.error(command.id, "search_paths", "query is required");
		}
		const cappedLimit = Math.min(
			Math.max(typeof limit === "number" ? limit : DEFAULT_SEARCH_LIMIT, 1),
			MAX_SEARCH_LIMIT,
		);
		const root = path.resolve(typeof cwd === "string" && cwd ? cwd : this.session.sessionManager.getCwd());
		let result: Awaited<ReturnType<typeof fuzzyFind>>;
		try {
			result = await fuzzyFind({
				query,
				path: root,
				hidden: true,
				gitignore: true,
				cache: true,
				maxResults: cappedLimit,
			});
		} catch (error) {
			return this.host.context.error(
				command.id,
				"search_paths",
				`Path search unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"search_unavailable",
			);
		}
		return this.host.context.success(command.id, "search_paths", {
			entries: result.matches.map(match => ({
				path: path.resolve(root, match.path),
				type: match.isDirectory ? ("dir" as const) : ("file" as const),
			})),
			truncated: result.totalMatches > result.matches.length,
		});
	}
}
