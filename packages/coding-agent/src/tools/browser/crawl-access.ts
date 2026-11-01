import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { offlineFromEnv } from "../../cli/args";
import { invokeEvalPrelude } from "../../eval/preludes";
import type { AgentSession } from "../../session/agent-session";
import type { ToolSession } from "../index";
import {
	approvalRestrictions,
	denyError,
	requestApproval,
	resolveApproval,
	resolveApprovalFromContext,
} from "../approval";
import { expandTilde } from "../path-utils";
import { enforcePlanModeWrite, targetsLocalSandbox } from "../plan-mode-guard";
import { WriteTool } from "../write";

/** Invoke the live browser prelude using the owning session's normal authorization. */
export async function crawlBrowserRequest(
	session: AgentSession,
	parameters: unknown,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	return session.invokeCrawlBrowser(parameters, signal);
}

/** Create a new Markdown file without replacing an existing file. */
export async function writeCrawlMarkdown(
	session: AgentSession,
	directory: string,
	basename: string,
	content: string,
	signal?: AbortSignal,
): Promise<string> {
	return session.writeCrawlMarkdown(directory, basename, content, signal);
}

/** Session-only implementations: the ToolSession never escapes AgentSession to command callers. */
export async function invokeCrawlBrowserWithSession(
	session: ToolSession,
	parameters: unknown,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	signal?.throwIfAborted();
	session.assertEvalExecutionAllowed?.();
	if (offlineFromEnv()) throw new Error("Browser is disabled in OMP_OFFLINE mode.");
	const context = session.getToolContext?.();
	if (!context) throw new Error("Browser crawl requires a live tool context.");
	return invokeEvalPrelude("browser", parameters, { session, context, signal, toolCallId: `crawl-${randomUUID()}` });
}

export async function writeCrawlMarkdownWithSession(
	session: ToolSession,
	directory: string,
	basename: string,
	content: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	session.assertEvalExecutionAllowed?.();
	if (!basename || basename === "." || basename === ".." || /[\\/]/.test(basename)) {
		throw new Error("Crawl output filename must be a single file name.");
	}
	const context = session.getToolContext?.();
	session.toolRestrictions?.assertAllowed("write");
	if (!context) throw new Error("Crawl output requires a live tool context.");
	const outputDirectory = path.resolve(session.cwd, expandTilde(directory));
	const { name, ext } = path.parse(basename);
	const tool = new WriteTool(session);
	for (let suffix = 0; ; suffix++) {
		signal?.throwIfAborted();
		const target = path.join(outputDirectory, suffix === 0 ? basename : `${name}-${suffix}${ext}`);
		const args = { path: target, content };
		if (session.deviceOnlyWrite && !(await targetsLocalSandbox(session, target, signal))) {
			throw new Error("The current session does not permit filesystem writes.");
		}
		session.toolRestrictions?.assertAllowed("write");
		await enforcePlanModeWrite(session, target, { op: "create", signal });
		const settings = context.settings ?? session.settings;
		const { approvalMode, userPolicies } = resolveApprovalFromContext(context);
		const approval = resolveApproval(
			tool,
			args,
			approvalMode,
			userPolicies,
			undefined,
			approvalRestrictions(settings, session.cwd),
		);
		if (approval.policy === "deny") throw denyError(approval, "write");
		if (approval.policy === "prompt") {
			if (!context.ui || context.hasUI === false) {
				throw new Error('Tool "write" requires approval but no interactive UI is available.');
			}
			const answer = await untilAborted(signal, () =>
				requestApproval(context.ui!, tool, args, { reason: approval.reason }),
			);
			if (answer === "deny") throw new Error("Tool call denied by user: write");
		}
		signal?.throwIfAborted();
		session.toolRestrictions?.assertAllowed("write");
		await fs.mkdir(outputDirectory, { recursive: true });
		signal?.throwIfAborted();
		try {
			await fs.writeFile(target, content, { encoding: "utf8", flag: "wx", signal });
			return target;
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue;
			throw error;
		}
	}
}
