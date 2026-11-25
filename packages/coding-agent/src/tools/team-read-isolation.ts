import * as path from "node:path";
import type { ToolSession } from ".";
import { InternalUrlRouter } from "../internal-urls";
import { resolveLocalRoot } from "../internal-urls/local-protocol";
import type { ResolveContext } from "../internal-urls/types";
import { resolveSyscallTarget } from "./path-utils";
import { ToolError } from "./tool-errors";

function contains(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonical(target: string): Promise<string> {
	const resolved = await resolveSyscallTarget(target, true);
	if (!resolved) throw new ToolError("Team read isolation cannot establish the filesystem target.");
	return resolved;
}

/** Refuse both protected entries (including exact transcript files) and scopes that contain them. */
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

/** Check parsed native search targets before stat, materialization, or walking. */
export async function createTeamSearchTargetCheck(session: ToolSession, context: ResolveContext) {
	const assertAllowed = await createReadIsolationPolicy(session);
	if (!assertAllowed) return undefined;
	const router = InternalUrlRouter.instance();
	return async (target: string): Promise<void> => {
		if (!router.canHandle(target)) {
			await assertAllowed(target);
			return;
		}
		// The search filesystem locates the directory form of a bare URL.
		const backing = await router.locate(target, context, { directory: true, localOnly: true });
		if (backing !== null) await assertAllowed(backing);
	};
}
