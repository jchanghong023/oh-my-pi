/**
 * `/team` default subagent runner.
 *
 * Drives the `runSubprocess` layer directly (the deliberate integration point
 * named in docs-zh-CN/requirements/team.md §7): the orchestrator never goes through the
 * main agent's task tool, every child session is pinned to the call's exact
 * model, and the read-only tool set plus `restrictToolNames` make the
 * read-only boundary a programmatic property rather than a prompt request.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../session/auth-storage";
import type { ContextFileEntry } from "../tools";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Rule } from "../capability/rule";
import type { Skill } from "../extensibility/skills";
import type { WorkspaceTree } from "../workspace-tree";
import { TEAM_ROLE_SYSTEM_PROMPTS } from "./prompts";
import { runSubprocess } from "../task/executor";
import { AgentOutputManager } from "../task/output-manager";
import type { AgentDefinition } from "../task/types";
import type { CreateAgentSessionOptions } from "../sdk";
import type { TeamSubagentCall, TeamSubagentOutcome, TeamSubagentRunner } from "./types";

/**
 * The read-only tool set for every `/team` subagent. `wiki` is listed
 * explicitly because `restrictToolNames` suppresses the automatic
 * read→wiki attachment; `yield` is added by the executor's required-yield
 * path. No bash/eval/write/edit/task/hub entry can appear here.
 */
export const TEAM_READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "glob", "wiki", "ast_grep"];

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
	if (!resolved) return false;
	if (resolved === pattern) return true;
	// Selectors may carry thinking-suffix annotations after the model id, and
	// routing-qualified ids carry `@upstream` after the base id.
	return (
		resolved.startsWith(`${pattern}[`) || resolved.startsWith(`${pattern}:`) || resolved.startsWith(`${pattern}@`)
	);
}

/** Build the default runner bound to the dispatching session's dependencies. */
export function createTeamSubagentRunner(deps: TeamRunnerDeps): TeamSubagentRunner {
	// Each discussion owns a namespace: separate managers can otherwise allocate
	// the same stage IDs before either concurrent run has written its artifacts.
	const outputManager = new AgentOutputManager(() => deps.artifactsDir, {
		parentPrefix: `team-${Snowflake.next()}`,
	});
	return async (call: TeamSubagentCall, signal: AbortSignal): Promise<TeamSubagentOutcome> =>
		logger.withLogContext(
			{
				team_run_id: logger.getLogContext().team_run_id ?? `team-${crypto.randomUUID()}`,
				call_id: logger.getLogContext().call_id ?? `team-call-${crypto.randomUUID()}`,
				operation_id:
					logger.getLogContext().operation_id ??
					logger.getLogContext().team_run_id ??
					`team-${crypto.randomUUID()}`,
				role: call.role,
				label: /^team-(?:proposal|review|revision|recheck)-[A-Z](?:-[12])?$|^team-(?:alignment|synthesis)$/.test(
					call.label,
				)
					? call.label
					: "custom",
				requested_model: call.modelPattern.slice(0, 192),
			},
			async () => {
				const started = performance.now();
				let stage = "lease";
				let terminationDiagnostics: {
					abort_category?: string;
					request_count?: number;
					soft_request_budget?: number;
				} = {};
				const finish = (result: "completed" | "failed" | "cancelled", category?: string): void => {
					const fields = {
						component: "team.runner",
						event: `team_runner_${result}`,
						stage,
						result,
						elapsed_ms: performance.now() - started,
						...(category ? { failure_category: category } : {}),
						...terminationDiagnostics,
					};
					if (result === "failed") logger.error("Team runner failed", fields);
					else logger.info("Team runner finished", fields);
				};
				logger.info("Team artifact lease started", {
					component: "team.runner",
					event: "team_lease_started",
					stage,
					result: "started",
					session_backed: Boolean(deps.sessionFile?.endsWith(".jsonl")),
				});
				if (signal.aborted) {
					finish("cancelled", "before_start");
					return { ok: false, error: "cancelled before start" };
				}
				let lease: ArtifactLease;
				try {
					lease = await leaseArtifacts(deps);
					logger.info("Team artifact lease prepared", {
						component: "team.runner",
						event: "team_lease_completed",
						stage,
						result: "completed",
						temporary: lease.temporary,
						elapsed_ms: performance.now() - started,
					});
				} catch (error) {
					logger[signal.aborted ? "info" : "error"]("Team artifact lease failed", {
						component: "team.runner",
						event: signal.aborted ? "team_lease_cancelled" : "team_lease_failed",
						stage,
						result: signal.aborted ? "cancelled" : "failed",
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
				}
				// Set when the executor hands off cleanup that outlives the visible
				// result (child session disposal overran its deadline); the temp lease
				// must survive until it settles or the rm below races open handles.
				let deferredCleanup: Promise<void> | undefined;
				let subprocessStarted: number | undefined;
				try {
					stage = "artifacts";
					logger.info("Team artifact allocation started", {
						component: "team.runner",
						event: "team_artifacts_started",
						stage,
						result: "started",
					});
					const id = await outputManager.allocate(sanitizeAgentId(call.label));
					logger.info("Team artifacts prepared", {
						component: "team.runner",
						event: "team_artifacts_completed",
						stage,
						result: "completed",
						child_agent_id: id,
						temporary: lease.temporary,
						elapsed_ms: performance.now() - started,
					});
					const agent: AgentDefinition = {
						name: `team-${call.role}`,
						description: `Team discussion ${call.role} (${call.label})`,
						systemPrompt: TEAM_ROLE_SYSTEM_PROMPTS[call.role],
						tools: [...TEAM_READ_ONLY_TOOLS],
						readSummarize: false,
						source: "bundled",
					};
					stage = "subprocess";
					subprocessStarted = performance.now();
					logger.info("Team subprocess started", {
						component: "team.runner",
						event: "team_subprocess_started",
						stage,
						result: "started",
						child_agent_id: id,
						max_runtime_ms: 0,
					});
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
						onCleanupDeferred: completion => {
							deferredCleanup = completion;
						},
						sessionFile: lease.sessionFile,
						persistArtifacts: !lease.temporary,
						artifactsDir: lease.artifactsDir,
						localProtocolOptions: {
							getArtifactsDir: () => path.join(lease.artifactsDir, id),
							getSessionId: () => id,
							// agent:// and history:// are global cross-agent namespaces;
							// disabling IRC messaging alone does not isolate their reads.
							allowCrossAgentReads: false,
						},
						authStorage: deps.authStorage,
						modelRegistry: deps.modelRegistry,
						settings: deps.settings,
						contextFiles: deps.contextFiles?.filter(
							file => path.basename(file.path).toLowerCase() !== "agents.md",
						),
						skills: deps.skills ? [...deps.skills] : undefined,
						workspaceTree: deps.workspaceTree,
						promptTemplates: deps.promptTemplates,
						rules: deps.rules,
						parentAgentId: deps.parentAgentId,
					});
					const failure = (error: string): TeamSubagentOutcome =>
						result.structuredOutput && Object.hasOwn(result.structuredOutput, "data")
							? { ok: false, error, data: result.structuredOutput.data }
							: { ok: false, error };
					const processResult = signal.aborted
						? "cancelled"
						: result.aborted || result.exitCode !== 0 || result.error
							? "failed"
							: "completed";
					terminationDiagnostics = { request_count: result.requests };
					if (signal.aborted) {
						terminationDiagnostics.abort_category = "signal";
					} else if (result.aborted) {
						// Match only executor-generated constants; unknown reasons may contain task text.
						const budgetAbort =
							/^Soft request budget exceeded \([0-9]{1,10} requests; budget ([0-9]{1,10})\)( — agent did not yield when force-stopped)?$/.exec(
								result.abortReason ?? "",
							);
						if (budgetAbort) {
							terminationDiagnostics.abort_category = budgetAbort[2]
								? "request_budget_hard_stop"
								: "request_budget_stop";
							terminationDiagnostics.soft_request_budget = Number(budgetAbort[1]);
						} else if (
							/^Subagent runtime limit exceeded \(task\.maxRuntimeMs=[0-9]{1,10}\)$/.test(
								result.abortReason ?? "",
							)
						) {
							terminationDiagnostics.abort_category = "runtime_limit";
						} else if (result.abortReason === "Async job manager shutdown") {
							terminationDiagnostics.abort_category = "shutdown";
						} else if (
							result.abortReason === "Cancelled by caller" ||
							result.abortReason === "Cancelled before start"
						) {
							terminationDiagnostics.abort_category = "caller_abort";
						} else if (result.abortReason === "Subagent aborted task") {
							terminationDiagnostics.abort_category = "task_aborted";
						} else {
							terminationDiagnostics.abort_category = "internal_abort";
						}
					}
					const resolved = (result.resolvedModelIdentity ?? result.resolvedModel)?.slice(0, 192);
					const separator = resolved?.indexOf("/") ?? -1;
					const processFields = {
						component: "team.runner",
						event: "team_subprocess_finished",
						stage,
						result: processResult,
						child_agent_id: id,
						exit_code: result.exitCode,
						aborted: result.aborted,
						resolved_provider: separator >= 0 ? resolved?.slice(0, separator) : undefined,
						resolved_model: separator >= 0 ? resolved?.slice(separator + 1) : resolved,
						stdout_chars: result.output?.length ?? 0,
						stderr_chars: result.stderr?.length ?? 0,
						structured_status: result.structuredOutput?.status,
						...terminationDiagnostics,
						elapsed_ms: performance.now() - subprocessStarted,
					};
					if (processResult === "failed") logger.error("Team subprocess finished unsuccessfully", processFields);
					else logger.info("Team subprocess finished", processFields);
					if (signal.aborted) {
						finish("cancelled");
						return failure("cancelled");
					}
					// A non-signal abort (soft-budget force-stop, internal termination)
					// is a participant failure, not user cancellation; `abortReason`
					// carries the cause and must reach the failure label verbatim.
					if (result.aborted) {
						finish("failed", "internal_abort");
						return failure(result.abortReason || "cancelled");
					}
					if (result.exitCode !== 0 || result.error) {
						finish("failed", result.exitCode !== 0 ? "nonzero_exit" : "executor_error");
						return failure(result.stderr || result.error || `exit code ${result.exitCode}`);
					}
					stage = "model_check";
					// A ":" suffix can be part of a distinct catalog model ID (e.g.
					// ":free"), not just a thinking annotation on the display selector.
					const resolvedIdentity = result.resolvedModelIdentity;
					if (
						!modelMatches(result.resolvedModel, call.modelPattern) ||
						(resolvedIdentity !== undefined &&
							resolvedIdentity !== call.modelPattern &&
							!resolvedIdentity.startsWith(`${call.modelPattern}@`))
					) {
						finish("failed", "model_mismatch");
						return failure(
							`model mismatch: requested ${call.modelPattern}, subagent ran ${result.resolvedModel ?? "unknown"}`,
						);
					}
					stage = "schema";
					const structured = result.structuredOutput;
					if (structured?.status !== "valid" || !structured.data || typeof structured.data !== "object") {
						finish(
							"failed",
							structured?.status !== "valid" ? "structured_output_invalid" : "structured_data_missing",
						);
						return failure(structured?.error ?? "structured output missing or invalid");
					}
					finish("completed");
					return { ok: true, data: structured.data as Record<string, unknown> };
				} catch (error) {
					if (stage === "subprocess") {
						logger[signal.aborted ? "info" : "warn"]("Team subprocess threw", {
							component: "team.runner",
							event: "team_subprocess_finished",
							stage,
							result: signal.aborted ? "cancelled" : "failed",
							failure_category: "executor_exception",
							elapsed_ms: performance.now() - (subprocessStarted ?? started),
						});
					}
					logger[signal.aborted ? "info" : "warn"]("Team runner threw", {
						component: "team.runner",
						event: signal.aborted ? "team_runner_cancelled" : "team_runner_failed",
						stage,
						result: signal.aborted ? "cancelled" : "failed",
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					if (signal.aborted) return { ok: false, error: "cancelled" };
					return { ok: false, error: error instanceof Error ? error.message : String(error) };
				} finally {
					// Temporary artifact dirs hold only child transcripts the orchestrator
					// already extracted; the session-backed lease stays for audit.
					if (lease.temporary) {
						const removeArtifacts = async (): Promise<void> => {
							const cleanupStarted = performance.now();
							logger.info("Team temporary artifacts cleanup started", {
								component: "team.runner",
								event: "team_artifacts_cleanup_started",
								stage: "cleanup",
								result: "started",
								deferred: Boolean(deferredCleanup),
							});
							try {
								await fs.rm(lease.artifactsDir, { recursive: true, force: true });
								logger.info("Team temporary artifacts removed", {
									component: "team.runner",
									event: "team_artifacts_cleanup_completed",
									stage: "cleanup",
									result: "completed",
									elapsed_ms: performance.now() - cleanupStarted,
								});
							} catch (error) {
								logger.warn("Team temporary artifacts cleanup failed", {
									component: "team.runner",
									event: "team_artifacts_cleanup_failed",
									stage: "cleanup",
									result: "failed",
									elapsed_ms: performance.now() - cleanupStarted,
									...logger.diagnosticError(error),
								});
							}
						};
						if (deferredCleanup) void deferredCleanup.then(removeArtifacts);
						else await removeArtifacts();
					}
				}
			},
		);
}
