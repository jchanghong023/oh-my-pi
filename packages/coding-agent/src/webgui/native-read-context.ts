import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathIsWithin } from "@oh-my-pi/pi-utils";
import {
	containedRealPath,
	ensureCreatableWithinRoot,
	UrlContainmentError,
} from "../internal-urls/filesystem-resource";
import { resolveToCwd } from "../tools/path-utils";
import { resolveWebGuiSession } from "./native-session-host";
import { readBrowserProject } from "./project-registry";
import type { WebGuiServiceContext } from "./rpc-contract";

/** Snapshot one admitted read, not a persistent workspace binding. */
export async function nativeReadContext(context: WebGuiServiceContext, sessionId?: string) {
	const session = await resolveWebGuiSession(context, sessionId);
	const admittedSessionId = session.sessionId;
	const cwd = session.sessionManager.getCwd();
	const ownerId = context.projectId ? readBrowserProject(context.projectId)?.ownerId : undefined;
	const assertCurrent = () => {
		context.signal.throwIfAborted();
		const project = context.projectId ? readBrowserProject(context.projectId) : undefined;
		if (
			session.isDisposed ||
			session.sessionId !== admittedSessionId ||
			session.sessionManager.getCwd() !== cwd ||
			session.isSessionTransitioning
		)
			throw new Error("The native workspace changed during the read");
		if (
			!project ||
			project.ownerId !== ownerId ||
			project.mode !== "webgui" ||
			project.phase !== "active" ||
			!project.nativeSessions?.has(session) ||
			!pathIsWithin(project.root, cwd)
		)
			throw new Error("The native workspace has no active owner");
	};
	assertCurrent();
	const root = await fs.realpath(cwd);
	assertCurrent();
	return { session, cwd, root, assertCurrent };
}

/** Resolve only within this call's live native cwd, including symlink targets. */
export async function resolveNativeReadPath(
	context: WebGuiServiceContext,
	requested: string,
	options?: { allowMissing?: boolean; sessionId?: string },
) {
	const read = await nativeReadContext(context, options?.sessionId);
	const target = path.resolve(resolveToCwd(requested, read.cwd));
	// Rebase the lexical spelling onto the canonical cwd before the central link checks.
	const relative = path.relative(read.cwd, target);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new UrlContainmentError("Native read escapes the current workspace");
	const lexical = path.join(read.root, relative);
	const resolved = await containedRealPath(lexical, read.root, "workspace", requested);
	read.assertCurrent();
	if (resolved !== undefined) return { ...read, path: resolved };
	if (!options?.allowMissing) {
		// Preserve the filesystem's native missing-path error rather than inventing existence.
		await fs.realpath(lexical);
		read.assertCurrent();
	}
	await ensureCreatableWithinRoot(lexical, read.root, "workspace", requested);
	read.assertCurrent();
	return { ...read, path: lexical };
}
