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
import { getApprovalGrants } from "../approval-cache";
import type { CrawlBrowserOperation } from "../browser";
import { expandTilde } from "../path-utils";
import { enforcePlanModeWrite, targetsLocalSandbox } from "../plan-mode-guard";
import { WriteTool } from "../write";

/** Carry host-only ownership through AgentSession without passing it as prelude arguments. */
class CrawlBrowserInvocation {
	constructor(
		readonly parameters: unknown,
		readonly operation: CrawlBrowserOperation,
	) {}
}

/** Invoke the live browser prelude using the owning session's normal authorization. */
export async function crawlBrowserRequest(
	session: AgentSession,
	parameters: unknown,
	signal?: AbortSignal,
	operation?: CrawlBrowserOperation,
): Promise<AgentToolResult<unknown>> {
	return session.invokeCrawlBrowser(
		operation ? new CrawlBrowserInvocation(parameters, operation) : parameters,
		signal,
	);
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
	const crawl = parameters instanceof CrawlBrowserInvocation ? parameters : undefined;
	return invokeEvalPrelude("browser", crawl ? crawl.parameters : parameters, {
		session,
		context,
		signal,
		toolCallId: `crawl-${randomUUID()}`,
		crawlBrowser: crawl?.operation,
	});
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
	if (!context) throw new Error("Crawl output requires a live tool context.");
	const outputDirectory = path.resolve(session.cwd, expandTilde(directory));
	const { name, ext } = path.parse(basename);
	const tool = new WriteTool(session);
	const settings = context.settings ?? session.settings;
	const grants = getApprovalGrants(settings?.getAgentDir(), session.sessionManager?.getSessionId?.());
	const { approvalMode, userPolicies } = resolveApprovalFromContext(context);
	for (let suffix = 0; ; suffix++) {
		signal?.throwIfAborted();
		const target = path.join(outputDirectory, suffix === 0 ? basename : `${name}-${suffix}${ext}`);
		const args = { path: target, content };
		if (session.isToolActive?.("write") === false && !(await targetsLocalSandbox(session, target, signal))) {
			throw new Error("The current session does not permit filesystem writes.");
		}
		await enforcePlanModeWrite(session, target, { op: "create", signal });
		const approval = resolveApproval(
			tool,
			args,
			approvalMode,
			userPolicies,
			grants,
			approvalRestrictions(settings, session.cwd),
			context,
		);
		if (approval.policy === "deny") throw denyError(approval, "write");
		if (approval.policy === "prompt") {
			if (!context.ui || context.hasUI === false) {
				throw new Error('Tool "write" requires approval but no interactive UI is available.');
			}
			const answer = await untilAborted(signal, () =>
				requestApproval(context.ui!, tool, args, { reason: approval.reason, signal }),
			);
			if (answer === "deny") throw new Error("Tool call denied by user: write");
		}
		signal?.throwIfAborted();
		await fs.mkdir(outputDirectory, { recursive: true });
		signal?.throwIfAborted();
		const staged = path.join(outputDirectory, `.omp-crawl-${randomUUID()}.tmp`);
		const file = await fs.open(staged, "wx");
		try {
			try {
				await file.writeFile(content, { encoding: "utf8", signal });
			} finally {
				await file.close();
			}
			signal?.throwIfAborted();
			try {
				// A hard link publishes complete contents without replacing an existing name.
				await fs.link(staged, target);
				return target;
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue;
				throw error;
			}
		} finally {
			await fs.unlink(staged);
		}
	}
}
