import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { structuredPatchHunks } from "@oh-my-pi/pi-natives";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resolveSessionLeafId, type SessionEntry } from "../../session/session-entries";
import { loadEntriesFromFile } from "../../session/session-loader";
import { migrateToCurrentVersion } from "../../session/session-migrations";
import { buildSessionContext, getRestorableSessionModels } from "../../session/session-context";
import { goalFromModeData, type GoalModeState } from "../../goals/state";
import { resolveDispatchDetails, writeDeviceDispatch } from "../../tools/resolve";
import { restoreFileCheckpoints } from "../../edit/file-rewind";
import { ZCodeProjection, acceptedModelSelection } from "./projection";
import { toZCodeReasoningLevel } from "./provider-config";
import type { ZCodeSessionManager } from "./sessions";
import {
	v4UsageStatsParamsSchema,
	v4UsageStatsResultSchema,
	v4ConversationUsageParamsSchema,
	v4ConversationUsageResultSchema,
	v4ConversationPlansParamsSchema,
	v4ConversationPlansResultSchema,
	v4ConversationFileChangesParamsSchema,
	v4ConversationFileChangesResultSchema,
	v4ConversationFileRewindPreviewParamsSchema,
	v4ConversationFileRewindPreviewResultSchema,
	v4BackgroundBashOutputParamsSchema,
	BACKGROUND_BASH_OUTPUT_MAX_BYTES,
	backgroundBashOutputResultSchema,
	type V4ConversationFileChangesParams,
	type V4ConversationFileRewindPreviewResult,
	type ConversationRow,
	type V4UsageStatsResult,
	type StatePatch,
} from "./schema";

export interface ZCodeQueryContext {
	manager: Pick<ZCodeSessionManager, "get" | "getAsyncJob" | "read" | "list">;
	getProjection(sessionId: string): ZCodeProjection | undefined;
	reasoning?(
		providerId: string,
		modelId: string,
		thinkingLevel: string,
	): Promise<{ thought: string; thoughtLevels: string[] }>;
}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
	value !== null && typeof value === "object" ? (value as RecordValue) : {};
const number = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

interface Facts {
	cwd: string;
	entries: SessionEntry[];
	branch: SessionEntry[];
	messages: AgentMessage[];
}
interface FileOperation {
	path: string;
	toolName: string;
	oldText?: string;
	newText?: string;
	op?: string;
	unsupported: boolean;
	snapshotsPruned: boolean;
	diff: string;
}

/** Read-side protocol adaptation. Never creates a session, takes its writer lease, or runs a Goal. */
export class ZCodeQueries {
	readonly #context: ZCodeQueryContext;
	constructor(context: ZCodeQueryContext) {
		this.#context = context;
	}

	async #facts(sessionId: string): Promise<Facts> {
		const live = this.#context.manager.get(sessionId);
		if (live) {
			const entries = live.session.sessionManager.getEntries();
			const branch = live.session.sessionManager.getBranch();
			return {
				cwd: live.cwd,
				entries,
				branch,
				messages: branch.flatMap(entry => (entry.type === "message" ? [entry.message] : [])),
			};
		}
		const history = await this.#context.manager.read(sessionId);
		const loaded = await loadEntriesFromFile(history.info.path, undefined, { throwIfMissing: true });
		if (!loaded.length || loaded[0].type !== "session" || loaded[0].id !== sessionId)
			throw new Error("Session history identity is invalid");
		migrateToCurrentVersion(loaded);
		const entries = loaded.filter((entry): entry is SessionEntry => entry.type !== "session");
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		const branch: SessionEntry[] = [];
		const visited = new Set<string>();
		for (let id = resolveSessionLeafId(entries); id !== null;) {
			if (visited.has(id)) throw new Error("Session history contains a cycle");
			visited.add(id);
			const entry = byId.get(id);
			if (!entry) throw new Error("Session history parent is missing");
			branch.push(entry);
			id = entry.parentId;
		}
		branch.reverse();
		return {
			cwd: history.cwd,
			entries,
			branch,
			messages: branch.flatMap(entry => (entry.type === "message" ? [entry.message] : [])),
		};
	}

	async goalState(sessionId: string): Promise<GoalModeState | undefined> {
		const live = this.#context.manager.get(sessionId);
		if (live) return live.session.getGoalModeState();
		const facts = await this.#facts(sessionId);
		const context = buildSessionContext(facts.branch);
		if (context.mode !== "goal" && context.mode !== "goal_paused") return undefined;
		const goal = goalFromModeData(context.modeData);
		if (!goal) return undefined;
		// History inspection never resumes accounting or schedules a continuation.
		return {
			enabled: context.mode === "goal",
			mode: "active",
			goal,
			...(context.modeData?.autoOrchestrate === true ? { autoOrchestrate: true } : {}),
		};
	}

	async revertedTargets(sessionId: string): Promise<string[]> {
		const facts = await this.#facts(sessionId);
		return [
			...new Set(
				facts.branch.flatMap(entry => {
					if (entry.type !== "custom" || entry.customType !== "workspace-file-rewind") return [];
					const data = record(entry.data);
					const receipts = data.receipts;
					return typeof data.targetEntityId === "string" &&
						Array.isArray(receipts) &&
						receipts.length > 0 &&
						receipts.every(
							receipt => record(receipt).status === "restored" || record(receipt).status === "unchanged",
						)
						? [data.targetEntityId]
						: [];
				}),
			),
		];
	}

	async subagentsState(sessionId: string): Promise<NonNullable<StatePatch["subagents"]>> {
		const childSessionIds = [...new Set(Object.values(await this.#context.manager.childIdentities(sessionId)))].sort();
		// This is a cold persisted directory, not a claim that historical work is still running.
		return { revision: 0, childSessionIds, running: [], endedTotal: childSessionIds.length };
	}

	async projectionState(sessionId: string): Promise<StatePatch> {
		const hosted = this.#context.getProjection(sessionId);
		if (this.#context.manager.get(sessionId) && hosted) {
			const state = hosted.snapshot();
			return { config: state.config, usage: state.usage, subagents: state.subagents };
		}
		const facts = await this.#facts(sessionId);
		const context = buildSessionContext(facts.branch);
		const lastSelection = facts.branch.findLast(entry => entry.type === "model_change");
		const selected = getRestorableSessionModels(
			context.models,
			lastSelection?.type === "model_change" ? lastSelection.role : undefined,
		)[0];
		const separator = selected?.indexOf("/") ?? -1;
		const reasoning =
			selected && separator > 0
				? await this.#context.reasoning?.(
						selected.slice(0, separator),
						selected.slice(separator + 1),
						context.thinkingLevel ?? "off",
					)
				: undefined;
		const cumulative = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
		for (const call of modelCalls(facts.entries)) {
			cumulative.inputTokens += number(call.usage.input);
			cumulative.outputTokens += number(call.usage.output);
			cumulative.cacheReadTokens += number(call.usage.cacheRead);
			cumulative.cacheWriteTokens += number(call.usage.cacheWrite);
		}
		// 冷恢复同样保留 canonical 已接受选择意图(缺陷1):从 journal 的 zcode_model_selection
		// custom entry 派生,不用 effective provider/model/thought 伪造。
		const modelSelection = acceptedModelSelection(facts.branch);
		return {
			...(selected && separator > 0
				? {
						config: {
							provider: selected.slice(0, separator),
							model: selected.slice(separator + 1),
							thought: reasoning?.thought ?? toZCodeReasoningLevel(context.thinkingLevel ?? "off"),
							thoughtLevels: reasoning?.thoughtLevels ?? [],
							followupMode: "queue" as const,
							mode: context.mode === "plan" ? "plan" : "build",
							...(modelSelection ? { modelSelection } : {}),
						},
					}
				: {}),
			usage: { contextWindow: null, cumulative },
			subagents: await this.subagentsState(sessionId),
		};
	}

	async conversationUsage(rawParams: unknown) {
		const { sessionId } = v4ConversationUsageParamsSchema.parse(rawParams);
		const facts = await this.#facts(sessionId);
		const result = {
			sessionId,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			modelRequestCount: 0,
			modelErrorCount: 0,
			inputBaselineBySource: {},
		};
		// Billing belongs to the session ledger, including abandoned branches and off-transcript calls.
		for (const call of modelCalls(facts.entries)) {
			addTokens(result, call.usage);
			result.modelRequestCount++;
			result.modelErrorCount += call.error ? 1 : 0;
		}
		return v4ConversationUsageResultSchema.parse(result);
	}

	async usageStats(rawParams: unknown): Promise<V4UsageStatsResult> {
		const params = v4UsageStatsParamsSchema.parse(rawParams);
		const now = Date.now();
		const timeZone = params.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		const formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		const day = (at: number) => {
			const parts = formatter.formatToParts(at);
			return `${parts.find(part => part.type === "year")!.value}-${parts.find(part => part.type === "month")!.value}-${parts.find(part => part.type === "day")!.value}`;
		};
		const today = day(now);
		const firstDay = params.range === "all" ? undefined : shiftDay(today, params.range === "7d" ? -6 : -29);
		const included = (at: number) => Number.isFinite(at) && at <= now && (!firstDay || day(at) >= firstDay);
		const summary: V4UsageStatsResult["summary"] = {
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			cacheHitRate: 0,
			totalSessions: 0,
			totalTurns: 0,
			toolCallCount: 0,
			toolErrorRate: 0,
			modelErrorRate: 0,
			avgTimeToFirstTokenMs: null,
			avgTurnDurationMs: null,
			activeDays: 0,
			currentStreakDays: 0,
			longestSessionMs: 0,
			longestStreakDays: 0,
			peakDayTokens: 0,
			favoriteModel: null,
		};
		const daily = new Map<
			string,
			{ totalTokens: number; turnCount: number; toolCallCount: number; models: Map<string | null, number> }
		>();
		const models = new Map<string | null, V4UsageStatsResult["models"][number]>();
		const tools = new Map<string, V4UsageStatsResult["tools"][number]>();
		let errors = 0,
			requests = 0,
			toolErrors = 0,
			ttft = 0,
			ttftCount = 0,
			duration = 0,
			durationCount = 0;
		const bucket = (at: number) => {
			const date = day(at);
			let value = daily.get(date);
			if (!value) {
				value = { totalTokens: 0, turnCount: 0, toolCallCount: 0, models: new Map() };
				daily.set(date, value);
			}
			return value;
		};
		for (const info of await this.#context.manager.list()) {
			const facts = await this.#facts(info.id);
			let active = false,
				start = Infinity,
				end = -Infinity;
			for (const entry of facts.entries) {
				if (entry.type !== "message") continue;
				const message = record(entry.message);
				const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
				if (!included(at)) continue;
				active = true;
				start = Math.min(start, at);
				end = Math.max(end, at);
				if (message.role === "user") {
					summary.totalTurns++;
					bucket(at).turnCount++;
				}
				if (message.role === "toolResult") {
					const name = string(message.toolName) ?? "unknown";
					let tool = tools.get(name);
					if (!tool) {
						tool = { toolName: name, callCount: 0, errorCount: 0, errorRate: 0, avgDurationMs: null };
						tools.set(name, tool);
					}
					tool.callCount++;
					summary.toolCallCount++;
					bucket(at).toolCallCount++;
					if (message.isError === true) {
						tool.errorCount++;
						toolErrors++;
					}
				}
			}
			for (const call of modelCalls(facts.entries)) {
				if (!included(call.at)) continue;
				active = true;
				start = Math.min(start, call.at);
				end = Math.max(end, call.at + (call.duration ?? 0));
				addTokens(summary, call.usage);
				requests++;
				errors += call.error ? 1 : 0;
				const tokenCount = tokens(call.usage);
				const date = bucket(call.at);
				date.totalTokens += tokenCount;
				date.models.set(call.model, (date.models.get(call.model) ?? 0) + tokenCount);
				let model = models.get(call.model);
				if (!model) {
					model = {
						modelId: call.model,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						requestCount: 0,
						share: 0,
					};
					models.set(call.model, model);
				}
				model.totalTokens += tokenCount;
				model.inputTokens += number(call.usage.input);
				model.outputTokens += number(call.usage.output);
				model.requestCount++;
				if (call.ttft !== undefined) {
					ttft += call.ttft;
					ttftCount++;
				}
				if (call.duration !== undefined) {
					duration += call.duration;
					durationCount++;
				}
			}
			if (active) {
				summary.totalSessions++;
				summary.longestSessionMs = Math.max(summary.longestSessionMs, end - start);
			}
		}
		for (const model of models.values())
			model.share = summary.totalTokens ? model.totalTokens / summary.totalTokens : 0;
		for (const tool of tools.values()) tool.errorRate = tool.errorCount / tool.callCount;
		const dates = [...daily.keys()].sort();
		summary.activeDays = dates.length;
		summary.peakDayTokens = Math.max(0, ...[...daily.values()].map(value => value.totalTokens));
		let streak = 0,
			previous: string | undefined;
		for (const date of dates) {
			streak = previous && shiftDay(previous, 1) === date ? streak + 1 : 1;
			summary.longestStreakDays = Math.max(summary.longestStreakDays, streak);
			previous = date;
		}
		if (previous === today || previous === shiftDay(today, -1)) summary.currentStreakDays = streak;
		summary.cacheHitRate =
			summary.inputTokens + summary.cacheReadTokens + summary.cacheCreationTokens
				? summary.cacheReadTokens / (summary.inputTokens + summary.cacheReadTokens + summary.cacheCreationTokens)
				: 0;
		summary.modelErrorRate = requests ? errors / requests : 0;
		summary.toolErrorRate = summary.toolCallCount ? toolErrors / summary.toolCallCount : 0;
		summary.avgTimeToFirstTokenMs = ttftCount ? ttft / ttftCount : null;
		summary.avgTurnDurationMs = durationCount ? duration / durationCount : null;
		const sortedModels = [...models.values()].sort(
			(a, b) => b.totalTokens - a.totalTokens || (a.modelId ?? "").localeCompare(b.modelId ?? ""),
		);
		if (sortedModels[0])
			summary.favoriteModel = {
				modelId: sortedModels[0].modelId,
				totalTokens: sortedModels[0].totalTokens,
				share: sortedModels[0].share,
			};
		const startDate = firstDay ?? dates[0] ?? null;
		const weeks: V4UsageStatsResult["heatmap"]["weeks"] = [];
		if (startDate) {
			let days: V4UsageStatsResult["heatmap"]["weeks"][number]["days"] = Array(
				new Date(`${startDate}T00:00:00Z`).getUTCDay(),
			).fill(null);
			for (let date = startDate; date <= today; date = shiftDay(date, 1)) {
				const value = daily.get(date);
				const totalTokens = value?.totalTokens ?? 0;
				const level =
					totalTokens && summary.peakDayTokens
						? (Math.min(4, Math.ceil((totalTokens / summary.peakDayTokens) * 4)) as 1 | 2 | 3 | 4)
						: 0;
				days.push({
					date,
					level,
					totalTokens,
					turnCount: value?.turnCount ?? 0,
					toolCallCount: value?.toolCallCount ?? 0,
				});
				if (days.length === 7) {
					weeks.push({ weekIndex: weeks.length, days });
					days = [];
				}
			}
			if (days.length) {
				while (days.length < 7) days.push(null);
				weeks.push({ weekIndex: weeks.length, days });
			}
		}
		return v4UsageStatsResultSchema.parse({
			range: params.range,
			generatedAt: now,
			timeZone,
			source: "agent-db",
			summary,
			heatmap: { startDate, endDate: startDate ? today : null, maxTokens: summary.peakDayTokens, weeks },
			dailyModelUsage: dates.map(date => ({
				date,
				models: [...daily.get(date)!.models].map(([modelId, totalTokens]) => ({ modelId, totalTokens })),
			})),
			models: sortedModels,
			tools: [...tools.values()].sort((a, b) => b.callCount - a.callCount || a.toolName.localeCompare(b.toolName)),
		});
	}

	async plans(rawParams: unknown) {
		const { sessionId } = v4ConversationPlansParamsSchema.parse(rawParams);
		const facts = await this.#facts(sessionId);
		const owned = this.#context.getProjection(sessionId);
		const projection = owned ?? new ZCodeProjection({ sessionId, cwd: facts.cwd, messages: facts.messages });
		try {
			const state = projection.snapshot();
			const planIds = new Set(
				facts.messages.flatMap(message => {
					if (message.role !== "toolResult" || message.isError) return [];
					const details = semanticToolResult(message).details;
					return typeof details.planFilePath === "string" && details.planExists === true
						? [message.toolCallId]
						: [];
				}),
			);
			return v4ConversationPlansResultSchema.parse({
				plans: projection
					.rows()
					.filter(
						row =>
							row.kind === "toolCall" &&
							row.status !== "running" &&
							row.status !== "inputStreaming" &&
							(row.toolName === "ExitPlanMode" || planIds.has(row.toolCallId)),
					)
					.sort((a, b) => b.rowId - a.rowId),
				atSeq: state.seq,
				atLogEpoch: state.logEpoch,
			});
		} finally {
			if (!owned) projection.dispose();
		}
	}

	async #fileTarget(params: V4ConversationFileChangesParams) {
		const projection = this.#context.getProjection(params.sessionId);
		if (!projection) throw new Error("proto.staleLogEpoch");
		const state = projection.snapshot();
		if (params.baseLogEpoch !== state.logEpoch) throw new Error("proto.staleLogEpoch");
		if (params.baseRevision !== state.revision) throw new Error("proto.staleRevision");
		const rows = projection.rows();
		const row = rows.find(row => row.rowId === params.target.rowId && row.entityId === params.target.entityId);
		if (!row) throw new Error("proto.staleTarget");
		if (row.kind !== "turnHeader") throw new Error("guard.actionUnavailable");
		const ids = new Set(
			rows
				.filter(
					(candidate): candidate is Extract<ConversationRow, { kind: "toolCall" }> =>
						candidate.turnId === row.turnId && candidate.kind === "toolCall",
				)
				.map(candidate => candidate.toolCallId),
		);
		const facts = await this.#facts(params.sessionId);
		const operations = fileOperations(
			facts.messages.filter(message => message.role === "toolResult" && ids.has(message.toolCallId)),
			facts.cwd,
		);
		const reverted = facts.branch.some(
			entry =>
				entry.type === "custom" &&
				entry.customType === "workspace-file-rewind" &&
				record(entry.data).targetEntityId === row.entityId &&
				[...groupOperations(operations).keys()].every(filePath => {
					const receipts = record(entry.data).receipts;
					return (
						Array.isArray(receipts) &&
						receipts.some(
							receipt =>
								record(receipt).path === filePath &&
								(record(receipt).status === "restored" || record(receipt).status === "unchanged"),
						)
					);
				}),
		);
		const assertCurrent = () => {
			const current = projection.snapshot();
			if (
				this.#context.getProjection(params.sessionId) !== projection ||
				current.logEpoch !== state.logEpoch ||
				current.revision !== state.revision
			)
				throw new Error("proto.staleRevision");
		};
		assertCurrent();
		return { operations, assertCurrent, reverted, projection };
	}

	async fileChanges(rawParams: unknown) {
		const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
		const { operations, assertCurrent, reverted } = await this.#fileTarget(params);
		const items = [...groupOperations(operations)].map(([filePath, changes]) => {
			const patches = changes.flatMap(change =>
				hasCompleteSnapshots(change)
					? structuredPatchHunks(change.oldText ?? "", change.newText ?? "", 3)
					: parseHunks(change.diff),
			);
			return {
				path: filePath,
				additions: patches.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith("+")).length, 0),
				deletions: patches.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith("-")).length, 0),
				writeCount: changes.length,
				toolNames: [...new Set(changes.map(change => change.toolName))],
				patches,
			};
		});
		assertCurrent();
		return v4ConversationFileChangesResultSchema.parse({
			files: items.length,
			additions: items.reduce((sum, item) => sum + item.additions, 0),
			deletions: items.reduce((sum, item) => sum + item.deletions, 0),
			state: reverted ? "reverted" : "active",
			items,
		});
	}

	async fileRewindPreview(rawParams: unknown) {
		const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
		const { operations, assertCurrent, reverted } = await this.#fileTarget(params);
		const preview: V4ConversationFileRewindPreviewResult = {
			canApply: false,
			ignoredFiles: [],
			safeFiles: [],
			unsafeFiles: [],
		};
		if (reverted) return v4ConversationFileRewindPreviewResultSchema.parse(preview);
		for (const [filePath, changes] of groupOperations(operations)) {
			const base = {
				path: filePath,
				operationCount: changes.length,
				toolNames: [...new Set(changes.map(change => change.toolName))],
			};
			const first = changes[0],
				last = changes[changes.length - 1];
			if (changes.some(change => change.unsupported)) {
				preview.unsafeFiles.push({ ...base, reason: "unsupported_checkpoint" });
				continue;
			}
			if (
				changes.some(
					change =>
						change.snapshotsPruned ||
						(change.oldText === undefined && change.op !== "create") ||
						(change.newText === undefined && change.op !== "delete"),
				)
			) {
				preview.unsafeFiles.push({ ...base, reason: "checkpoint_missing" });
				continue;
			}
			if (changes.some((change, index) => index > 0 && change.oldText !== changes[index - 1].newText)) {
				preview.unsafeFiles.push({
					...base,
					reason: "unsupported_checkpoint",
					message: "Checkpoint chain is discontinuous",
				});
				continue;
			}
			try {
				let current: Buffer | undefined;
				try {
					const stat = await fs.lstat(filePath);
					if (!stat.isFile() || stat.isSymbolicLink()) {
						preview.unsafeFiles.push({ ...base, reason: "unsupported_checkpoint" });
						continue;
					}
					current = await fs.readFile(filePath);
				} catch (error) {
					if (record(error).code !== "ENOENT") throw error;
				}
				const expectedHash = last.newText === undefined ? undefined : hash(Buffer.from(last.newText));
				const currentHash = current === undefined ? undefined : hash(current);
				if (expectedHash !== currentHash)
					preview.unsafeFiles.push({ ...base, reason: "external_modified", expectedHash, currentHash });
				else preview.safeFiles.push({ ...base, action: first.op === "create" ? "delete" : "restore" });
			} catch (error) {
				preview.unsafeFiles.push({
					...base,
					reason: "file_read_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		preview.canApply = preview.safeFiles.length > 0 && preview.unsafeFiles.length === 0;
		assertCurrent();
		return v4ConversationFileRewindPreviewResultSchema.parse(preview);
	}

	async applyFileRewind(rawParams: unknown) {
		const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
		const live = this.#context.manager.get(params.sessionId);
		if (!live) throw new Error("Session must be active to restore workspace files");
		const preview = await this.fileRewindPreview(params);
		if (!preview.canApply)
			return { applied: false, preview, response: { applied: false, receipts: [], reason: "checkpoint_unsafe" } };
		const { operations, assertCurrent, projection } = await this.#fileTarget(params);
		const targetEntryId = projection.resolveTarget(params.target).entryId;
		const checkpoints = [...groupOperations(operations)].map(([filePath, changes]) => ({
			path: filePath,
			before: changes[0].oldText,
			after: changes[changes.length - 1].newText,
		}));
		const response = await live.run(() => restoreFileCheckpoints(checkpoints, { cwd: live.cwd, assertCurrent }));
		if (response.applied) {
			live.session.sessionManager.appendCustomEntry("workspace-file-rewind", {
				targetEntryId,
				targetEntityId: params.target.entityId,
				receipts: response.receipts,
			});
			await live.session.sessionManager.flush();
		}
		return { applied: response.applied, preview, response };
	}

	async backgroundBashOutput(rawParams: unknown) {
		const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
		const job = await this.#context.manager.getAsyncJob(sessionId, workId);
		// 冷子会话可能不持有原任务，管理器按原始 session 身份回查现存祖先。
		// 只有确定无匹配任务才返回 unavailable；输出读取失败仍保留 read_failed。
		if (!job || job.type !== "bash" || job.foreground)
			return backgroundBashOutputResultSchema.parse({ kind: "unavailable", workId });
		const source = job.widgetInputs?.sources().find(source => source.id === "out");
		if (!source) return backgroundBashOutputResultSchema.parse({ kind: "unavailable", workId });
		try {
			const chunk = source.read(0);
			const bytes = Buffer.from(chunk.text);
			let start = Math.max(0, bytes.length - BACKGROUND_BASH_OUTPUT_MAX_BYTES);
			while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
			const status = job.latestDetails?.timedOut === true ? "timed_out" : job.status;
			return backgroundBashOutputResultSchema.parse({
				kind: "output",
				workId,
				status,
				output: bytes.subarray(start).toString("utf8"),
				truncated: chunk.start > 0 || start > 0,
				outputPath: `proc://${workId}`,
			});
		} catch (error) {
			return backgroundBashOutputResultSchema.parse({
				kind: "read_failed",
				workId,
				code: string(record(error).code),
			});
		}
	}
}

function shiftDay(day: string, offset: number): string {
	const value = new Date(`${day}T00:00:00Z`);
	value.setUTCDate(value.getUTCDate() + offset);
	return value.toISOString().slice(0, 10);
}
function tokens(usage: RecordValue): number {
	return typeof usage.totalTokens === "number"
		? number(usage.totalTokens)
		: number(usage.input) + number(usage.output) + number(usage.cacheRead) + number(usage.cacheWrite);
}
function addTokens(
	target: {
		totalTokens: number;
		inputTokens: number;
		outputTokens: number;
		reasoningTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
	},
	usage: RecordValue,
): void {
	target.totalTokens += tokens(usage);
	target.inputTokens += number(usage.input);
	target.outputTokens += number(usage.output);
	target.reasoningTokens += number(usage.reasoning);
	target.cacheCreationTokens += number(usage.cacheWrite);
	target.cacheReadTokens += number(usage.cacheRead);
}
function modelCalls(entries: SessionEntry[]) {
	return entries.flatMap(entry => {
		const message =
			entry.type === "model_usage"
				? record(entry)
				: entry.type === "message" && entry.message.role === "assistant"
					? record(entry.message)
					: undefined;
		if (!message) return [];
		return [
			{
				usage: record(message.usage),
				at: typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp),
				model: string(message.model) ?? null,
				error: message.stopReason === "error",
				ttft: typeof message.ttft === "number" ? number(message.ttft) : undefined,
				duration: typeof message.duration === "number" ? number(message.duration) : undefined,
			},
		];
	});
}
function groupOperations(operations: FileOperation[]): Map<string, FileOperation[]> {
	const groups = new Map<string, FileOperation[]>();
	for (const operation of operations) {
		const changes = groups.get(operation.path);
		if (changes) changes.push(operation);
		else groups.set(operation.path, [operation]);
	}
	return groups;
}

function fileOperations(messages: readonly AgentMessage[], cwd?: string): FileOperation[] {
	const operations: FileOperation[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.isError) continue;
		const { details, toolName } = semanticToolResult(message);
		if (toolName !== "edit" && toolName !== "write" && toolName !== "apply_patch") continue;
		const files = Array.isArray(details.perFileResults) ? details.perFileResults.map(record) : [details];
		for (const file of files) {
			const filePath = string(file.path) ?? string(file.resolvedPath);
			if (!filePath || file.isError === true) continue;
			const op = string(file.op);
			operations.push({
				path: cwd ? path.resolve(cwd, filePath) : filePath,
				toolName,
				oldText: op === "create" ? undefined : string(file.oldText),
				newText: op === "delete" ? undefined : string(file.newText),
				op,
				unsupported: typeof file.sourcePath === "string" || typeof file.move === "string",
				snapshotsPruned: file.snapshotsPruned === true,
				diff: string(file.diff) ?? "",
			});
		}
	}
	return operations;
}

/** Shared pure turn summary; uses the same persisted checkpoints as preview/apply. */
export function summarizeMessageFileChanges(messages: readonly AgentMessage[]) {
	const groups = groupOperations(fileOperations(messages));
	let additions = 0,
		deletions = 0,
		canRewindFiles = groups.size > 0;
	for (const changes of groups.values()) {
		for (const [index, change] of changes.entries()) {
			const patches = hasCompleteSnapshots(change)
				? structuredPatchHunks(change.oldText ?? "", change.newText ?? "", 3)
				: parseHunks(change.diff);
			for (const patch of patches)
				for (const line of patch.lines) {
					if (line.startsWith("+")) additions++;
					if (line.startsWith("-")) deletions++;
				}
			if (
				change.unsupported ||
				change.snapshotsPruned ||
				(change.oldText === undefined && change.op !== "create") ||
				(change.newText === undefined && change.op !== "delete") ||
				(index > 0 && change.oldText !== changes[index - 1].newText)
			)
				canRewindFiles = false;
		}
	}
	return { files: groups.size, additions, deletions, canRewindFiles };
}

function hasCompleteSnapshots(change: FileOperation): boolean {
	return (
		!change.snapshotsPruned &&
		(change.oldText !== undefined || change.op === "create") &&
		(change.newText !== undefined || change.op === "delete")
	);
}

export function semanticToolResult(message: Extract<AgentMessage, { role: "toolResult" }>) {
	const resolution = resolveDispatchDetails(message.toolName, message);
	if (resolution?.action === "apply" && resolution.sourceToolName) {
		return { toolName: resolution.sourceToolName, details: record(resolution.sourceResultDetails) };
	}
	const dispatch = writeDeviceDispatch(message.toolName, message);
	return dispatch?.mode === "execute"
		? { toolName: dispatch.tool, details: record(dispatch.inner) }
		: { toolName: message.toolName.replace(/^xd:\/\//, ""), details: record(message.details) };
}
function parseHunks(diff: string) {
	const hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] = [];
	for (const line of diff.split("\n")) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (header)
			hunks.push({
				oldStart: Number(header[1]),
				oldLines: header[2] === undefined ? 1 : Number(header[2]),
				newStart: Number(header[3]),
				newLines: header[4] === undefined ? 1 : Number(header[4]),
				lines: [],
			});
		else if (hunks.length && /^[ +\\-]/.test(line)) hunks[hunks.length - 1].lines.push(line);
	}
	return hunks;
}
