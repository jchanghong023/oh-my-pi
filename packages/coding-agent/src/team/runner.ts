/**
 * `/team` default subagent runner.
 *
 * Drives the `runSubprocess` layer directly (the deliberate integration point
 * named in docs-zh-CN/team.md §7): the orchestrator never goes through the
 * main agent's task tool, every child session is pinned to the call's exact
 * model, and the read-only tool set plus `restrictToolNames` make the
 * read-only boundary a programmatic property rather than a prompt request.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../session/auth-storage";
import type { ContextFileEntry } from "../tools";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Rule } from "../capability/rule";
import type { Skill } from "../extensibility/skills";
import type { WorkspaceTree } from "../workspace-tree";
import alignerPrompt from "../prompts/team/aligner.md" with { type: "text" };
import proposerPrompt from "../prompts/team/proposer.md" with { type: "text" };
import reviewerPrompt from "../prompts/team/reviewer.md" with { type: "text" };
import reviserPrompt from "../prompts/team/reviser.md" with { type: "text" };
import synthesizerPrompt from "../prompts/team/synthesizer.md" with { type: "text" };
import { runSubprocess } from "../task/executor";
import { AgentOutputManager } from "../task/output-manager";
import type { AgentDefinition } from "../task/types";
import type { CreateAgentSessionOptions } from "../sdk";
import type { Model } from "@oh-my-pi/pi-ai";
import type { TeamRole, TeamSubagentCall, TeamSubagentOutcome, TeamSubagentRunner } from "./types";

/**
 * The read-only tool set for every `/team` subagent. `wiki` is listed
 * explicitly because `restrictToolNames` suppresses the automatic
 * read→wiki attachment; `yield` is added by the executor's required-yield
 * path. No bash/eval/write/edit/task/hub entry can appear here.
 */
export const TEAM_READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "glob", "wiki", "ast_grep"];

const ROLE_SYSTEM_PROMPTS: Record<TeamRole, string> = {
	proposer: proposerPrompt,
	reviewer: reviewerPrompt,
	reviser: reviserPrompt,
	aligner: alignerPrompt,
	synthesizer: synthesizerPrompt,
};

/** Everything the runner needs from the dispatching session, as plain values. */
export interface TeamRunnerDeps {
	cwd: string;
	additionalDirectories?: string[];
	settings: Settings;
	modelRegistry: ModelRegistry;
	authStorage?: AuthStorage;
	getApiKey?: CreateAgentSessionOptions["getApiKey"];
	/** Persisted session file; child transcripts nest beside it. `null` uses a temp dir. */
	sessionFile: string | null;
	artifactsDir: string | null;
	parentAgentId: string;
	parentActiveModelPattern?: string;
	skills?: readonly Skill[];
	promptTemplates?: PromptTemplate[];
	rules?: Rule[];
	contextFiles?: ContextFileEntry[];
	workspaceTree?: WorkspaceTree;
}

interface ArtifactLease {
	sessionFile: string | null;
	artifactsDir: string;
	temporary: boolean;
}

async function leaseArtifacts(deps: TeamRunnerDeps): Promise<ArtifactLease> {
	// Mirror the session-manager derivation: only a real transcript file (named
	// `*.jsonl`) owns a sibling artifacts dir; anything else falls back to a
	// temp lease instead of mkdir-ing a mangled path.
	if (deps.sessionFile?.endsWith(".jsonl")) {
		const artifactsDir = deps.sessionFile.slice(0, -6);
		await fs.mkdir(artifactsDir, { recursive: true });
		return { sessionFile: deps.sessionFile, artifactsDir, temporary: false };
	}
	const artifactsDir = path.join(os.tmpdir(), `omp-team-${Snowflake.next()}`);
	await fs.mkdir(artifactsDir, { recursive: true });
	return { sessionFile: null, artifactsDir, temporary: true };
}

function sanitizeAgentId(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
	return sanitized || "team-agent";
}

export function modelMatches(resolved: string | undefined, pattern: string): boolean {
	if (!resolved) return true;
	if (resolved === pattern) return true;
	// Selectors may carry thinking-suffix annotations after the model id, and
	// routing-qualified ids carry `@upstream` after the base id.
	return (
		resolved.startsWith(`${pattern}[`) || resolved.startsWith(`${pattern}:`) || resolved.startsWith(`${pattern}@`)
	);
}

/** Build the default runner bound to the dispatching session's dependencies. */
export function createTeamSubagentRunner(deps: TeamRunnerDeps): TeamSubagentRunner {
	const outputManager = new AgentOutputManager(() => deps.artifactsDir);
	return async (call: TeamSubagentCall, signal: AbortSignal): Promise<TeamSubagentOutcome> => {
		if (signal.aborted) return { ok: false, error: "cancelled before start" };
		const lease = await leaseArtifacts(deps);
		try {
			const id = await outputManager.allocate(sanitizeAgentId(call.label));
			const agent: AgentDefinition = {
				name: `team-${call.role}`,
				description: `Team discussion ${call.role} (${call.label})`,
				systemPrompt: ROLE_SYSTEM_PROMPTS[call.role],
				tools: [...TEAM_READ_ONLY_TOOLS],
				readSummarize: false,
				source: "bundled",
			};
			const result = await runSubprocess({
				cwd: deps.cwd,
				additionalDirectories: deps.additionalDirectories,
				getApiKey: deps.getApiKey,
				agent,
				task: call.task,
				assignment: call.task,
				modelOverride: call.modelPattern,
				parentActiveModelPattern: deps.parentActiveModelPattern,
				id,
				index: 0,
				outputSchema: call.schema,
				outputSchemaMode: "strict",
				outputSchemaSource: "caller",
				outputSchemaOverridesAgent: true,
				// The workflow is known to run minutes; the generic per-subagent
				// wall-clock cap would abort legitimate stages.
				maxRuntimeMs: 0,
				enableLsp: false,
				enableIrc: false,
				enableMCP: false,
				restrictToolNames: true,
				keepAlive: false,
				signal,
				sessionFile: lease.sessionFile,
				persistArtifacts: !lease.temporary,
				artifactsDir: lease.artifactsDir,
				authStorage: deps.authStorage,
				modelRegistry: deps.modelRegistry,
				settings: deps.settings,
				contextFiles: deps.contextFiles?.filter(file => path.basename(file.path).toLowerCase() !== "agents.md"),
				skills: deps.skills ? [...deps.skills] : undefined,
				workspaceTree: deps.workspaceTree,
				promptTemplates: deps.promptTemplates,
				rules: deps.rules,
				parentAgentId: deps.parentAgentId,
			});
			if (signal.aborted || result.aborted) return { ok: false, error: "cancelled" };
			if (result.exitCode !== 0 || result.error) {
				return { ok: false, error: result.stderr || result.error || `exit code ${result.exitCode}` };
			}
			if (!modelMatches(result.resolvedModel, call.modelPattern)) {
				return {
					ok: false,
					error: `model mismatch: requested ${call.modelPattern}, subagent ran ${result.resolvedModel ?? "unknown"}`,
				};
			}
			const structured = result.structuredOutput;
			if (structured?.status !== "valid" || !structured.data || typeof structured.data !== "object") {
				return { ok: false, error: structured?.error ?? "structured output missing or invalid" };
			}
			return { ok: true, data: structured.data as Record<string, unknown> };
		} catch (error) {
			if (signal.aborted) return { ok: false, error: "cancelled" };
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			// Temporary artifact dirs hold only child transcripts the orchestrator
			// already extracted; the session-backed lease stays for audit.
			if (lease.temporary) {
				await fs.rm(lease.artifactsDir, { recursive: true, force: true }).catch(() => {});
			}
		}
	};
}

/** Helper for callers that only know the session's model object. */
export function modelPatternOf(model: Model): string {
	return `${model.provider}/${model.id}`;
}
