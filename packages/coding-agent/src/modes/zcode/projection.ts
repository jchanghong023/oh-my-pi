import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isTaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { AsyncResultDetails } from "../../session/async-job-delivery";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type { SessionEntry } from "../../session/session-entries";
import type { AgentRegistry } from "../../registry/agent-registry";
import { goalFromModeData, type GoalModeState } from "../../goals/state";
import { semanticToolResult, summarizeMessageFileChanges } from "./queries";
import { toZCodeReasoningLevel } from "./provider-config";
import { modelSelectionSchema, type ModelSelection } from "./schema/vendor/model-selection";
import { readHighspeedInputFacts } from "./sessions";
import { deobfuscateAssistantContent } from "../../secrets/message-transform";
import {
	conversationSnapshotSchema,
	conversationRowSchema,
	statePatchSchema,
	toolResultDisplaySchema,
	type ConversationSnapshot,
	type ConversationRow,
	type ConversationDelta,
	type StatePatch,
	type SessionSummary,
	type AttachmentRef,
	PROTOCOL_V4_LIMITS,
	workflowLaunchMetaSchema,
	deriveSessionWorkflowActivity,
} from "./schema";

interface ProjectionMessage {
	role: string;
	customType?: string;
	display?: boolean;
	timestamp?: number;
	duration?: number;
	completedAt?: number;
	inputId?: string;
	inputAdmissionSeq?: number;
	inputClientId?: string;
	sourceCommand?: { type?: string; commandId?: string; automationId?: string };
	attachments?: AttachmentRef[];
	content?:
		| string
		| { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[];
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
	cancelled?: boolean;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}
interface MessageRecord {
	message: ProjectionMessage;
	streaming: boolean;
	pendingSettlement?: boolean;
	entity?: string;
	journalEntryId?: string;
}
export interface ZCodeProjectionOptions {
	sessionId: string;
	cwd: string;
	session?: AgentSession;
	registry?: AgentRegistry;
	/** Native parent identity within this tree; never a public root session ID. */
	agentId?: string;
	childSessions?: Readonly<Record<string, string>>;
	messages?: readonly AgentMessage[];
	logEpoch?: string;
	state?: StatePatch;
	goalState?: GoalModeState;
	entries?: readonly SessionEntry[];
	reasoning?: (session: AgentSession) => Pick<ConversationSnapshot["config"], "thought" | "thoughtLevels">;
	revertedTargets?: readonly string[];
	/** Canonical linkage and inherited visible-message boundary resolved by the journal owner. */
	parentSessionId?: string;
	inheritedMessageCount?: number;
}
const textContent = (message: ProjectionMessage): string =>
	typeof message.content === "string"
		? message.content
		: (message.content ?? [])
				.filter(block => block.type === "text")
				.map(block => block.text ?? "")
				.join("\n");
const TOOL_PRESENTATION_NAMES: Readonly<Record<string, string>> = {
	ask: "AskUserQuestion",
	propose: "ExitPlanMode",
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
};
function projectionBranch(session: AgentSession): readonly SessionEntry[] {
	const branch = session.sessionManager.getBranchView();
	const boundary = branch.findLastIndex(entry => entry.type === "reset_boundary");
	return boundary < 0 ? branch : branch.slice(boundary + 1);
}

function visibleJournalEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	const boundary = entries.findLastIndex(entry => entry.type === "reset_boundary");
	return entries
		.slice(boundary + 1)
		.filter(entry => entry.type === "message" || (entry.type === "custom_message" && entry.display));
}

function messageEntity(
	sessionId: string,
	message: Pick<ProjectionMessage, "role" | "timestamp" | "inputId">,
	ordinal: number,
): string {
	return `${sessionId}:${message.inputId ?? `${message.role}:${message.timestamp ?? 0}:${ordinal}`}`;
}

/** Public custom rows use the same visible journal ordinals as the conversation projection. */
export function projectCustomMessageEntityIds(
	sessionId: string,
	entries: readonly SessionEntry[],
): Map<string, string> {
	const entities = new Map<string, string>();
	for (const [ordinal, entry] of visibleJournalEntries(entries).entries()) {
		if (entry.type !== "custom_message") continue;
		entities.set(
			entry.id,
			`${messageEntity(sessionId, { role: "custom", timestamp: new Date(entry.timestamp).getTime() }, ordinal)}:custom`,
		);
	}
	return entities;
}

/**
 * 从 journal 派生已接受的稀疏模型选择意图(custom entry "zcode_model_selection",
 * 由 server #model 接受 selection 时写入;与 workspace-file-rewind 同一持久化机制)。
 * 合同(forkZcode session-config.ts):modelSelection 是 canonical 已接受意图,
 * provider/model/thought 只是 effective 展示 —— 绝不从 effective 字段伪造选择;
 * 记录缺失或 schema 不合法时返回 undefined,而不是降级成默认/Recent。
 */
export function acceptedModelSelection(entries: readonly SessionEntry[]): ModelSelection | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== "zcode_model_selection") continue;
		const parsed = modelSelectionSchema.safeParse(entry.data);
		if (parsed.success) return parsed.data;
	}
	return undefined;
}

function completedGoal(entries: readonly SessionEntry[]) {
	const lastMode = entries.findLastIndex(entry => entry.type === "mode_change");
	const mode = entries[lastMode];
	if (
		mode?.type !== "mode_change" ||
		mode.mode !== "none" ||
		!entries.slice(lastMode + 1).some(entry => entry.type === "custom" && entry.customType === "goal-completed")
	)
		return undefined;
	for (let index = lastMode - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "mode_change") continue;
		const goal = goalFromModeData(entry.data);
		return goal ? { ...goal, status: "complete" as const } : undefined;
	}
	return undefined;
}

function completingGoal(toolName: string, args: unknown): boolean {
	if (!args || typeof args !== "object") return false;
	if (toolName.replace(/^_/, "") === "goal") return "op" in args && args.op === "complete";
	if (
		toolName.replace(/^_/, "") !== "write" ||
		!("path" in args) ||
		args.path !== "xd://goal" ||
		!("content" in args) ||
		typeof args.content !== "string"
	)
		return false;
	try {
		const content: unknown = JSON.parse(args.content);
		return !!content && typeof content === "object" && "op" in content && content.op === "complete";
	} catch {
		return false;
	}
}

function bashOutputPreview(output: string): Extract<ConversationRow, { kind: "toolCall" }>["outputPreview"] {
	const bytes = Buffer.from(output, "utf8");
	const totalBytes = bytes.length;
	// 修复:旧实现先 output.slice(-4096) 按 UTF-16 码元截,可能把代理对切开再编码,
	// 首字符变 U+FFFD。与 queries.ts 的后台 tail 一样直接按字节取尾,再向前跳过
	// UTF-8 continuation bytes,保证落在字符边界上。
	let start = Math.max(0, totalBytes - 4096);
	while (start < totalBytes && (bytes[start] & 0xc0) === 0x80) start++;
	const tail = bytes.subarray(start).toString("utf8");
	const lines = tail ? tail.split("\n") : [];
	let totalLines = output ? 1 : 0;
	for (let newline = output.indexOf("\n"); newline >= 0; newline = output.indexOf("\n", newline + 1)) totalLines++;
	return {
		text: lines.slice(-5).join("\n"),
		fullText: lines.slice(-100).join("\n"),
		totalBytes,
		totalLines,
		// 原生进度是 sink 的当前 inline view,不是完整落盘输出的全量计数。
		linesEstimated: true,
	};
}

/** bash_output display 头部的字节预算(schema 上限 150k 字符,这里收紧防止终态行拖垮整帧)。 */
const BASH_OUTPUT_DISPLAY_HEAD_BYTES = 30_000;

/**
 * BDO02:Bash 终态 toolCall 行的合规 kind:"bash_output" display(vendor bash-output-display.ts
 * 形状:{output,truncated,outputPath?})。forkZcode UI 终态正文取 outputDisplay ?? output.text 全文,
 * 没有生产者时 ~50KB 原文整帧下发。头部按 UTF-8 字节截断(绝不按 UTF-16 码元切,与 queries.ts
 * 的后台 tail 同一 continuation-byte 跳过规则);truncated 是对原始长度的如实陈述(原文是否超出
 * 头部预算),原始全文事实仍保留在行的 output.text 中,不进 display。
 */
function bashTerminalOutputDisplay(output: string): { kind: "bash_output"; output: string; truncated: boolean } {
	const bytes = Buffer.from(output, "utf8");
	if (bytes.length <= BASH_OUTPUT_DISPLAY_HEAD_BYTES) return { kind: "bash_output", output, truncated: false };
	let end = BASH_OUTPUT_DISPLAY_HEAD_BYTES;
	// 从切点向前跳过 continuation bytes,退到完整多字节字符的边界,避免产生 U+FFFD。
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return { kind: "bash_output", output: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** Derived view only: the AgentSession remains the journal, queue and work owner. */
export class ZCodeProjection {
	readonly #options: ZCodeProjectionOptions;
	readonly #messages: MessageRecord[] = [];
	readonly #listeners = new Set<(deltas: ConversationDelta[]) => void>();
	readonly #tools = new Map<
		string,
		{
			status: "running" | "success" | "error" | "cancelled";
			output?: string;
			outputPreview?: Extract<ConversationRow, { kind: "toolCall" }>["outputPreview"];
		}
	>();
	readonly #rowMessages = new Map<string, number>();
	// rowId 稳定性(10-protocol-spec.md §4.4/R-04:session 内单调、永不复用、既有行稳定):
	// 按行语义键(entityId)持久分配 rowId,新行取 nextRowId++。中途插行(如 #restoreCompactions
	// 按时间戳插入 compact 伪消息、task 子行晚于同消息后续块出现)不再让后续行按位置漂移。
	// 跨 resetEpoch 保留映射:同一实体保持同一 rowId,消失分支的 id 永不复用。
	readonly #rowIds = new Map<string, number>();
	readonly #journalEntities = new Map<string, string>();
	readonly #messageEntities = new Set<string>();
	#nextMessageEntity = 1;
	#nextRowId = 1;
	readonly #childSessions = new Map<string, string>();
	readonly #fileSummaries = new Map<
		string,
		{
			results: ProjectionMessage[];
			summary: { files: number; additions: number; deletions: number; canRewindFiles: boolean };
		}
	>();
	#state: ConversationSnapshot;
	#unsubscribe?: () => void;
	#unsubscribeTitle?: () => void;
	#unsubscribeRegistry?: () => void;
	#activeMessage = -1;
	#executionActive = false;
	#activeAutoCompact?: string;
	readonly #goalCompletionCalls = new Set<string>();
	#factsTimer?: NodeJS.Timeout;
	#resetBoundaryId?: string;
	#observedLeafId?: string | null;
	// 已接受的稀疏模型选择意图(缺陷1):journal custom entry 派生或 server #model 写回,
	// 是 sessionConfig.modelSelection 的唯一事实源;refresh 只更新 effective 展示。
	#acceptedModelSelection?: ModelSelection;
	// 真实派生(fork)linkage:来自 journal session header 的 parentSession 或冷恢复
	// 调用方显式传入;无 linkage 时不合成 forkNotice 分割线(缺陷2)。
	#forkParentSessionId?: string;

	#workflowState: Pick<StatePatch, "workflowRuns" | "backgroundWorks"> = {};
	constructor(options: ZCodeProjectionOptions) {
		this.#options = options;
		for (const [agentId, sessionId] of Object.entries(options.childSessions ?? {}))
			this.#childSessions.set(agentId, sessionId);
		this.#executionActive = options.session?.isStreaming ?? options.state?.control?.phase === "running";
		this.#resetBoundaryId = options.session?.sessionManager
			.getBranch()
			.findLast(entry => entry.type === "reset_boundary")?.id;
		this.#observedLeafId = options.session?.sessionManager.getLeafId();
		this.#acceptedModelSelection =
			acceptedModelSelection(options.session?.sessionManager.getBranch() ?? []) ??
			options.state?.config?.modelSelection;
		this.#forkParentSessionId = options.parentSessionId;
		const allow = { allowed: true as const };
		this.#state = conversationSnapshotSchema.parse({
			protocolVersion: 1,
			sessionId: options.sessionId,
			logEpoch: options.logEpoch ?? randomUUID(),
			seq: 0,
			revision: 0,
			control: {
				phase: "completedSuccess",
				sessionEnded: true,
				canStop: false,
				stopState: "idle",
				stopTargetKind: "unknown",
				activeWorks: [],
				lastError: null,
				apiRetry: null,
			},
			availability: {
				fork: allow,
				compact: allow,
				switchModelConfig: allow,
				setFollowupMode: allow,
				queueEdit: allow,
				sendQueuedNow: allow,
				pauseGoal: allow,
				resumeGoal: allow,
			},
			inputRouting: { mode: "startNow" },
			meta: {
				title: options.session?.sessionName ?? "",
				titleSource:
					options.session?.sessionManager.titleSource === "user"
						? "custom"
						: options.session?.sessionManager.titleSource === "auto"
							? "generated"
							: "default",
			},
			config: {
				provider: options.session?.model?.provider ?? "",
				model: options.session?.model?.id ?? "",
				thought: toZCodeReasoningLevel(options.session?.thinkingLevel ?? "off"),
				thoughtLevels: options.session?.getAvailableThinkingLevels().map(toZCodeReasoningLevel) ?? [],
				...(options.session && options.reasoning ? options.reasoning(options.session) : {}),
				followupMode: "queue",
				mode: "build",
				// canonical 已接受选择意图(缺陷1):冷恢复由 state/queries 注入,live 由 journal 派生。
				...(this.#acceptedModelSelection ? { modelSelection: this.#acceptedModelSelection } : {}),
			},
			usage: {
				contextWindow: null,
				cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			},
			queue: { items: [], autoDrain: true },
			pendingInteractions: [],
			pendingCommands: [],
			backgroundWorks: [],
			subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
			goal: null,
			plan: null,
			rows: { window: [], totalCount: 0, firstRowId: null },
		});
		const history =
			options.messages ??
			(options.session
				? projectionBranch(options.session).flatMap(entry =>
						entry.type === "message"
							? [entry.message]
							: entry.type === "custom_message" && entry.display
								? [
										{
											role: "custom",
											customType: entry.customType,
											content: entry.content,
											display: entry.display,
											details: entry.details,
											timestamp: new Date(entry.timestamp).getTime(),
										} as AgentMessage,
									]
								: [],
					)
				: []);
		for (const message of history)
			this.#messages.push({ message: message as unknown as ProjectionMessage, streaming: false });
		this.#restoreCompactions(options.entries ?? (options.session ? projectionBranch(options.session) : []));
		// 详情可能在首个流式 delta 之后打开；journal 尚无这条消息，不能只等未来事件。
		const stream = options.session?.agent.state.streamMessage;
		if (
			stream?.role === "assistant" &&
			!history.some(message => message.role === "assistant" && message.timestamp === stream.timestamp)
		) {
			const obfuscator = options.session?.obfuscator;
			const message = obfuscator?.hasSecrets()
				? { ...stream, content: deobfuscateAssistantContent(obfuscator, stream.content) }
				: stream;
			this.#activeMessage = this.#messages.length;
			this.#messages.push({ message: message as unknown as ProjectionMessage, streaming: true });
		}
		this.#rebuild();
		const last = this.#messages.findLast(record => record.message.role === "assistant")?.message;
		if (last?.stopReason === "aborted")
			this.#state.control = { ...this.#state.control, phase: "completedInterrupted" };
		if (last?.stopReason === "error")
			this.#state.control = {
				...this.#state.control,
				phase: "error",
				sessionEnded: false,
				lastError: {
					code: "fault.provider",
					message: last.errorMessage ?? "Model response failed",
					recoverable: true,
					at: last.timestamp ?? 0,
					source: "provider",
				},
			};
		if (options.state) this.#state = conversationSnapshotSchema.parse({ ...this.#state, ...options.state });
		if (options.goalState)
			this.applyEvent({ type: "goal_updated", goal: options.goalState.goal, state: options.goalState });
		else {
			const goal = completedGoal(options.entries ?? []);
			if (goal) this.applyEvent({ type: "goal_updated", goal });
		}
		if (options.session) {
			this.refresh();
			this.#factsTimer = setInterval(() => this.#syncRuntimeFacts(), 250);
			this.#factsTimer.unref();
		}
		if (options.session) {
			this.#unsubscribe = options.session.subscribe(event => this.applyEvent(event));
			this.#unsubscribeTitle = options.session.sessionManager.onSessionNameChanged(() => this.refresh());
		}
		if (options.registry) {
			this.#unsubscribeRegistry = options.registry.onChange(() => this.#syncSubagents());
			this.#syncSubagents();
		}
	}

	snapshot(): ConversationSnapshot {
		return structuredClone({
			...this.#state,
			rows: {
				...this.#state.rows,
				window: this.#state.rows.window.slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows),
			},
		});
	}
	rows(): ConversationRow[] {
		return structuredClone(this.#state.rows.window);
	}
	telemetryIdentity(): { sourceCommandId: string; turnId: string; automationId?: string } | undefined {
		const message = this.#messages.findLast(record => record.message.role === "user")?.message;
		if (!message?.inputId) return undefined;
		const header = this.#state.rows.window.findLast(
			row => row.kind === "turnHeader" && row.sourceCommandId === message.inputId,
		);
		return header
			? {
					sourceCommandId: message.sourceCommand?.commandId ?? message.inputId,
					turnId: header.turnId,
					...(message.sourceCommand?.automationId ? { automationId: message.sourceCommand.automationId } : {}),
				}
			: undefined;
	}
	setWorkflowState(state: Pick<StatePatch, "workflowRuns" | "backgroundWorks">): void {
		this.#workflowState = state;
		this.setState({
			workflowRuns: state.workflowRuns,
			backgroundWorks: [
				...this.#state.backgroundWorks.filter(work => work.kind !== "workflow"),
				...(state.backgroundWorks ?? []),
			],
		});
	}
	resolveTarget(target: { rowId: number; entityId: string }): {
		entryId: string;
		message: AgentMessage;
		inputId?: string;
		messageIndex: number;
		row: ConversationRow;
	} {
		const row = this.#state.rows.window.find(
			candidate => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
		);
		const messageIndex = this.#rowMessages.get(target.entityId);
		if (!row || messageIndex === undefined) throw new Error("guard.staleRowTarget");
		const record = this.#messages[messageIndex];
		const entries = this.#options.session
			? projectionBranch(this.#options.session).filter(
					entry => entry.type === "message" || (entry.type === "custom_message" && entry.display),
				)
			: [];
		const journalIndex = entries.findIndex(
			candidate =>
				candidate.type === "message" &&
				(record.journalEntryId
					? candidate.id === record.journalEntryId
					: record.message.inputId
						? (candidate.message as AgentMessage & { inputId?: string }).inputId === record.message.inputId
						: candidate.message.role === record.message.role &&
							candidate.message.timestamp === record.message.timestamp),
		);
		const entry = entries[journalIndex];
		if (!entry || entry.type !== "message") throw new Error("guard.rowNotPersisted");
		return {
			entryId: entry.id,
			message: entry.message,
			inputId: record.message.inputId,
			messageIndex: journalIndex,
			row: structuredClone(row),
		};
	}
	subscribe(listener: (deltas: ConversationDelta[]) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribeTitle?.();
		this.#unsubscribeRegistry?.();
		clearInterval(this.#factsTimer);
		this.#listeners.clear();
	}

	setState(patch: StatePatch): void {
		const checked = statePatchSchema.parse(patch);
		if (checked.pendingInteractions) {
			// 审批锚定真实工具行；child 的工具不属于父行，保留 null 及原生 origin。
			checked.pendingInteractions = checked.pendingInteractions.map(interaction => {
				const payload = interaction.payload;
				return {
					...interaction,
					anchorRowId:
						payload.kind === "permission"
							? (this.#state.rows.window.find(
									row => row.kind === "toolCall" && row.toolCallId === payload.toolCallId,
								)?.rowId ?? null)
							: interaction.anchorRowId,
				};
			});
		}
		if (
			Object.entries(checked).every(
				([key, value]) => JSON.stringify(this.#state[key as keyof ConversationSnapshot]) === JSON.stringify(value),
			)
		)
			return;
		const previousRows = this.#state.rows.window;
		this.#state = conversationSnapshotSchema.parse({
			...this.#state,
			...checked,
			seq: this.#state.seq + 1,
			revision: this.#state.revision + 1,
		});
		const deltas: ConversationDelta[] = [
			{ op: "state.updated", patch: { ...checked, revision: this.#state.revision } },
		];
		if (checked.pendingInteractions || checked.workflowRuns) {
			this.#rebuild();
			// 同 #publishRows:按 rowId 而非索引对齐,避免插行后把未变化的既有行整行 upsert。
			const previousById = new Map(previousRows.map(row => [row.rowId, row]));
			for (const row of this.#state.rows.window) {
				const previous = previousById.get(row.rowId);
				if (previous && JSON.stringify(row) === JSON.stringify(previous)) continue;
				deltas.push(previous ? { op: "row.upserted", row } : { op: "row.appended", row });
			}
		}
		this.#emit(deltas);
	}

	/**
	 * server #model 接受 selection 后写回 canonical sessionConfig(缺陷1):
	 * modelSelection 成为会话事实,与 effective provider/model/thought 分离;
	 * 不写全局配置,也不借默认值/Recent 替代。无效载荷直接抛错,不落半截事实。
	 */
	acceptModelSelection(selection: ModelSelection): void {
		const accepted = modelSelectionSchema.parse(selection);
		this.#acceptedModelSelection = accepted;
		this.setState({ config: { ...this.#state.config, modelSelection: accepted } });
	}

	refresh(): void {
		const session = this.#options.session;
		if (!session) return;
		this.applyEvent({ type: "queue_update", ...session.getQueuedMessages() });
		const goalState = session.getGoalModeState();
		this.applyEvent({ type: "goal_updated", goal: goalState?.goal ?? null, state: goalState });
		this.#syncRuntimeFacts();
		this.setState({
			config: {
				...this.#state.config,
				provider: session.model?.provider ?? "",
				model: session.model?.id ?? "",
				thought: toZCodeReasoningLevel(session.thinkingLevel ?? "off"),
				thoughtLevels: session.getAvailableThinkingLevels().map(toZCodeReasoningLevel),
				...(this.#options.reasoning?.(session) ?? {}),
				// renderer 刷新只更新 effective 展示;canonical modelSelection 独立保留(缺陷1),
				// 自动 fallback/model_changed 不会伪造或丢失用户已接受的选择意图。
				modelSelection: this.#acceptedModelSelection,
			},
			meta: {
				title: session.sessionName ?? this.#state.meta.title,
				titleSource:
					session.sessionManager.titleSource === "user"
						? "custom"
						: session.sessionManager.titleSource === "auto"
							? "generated"
							: "default",
			},
		});
		const previousRows = this.#state.rows.window;
		this.#rebuild();
		this.#publishRows(previousRows);
	}
	#restoreCompactions(entries: readonly SessionEntry[]): void {
		for (const entry of entries) {
			if (entry.type !== "compaction" || !entry.origin) continue;
			this.#messages.push({
				message: {
					role: "compact",
					inputId: entry.operationId ?? entry.id,
					timestamp: new Date(entry.timestamp).getTime(),
					details: {
						type: "compact",
						origin: entry.origin,
						status: "success",
						summaryRef: entry.id,
						tokensBefore: entry.tokensBefore,
						tokensAfter: entry.tokensAfter,
					},
				},
				streaming: false,
			});
		}
		this.#messages.sort((a, b) => (a.message.timestamp ?? 0) - (b.message.timestamp ?? 0));
	}

	resetEpoch(): void {
		const session = this.#options.session;
		if (!session) throw new Error("A cold projection cannot change its branch");
		this.#resetBoundaryId = session.sessionManager.getBranch().findLast(entry => entry.type === "reset_boundary")?.id;
		this.#observedLeafId = session.sessionManager.getLeafId();
		this.#messages.splice(0);
		for (const entry of projectionBranch(session)) {
			if (entry.type === "message")
				this.#messages.push({ message: entry.message as unknown as ProjectionMessage, streaming: false });
			if (entry.type === "custom_message" && entry.display)
				this.#messages.push({
					message: {
						role: "custom",
						customType: entry.customType,
						content: entry.content,
						display: true,
						timestamp: new Date(entry.timestamp).getTime(),
					},
					streaming: false,
				});
		}
		this.#restoreCompactions(projectionBranch(session));
		this.#goalCompletionCalls.clear();
		this.#activeAutoCompact = undefined;
		this.#tools.clear();
		this.#activeMessage = -1;
		this.#executionActive = session.isStreaming;
		// rewind/edit 截断 branch 后按剩余 journal 重derive选择意图,sessionConfig 与
		// journal 保持一致;resetEpoch 随后的 refresh 会把它写回 config(缺陷1)。
		this.#acceptedModelSelection = acceptedModelSelection(session.sessionManager.getBranch());
		this.#state.logEpoch = randomUUID();
		this.#state.seq = 0;
		this.#state.revision = 0;
		this.#rebuild();
		this.#emit([{ op: "state.updated", patch: { revision: 0 } }]);
		this.refresh();
	}

	#syncSubagents(): void {
		const parentId = this.#options.agentId ?? "Main";
		const children =
			this.#options.registry?.list().filter(ref => ref.kind === "sub" && (ref.parentId ?? "Main") === parentId) ??
			[];
		let identityChanged = false;
		for (const ref of children) {
			const childSessionId = ref.session?.sessionManager.getSessionId();
			if (!childSessionId || this.#childSessions.get(ref.id) === childSessionId) continue;
			// provider sessionId 可被 Tan 覆盖；公开历史目标必须保持 native journal header 身份。
			this.#childSessions.set(ref.id, childSessionId);
			identityChanged = true;
		}
		// task 进度可以早于 registry 的真实 child 身份；同一次通知必须同时补齐卡片下钻。
		if (identityChanged) {
			const before = this.#state.rows.window;
			this.#rebuild();
			this.#publishRows(before);
		}
		const state = {
			childSessionIds: [...new Set(this.#childSessions.values())].sort(),
			running: children
				.filter(ref => ref.status === "running" && this.#childSessions.has(ref.id))
				.map(ref => ({
					childSessionId: this.#childSessions.get(ref.id)!,
					agentId: ref.id,
					subagentType: ref.history?.agent ?? "task",
					title: ref.displayName,
					summary: ref.activity,
					status: "running" as const,
					startedAt: ref.createdAt,
				})),
			endedTotal:
				new Set(this.#childSessions.values()).size -
				children.filter(ref => ref.status === "running" && this.#childSessions.has(ref.id)).length,
		};
		const previous = this.#state.subagents;
		if (JSON.stringify({ ...previous, revision: undefined }) === JSON.stringify(state)) return;
		this.setState({ subagents: { ...state, revision: (previous?.revision ?? 0) + 1 } });
	}
	#observeResetBoundary(): void {
		const session = this.#options.session;
		if (!session) return;
		const leafId = session.sessionManager.getLeafId();
		if (leafId === this.#observedLeafId) return;
		this.#observedLeafId = leafId;
		const boundary = session.sessionManager.getBranch().findLast(entry => entry.type === "reset_boundary")?.id;
		if (boundary === this.#resetBoundaryId) return;
		this.#resetBoundaryId = boundary;
		this.resetEpoch();
	}
	#queueRuntimeFacts(idle: boolean): Pick<StatePatch, "queue" | "inputRouting"> {
		const session = this.#options.session;
		if (!session) return idle ? { inputRouting: { mode: "startNow" } } : {};
		const autoDrain = session.getQueueAutoDrain();
		// Stop 只切换原生 held 时，条目未变的 queue_update 会被合并；刷新消费事实，不重建队列。
		return {
			...(autoDrain !== this.#state.queue.autoDrain ? { queue: { ...this.#state.queue, autoDrain } } : {}),
			...(idle
				? {
						inputRouting: {
							mode: !autoDrain && this.#state.queue.items.length ? ("choice" as const) : ("startNow" as const),
						},
					}
				: {}),
		};
	}

	#contextRuntimeFacts(): Pick<StatePatch, "usage"> {
		const session = this.#options.session;
		if (!session) return {};
		const context = session.getContextUsage();
		return {
			usage: {
				...this.#state.usage,
				contextWindow: context
					? { usedTokens: context.tokens, maxTokens: context.contextWindow, autoCompactThresholdTokens: null }
					: null,
			},
		};
	}

	#syncRuntimeFacts(): void {
		const session = this.#options.session;
		if (!session) return;
		this.#observeResetBoundary();
		// SDK attachSession 不发 registry 事件，重复 running 状态也不发；从真实 owner 刷新晚绑定身份。
		this.#syncSubagents();
		// 上下文水位归 AgentSession 所有；回复或压缩后沿用事实刷新发布，避免冷恢复旧值滞留。
		this.setState({
			...this.#queueRuntimeFacts(!session.isStreaming && !session.isCompacting),
			...this.#contextRuntimeFacts(),
		});
		const goalState = session.getGoalModeState();
		this.applyEvent({ type: "goal_updated", goal: goalState?.goal ?? null, state: goalState });
		const backgroundWorks = this.#asyncBackgroundWorks();
		if (!backgroundWorks) return;
		// 原生取消不投递 async-result;沿用事实刷新发布子代理终态,不能一直显示旧 receipt 的 running。
		const before = this.#state.rows.window;
		this.#rebuild();
		this.#publishRows(before, {
			backgroundWorks: [...backgroundWorks, ...(this.#workflowState.backgroundWorks ?? [])],
		});
	}

	/** 会话后台任务事实(运行中 + 失败/取消收尾);无会话或无 async job 管理器时返回 undefined。 */
	#asyncBackgroundWorks(): ConversationSnapshot["backgroundWorks"] | undefined {
		const session = this.#options.session;
		if (!session) return undefined;
		const jobs = session.getAsyncJobSnapshot({ recentLimit: Number.POSITIVE_INFINITY });
		if (!jobs) return undefined;
		return [...jobs.running, ...jobs.recent.filter(job => job.status === "failed" || job.status === "cancelled")].map<
			ConversationSnapshot["backgroundWorks"][number]
		>(job => ({
			workId: job.id,
			kind: job.type === "task" ? "subagent" : "bash",
			title: job.label,
			status: job.status === "running" ? "running" : job.status === "cancelled" ? "cancelled" : "failed",
			startedAt: job.startTime,
			endedAt: job.endTime,
			cancellable: job.status === "running",
			anchorRowId: null,
			childSessionId: job.agentId ? this.#childSessions.get(job.agentId) : undefined,
		}));
	}

	applyEvent(event: AgentSessionEvent): void {
		this.#observeResetBoundary();
		const before = this.#state.rows.window;
		if (event.type === "manual_compaction_start" || event.type === "auto_compaction_start") {
			const origin = event.type === "manual_compaction_start" ? "manual" : "auto";
			const operationId = event.operationId ?? `auto:${randomUUID()}`;
			if (origin === "auto") this.#activeAutoCompact = operationId;
			this.#messages.push({
				message: {
					role: "compact",
					inputId: operationId,
					timestamp: Date.now(),
					details: { type: "compact", origin, status: "running" },
				},
				streaming: false,
			});
			this.#rebuild();
			this.#publishRows(before);
			this.setState({
				inputRouting: { mode: "enqueue" },
				control: {
					...this.#state.control,
					phase: "running",
					sessionEnded: false,
					canStop: true,
					stopState: "stoppable",
					stopTargetKind: "compact",
					activeWorks: [
						...this.#state.control.activeWorks.filter(work => work.kind !== "compact"),
						{ kind: "compact", startedAt: Date.now() },
					],
				},
			});
		}
		if (event.type === "manual_compaction_end" || event.type === "auto_compaction_end") {
			const operationId = event.operationId ?? this.#activeAutoCompact;
			const record = this.#messages.find(
				item => item.message.role === "compact" && item.message.inputId === operationId,
			);
			if (record) {
				const entry = this.#options.session?.sessionManager
					.getBranch()
					.findLast(item => item.type === "compaction");
				record.message.details = {
					type: "compact",
					origin: event.type === "manual_compaction_end" ? "manual" : "auto",
					status: event.aborted ? "cancelled" : event.result ? "success" : event.skipped ? "noop" : "failed",
					tokensBefore: event.result?.tokensBefore,
					summaryRef: event.summaryRef ?? (event.result && entry?.type === "compaction" ? entry.id : undefined),
				};
				this.#rebuild();
				this.#publishRows(before);
			}
			if (event.type === "auto_compaction_end") this.#activeAutoCompact = undefined;
			const running = this.#options.session?.isStreaming ?? false;
			this.setState({
				inputRouting: {
					mode: running
						? "enqueue"
						: this.#options.session &&
							  !this.#options.session.getQueueAutoDrain() &&
							  this.#options.session.getQueuedInputMessages().length
							? "choice"
							: "startNow",
				},
				control: {
					...this.#state.control,
					phase: running ? "running" : event.aborted ? "completedInterrupted" : "completedSuccess",
					sessionEnded: !running,
					canStop: running,
					stopState: running ? "stoppable" : "idle",
					stopTargetKind: running ? "assistant" : "unknown",
					activeWorks: this.#state.control.activeWorks.filter(work => work.kind !== "compact"),
				},
			});
		}
		if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
			const message = event.message as unknown as ProjectionMessage;
			// A provider message ends before AgentSession maintenance, queued input and
			// async delivery settle. Keep only its terminal presentation live until
			// the owner publishes a true end; text deltas and tool progress still flow.
			const pendingSettlement =
				event.type === "message_end" &&
				message.role === "assistant" &&
				this.#executionActive &&
				!(Array.isArray(message.content) && message.content.some(block => block.type === "toolCall"));
			let index = message.inputId
				? this.#messages.findIndex(record => record.message.inputId === message.inputId)
				: -1;
			// journal-only custom 已由事实刷新补入；晚到的 message_end 只能更新同一行，不能重复追加。
			if (index < 0 && message.role === "custom")
				index = this.#messages.findIndex(
					record =>
						record.message.role === "custom" &&
						record.message.customType === message.customType &&
						record.message.timestamp === message.timestamp &&
						textContent(record.message) === textContent(message),
				);
			if (index < 0 && this.#activeMessage >= 0) {
				const active = this.#messages[this.#activeMessage];
				if (active.message.role === message.role && active.message.timestamp === message.timestamp)
					index = this.#activeMessage;
			}
			if (index < 0) {
				index = this.#messages.length;
				this.#messages.push({
					message,
					streaming: event.type !== "message_end" || pendingSettlement,
					pendingSettlement,
				});
			} else
				this.#messages[index] = {
					...this.#messages[index],
					message,
					streaming: event.type !== "message_end" || pendingSettlement,
					pendingSettlement,
				};
			// busy 命令结果独立追加，不能抢走仍在 streaming 的 assistant 消息所有权。
			if (
				message.role !== "custom" ||
				event.type !== "message_end" ||
				this.#activeMessage < 0 ||
				this.#messages[this.#activeMessage].message.role !== "assistant"
			)
				this.#activeMessage = event.type === "message_end" ? -1 : index;
			this.#rebuild();
			this.#publishRows(before);
			if (message.role === "assistant" && message.stopReason === "error")
				this.#error(message.errorMessage ?? "Model response failed", message.timestamp ?? Date.now());
		}
		if (event.type === "agent_start") {
			this.#executionActive = true;
			this.#rebuild();
			this.#publishRows(before, {
				control: {
					...this.#state.control,
					phase: "running",
					sessionEnded: false,
					canStop: true,
					stopState: "stoppable",
					stopTargetKind: "assistant",
					activeWorks: [
						{
							kind: "primaryTurn",
							sourceCommandId: this.#messages.findLast(record => record.message.role === "user")?.message
								.inputId,
							startedAt: Date.now(),
						},
					],
					lastError: null,
				},
				inputRouting: { mode: "enqueue" },
			});
		}
		// 非终态 settle(awaitingAsyncWork:模型让出控制权、仅后台任务结果可唤醒)进入合同内
		// 的 yielded-awaiting-background 形态(见下方分支注释),否则后台 job 存活期间会话在
		// GUI 侧永不回 idle(BDO04)。其余 isTerminal:false(排队续跑/IRC 唤醒/重试)不 settle:
		// 紧随的 agent_start 会重新进入 running。
		if (event.type === "agent_end" && (event.isTerminal !== false || event.awaitingAsyncWork === true)) {
			if (
				this.#options.session?.isCompacting ??
				this.#state.control.activeWorks.some(work => work.kind === "compact")
			) {
				this.setState({
					inputRouting: { mode: "enqueue" },
					control: {
						...this.#state.control,
						phase: "running",
						sessionEnded: false,
						canStop: true,
						stopState: "stoppable",
						stopTargetKind: "compact",
						activeWorks: this.#state.control.activeWorks.filter(work => work.kind === "compact"),
					},
				});
				return;
			}
			const last = this.#messages.findLast(record => record.message.role === "assistant")?.message;
			const phase =
				last?.stopReason === "aborted"
					? "completedInterrupted"
					: last?.stopReason === "error"
						? "error"
						: "completedSuccess";
			this.#executionActive = false;
			for (const record of this.#messages)
				if (record.pendingSettlement) {
					record.streaming = false;
					record.pendingSettlement = false;
				}
			this.#rebuild();
			// 收口同时发布最终上下文水位，不能让 idle/choice 携带旧水位，再由
			// 250ms 事实刷新制造无新业务转移的 revision，令紧随的 Resume CAS 过期。
			const queueFacts = { ...this.#queueRuntimeFacts(true), ...this.#contextRuntimeFacts() };
			if (event.isTerminal === false) {
				// 合同内的 yielded-awaiting-background 形态(缺陷3,BDO04):模型让出控制权、
				// 仅后台任务结果可唤醒。前台回合已收口 → phase=completed*、composer 满足
				// idle 判定(canStop=false 且 stopState=idle,即 Root 无 Stop 按钮);但与完全
				// 终态不同,「等待后台」事实随同一 state.updated 原子发布:backgroundWorks 保持
				// running/cancellable,保留 cancelBackgroundWork 停止语义,后台结果唤醒会再走
				// agent_start 重新进入 running。activeWorks 只清主 turn 占位(后台任务不在其
				// 闭集枚举内,由 backgroundWorks 事实链路维护),不整帧伪装成无后台的完全 idle。
				const awaited = this.#asyncBackgroundWorks();
				this.#publishRows(before, {
					control: {
						...this.#state.control,
						phase,
						sessionEnded: phase !== "error",
						canStop: false,
						stopState: "idle",
						activeWorks: this.#state.control.activeWorks.filter(work => work.kind !== "primaryTurn"),
					},
					...(awaited ? { backgroundWorks: [...awaited, ...(this.#workflowState.backgroundWorks ?? [])] } : {}),
					...queueFacts,
				});
			} else
				this.#publishRows(before, {
					control: {
						...this.#state.control,
						phase,
						sessionEnded: phase !== "error",
						canStop: false,
						stopState: "idle",
						activeWorks: [],
					},
					...queueFacts,
				});
		}
		if (event.type === "tool_execution_start") {
			this.#tools.set(event.toolCallId, { status: "running" });
			if (completingGoal(event.toolName, event.args) && this.#state.goal) {
				this.#goalCompletionCalls.add(event.toolCallId);
				this.setState({ goal: { ...this.#state.goal, status: "verifying" } });
			}
			this.#rebuild();
			this.#publishRows(before);
			this.setState({ control: { ...this.#state.control, stopTargetKind: "tool" } });
		}
		if (event.type === "tool_execution_update") {
			const partial = event.partialResult as { content?: ProjectionMessage["content"] };
			if (partial?.content) {
				const output = textContent({ role: "toolResult", content: partial.content });
				const outputPreview = event.toolName === "bash" ? bashOutputPreview(output) : undefined;
				this.#tools.set(event.toolCallId, {
					status: "running",
					output: outputPreview?.fullText ?? output,
					outputPreview,
				});
				this.#rebuild();
				this.#publishRows(before);
			}
		}
		if (event.type === "tool_execution_end") {
			this.#goalCompletionCalls.delete(event.toolCallId);
			this.#tools.set(event.toolCallId, {
				status: event.isError ? "error" : "success",
				output: textContent({ role: "toolResult", content: event.result.content }),
			});
			this.#rebuild();
			this.#publishRows(before);
		}
		if (event.type === "auto_retry_start")
			this.setState({
				control: {
					...this.#state.control,
					apiRetry: {
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						nextRetryAt: Date.now() + event.delayMs,
						reasonCode: event.errorMessage,
					},
				},
			});
		if (event.type === "auto_retry_end") {
			this.setState({ control: { ...this.#state.control, apiRetry: null } });
			if (!event.success && event.finalError) this.#error(event.finalError, Date.now());
		}
		if (event.type === "queue_update" && this.#options.session) {
			const queued = this.#options.session.getQueuedInputMessages();
			const guiding = new Set(this.#options.session.agent.peekSteeringQueue());
			const highspeed = readHighspeedInputFacts(projectionBranch(this.#options.session));
			this.setState({
				queue: {
					...this.#state.queue,
					autoDrain: this.#options.session.getQueueAutoDrain(),
					items: queued.map((raw, index) => {
						const message = raw as unknown as ProjectionMessage;
						if (!message.inputId) throw new Error("Queued ZCode input is missing its runtime admission identity");
						return {
							sourceCommandId: message.sourceCommand?.commandId ?? message.inputId,
							queueItemId: message.inputId,
							clientId: message.inputClientId ?? "omp",
							provenance: {
								sourceCommandId: message.sourceCommand?.commandId ?? message.inputId,
								queueItemId: message.inputId,
								clientId: message.inputClientId ?? "omp",
							},
							kind:
								message.sourceCommand?.type === "sendGoalCommand" ||
								/^\/goal(?:-autopilot)?(?:\s|$)/.test(textContent(message))
									? ("sendGoalCommand" as const)
									: message.sourceCommand?.type === "compact"
										? ("compact" as const)
										: ("sendText" as const),
							text: textContent(message),
							attachments: message.attachments ?? [],
							highspeed: highspeed.get(message.inputId),
							delivery: {
								requested: guiding.has(raw) ? ("guide" as const) : ("queue" as const),
								admitted: guiding.has(raw) ? ("guide" as const) : ("queue" as const),
							},
							order: { admissionSeq: message.inputAdmissionSeq ?? 0, queuePosition: index },
							steer: { state: guiding.has(raw) ? ("steering" as const) : ("notRequested" as const) },
							dispatch: { state: "queued" as const },
							admittedAt: message.timestamp ?? 0,
						};
					}),
				},
			});
			if (!this.#options.session.isStreaming && !this.#options.session.isCompacting)
				this.setState({
					inputRouting: {
						mode: !this.#state.queue.autoDrain && queued.length ? "choice" : "startNow",
					},
				});
		}
		if (event.type === "goal_updated") {
			const goal =
				event.goal ??
				completedGoal(
					this.#options.session ? projectionBranch(this.#options.session) : (this.#options.entries ?? []),
				);
			this.setState({
				goal:
					goal && goal.status !== "dropped"
						? {
								targetId: goal.id,
								objective: goal.objective,
								summaryTitle: null,
								timeUsedSeconds: Math.floor(goal.timeUsedSeconds),
								activeRunStartedAtMs: null,
								status:
									goal.status === "complete"
										? "verified"
										: goal.status === "active"
											? this.#goalCompletionCalls.size
												? "verifying"
												: "active"
											: "paused",
								iteration: 0,
								verifications: [],
								iterations: [],
							}
						: null,
			});
		}
		if (event.type === "model_changed" || event.type === "thinking_level_changed") this.refresh();
	}

	summary(workspaceId: string): SessionSummary {
		const state = this.#state;
		const times = this.#messages.map(record => record.message.timestamp ?? 0);
		return {
			sessionId: state.sessionId,
			workspaceId,
			title: state.meta.title,
			titleSource: state.meta.titleSource,
			phase: state.control.phase,
			sessionEnded: state.control.sessionEnded,
			hasBackgroundWork: state.backgroundWorks.some(work => work.status === "running"),
			workflowActivity: deriveSessionWorkflowActivity({
				workflowRuns: state.workflowRuns,
				backgroundWorks: state.backgroundWorks,
			}),
			createdAt: times[0] ?? 0,
			lastActivityAt: times.at(-1) ?? 0,
			lastAssistantPreview:
				state.rows.window.findLast(row => row.kind === "assistantText")?.kind === "assistantText"
					? (
							state.rows.window.findLast(row => row.kind === "assistantText") as Extract<
								ConversationRow,
								{ kind: "assistantText" }
							>
						).text.slice(0, 120)
					: undefined,
			pendingInteractionSummary: {
				permissionCount: state.pendingInteractions.filter(item => item.kind === "permission").length,
				userInputCount: state.pendingInteractions.filter(item => item.kind === "userInput").length,
			},
			goalStatus: state.goal?.status,
		};
	}

	#error(message: string, at: number): void {
		this.setState({
			control: {
				...this.#state.control,
				phase: "error",
				lastError: { code: "fault.provider", message, recoverable: true, at, source: "provider" },
			},
		});
	}
	#emit(deltas: ConversationDelta[]): void {
		for (const listener of this.#listeners) listener(deltas);
	}
	#publishRows(before: ConversationRow[], patch?: StatePatch): void {
		const checked = patch ? statePatchSchema.parse(patch) : undefined;
		const stateChanged =
			checked &&
			Object.entries(checked).some(
				([key, value]) => JSON.stringify(this.#state[key as keyof ConversationSnapshot]) !== JSON.stringify(value),
			);
		if (checked) this.#state = conversationSnapshotSchema.parse({ ...this.#state, ...checked });
		const deltas: ConversationDelta[] = [];
		// diff 按 rowId(稳定语义身份)对齐而不是索引:插行后索引错位会把未变化的既有行
		// 判成「变化」并整行 upsert,违反既有行 rowId 稳定不变量;键对齐保证旧行不动、
		// 新行 row.appended。删除按协议后缀语义(row.removed 移除客户端所有 rowId >= fromRowId
		// 的行),先截断,再完整重交付该后缀内仍存活的行。
		const previousById = new Map(before.map(row => [row.rowId, row]));
		const orphaned = before.filter(row => !this.#state.rows.window.some(current => current.rowId === row.rowId));
		const removedFromRowId = orphaned.length ? Math.min(...orphaned.map(row => row.rowId)) : undefined;
		if (removedFromRowId !== undefined) deltas.push({ op: "row.removed", fromRowId: removedFromRowId });
		for (const row of this.#state.rows.window) {
			const previous =
				removedFromRowId !== undefined && row.rowId >= removedFromRowId ? undefined : previousById.get(row.rowId);
			if (previous && JSON.stringify(row) === JSON.stringify(previous)) continue;
			if (
				previous &&
				(row.kind === "assistantText" || row.kind === "reasoning") &&
				previous.kind === row.kind &&
				previous.state === "streaming" &&
				row.state === "streaming" &&
				row.text.startsWith(previous.text) &&
				JSON.stringify({ ...previous, text: row.text }) === JSON.stringify(row)
			) {
				deltas.push({
					op: "row.delta",
					rowId: row.rowId,
					path: "text",
					append: row.text.slice(previous.text.length),
				});
			} else deltas.push({ op: previous ? "row.upserted" : "row.appended", row });
		}
		if (deltas.length || stateChanged) {
			this.#state.seq++;
			this.#state.revision++;
			deltas.push({
				op: "state.updated",
				patch: { ...checked, revision: this.#state.revision, usage: this.#state.usage },
			});
			this.#emit(deltas);
		}
	}

	/** 稳定 rowId:同一 entityId 生命周期内恒等返回;新实体取单调递增的 nextRowId,永不复用。 */
	#stableRowId(entityId: string): number {
		let rowId = this.#rowIds.get(entityId);
		if (rowId === undefined) {
			rowId = this.#nextRowId++;
			this.#rowIds.set(entityId, rowId);
		}
		return rowId;
	}

	#rebuild(): void {
		const entries = this.#options.session ? visibleJournalEntries(projectionBranch(this.#options.session)) : [];
		// 原生 nextTurn/triggerTurn:false（包括 Team dispatch/result）只提交 journal，不发布消息事件。
		// 沿用既有事实刷新投影这些真实公开行；以 journal ordinal 生成锚点，不能等重新打开会话才出现。
		const customMessages = new Map<string, MessageRecord[]>();
		for (const record of this.#messages) {
			if (record.message.role !== "custom") continue;
			const key = `${record.message.timestamp ?? 0}:${record.message.customType ?? ""}`;
			const records = customMessages.get(key);
			if (records) records.push(record);
			else customMessages.set(key, [record]);
		}
		let appendedCustom = false;
		for (const entry of entries) {
			if (entry.type !== "custom_message") continue;
			const timestamp = new Date(entry.timestamp).getTime();
			const existing =
				customMessages.get(`${timestamp}:${entry.customType ?? ""}`)?.shift() ??
				this.#messages.find(
					record =>
						!record.journalEntryId &&
						record.message.role === "custom" &&
						record.message.customType === entry.customType &&
						textContent(record.message) ===
							textContent({ role: "custom", content: entry.content } as ProjectionMessage),
				);
			if (existing) {
				existing.journalEntryId = entry.id;
				continue;
			}
			this.#messages.push({
				message: {
					role: "custom",
					customType: entry.customType,
					content: entry.content,
					display: entry.display,
					details: entry.details,
					timestamp,
				},
				streaming: false,
				journalEntryId: entry.id,
			});
			appendedCustom = true;
		}
		if (appendedCustom) {
			const active = this.#messages[this.#activeMessage];
			this.#messages.sort((a, b) => (a.message.timestamp ?? 0) - (b.message.timestamp ?? 0));
			this.#activeMessage = active ? this.#messages.indexOf(active) : -1;
		}
		const rows: ConversationRow[] = [];
		const highspeed = readHighspeedInputFacts(
			this.#options.session ? projectionBranch(this.#options.session) : (this.#options.entries ?? []),
		);
		this.#rowMessages.clear();
		let turnId = `${this.#options.sessionId}:initial`;
		const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
		const results = new Map(
			this.#messages
				.filter(record => record.message.role === "toolResult")
				.map(record => [record.message.toolCallId, record.message]),
		);
		const turnResults = new Map<string, ProjectionMessage[]>();
		const turnMessages = new Map<string, MessageRecord[]>();
		const revertedTargets = new Set(this.#options.revertedTargets);
		for (const entry of this.#options.session?.sessionManager.getBranch() ?? []) {
			if (
				entry.type !== "custom" ||
				entry.customType !== "workspace-file-rewind" ||
				!entry.data ||
				typeof entry.data !== "object"
			)
				continue;
			if (
				!("targetEntityId" in entry.data) ||
				typeof entry.data.targetEntityId !== "string" ||
				!("receipts" in entry.data) ||
				!Array.isArray(entry.data.receipts)
			)
				continue;
			if (
				entry.data.receipts.length > 0 &&
				entry.data.receipts.every(
					receipt =>
						receipt &&
						typeof receipt === "object" &&
						"status" in receipt &&
						(receipt.status === "restored" || receipt.status === "unchanged"),
				)
			)
				revertedTargets.add(entry.data.targetEntityId);
		}
		const deliveredJobs = new Map(
			this.#messages.flatMap(record => {
				const message = record.message;
				if (message.role !== "custom" || message.customType !== "async-result") return [];
				const details = message.details as AsyncResultDetails | undefined;
				return (details?.jobs ?? []).map(job => [job.agentId ?? job.jobId, job] as const);
			}),
		);
		const jobs = this.#options.session?.getAsyncJobSnapshot({ recentLimit: Number.POSITIVE_INFINITY });
		const taskJobs = new Map(
			[...(jobs?.running ?? []), ...(jobs?.recent ?? [])]
				.filter(job => job.type === "task" && job.agentId)
				.map(job => [job.agentId, job]),
		);
		const journalOrdinals = new Map<string, number[]>();
		for (const [ordinal, entry] of entries.entries()) {
			const message =
				entry.type === "message"
					? (entry.message as unknown as ProjectionMessage)
					: entry.type === "custom_message"
						? { role: "custom", timestamp: new Date(entry.timestamp).getTime(), customType: entry.customType }
						: undefined;
			if (!message) continue;
			const key = `${message.role}:${message.timestamp ?? 0}:${message.customType ?? ""}`;
			const ordinals = journalOrdinals.get(key);
			if (ordinals) ordinals.push(ordinal);
			else journalOrdinals.set(key, [ordinal]);
		}
		let messageOrdinal = -1;
		// The manager resolves the actual inherited journal boundary, including later-turn forks.
		// Allocate the marker before any child rows so rowId order survives cold reconstruction.
		let forkNoticeEmitted = false;
		const emitForkNotice = () => {
			if (!this.#forkParentSessionId || !this.#options.inheritedMessageCount || forkNoticeEmitted || !rows.length)
				return;
			forkNoticeEmitted = true;
			const entityId = `${this.#options.sessionId}:forkNotice`;
			const rowId = this.#stableRowId(entityId);
			rows.push(
				conversationRowSchema.parse({
					rowId,
					turnId,
					productTurnId: turnId,
					entityId,
					createdAt: rows[rows.length - 1].createdAt,
					createdAtSeq: rowId,
					kind: "timelineMarker",
					lane: "turnTailBoundary",
					marker: { type: "forkNotice", parentSessionId: this.#forkParentSessionId, parentRowId: 0 },
				}),
			);
		};
		for (const [index, record] of this.#messages.entries()) {
			const message = record.message;
			// 直接追加的 developer 提醒没有 message 事件；已持久化消息必须以真实 journal ordinal 为准。
			// 同时冷读不包含 display:false custom，不能把它们计入公开实体序号。
			if (message.role !== "compact" && !(message.role === "custom" && !message.display)) messageOrdinal++;
			const nativeOrdinal = journalOrdinals
				.get(`${message.role}:${message.timestamp ?? 0}:${message.customType ?? ""}`)
				?.shift();
			if (nativeOrdinal !== undefined) messageOrdinal = nativeOrdinal;
			if (message.role !== "compact" && messageOrdinal >= (this.#options.inheritedMessageCount ?? Infinity))
				emitForkNotice();
			if (message.role === "toolResult") {
				const group = turnResults.get(turnId) ?? [];
				group.push(message);
				turnResults.set(turnId, group);
				const records = turnMessages.get(turnId) ?? [];
				records.push(record);
				turnMessages.set(turnId, records);
			}
			const entry = nativeOrdinal === undefined ? undefined : entries[nativeOrdinal];
			// developer 提醒直接写 journal 后 ordinal 会补齐；迁移 journal→已发布实体，
			// 不重新分配流式行。以 entry.id 恢复分支身份，不能让同时间戳的新消息复用旧 target。
			let entity = (entry && this.#journalEntities.get(entry.id)) ?? record.entity;
			if (!entity) {
				entity = messageEntity(this.#options.sessionId, message, messageOrdinal);
				if (!message.inputId && this.#messageEntities.has(entity))
					entity = `${entity}:message:${this.#nextMessageEntity++}`;
				this.#messageEntities.add(entity);
			}
			record.entity = entity;
			if (entry) {
				this.#journalEntities.set(entry.id, entity);
				record.journalEntryId = entry.id;
			}
			const createdAt = message.timestamp ?? 0;
			const base = (suffix: string) => {
				const entityId = `${entity}:${suffix}`;
				this.#rowMessages.set(entityId, index);
				// rowId 按 entityId 持久分配(见 #rowIds 声明处的说明),不再用 rows.length+1
				// 的位置值 —— 位置值会在中途插行时让后续所有行漂移并触发整行 upsert。
				const rowId = this.#stableRowId(entityId);
				return {
					rowId,
					turnId,
					productTurnId: turnId,
					entityId,
					createdAt,
					createdAtSeq: rowId,
				};
			};
			if (message.role === "custom" && message.customType === "zcode-workflow-launch") {
				const details = message.details as { launch?: unknown; inputId?: string } | undefined;
				const parsed = workflowLaunchMetaSchema.safeParse(details?.launch);
				if (parsed.success) {
					turnId = `${this.#options.sessionId}:${details?.inputId ?? parsed.data.runId}:turn`;
					const run = this.#state.workflowRuns?.runs.find(run => run.runId === parsed.data.runId);
					rows.push(
						conversationRowSchema.parse({
							...base("header"),
							kind: "turnHeader",
							origin: "workflowLaunch",
							executionKind: "controlOnly",
							sourceCommandId: details?.inputId,
							workflowLaunch: parsed.data,
							state:
								run?.status === "errored"
									? "failed"
									: run?.status === "stopped"
										? "completedInterrupted"
										: "completedSuccess",
							startedAt: createdAt,
						}),
					);
					rows.push(
						conversationRowSchema.parse({
							...base("launch"),
							kind: "userInput",
							origin: "workflowLaunch",
							text: textContent(message),
							sourceCommandId: details?.inputId,
							workflowLaunch: parsed.data,
						}),
					);
				}
			}
			if (message.role === "user") {
				turnId = `${entity}:turn`;
				rows.push(
					conversationRowSchema.parse({
						...base("header"),
						kind: "turnHeader",
						origin: "userInput",
						executionKind: "agent",
						sourceCommandId: message.inputId,
						state: "completedSuccess",
						startedAt: createdAt,
					}),
				);
				rows.push(
					conversationRowSchema.parse({
						...base("input"),
						kind: "userInput",
						text: textContent(message),
						origin: "realUser",
						sourceCommandId: message.inputId,
						clientId: message.inputClientId,
						attachments: message.attachments,
						highspeed: message.inputId ? highspeed.get(message.inputId) : undefined,
						actions: { canFork: true, canEdit: true, editDisposition: "rewind" },
					}),
				);
			} else if (message.role === "assistant") {
				const records = turnMessages.get(turnId) ?? [];
				records.push(record);
				turnMessages.set(turnId, records);
				const response = `${entity}:response`;
				const entry = message.inputId
					? entries.find(
							candidate =>
								candidate.type === "message" &&
								(candidate.message as AgentMessage & { inputId?: string }).inputId === message.inputId,
						)
					: entries[messageOrdinal];
				// UI 依赖此权威 action；临时／流式文本或没有真实 assistant journal target 时不能提供分支。
				const canFork =
					!record.streaming &&
					message.stopReason !== "error" &&
					message.stopReason !== "aborted" &&
					Boolean(this.#options.session?.sessionManager.getSessionFile()) &&
					entry?.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.timestamp === message.timestamp &&
					JSON.stringify(entry.message.content) === JSON.stringify(message.content);
				for (const [blockIndex, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
					const common = { ...base(String(blockIndex)), assistantResponseId: response };
					if (block.type === "text")
						rows.push(
							conversationRowSchema.parse({
								...common,
								kind: "assistantText",
								text: block.text ?? "",
								state: record.streaming
									? "streaming"
									: message.stopReason === "aborted"
										? "interrupted"
										: message.stopReason === "error"
											? "failed"
											: "complete",
								model: message.model,
								actions: canFork ? { canFork: true } : undefined,
							}),
						);
					if (block.type === "thinking")
						rows.push(
							conversationRowSchema.parse({
								...common,
								kind: "reasoning",
								text: block.thinking ?? "",
								state: record.streaming
									? "streaming"
									: message.stopReason === "aborted"
										? "interrupted"
										: "complete",
							}),
						);
					if (block.type === "toolCall") {
						const result = results.get(block.id);
						const live = this.#tools.get(block.id ?? "");
						const interaction = this.#state.pendingInteractions.find(
							item => item.payload.kind !== "workspaceHookReview" && item.payload.toolCallId === block.id,
						);
						// 冷历史没有本代执行实例；缺失结果表示中断，不能沿用实时工具的 running 默认值。
						const status = result
							? result.cancelled
								? "cancelled"
								: result.isError
									? "error"
									: "success"
							: interaction
								? "pendingApproval"
								: (live?.status ??
									(record.streaming
										? "inputStreaming"
										: !this.#options.session || message.stopReason === "aborted"
											? "cancelled"
											: "running"));
						const semantic = result
							? semanticToolResult(result as unknown as Extract<AgentMessage, { role: "toolResult" }>)
							: undefined;
						const args =
							block.arguments && typeof block.arguments === "object"
								? (block.arguments as Record<string, unknown>)
								: undefined;
						const deviceName =
							block.name === "write" && typeof args?.path === "string"
								? /^xd:\/\/([^/?#:]+)/.exec(args.path)?.[1]
								: undefined;
						const presentationName = semantic?.toolName ?? deviceName ?? block.name ?? "";
						const agentMessageWrite =
							presentationName === "write" && typeof args?.path === "string" && args.path.startsWith("agent://");
						const messageReceipt = agentMessageWrite ? semantic?.details.message : undefined;
						const display = toolResultDisplaySchema.safeParse(semantic?.details ?? result?.details);
						// Agent is the renderer's semantic card, not an executable tool alias.
						// Keep the native batch and result intact; derive its visible fields from
						// the actual assignment and the native spawn receipt.
						const taskDetails =
							presentationName === "task" && isTaskToolDetails(result?.details) ? result.details : undefined;
						// 后台 Bash 的 toolResult 带 details.async({state,jobId,type:"bash"},见
						// tools/bash.ts 的后台启动/终帧)。按协议合同(toolCall 行 backgrounded 必带
						// workId,10-protocol-spec.md)与下方 subagent 行同法锚定后台任务;该事实随
						// journal 持久,冷恢复后 GUI 仍能从这一行重新定位后台任务与输出详情。
						const bashAsync =
							presentationName === "bash"
								? (result?.details as { async?: { jobId?: unknown; type?: unknown } } | undefined)?.async
								: undefined;
						const bashWorkId =
							typeof bashAsync?.jobId === "string" && bashAsync.type === "bash" ? bashAsync.jobId : undefined;
						// BDO02:Bash 终态行产出 kind:"bash_output" display(bashTerminalOutputDisplay)。
						// 后台移交 receipt(bashWorkId)与空文本(如纯图片结果)不产 display:后台输出走
						// backgroundWorks/backgroundBashOutput 链路,同 forkZcode CLI createBashResultDisplay
						// 对 backgrounded/isImage 的取舍;原始全文事实仍保留在 output.text。
						const terminalBashText =
							presentationName === "bash" &&
							!bashWorkId &&
							(status === "success" || status === "error" || status === "cancelled")
								? result
									? textContent(result)
									: (live?.output ?? "")
								: "";
						const bashDisplay = terminalBashText ? bashTerminalOutputDisplay(terminalBashText) : undefined;
						const taskItems =
							presentationName === "task" ? (Array.isArray(args?.tasks) ? args.tasks : args ? [args] : []) : [];
						const assignments = taskItems.filter(
							(item): item is Record<string, unknown> => !!item && typeof item === "object",
						);
						const presentationInput =
							presentationName === "task"
								? {
										...args,
										description: typeof args?.i === "string" ? args.i : undefined,
										prompt: assignments
											.map(item => (typeof item.task === "string" ? item.task : ""))
											.join("\n\n"),
										subagent_type: [
											...new Set(
												assignments.map(item => (typeof item.agent === "string" ? item.agent : "task")),
											),
										].join(", "),
										...(taskDetails?.async ? { run_in_background: true } : {}),
									}
								: block.arguments;
						rows.push(
							conversationRowSchema.parse({
								...common,
								kind: "toolCall",
								toolCallId: block.id ?? `${entity}:${blockIndex}`,
								toolName: agentMessageWrite
									? presentationName
									: presentationName === "task"
										? "Agent"
										: (TOOL_PRESENTATION_NAMES[presentationName] ?? presentationName),
								status,
								approvalInteractionId: interaction?.interactionId,
								inputText: JSON.stringify(block.arguments ?? {}),
								input: presentationInput,
								output:
									result || live?.output !== undefined
										? {
												// 通信保留原生正文回执事实，不能套用文件 Write 的隐藏成功结果策略。
												text: result
													? messageReceipt !== undefined
														? `${textContent(result)}\n${JSON.stringify(messageReceipt, null, 2)}`
														: textContent(result)
													: (live?.output ?? ""),
												display: display.success ? display.data : bashDisplay,
											}
										: undefined,
								// execute renderer 只消费此有界预览；终态、后台 receipt 与回合结束均不保留旧进度。
								outputPreview:
									presentationName === "bash" && status === "running" && this.#executionActive
										? live?.outputPreview
										: undefined,
								error:
									status === "error"
										? {
												code: "fault.tool",
												message: result ? textContent(result) : (live?.output ?? "Tool failed"),
											}
										: undefined,
								...(bashWorkId !== undefined ? { backgrounded: true as const, workId: bashWorkId } : {}),
							}),
						);
						for (const progress of taskDetails?.progress ?? []) {
							const ref = this.#options.registry?.list().find(child => child.id === progress.id);
							const childSessionId =
								ref?.session?.sessionManager.getSessionId() ?? this.#childSessions.get(progress.id);
							const delivered = deliveredJobs.get(progress.id);
							const job = taskJobs.get(progress.id);
							const status = job?.status ?? delivered?.status;
							const childStatus =
								status === "completed"
									? "success"
									: status === "failed"
										? "failed"
										: status === "cancelled"
											? "cancelled"
											: status === "running"
												? "running"
												: progress.status === "completed"
													? "success"
													: progress.status === "failed"
														? "failed"
														: progress.status === "aborted"
															? "cancelled"
															: "running";
							rows.push(
								conversationRowSchema.parse({
									...base(`child:${progress.id}`),
									kind: "subagent",
									parentToolCallId: block.id,
									subagentType: progress.agent,
									status: childStatus,
									summaryText: progress.description ?? progress.task,
									childSessionId,
									workId:
										job?.id ??
										delivered?.jobId ??
										(taskDetails?.progress?.length === 1 ? taskDetails.async?.jobId : undefined),
									...(taskDetails?.async ? { backgrounded: true } : {}),
								}),
							);
						}
					}
				}
				usage.inputTokens += message.usage?.input ?? 0;
				usage.outputTokens += message.usage?.output ?? 0;
				usage.cacheReadTokens += message.usage?.cacheRead ?? 0;
				usage.cacheWriteTokens += message.usage?.cacheWrite ?? 0;
			}
			if (message.role === "compact") {
				rows.push(
					conversationRowSchema.parse({
						...base("compact"),
						kind: "timelineMarker",
						lane: "assistantWork",
						marker: message.details,
					}),
				);
			}
			if (message.role === "custom" && message.customType === "async-result") {
				const details = message.details as AsyncResultDetails | undefined;
				const jobs = details?.jobs;
				if (jobs?.length) {
					turnId = `${entity}:turn`;
					const first = jobs[0];
					rows.push(
						conversationRowSchema.parse({
							...base("header"),
							kind: "turnHeader",
							origin: "backgroundResult",
							executionKind: "agent",
							state: "completedSuccess",
							startedAt: createdAt,
							originMeta: {
								backgroundSource: first.type === "task" ? "subagent" : "bash",
								workId: first.jobId,
								title: jobs.map(job => job.label || job.jobId).join(", "),
							},
						}),
					);
				}
				continue;
			}
			if (message.role === "custom" && message.display && message.customType !== "zcode-workflow-launch") {
				if (!rows.length) {
					turnId = `${entity}:turn`;
					rows.push(
						conversationRowSchema.parse({
							...base("header"),
							kind: "turnHeader",
							origin: "userInput",
							executionKind: "controlOnly",
							state: "completedSuccess",
							startedAt: createdAt,
						}),
					);
				}
				rows.push(
					conversationRowSchema.parse({
						...base("custom"),
						kind: "assistantText",
						text: textContent(message),
						state: "complete",
					}),
				);
			}
		}
		// 修复：执行事实属于当前原生 turn，首内容前和 tool-only 不能由文本行猜测完成；
		// 仅选择最后一个原生执行 header，绝不把历史已完成回合重新标为 running。
		const activeHeader = this.#executionActive
			? rows.findLast(row => row.kind === "turnHeader" && row.executionKind === "agent")
			: undefined;
		// A child without new messages still ends at the inherited boundary.
		emitForkNotice();
		for (const row of rows)
			if (row.kind === "turnHeader") {
				const changes = turnResults.get(row.turnId) ?? [];
				let cached = this.#fileSummaries.get(row.turnId);
				if (
					!cached ||
					cached.results.length !== changes.length ||
					changes.some((message, index) => message !== cached?.results[index])
				) {
					cached = {
						results: changes,
						summary: summarizeMessageFileChanges(changes as unknown as AgentMessage[]),
					};
					this.#fileSummaries.set(row.turnId, cached);
				}
				if (cached.summary.files) {
					const reverted = revertedTargets.has(row.entityId ?? "");
					row.fileChanges = {
						additions: cached.summary.additions,
						deletions: cached.summary.deletions,
						files: cached.summary.files,
						state: reverted ? "reverted" : "active",
					};
					if (cached.summary.canRewindFiles && !reverted) row.actions = { ...row.actions, canRewindFiles: true };
				}
				const records = turnMessages.get(row.turnId) ?? [];
				row.state =
					row === activeHeader
						? "running"
						: records.some(record => record.message.stopReason === "error")
							? "failed"
							: records.some(record => record.message.stopReason === "aborted")
								? "completedInterrupted"
								: row.state;
				if (row.executionKind !== "agent" || row.state === "running") continue;
				// 结束时间与有效工时仅取可冷恢复的原生消息事实。请求 duration 不含 ask
				// 等待用户的工具时间；没有通用工具活跃时长事实，不能用整轮墙钟冒充工时。
				let endedAt: number | undefined;
				const intervals: { start: number; end: number }[] = [];
				for (const { message, streaming } of records) {
					if (streaming) continue;
					const end =
						message.role === "assistant"
							? message.completedAt
							: message.role === "toolResult"
								? message.timestamp
								: undefined;
					if (end === undefined || !Number.isFinite(end)) continue;
					endedAt = Math.max(endedAt ?? end, end);
					if (
						message.role === "assistant" &&
						message.duration !== undefined &&
						Number.isFinite(message.duration) &&
						message.duration >= 0
					)
						intervals.push({ start: end - message.duration, end });
				}
				if (endedAt !== undefined) row.endedAt = endedAt;
				// 工具（含用户等待）没有通用活跃时间事实时，不能把部分模型工时
				// 冒充整轮 activeMs；旧 journal 缺少任一请求时间也保持 optional。
				const completeTiming =
					records.length > 0 &&
					records.every(
						({ message }) =>
							message.role === "assistant" &&
							message.completedAt !== undefined &&
							Number.isFinite(message.completedAt) &&
							message.duration !== undefined &&
							Number.isFinite(message.duration) &&
							message.duration >= 0 &&
							!(Array.isArray(message.content) && message.content.some(block => block.type === "toolCall")),
					);
				if (completeTiming && intervals.length) {
					intervals.sort((left, right) => left.start - right.start);
					let activeMs = 0;
					let previousEnd = -Infinity;
					for (const interval of intervals) {
						activeMs += Math.max(0, interval.end - Math.max(previousEnd, interval.start));
						previousEnd = Math.max(previousEnd, interval.end);
					}
					row.activeMs = activeMs;
				}
			}
		// rowsRange uses rowId cursors and tail slices; late entities must follow existing IDs.
		rows.sort((left, right) => left.rowId - right.rowId);
		this.#state.rows = { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null };
		this.#state.usage = { ...this.#state.usage, cumulative: usage };
	}
}
