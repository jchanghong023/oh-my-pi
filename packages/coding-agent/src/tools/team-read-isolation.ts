import * as path from "node:path";
import type { Tool, ToolSession } from ".";
import { InternalUrlRouter } from "../internal-urls";
import { sessionResolveContext } from "../internal-urls/context";
import { resolveLocalRoot } from "../internal-urls/local-protocol";
import {
	expandDelimitedPathEntries,
	expandPath,
	parseFindPattern,
	parseSearchPathPreferringLiteral,
	resolveReadPathAsync,
	resolveSyscallTarget,
	splitPathAndSelPreferringLiteral,
} from "./path-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const ISOLATED_SEARCH_TOOLS: Record<string, true> = { grep: true, glob: true, ast_grep: true };

function contains(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonical(target: string): Promise<string> {
	const resolved = await resolveSyscallTarget(target, true);
	if (!resolved) throw new ToolError("Team read isolation cannot establish the filesystem target.");
	return resolved;
}

/**
 * Bound the actual filesystem scopes, not just agent:// visibility. Native
 * grep/glob/AST walkers do not follow nested symlinks; only their explicit
 * roots need canonicalizing. Ancestor scopes are refused rather than walking
 * peer material and trying to redact it after native search has read it.
 */
async function createReadIsolationPolicy(session: ToolSession) {
	const options = session.localProtocolOptions;
	if (options?.allowCrossAgentReads !== false) return undefined;
	const ownArtifacts = options.getArtifactsDir?.();
	if (!ownArtifacts) throw new ToolError("Team read isolation requires the child artifact identity.");
	const ownLocal = resolveLocalRoot(options);
	const sessionFile = session.getSessionFile();
	const ownRoot = await canonical(ownArtifacts);
	const [ownLocalParent, sessionParent, protectedRoots] = await Promise.all([
		canonical(path.dirname(ownLocal)),
		sessionFile ? canonical(path.dirname(sessionFile)) : null,
		Promise.all(
			[
				...new Set([
					path.dirname(ownArtifacts),
					// Long Windows paths may put local:// in the shared short-root
					// directory instead of under the session's artifact tree.
					...(contains(ownArtifacts, ownLocal) ? [] : [path.dirname(ownLocal)]),
					...(options.getReadIsolationRoots?.() ?? []),
				]),
			].map(canonical),
		),
	]);
	const ownLocalRoot = path.join(ownLocalParent, path.basename(ownLocal));
	const ownFiles = [".md", ".json", ".jsonl"].map(extension => `${ownRoot}${extension}`);
	if (sessionFile && sessionParent) ownFiles.push(path.join(sessionParent, path.basename(sessionFile)));
	return async (target: string) => {
		const actual = await canonical(target);
		if (contains(ownRoot, actual) || contains(ownLocalRoot, actual) || ownFiles.includes(actual)) return;
		if (protectedRoots.some(root => contains(root, actual) || contains(actual, root))) {
			throw new ToolError(
				"Team read isolation denies other agents' materials and ancestor directory scopes. Query project source or this agent's own material directly.",
			);
		}
	};
}

/** Check the chosen backing file after suffix, selector, and URI resolution. */
export async function assertTeamReadTarget(session: ToolSession, target: string): Promise<void> {
	const assertAllowed = await createReadIsolationPolicy(session);
	await assertAllowed?.(target);
}

/** Apply the same boundary to registered native search roots before traversal. */
export function isolateTeamReads<T extends Tool>(tool: T, session: ToolSession): T {
	if (session.localProtocolOptions?.allowCrossAgentReads !== false || !ISOLATED_SEARCH_TOOLS[tool.name]) return tool;
	const execute = tool.execute;
	tool.execute = async (id, params, signal, onUpdate, context) => {
		const assertAllowed = await createReadIsolationPolicy(session);
		if (!assertAllowed) return execute.call(tool, id, params, signal, onUpdate, context);
		const requested: unknown = params.path;
		const paths =
			typeof requested === "string"
				? [requested]
				: Array.isArray(requested)
					? requested.filter((entry): entry is string => typeof entry === "string")
					: [];
		const entries = await expandDelimitedPathEntries(paths.length ? paths : ["."], session.cwd, {
			splitter: tool.name === "glob" ? parseFindPattern : undefined,
		});
		const router = InternalUrlRouter.instance();
		for (const entry of entries) {
			const split = await splitPathAndSelPreferringLiteral(entry, session.cwd);
			const expanded = expandPath(split.path);
			const parsed =
				tool.name === "glob"
					? parseFindPattern(expanded)
					: await parseSearchPathPreferringLiteral(expanded, session.cwd);
			const url = router.normalize(parsed.basePath);
			if (router.canHandle(url)) {
				const located = await router.locate(url, sessionResolveContext(session, { signal }), { localOnly: true });
				if (located) await assertAllowed(located);
				continue;
			}
			// Remote URLs have no host backing. file:// has already been
			// expanded above and must pass the same checks as an absolute path.
			if (/^(?:https?|ftp|ws|wss):\/\//i.test(expanded)) continue;
			await assertAllowed(await resolveReadPathAsync(parsed.basePath, session.cwd));
		}
		return execute.call(tool, id, params, signal, onUpdate, context);
	};
	return tool;
}
