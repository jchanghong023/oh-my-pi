import type { AstEditToolDetails } from "@oh-my-pi/pi-tui/tools/ast-edit";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { type AstReplaceChange, type AstReplaceFileChange, astEdit, type ShellFilesystem } from "@oh-my-pi/pi-natives";

import { $envpos, isRecord, logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { getEditStore } from "../edit/store";
import { normalizeToLF } from "../edit/normalize";
import { InternalUrlRouter, sessionResolveContext } from "../internal-urls";
import { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import { formatHashlineHeader } from "@oh-my-pi/pi-tui/tools/hashline-format";

import astEditDescription from "../prompts/tools/ast-edit.md" with { type: "text" };

import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { missingGrammarsNote, rerunWithGrammars } from "../utils/grammars";
import type { ToolSession } from ".";
import { resolveToolTier, strictestApproval, truncateForPrompt } from "./approval";
import { parseReadUrlTarget } from "./fetch";
import { createFileRecorder, formatResultPath, resultSnapshotPath } from "./file-recorder";
import { invalidateFsScanAfterUncertainWrites, invalidateFsScanAfterWrites } from "./fs-cache-invalidation";
import { formatGroupedFiles } from "@oh-my-pi/pi-tui/tools/grouped-file-output";

import { relativeSearchResultPath, resolveSearchResultPath, resolveToolSearchScope } from "./path-utils";
import {
	capParseErrors,
	formatCodeFrameLine,
	formatCount,
	formatParseErrors,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { PREVIEW_PENDING_NOTICE, queueResolveHandler } from "./resolve";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";

const astEditOpSchema = type({
	pat: type("string").describe("ast pattern"),
	out: type("string").describe("replacement template"),
});

const astEditSchema = type({
	ops: astEditOpSchema.array().atLeastLength(1).describe("rewrite ops"),
	paths: type("string")
		.describe("file, directory, glob, or internal URL to rewrite")
		.array()
		.atLeastLength(1)
		.describe("files, directories, globs, or internal URLs to rewrite"),
});

interface AstEditCallOptions {
	rewrites: Record<string, string>;
	dryRun: boolean;
	maxFiles: number;
	failOnParseError: boolean;
	signal?: AbortSignal;
	filesystem: ShellFilesystem;
}

interface AstEditAggregatedResult {
	changes: AstReplaceChange[];
	fileChanges: AstReplaceFileChange[];
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
	missingGrammars?: string[];
}

async function runNativeAstEdit(
	options: AstEditCallOptions & { path: string; glob?: string },
	targetIndex?: number,
): Promise<AstEditAggregatedResult> {
	const stage = options.dryRun ? "native_preview" : "native_apply";
	return logger.withLogContext({ native_call_id: crypto.randomUUID() }, async () => {
		const started = performance.now();
		const fields = { component: "ast_edit", stage, target_index: targetIndex };
		logger.info("AST edit native call started", {
			...fields,
			event: "ast_edit_native_started",
			result: "started",
			candidate_count: "unknown",
			reported_written_count: options.dryRun ? 0 : "unknown",
		});
		try {
			const result = await astEdit(options);
			logger.info("AST edit native call completed", {
				...fields,
				event: "ast_edit_native_completed",
				result: "completed",
				elapsed_ms: performance.now() - started,
				candidate_count: result.fileChanges.length,
				reported_written_count: result.applied ? result.fileChanges.length : 0,
				replacement_count: result.totalReplacements,
				files_searched: result.filesSearched,
				applied: result.applied,
				limit_reached: result.limitReached,
				parse_error_count: result.parseErrors?.length ?? 0,
				missing_grammar_count: result.missingGrammars?.length ?? 0,
			});
			return result;
		} catch (error) {
			const cancelled = options.signal?.aborted === true;
			const failureFields = {
				...fields,
				event: cancelled ? "ast_edit_native_cancelled" : "ast_edit_native_failed",
				result: cancelled ? "cancelled" : "failed",
				elapsed_ms: performance.now() - started,
				candidate_count: "unknown",
				reported_written_count: options.dryRun ? 0 : "unknown",
				possible_partial_write: !options.dryRun,
				...logger.diagnosticError(error),
			};
			if (cancelled) logger.info("AST edit native call cancelled", failureFields);
			else logger.error("AST edit native call failed", failureFields);
			throw error;
		}
	});
}

async function runAstEditTargets(
	targets: Array<{ basePath: string; glob?: string }>,
	commonBasePath: string,
	options: AstEditCallOptions,
): Promise<AstEditAggregatedResult> {
	const aggregatedChanges: AstReplaceChange[] = [];
	const fileCounts = new Map<string, number>();
	const parseErrors: string[] = [];
	const missingGrammars = new Set<string>();
	let totalReplacements = 0;
	let filesSearched = 0;
	let limitReached = false;
	let applied = !options.dryRun;
	let targetIndex = 0;
	for (const target of targets) {
		const targetResult = await runNativeAstEdit(
			{
				rewrites: options.rewrites,
				path: target.basePath,
				glob: target.glob,
				dryRun: options.dryRun,
				maxFiles: options.maxFiles,
				failOnParseError: options.failOnParseError,
				signal: options.signal,
				filesystem: options.filesystem,
			},
			targetIndex++,
		);
		if (targetResult.applied && targetResult.fileChanges.length) {
			invalidateFsScanAfterWrites(
				targetResult.fileChanges.map(change => resolveSearchResultPath(target.basePath, change.path)),
			);
		}
		totalReplacements += targetResult.totalReplacements;
		filesSearched += targetResult.filesSearched;
		limitReached = limitReached || targetResult.limitReached;
		applied = applied && targetResult.applied;
		if (targetResult.parseErrors) parseErrors.push(...targetResult.parseErrors);
		for (const language of targetResult.missingGrammars ?? []) missingGrammars.add(language);
		for (const change of targetResult.changes) {
			const absolute = resolveSearchResultPath(target.basePath, change.path);
			aggregatedChanges.push({ ...change, path: relativeSearchResultPath(commonBasePath, absolute) });
		}
		for (const fileChange of targetResult.fileChanges) {
			const absolute = resolveSearchResultPath(target.basePath, fileChange.path);
			const rebased = relativeSearchResultPath(commonBasePath, absolute);
			fileCounts.set(rebased, (fileCounts.get(rebased) ?? 0) + fileChange.count);
		}
	}
	const fileChanges: AstReplaceFileChange[] = Array.from(fileCounts, ([changePath, count]) => ({
		path: changePath,
		count,
	}));
	return {
		changes: aggregatedChanges,
		fileChanges,
		totalReplacements,
		filesTouched: fileChanges.length,
		filesSearched,
		applied,
		limitReached,
		parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
		missingGrammars: missingGrammars.size > 0 ? [...missingGrammars] : undefined,
	};
}

function runAstEditOnce(
	targets: Array<{ basePath: string; glob?: string }> | undefined,
	resolvedSearchPath: string,
	globFilter: string | undefined,
	options: AstEditCallOptions,
): Promise<AstEditAggregatedResult> {
	if (targets) {
		return runAstEditTargets(targets, resolvedSearchPath, options);
	}
	return runNativeAstEdit({
		rewrites: options.rewrites,
		path: resolvedSearchPath,
		glob: globFilter,
		dryRun: options.dryRun,
		maxFiles: options.maxFiles,
		failOnParseError: options.failOnParseError,
		signal: options.signal,
		filesystem: options.filesystem,
	}).then(result => {
		if (result.applied && result.fileChanges.length) {
			invalidateFsScanAfterWrites(
				result.fileChanges.map(change => resolveSearchResultPath(resolvedSearchPath, change.path)),
			);
		}
		return result;
	});
}

type AstEditSchemaInfer = typeof astEditSchema.infer;

export class AstEditTool implements AgentTool<typeof astEditSchema, AstEditToolDetails> {
	readonly name = "ast_edit";
	/** Strictest write decision ({@link strictestApproval}) over every path; "write" when none is given. */
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const paths = isRecord(args) ? args.paths : undefined;
		if (!Array.isArray(paths) || paths.length === 0) return "write";
		const router = InternalUrlRouter.instance();
		const decisions: ToolApprovalDecision[] = [];
		for (const target of paths) {
			// A malformed entry fails closed rather than reaching a tier decision.
			if (typeof target !== "string") return "exec";
			decisions.push(router.writeTier(target, undefined, undefined));
		}
		return strictestApproval(decisions);
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<AstEditSchemaInfer>;
		const lines: string[] = [];
		const ops = Array.isArray(params.ops) ? params.ops : [];
		const firstOp = ops[0];
		if (firstOp) {
			lines.push(`Pattern: ${truncateForPrompt(firstOp.pat)}`);
			lines.push(`Replacement: ${truncateForPrompt(firstOp.out)}`);
			if (ops.length > 1) {
				lines.push(`+${ops.length - 1} more op${ops.length === 2 ? "" : "s"}`);
			}
		}
		if (Array.isArray(params.paths) && params.paths.length > 0) {
			lines.push(`Paths: ${truncateForPrompt(params.paths.join(", "))}`);
		}
		return lines;
	};
	readonly label = "AST Edit";
	readonly summary = "Perform AST-aware code edits (structural refactoring)";
	readonly description: string;
	readonly parameters = astEditSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<AstEditSchemaInfer>[] = [
		{
			caption: "Rename a call site across TypeScript files",
			call: {
				ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }],
				paths: ["src/**/*.ts"],
			},
		},
		{
			caption: "Delete matching calls",
			call: {
				ops: [{ pat: "console.log($$$ARGS)", out: "" }],
				paths: ["src/**/*.ts"],
			},
		},
		{
			caption: "Rewrite import source path",
			call: {
				ops: [{ pat: 'import { $$$IMPORTS } from "old-package"', out: 'import { $$$IMPORTS } from "new-package"' }],
				paths: ["src/**/*.ts"],
			},
		},
		{
			caption: "Modernize to optional chaining (same metavariable enforces identity)",
			call: {
				ops: [{ pat: "$A && $A()", out: "$A?.()" }],
				paths: ["src/**/*.ts"],
			},
		},
		{
			caption: "Swap two arguments using captures",
			call: {
				ops: [{ pat: "assertEqual($A, $B)", out: "assertEqual($B, $A)" }],
				paths: ["tests/**/*.ts"],
			},
		},
		{
			caption: "Python — convert print calls to logging",
			call: {
				ops: [{ pat: "print($$$ARGS)", out: "logger.info($$$ARGS)" }],
				paths: ["src/**/*.py"],
			},
		},
	];
	readonly deferrable = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(astEditDescription);
	}

	async execute(
		_toolCallId: string,
		params: AstEditSchemaInfer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstEditToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstEditToolDetails>> {
		const logContext = {
			...logger.getLogContext(),
			operation_id: logger.getLogContext().operation_id ?? `ast-edit-${crypto.randomUUID()}`,
			tool_call_id: _toolCallId,
			mutation_source: "ast_edit",
		};
		return logger.withLogContext(logContext, () => {
			const previewStarted = performance.now();
			let previewStage = "validate";
			logger.info("AST edit preview started", {
				component: "ast_edit",
				event: "ast_edit_preview_started",
				stage: "preview",
				result: "started",
			});
			return untilAborted(signal, async () => {
				const ops = params.ops.map((entry, index) => {
					if (entry.pat.length === 0) {
						throw new ToolError(`\`ops[${index}].pat\` must be a non-empty pattern`);
					}
					return [entry.pat, entry.out] as const;
				});
				if (ops.length === 0) {
					throw new ToolError("`ops` must include at least one op entry");
				}
				const seenPatterns = new Set<string>();
				for (const [pat] of ops) {
					if (seenPatterns.has(pat)) {
						throw new ToolError(`Duplicate rewrite pattern: ${pat}`);
					}
					seenPatterns.add(pat);
				}
				const normalizedRewrites = Object.fromEntries(ops);
				const maxFiles = $envpos("PI_MAX_AST_FILES", 1000);

				const resolveContext = sessionResolveContext(this.session, { signal });
				// Internal URLs resolve inside the native rewrite, bounded by the tier this call was approved at.
				const tier = resolveToolTier(this, params);
				const urlFilesystem = new InternalUrlFilesystem({ context: resolveContext, tier });
				previewStage = "resolve_scope";
				const scope = await resolveToolSearchScope({
					rawPaths: params.paths,
					cwd: this.session.cwd,
					internalUrlAction: "rewrite",
					filesystem: urlFilesystem,
					fileWritableOnly: true,
					resolveExternalUrl: async rawPath => {
						if (!parseReadUrlTarget(rawPath)) return undefined;
						throw new ToolError(
							`Cannot rewrite external URL: ${rawPath}. Use \`read\` or \`search\` to inspect fetched web content; ast_edit only applies to local files.`,
						);
					},
				});
				const { searchPath: resolvedSearchPath, scopePath, isDirectory, multiTargets, globFilter } = scope;

				previewStage = "native_preview";
				// Dry run, so a re-run after installing missing grammars cannot double-apply.
				const result = await rerunWithGrammars(() =>
					runAstEditOnce(multiTargets, resolvedSearchPath, globFilter, {
						rewrites: normalizedRewrites,
						dryRun: true,
						maxFiles,
						failOnParseError: false,
						signal,
						filesystem: urlFilesystem.shellFilesystem(),
					}),
				);
				const grammarNote = result.missingGrammars?.length
					? missingGrammarsNote(result.missingGrammars)
					: undefined;

				previewStage = "render_preview";
				const { errors: cappedParseErrors, total: parseErrorsTotal } = capParseErrors(result.parseErrors);
				const formatPath = (filePath: string): string =>
					formatResultPath(filePath, isDirectory, resolvedSearchPath, this.session.cwd);

				const { record: recordFile, list: fileList } = createFileRecorder();
				const fileReplacementCounts = new Map<string, number>();
				const changesByFile = new Map<string, AstReplaceChange[]>();
				for (const fileChange of result.fileChanges) {
					const relativePath = formatPath(fileChange.path);
					recordFile(relativePath);
					fileReplacementCounts.set(
						relativePath,
						(fileReplacementCounts.get(relativePath) ?? 0) + fileChange.count,
					);
				}
				for (const change of result.changes) {
					const relativePath = formatPath(change.path);
					recordFile(relativePath);
					if (!changesByFile.has(relativePath)) {
						changesByFile.set(relativePath, []);
					}
					changesByFile.get(relativePath)!.push(change);
				}

				const baseDetails: AstEditToolDetails = {
					totalReplacements: result.totalReplacements,
					filesTouched: result.filesTouched,
					filesSearched: result.filesSearched,
					applied: result.applied,
					limitReached: result.limitReached,
					...(cappedParseErrors.length > 0 ? { parseErrors: cappedParseErrors, parseErrorsTotal } : {}),
					scopePath,
					searchPath: resolvedSearchPath,
					cwd: this.session.cwd,
					files: fileList,
					fileReplacements: [],
				};

				if (result.totalReplacements === 0) {
					const parseMessage = cappedParseErrors.length
						? `\n${formatParseErrors(cappedParseErrors, parseErrorsTotal).join("\n")}`
						: "";
					const grammarMessage = grammarNote ? `\n${grammarNote}` : "";
					return toolResult(baseDetails).text(`No replacements made${parseMessage}${grammarMessage}`).done();
				}

				const useHashLines = resolveFileDisplayMode(this.session).hashLines;
				const hashContexts = new Map<string, { tag: string }>();
				let previewSnapshotFailureCount = 0;
				let previewSnapshotFailure: Record<string, unknown> | undefined;
				if (useHashLines) {
					const snapshotStore = getEditStore(this.session);
					for (const relativePath of fileList) {
						// A `local://` result binds to its backing file.
						const snapshotPath = await resultSnapshotPath(relativePath, this.session.cwd, resolveContext);
						if (snapshotPath === undefined) continue;
						try {
							const fullText = normalizeToLF(await Bun.file(snapshotPath).text());
							const tag = snapshotStore.recordSnapshot(snapshotPath, fullText);
							hashContexts.set(relativePath, { tag });
						} catch (error) {
							// Best-effort: if a file disappears between ast-edit and rendering, emit plain line output.
							previewSnapshotFailureCount++;
							previewSnapshotFailure ??= logger.diagnosticError(error);
						}
					}
				}
				if (previewSnapshotFailureCount) {
					logger.warn("AST edit preview snapshot unavailable", {
						component: "ast_edit",
						event: "ast_edit_snapshot_degraded",
						stage: "preview_snapshot",
						result: "degraded",
						candidate_count: fileList.length,
						failed_snapshot_count: previewSnapshotFailureCount,
						...previewSnapshotFailure,
					});
				}
				const outputLines: string[] = [];
				const displayLines: string[] = [];
				const renderChangesForFile = (relativePath: string): { model: string[]; display: string[] } => {
					const modelOut: string[] = [];
					const displayOut: string[] = [];
					const fileChanges = changesByFile.get(relativePath) ?? [];
					const hashContext = hashContexts.get(relativePath);
					const lineNumberWidth = fileChanges.reduce(
						(width, change) => Math.max(width, String(change.startLine).length),
						0,
					);
					for (const change of fileChanges) {
						const beforeFirstLine = change.before.split("\n", 1)[0] ?? "";
						const afterFirstLine = change.after.split("\n", 1)[0] ?? "";
						const beforeLine = beforeFirstLine.slice(0, 120);
						const afterLine = afterFirstLine.slice(0, 120);
						const beforeRef = hashContext ? `${change.startLine}` : `${change.startLine}:${change.startColumn}`;
						const afterRef = hashContext ? `${change.startLine}` : `${change.startLine}:${change.startColumn}`;
						const lineSeparator = hashContext ? ":" : " ";
						modelOut.push(`-${beforeRef}${lineSeparator}${beforeLine}`);
						modelOut.push(`+${afterRef}${lineSeparator}${afterLine}`);
						displayOut.push(formatCodeFrameLine("-", change.startLine, beforeLine, lineNumberWidth));
						displayOut.push(formatCodeFrameLine("+", change.startLine, afterLine, lineNumberWidth));
					}
					return { model: modelOut, display: displayOut };
				};

				if (isDirectory) {
					const grouped = formatGroupedFiles(fileList, relativePath => {
						const rendered = renderChangesForFile(relativePath);
						const count = fileReplacementCounts.get(relativePath) ?? 0;
						const hashContext = hashContexts.get(relativePath);
						const hashSuffix = hashContext ? `#${hashContext.tag}` : "";
						return {
							headerSuffix: `${hashSuffix} (${formatCount("replacement", count)})`,
							modelLines: rendered.model,
							displayLines: rendered.display,
							skip: rendered.model.length === 0,
						};
					});
					outputLines.push(...grouped.model);
					displayLines.push(...grouped.display);
				} else {
					for (const relativePath of fileList) {
						const rendered = renderChangesForFile(relativePath);
						if (rendered.model.length === 0) continue;
						if (outputLines.length > 0) {
							outputLines.push("");
							displayLines.push("");
						}
						const hashContext = hashContexts.get(relativePath);
						if (hashContext) {
							outputLines.push(formatHashlineHeader(relativePath, hashContext.tag));
						}
						outputLines.push(...rendered.model);
						displayLines.push(...rendered.display);
					}
				}

				const fileReplacements = fileList.map(filePath => ({
					path: filePath,
					count: fileReplacementCounts.get(filePath) ?? 0,
				}));
				if (result.limitReached) {
					outputLines.push("", "Limit reached; narrow paths.");
				}
				if (cappedParseErrors.length) {
					outputLines.push("", ...formatParseErrors(cappedParseErrors, parseErrorsTotal));
				}
				if (grammarNote) {
					outputLines.push("", grammarNote);
				}

				// Register pending action so `resolve` can apply or discard these previewed changes
				if (!result.applied && result.totalReplacements > 0) {
					const previewReplacementPlural = result.totalReplacements !== 1 ? "s" : "";
					const previewFilePlural = result.filesTouched !== 1 ? "s" : "";
					queueResolveHandler(this.session, {
						label: `AST Edit: ${result.totalReplacements} replacement${previewReplacementPlural} in ${result.filesTouched} file${previewFilePlural}`,
						sourceToolName: this.name,
						apply: async (_reason: string) =>
							logger.withLogContext(
								{
									...logContext,
									call_id: crypto.randomUUID(),
									preview_candidate_count: result.fileChanges.length,
								},
								async () => {
									const applyStarted = performance.now();
									logger.info("Deferred AST edit apply started", {
										component: "ast_edit",
										event: "ast_edit_deferred_apply_started",
										stage: "deferred_apply",
										result: "started",
										candidate_count: result.fileChanges.length,
										reported_written_count: "unknown",
									});
									let applyStage = "native_apply";
									let reportedWrittenCount: number | "unknown" = "unknown";
									try {
										// The apply outlives the preview call: its filesystem carries no signal.
										const applyContext = sessionResolveContext(this.session);
										const applyResult = await runAstEditOnce(multiTargets, resolvedSearchPath, globFilter, {
											rewrites: normalizedRewrites,
											dryRun: false,
											maxFiles,
											failOnParseError: false,
											filesystem: new InternalUrlFilesystem({
												context: applyContext,
												tier,
											}).shellFilesystem(),
										}).catch(error => {
											// Native apply commits files sequentially and can reject after a partial write.
											// Preview paths are candidates, not proof of success or an exhaustive
											// post-preview scope: keep the index uncertain until full reconciliation.
											invalidateFsScanAfterUncertainWrites(
												result.fileChanges.map(change =>
													resolveSearchResultPath(resolvedSearchPath, change.path),
												),
												"AST edit apply failed; files may have been partially written; reconcile to verify coverage",
											);
											throw error;
										});
										reportedWrittenCount = applyResult.applied ? applyResult.fileChanges.length : 0;
										applyStage = "render_apply_result";
										const { errors: cappedApplyParseErrors, total: applyParseErrorsTotal } = capParseErrors(
											applyResult.parseErrors,
										);
										const { record: recordAppliedFile, list: appliedFileList } = createFileRecorder();
										const appliedFileReplacementCounts = new Map<string, number>();
										for (const fileChange of applyResult.fileChanges) {
											const relativePath = formatPath(fileChange.path);
											recordAppliedFile(relativePath);
											appliedFileReplacementCounts.set(
												relativePath,
												(appliedFileReplacementCounts.get(relativePath) ?? 0) + fileChange.count,
											);
										}
										for (const change of applyResult.changes) {
											recordAppliedFile(formatPath(change.path));
										}
										// The preview minted tags from pre-apply content; the rewrite just
										// invalidated them. Re-record post-apply snapshots (canonical keys)
										// so the model's next hashline edit anchors against fresh tags.
										const freshTagLines: string[] = [];
										let applySnapshotFailureCount = 0;
										let applySnapshotFailure: Record<string, unknown> | undefined;
										if (useHashLines) {
											const snapshotStore = getEditStore(this.session);
											for (const relativePath of appliedFileList) {
												const appliedPath = await resultSnapshotPath(
													relativePath,
													this.session.cwd,
													applyContext,
												);
												if (appliedPath === undefined) continue;
												try {
													const fullText = normalizeToLF(await Bun.file(appliedPath).text());
													const freshTag = snapshotStore.recordSnapshot(appliedPath, fullText);
													freshTagLines.push(formatHashlineHeader(relativePath, freshTag));
												} catch (error) {
													// File disappeared between apply and re-read; skip its tag.
													applySnapshotFailureCount++;
													applySnapshotFailure ??= logger.diagnosticError(error);
												}
											}
										}
										if (applySnapshotFailureCount) {
											logger.warn("AST edit applied snapshot unavailable", {
												component: "ast_edit",
												event: "ast_edit_snapshot_degraded",
												stage: "apply_snapshot",
												result: "degraded",
												candidate_count: appliedFileList.length,
												failed_snapshot_count: applySnapshotFailureCount,
												...applySnapshotFailure,
											});
										}
										const appliedFileReplacements = appliedFileList.map(filePath => ({
											path: filePath,
											count: appliedFileReplacementCounts.get(filePath) ?? 0,
										}));
										const appliedDetails: AstEditToolDetails = {
											totalReplacements: applyResult.totalReplacements,
											filesTouched: applyResult.filesTouched,
											filesSearched: applyResult.filesSearched,
											applied: applyResult.applied,
											limitReached: applyResult.limitReached,
											...(cappedApplyParseErrors.length > 0
												? { parseErrors: cappedApplyParseErrors, parseErrorsTotal: applyParseErrorsTotal }
												: {}),
											scopePath,
											files: appliedFileList,
											fileReplacements: appliedFileReplacements,
										};
										const stalePreview =
											applyResult.totalReplacements !== result.totalReplacements ||
											applyResult.filesTouched !== result.filesTouched ||
											fileList.some(
												filePath =>
													appliedFileReplacementCounts.get(filePath) !==
													fileReplacementCounts.get(filePath),
											) ||
											appliedFileList.some(
												filePath =>
													fileReplacementCounts.get(filePath) !==
													appliedFileReplacementCounts.get(filePath),
											);
										logger.info("Deferred AST edit apply completed", {
											component: "ast_edit",
											event: "ast_edit_deferred_apply_completed",
											stage: "deferred_apply",
											result: stalePreview ? "stale_preview" : "completed",
											elapsed_ms: performance.now() - applyStarted,
											candidate_count: result.fileChanges.length,
											reported_written_count: applyResult.applied ? applyResult.fileChanges.length : 0,
											replacement_count: applyResult.totalReplacements,
											applied: applyResult.applied,
											stale_preview: stalePreview,
										});
										if (stalePreview) {
											const staleText =
												applyResult.totalReplacements === 0
													? `Preview is stale / no longer matches; no replacements were applied. Preview expected ${result.totalReplacements} replacement${previewReplacementPlural} in ${result.filesTouched} file${previewFilePlural}.`
													: applyResult.totalReplacements < result.totalReplacements
														? `Preview is stale / no longer matches; only ${applyResult.totalReplacements} of ${result.totalReplacements} replacements were applied in ${applyResult.filesTouched} of ${result.filesTouched} files.`
														: `Preview is stale / no longer matches; applied ${applyResult.totalReplacements} replacements but preview expected ${result.totalReplacements}.`;
											const staleWithTags =
												freshTagLines.length > 0 ? `${staleText}\n${freshTagLines.join("\n")}` : staleText;
											return { ...toolResult(appliedDetails).text(staleWithTags).done(), isError: true };
										}
										const appliedReplacementPlural = applyResult.totalReplacements !== 1 ? "s" : "";
										const appliedFilePlural = applyResult.filesTouched !== 1 ? "s" : "";
										const appliedText = `Applied ${applyResult.totalReplacements} replacement${appliedReplacementPlural} in ${applyResult.filesTouched} file${appliedFilePlural}.`;
										const text =
											freshTagLines.length > 0 ? `${appliedText}\n${freshTagLines.join("\n")}` : appliedText;
										return toolResult(appliedDetails).text(text).done();
									} catch (error) {
										logger.error("Deferred AST edit apply failed", {
											component: "ast_edit",
											event: "ast_edit_deferred_apply_failed",
											stage: applyStage,
											result: "failed",
											elapsed_ms: performance.now() - applyStarted,
											candidate_count: result.fileChanges.length,
											reported_written_count: reportedWrittenCount,
											possible_partial_write: reportedWrittenCount === "unknown",
											uncertain_notification_count:
												reportedWrittenCount === "unknown" ? result.fileChanges.length : 0,
											...logger.diagnosticError(error),
										});
										throw error;
									}
								},
							),
						reject: async () =>
							logger.withLogContext(logContext, () => {
								logger.info("Deferred AST edit preview discarded", {
									component: "ast_edit",
									event: "ast_edit_deferred_apply_cancelled",
									stage: "deferred_apply",
									result: "cancelled",
									candidate_count: result.fileChanges.length,
									reported_written_count: 0,
								});
								return undefined;
							}),
					});
					// The renderer's ⟨proposed⟩ badge is TUI-only; this line is the model's
					// in-result signal that the diff above is staged, not applied.
					outputLines.unshift(PREVIEW_PENDING_NOTICE, "");
				}

				const details: AstEditToolDetails = {
					...baseDetails,
					fileReplacements,
					displayContent: displayLines.join("\n"),
				};
				return toolResult(details).text(outputLines.join("\n")).done();
			}).then(
				previewResult => {
					logger.info("AST edit preview completed", {
						component: "ast_edit",
						event: "ast_edit_preview_completed",
						stage: "preview",
						result: "completed",
						elapsed_ms: performance.now() - previewStarted,
						candidate_count: previewResult.details?.filesTouched ?? "unknown",
						replacement_count: previewResult.details?.totalReplacements ?? "unknown",
						reported_written_count: 0,
					});
					return previewResult;
				},
				error => {
					const cancelled = signal?.aborted === true;
					const fields = {
						component: "ast_edit",
						event: cancelled ? "ast_edit_preview_cancelled" : "ast_edit_preview_failed",
						stage: previewStage,
						result: cancelled ? "cancelled" : "failed",
						elapsed_ms: performance.now() - previewStarted,
						reported_written_count: 0,
						...logger.diagnosticError(error),
					};
					if (cancelled) logger.info("AST edit preview cancelled", fields);
					else logger.error("AST edit preview failed", fields);
					throw error;
				},
			);
		});
	}
}
