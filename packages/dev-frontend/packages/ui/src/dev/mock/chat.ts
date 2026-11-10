import type { IServiceAccessor, ZCodeAgentSessionTarget } from "@zcode/services";
import type { ModelSelection, ZCodeConfigOption, ZCodeTaskMeta, ZCodeTaskSnapshot, ZCodeSessionStateSnapshot, ZCodeSessionInfo, ZCodeMessageWithParts } from "@zcode/shared";
import { ZCODE_PROTOCOL_NAME, ZCODE_PROTOCOL_VERSION } from "@zcode/shared";
import {
  V4_WIRE_PROTOCOL_VERSION, commandPayloadSchemas,
  type CommandAck, type ConversationSnapshot, type ConversationRow, type ConversationTopicFrame,
  type ConversationTopicWireCandidate, type SessionsIndexSnapshot, type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate, type WorkspaceConfigSnapshot, type WorkspaceConfigTopicFrame,
  type WorkspaceConfigTopicWireCandidate, type AttachmentRef, type V4AttachmentReadResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createPrototypeEvent, silentPrototypeEvent, unavailablePrototypeOperation } from "./events.js";
import { PROTOTYPE_MODEL_SELECTION } from "./settings.js";
import { prototypeConversationFileChanges } from "./files.js";
import { getPrototypeWorkflow } from "./workflow.js";

export interface PrototypeAttachment {
  ref: string;
  bytes: number;
  adopted: boolean;
  sessionId: string;
  fileName: string;
  mime: string;
  bytesBase64: string;
}

export const PROTOTYPE_CHAT_DISCUSSIONS = {
  requirements: [
    ["我们希望为 Aurora 企业协作控制台梳理统一登录与权限体验。首屏需要让用户快速找到当前项目，登录过期后要能清晰恢复。先讨论需求，不进入实现。", "可以。建议分成四个边界：统一登录、会话恢复、角色权限、操作审计。\n\n1. 登录支持企业邮箱与 SSO 入口，错误信息靠近字段。\n2. 会话过期后保留未发送草稿，重新进入时回到原项目。\n3. 权限不足时说明缺少的角色，不展示不可操作的危险按钮。\n4. 审计记录包含操作者、对象与时间，并提供空态和筛选。\n\n以上是阶段性前端原型的讨论样例，尚未连接真实认证或 OMP 后端。"],
    ["请补充可访问性和验收边界，并把需求拆成可以分别评审的 SR。", "建议拆分为「统一登录与会话管理」「会话恢复与设备管理」「角色权限与访问边界」「操作审计与交付」。\n\n**交互验收点（待真实验证）**\n- 键盘可到达每个输入和操作项；错误提示关联对应字段。\n- 失效会话不丢失草稿，返回时明确恢复的项目。\n- 切换角色后展示一致的访问边界；空态提供下一步。\n\n右侧只读材料展示需求、拆分关系和样例审阅内容。当前只是第一阶段原型；确认交互后再接入真实 OMP 并完成实际验收。"],
  ],
  solution: [["请给统一登录与会话管理提供一个便于评审的前端方案。", "**方案讨论样例**\n\n将登录表单、会话状态展示和认证适配层分开，避免界面绑定某个服务。默认布局保留项目导航、原生聊天输入框和右侧只读资料。\n\n- 登录页：企业邮箱、SSO 入口、就地校验。\n- 会话失效：保留上下文，显示重新登录入口。\n- 恢复成功：回到之前的项目和需求讨论。\n\n预置代码差异可在原文件/审查面板查看；它不是已运行的实现。"]],
  planning: [["把会话恢复与设备管理方案转成实施计划，并说明依赖。", "**计划展示样例（未执行）**\n\n1. 确认过期、撤销、离线三类状态文案。\n2. 完成会话恢复交互和设备卡片。\n3. 用户确认后对接真实 OMP 与认证契约。\n4. 执行单元、集成与端到端验收，补齐安全审查。\n\n依赖是实际认证环境、接口权限和用户确认。当前未创建后端任务或运行测试。"]],
  executing: [["展示角色权限实现阶段的状态，以及还需要验证哪些内容。", "**实施状态演示**\n\n样例看板将权限矩阵、访问提示和审查差异分开呈现，方便讨论进行中/待评审状态。\n\n右侧文件面板包含预置源码和实际格式的 unified diff。这里的代码、状态和报告均是前端样例，没有执行工具、修改真实仓库或通过任何测试。真实实现与验收将在后续阶段完成。"]],
  pr: [["请汇总审计模块交付评审需要检查的内容。", "**交付评审样例**\n\n- 审计筛选、空态、详情和权限提示是否一致。\n- 需求与方案的关联材料是否完整。\n- 代码审查要检查过期边界、可访问性与敏感信息。\n- 真实环境的测试证据和发布审批仍待后续完成。\n\n当前 PR 地址与审阅记录是明确标注的样例，不代表已创建真实 PR、运行测试或完成验收。"]],
} satisfies Record<string, readonly (readonly [string, string])[]>;

const initialTime = Date.parse("2026-11-10T09:00:00Z");
const epoch = "prototype-browser-memory";
const configOptions: ZCodeConfigOption[] = [{ id: "model", name: "演示模型", type: "select", currentValue: "Beam Free", options: [{ value: "Beam Free", name: "Beam Free（预置回复）", modelProviderId: "prototype-opencode-go", modelProviderName: "OpenCode Go" }] }];
const slashCommands = [{ name: "help", description: "阶段性前端原型：显示预置讨论，不执行真实命令", source: "builtin" as const }];
type Stage = keyof typeof PROTOTYPE_CHAT_DISCUSSIONS;
interface LocalSession { meta: ZCodeTaskMeta; stage: Stage; snapshot: ConversationSnapshot; archived: boolean; pinned: boolean; deleted: boolean; }
interface Subscription { id: string; sessionId: string; workspacePath: string; workspaceIdentity?: string; ordinal: number; }

function stageFor(id: string): Stage {
  if (id === "demo-solution" || id.endsWith("-solution")) return "solution";
  if (id === "demo-planning" || id.endsWith("-planning")) return "planning";
  if (id === "demo-executing" || id.endsWith("-executing")) return "executing";
  if (id === "demo-pr" || id.endsWith("-pr")) return "pr";
  return "requirements";
}
function rowsFor(sessionId: string, stage: Stage): ConversationRow[] {
  const rows: ConversationRow[] = [];
  for (const [user, assistant] of PROTOTYPE_CHAT_DISCUSSIONS[stage]) appendRows(rows, sessionId, user, assistant, initialTime + rows.length * 60000);
  return rows;
}
function appendRows(rows: ConversationRow[], sessionId: string, user: string, assistant: string, at: number, commandId?: string, attachments?: AttachmentRef[]): void {
  const base = rows.length + 1;
  const turnId = `${sessionId}-turn-${base}`;
  const common = { turnId, productTurnId: turnId, createdAt: at, createdAtSeq: base };
  rows.push({ ...common, rowId: base, entityId: `${turnId}-header`, kind: "turnHeader", origin: "userInput", state: "completedSuccess", startedAt: at, endedAt: at, sourceCommandId: commandId });
  rows.push({ ...common, rowId: base + 1, entityId: `${turnId}-user`, kind: "userInput", text: user, origin: "realUser", sourceCommandId: commandId, attachments });
  rows.push({ ...common, rowId: base + 2, entityId: `${turnId}-assistant`, kind: "assistantText", text: assistant, state: "complete", model: "Beam Free · 预置演示回复" });
}
function conversation(sessionId: string, stage: Stage, title: string): ConversationSnapshot {
  const rows = rowsFor(sessionId, stage);
  return {
    protocolVersion: 1, sessionId, logEpoch: `${epoch}:${sessionId}`, seq: 1, revision: 1,
    runtimeInitialization: { status: "ready", attemptId: "prototype-no-runtime" },
    control: { phase: "completedSuccess", sessionEnded: true, canStop: false, stopState: "idle", stopTargetKind: "unknown", activeWorks: [], lastError: null, apiRetry: null },
    availability: { fork: { allowed: false, reasonCode: "prototype.unsupported" }, compact: { allowed: false, reasonCode: "prototype.unsupported" }, switchModelConfig: { allowed: true }, setFollowupMode: { allowed: true }, queueEdit: { allowed: false, reasonCode: "prototype.noQueue" }, sendQueuedNow: { allowed: false, reasonCode: "prototype.noQueue" }, pauseGoal: { allowed: false, reasonCode: "prototype.noGoal" }, resumeGoal: { allowed: false, reasonCode: "prototype.noGoal" } },
    inputRouting: { mode: "startNow" }, meta: { title, titleSource: "custom" },
    config: { modelSelection: PROTOTYPE_MODEL_SELECTION, provider: "prototype-opencode-go", model: "Beam Free", thought: "", thoughtLevels: [], followupMode: "queue", mode: "build" },
    modelTransition: null, usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    queue: { items: [], autoDrain: true }, pendingInteractions: [], pendingCommands: [], backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 }, goal: null,
    plan: stage === "planning" ? { updatedAt: initialTime, items: [{ id: "prototype-plan-1", content: "评审会话恢复交互（样例）", status: "completed" }, { id: "prototype-plan-2", content: "用户确认后对接真实 OMP", status: "pending" }, { id: "prototype-plan-3", content: "执行真实验证与验收", status: "pending" }] } : null,
    workspaceHookAdmission: null, workspaceMcpAdmission: null,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
  };
}

export function createPrototypeChatServices(attachments: Map<string, PrototypeAttachment> = new Map(), sessionWorkspaces: Map<string, string> = new Map()): Pick<IServiceAccessor, "zcodeTaskService" | "zcodeAgentService" | "zcodeSessionService"> {
  const sessions = new Map<string, LocalSession>();
  const subscriptions = new Map<string, Subscription>();
  const frames = createPrototypeEvent<ConversationTopicWireCandidate>();
  const indexFrames = createPrototypeEvent<SessionsIndexTopicWireCandidate>();
  const configFrames = createPrototypeEvent<WorkspaceConfigTopicWireCandidate>();
  const commandResults = new Map<string, CommandAck>();
  const indexSubscriptions = new Map<string, { root: string; identity?: string; ordinal: number }>();
  const workspaceSubscriptions = new Map<string, { root: string; ordinal: number }>();
  const uploads = new Map<string, { sessionId: string; fileName: string; mime: string; chunks: string[] }>();
  let nextId = 0;
  const ensure = (sessionId: string, root = "/demo/aurora-console", identity?: string): LocalSession => {
    sessionWorkspaces.set(sessionId, root);
    const key = `${root}:${identity ?? ""}:${sessionId}`;
    const existing = sessions.get(key);
    if (existing) return existing;
    const workflow = getPrototypeWorkflow({ projectId: root.includes("mobile") ? "demo-mobile" : "demo-aurora" });
    const ref = workflow.sessions.find(item => item.sessionId === sessionId);
    const sr = workflow.srs.find(item => item.id === ref?.srId);
    const group = [...workflow.groups, ...workflow.drafts].find(item => item.id === ref?.irId);
    const stage = stageFor(sessionId);
    const title = `${sr?.title ?? group?.title ?? "需求讨论"} · ${stage === "requirements" ? "需求" : stage === "solution" ? "方案" : stage === "planning" ? "计划" : stage === "executing" ? "实施" : "交付"}（样例）`;
    const snapshot = conversation(sessionId, stage, title);
    if (group?.id === "ir-dashboard") {
      snapshot.rows.window = []; appendRows(snapshot.rows.window, sessionId, "希望团队数据总览能清晰展示项目进度和趋势，支持筛选和空态。", "**数据总览需求讨论样例**\n\n建议提供概览指标、趋势卡片、项目筛选及无数据状态，并补齐键盘导航和窄屏布局。这里仅使用独立的前端样例，不读取真实指标。", initialTime);
      snapshot.rows.totalCount = snapshot.rows.window.length; snapshot.rows.firstRowId = 1;
    }
    if (root.includes("mobile")) {
      snapshot.rows.window = []; appendRows(snapshot.rows.window, sessionId, `请讨论${sr?.title ?? group?.title ?? "移动工作台"}的移动端体验。`, `**移动工作台${stage}讨论样例**\n\n为${sr?.title ?? "移动协作"}提供单手可触达导航、明确返回路径、加载与离线提示。保留项目上下文并使用可访问标签。\n\n当前内容仅为阶段性前端原型样例，未读取设备、运行工具或接入真实 OMP。`, initialTime);
      snapshot.rows.totalCount = snapshot.rows.window.length; snapshot.rows.firstRowId = 1;
    }
    const value: LocalSession = { stage, snapshot, archived: false, pinned: false, deleted: false,
      meta: { taskId: sessionId, traceId: `prototype:${sessionId}`, title, workspacePath: root, workspaceIdentity: identity, createdAt: initialTime, updatedAt: initialTime, mode: "build", provider: "glm", model: "Beam Free", status: "completed" } };
    sessions.set(key, value); return value;
  };
  const target = (params: ZCodeAgentSessionTarget) => ensure(params.sessionId, params.workspacePath, params.workspaceIdentity);
  const list = (root: string, identity?: string) => {
    const projectId = root.includes("mobile") ? "demo-mobile" : "demo-aurora";
    for (const ref of getPrototypeWorkflow({ projectId }).sessions) ensure(ref.sessionId, root, identity);
    return [...sessions.values()].filter(item => item.meta.workspacePath === root && item.meta.workspaceIdentity === identity && !item.deleted);
  };
  const info = (value: LocalSession): ZCodeSessionInfo => ({ sessionId: value.meta.taskId, workspace: { workspacePath: value.meta.workspacePath, workspaceIdentity: value.meta.workspaceIdentity, workspaceKey: value.meta.workspaceIdentity ?? value.meta.workspacePath }, sessionKind: "interactive", title: value.meta.title, titleSource: "custom", mode: "build", status: "completed", model: value.snapshot.config.modelSelection, createdAt: value.meta.createdAt, updatedAt: value.meta.updatedAt });
  const legacy = (value: LocalSession): ZCodeSessionStateSnapshot => ({
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION }, session: info(value),
    settings: { model: { current: value.snapshot.config.modelSelection, available: [] }, thoughtLevel: { enabled: false, available: [] }, mode: { current: "build" } },
    projection: { sessionId: value.meta.taskId, status: "completed", mode: "build", turnCount: value.snapshot.rows.window.filter(row => row.kind === "userInput").length, totalTokenCount: 0, contextUsed: 0, contextWindow: 128000, pendingPermissions: [], activeToolCalls: [], backgroundJobs: [] },
    runtime: { eventSeq: value.snapshot.seq, stateRevision: value.snapshot.revision, pendingRequestIds: [] }, messages: messages(value), slashCommands,
  });
  const messages = (value: LocalSession): ZCodeMessageWithParts[] => value.snapshot.rows.window.flatMap((row): ZCodeMessageWithParts[] => {
    if (row.kind !== "userInput" && row.kind !== "assistantText") return [];
    const messageId = row.entityId ?? `${value.meta.taskId}:${row.rowId}`;
    const common = { messageId, sessionId: value.meta.taskId, time: { created: row.createdAt, completed: row.createdAt }, agent: "prototype-preset" };
    const parts = [{ partId: `${messageId}:text`, sessionId: value.meta.taskId, messageId, type: "text" as const, text: row.text }];
    if (row.kind === "userInput") return [{ info: { ...common, role: "user" as const }, parts }];
    return [{ info: { ...common, role: "assistant" as const, parentMessageId: `${row.turnId}-user`, path: { cwd: value.meta.workspacePath, root: value.meta.workspacePath }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts }];
  });
  const attachmentFor = (sessionId: string, ref: string): PrototypeAttachment => {
    const value = [...attachments.values()].find(item => item.sessionId === sessionId && item.ref === ref);
    if (!value) throw new Error("此附件不在当前浏览器会话中");
    return value;
  };
  const readAttachment = async (params: { sessionId: string; ref: string; offset: number; limit: number }): Promise<V4AttachmentReadResult> => {
    const value = attachmentFor(params.sessionId, params.ref);
    const raw = atob(value.bytesBase64);
    const chunk = raw.slice(params.offset, params.offset + params.limit);
    const next = params.offset + chunk.length;
    return { dataBase64: btoa(chunk), mediaType: value.mime, totalBytes: raw.length, nextOffset: next < raw.length ? next : null };
  };
  const taskSnapshot = (value: LocalSession): ZCodeTaskSnapshot => ({ meta: { ...value.meta }, messages: value.snapshot.rows.window.flatMap(row => row.kind === "userInput" || row.kind === "assistantText" ? [{ id: row.entityId, role: row.kind === "userInput" ? "user" as const : "assistant" as const, content: row.text, timestamp: row.createdAt }] : []), configOptions, slashCommands });
  const emit = (sub: Subscription, initial = false, recovery = false) => {
    if (!subscriptions.has(sub.id)) return;
    const snapshot = structuredClone(ensure(sub.sessionId, sub.workspacePath, sub.workspaceIdentity).snapshot);
    const topic = `conversation/${sub.sessionId}`;
    const frame: ConversationTopicFrame = { topic, subscriptionId: sub.id, fromSeq: 0, toSeq: snapshot.seq, sentAt: Date.now(), payload: { kind: "snapshot", snapshot } };
    frames.fire({ wireVersion: V4_WIRE_PROTOCOL_VERSION, kind: "complete", deliveryKind: initial ? "initial" : recovery ? "recovery" : "online", logicalFrameId: `${sub.id}:${sub.ordinal + 1}`, logicalFrameOrdinal: ++sub.ordinal, topic, subscriptionId: sub.id, frame });
  };
  const emitIndex = (id: string, initial = false, recovery = false) => {
    const sub = indexSubscriptions.get(id); if (!sub) return;
    const snapshot: SessionsIndexSnapshot = { protocolVersion: 1, workspaceId: sub.identity ?? sub.root, logEpoch: epoch, sessions: list(sub.root, sub.identity).map(value => ({ sessionId: value.meta.taskId, workspaceId: sub.identity ?? sub.root, title: value.meta.title, titleSource: "custom", lastOutcome: "completed", phase: "completedSuccess", sessionEnded: true, hasBackgroundWork: false, lastActivityAt: value.meta.updatedAt, createdAt: value.meta.createdAt })) };
    const topic = `sessions-index/${snapshot.workspaceId}`;
    const frame: SessionsIndexTopicFrame = { topic, subscriptionId: id, fromSeq: 0, toSeq: ++sub.ordinal, sentAt: Date.now(), payload: { kind: "snapshot", snapshot } };
    indexFrames.fire({ wireVersion: V4_WIRE_PROTOCOL_VERSION, kind: "complete", deliveryKind: initial ? "initial" : recovery ? "recovery" : "online", logicalFrameId: `${id}:${sub.ordinal}`, logicalFrameOrdinal: sub.ordinal, topic, subscriptionId: id, frame });
  };
  const changed = (value: LocalSession) => {
    value.snapshot.revision++; value.snapshot.seq++; value.meta.updatedAt = Date.now();
    for (const sub of subscriptions.values()) if (sub.sessionId === value.meta.taskId && sub.workspacePath === value.meta.workspacePath && sub.workspaceIdentity === value.meta.workspaceIdentity) emit(sub);
    for (const [id, sub] of indexSubscriptions) if (sub.root === value.meta.workspacePath && sub.identity === value.meta.workspaceIdentity) emitIndex(id);
  };
  const append = (value: LocalSession, content: string, commandId?: string, refs?: AttachmentRef[]) => {
    appendRows(value.snapshot.rows.window, value.meta.taskId, content, `【阶段性前端原型 · 预置回复】\n\n已将你的补充保存在本次浏览器会话中。当前${value.stage === "requirements" ? "需求讨论" : value.stage === "solution" ? "方案讨论" : value.stage === "planning" ? "计划评审" : value.stage === "executing" ? "实施状态演示" : "交付评审"}建议继续核对交互边界、空态、错误提示与可访问性。\n\n这不是模型生成或真实执行结果；没有调用 OMP、模型、Git、命令或测试。用户确认原型后再进入真实后端对接与验收阶段。`, Date.now(), commandId, refs);
    value.snapshot.rows.totalCount = value.snapshot.rows.window.length; value.snapshot.rows.firstRowId = value.snapshot.rows.window[0]?.rowId ?? null; changed(value);
  };
  const updateModel = (value: LocalSession, model: ModelSelection) => { value.snapshot.config.modelSelection = model; value.snapshot.config.provider = model.providerId; value.snapshot.config.model = model.modelId; value.meta.model = model.modelId; changed(value); return legacy(value); };
  const read = async (params: ZCodeAgentSessionTarget) => legacy(target(params));
  const create = async (params: { workspacePath: string; workspaceIdentity?: string; sessionId?: string }) => legacy(ensure(params.sessionId ?? `prototype-conversation-${++nextId}`, params.workspacePath, params.workspaceIdentity));
  const noRuntime = unavailablePrototypeOperation;
  const taskService: IServiceAccessor["zcodeTaskService"] = {
    initialize: async () => ({ available: true, version: "prototype-memory" }), releaseWorkspacePreparation: async () => {}, checkCodexConnectivity: noRuntime,
    createTask: async params => ensure(`prototype-conversation-${++nextId}`, params.workspacePath, params.workspaceIdentity).meta,
    sendPrompt: async params => { const value = [...sessions.values()].find(item => item.meta.taskId === params.taskId) ?? ensure(params.taskId); append(value, params.content); },
    deliverSessionMessage: noRuntime, sendSessionMessageDeliveryResult: async () => {}, enqueueTaskCommand: noRuntime, promoteTaskCommand: noRuntime,
    cancelTaskCommand: async params => ({ canceled: false, commandId: params.commandId }), stopGeneration: async () => {}, compactSession: noRuntime, goalSession: noRuntime,
    respondPermission: async () => false, respondElicitation: async () => false,
    resumeTask: async params => ensure(params.taskId, params.workspacePath, params.workspaceIdentity).meta,
    listTasks: async params => list(params.workspacePath, params.workspaceIdentity).filter(value => !value.archived).map(value => ({ ...value.meta })),
    listPinnedTaskIds: async () => [...sessions.values()].filter(value => value.pinned && !value.deleted).map(value => value.meta.taskId),
    listPinnedTasks: async params => list(params.workspacePath, params.workspaceIdentity).filter(value => value.pinned).map(value => ({ ...value.meta })),
    listDeletedTaskIds: async params => [...sessions.values()].filter(value => value.deleted && value.meta.workspacePath === params.workspacePath).map(value => value.meta.taskId),
    listActiveTaskIds: async () => [],
    listTaskList: async params => {
      const values = params.workspaceScopes === "host" ? [...sessions.values()] : params.workspaceScopes.flatMap(scope => list(scope.workspacePath, scope.workspaceIdentity));
      const matching = values.filter(value => !value.deleted && (params.kind === "all" || params.kind === "pinned" ? params.kind === "all" || value.pinned : params.kind === "archived" ? value.archived : params.kind !== "active" && !value.archived) && (!params.search || value.meta.title.includes(params.search))).map(value => ({ ...value.meta })).sort((a, b) => params.sortBy === "created" ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt);
      return { items: matching.slice(0, params.limit ?? 100), total: matching.length, hasMore: matching.length > (params.limit ?? 100) };
    },
    listArchivedTasks: async params => list(params.workspacePath, params.workspaceIdentity).filter(value => value.archived).map(value => ({ ...value.meta })),
    getTaskSnapshot: async params => taskSnapshot(ensure(params.taskId, params.workspacePath, params.workspaceIdentity)),
    getTaskSnapshotWithEtag: async params => { const value = ensure(params.taskId, params.workspacePath, params.workspaceIdentity); return { snapshot: taskSnapshot(value), etag: `prototype-${value.snapshot.revision}` }; },
    getTaskSnapshotBody: async () => null, getTaskSnapshotRef: async () => null, getTaskSnapshotToolCallsSlice: async () => null,
    getTaskMeta: async params => ({ ...ensure(params.taskId, params.workspacePath, params.workspaceIdentity).meta }),
    getTaskConfigOptions: async () => structuredClone(configOptions),
    getTaskModelSelection: async params => [...sessions.values()].find(value => value.meta.taskId === params.taskId)?.snapshot.config.modelSelection ?? PROTOTYPE_MODEL_SELECTION,
    setAssistantMessageFeedback: async params => { const value = ensure(params.taskId, params.workspacePath, params.workspaceIdentity); const row = value.snapshot.rows.window.filter(row => row.kind === "assistantText")[params.turnIndex]; if (row?.kind === "assistantText") { row.feedback = params.feedback ?? undefined; changed(value); } return taskSnapshot(value); },
    syncTaskSessionBinding: noRuntime, switchAgent: noRuntime, scanImportableClaudeSessions: async () => [], importClaudeSessions: noRuntime,
    setMode: async params => { for (const value of sessions.values()) if (value.meta.taskId === params.taskId) { value.meta.mode = params.mode; value.snapshot.config.mode = params.mode; changed(value); } },
    setConfigOption: async () => structuredClone(configOptions),
    setModel: async params => { for (const value of sessions.values()) if (value.meta.taskId === params.taskId) updateModel(value, params.modelSelection); return structuredClone(configOptions); },
    setAutomationSessionConfig: noRuntime,
    getWorkspaceProviderConfigFile: async () => ({ provider: "glm", path: "/demo/user/.zcode/config.json", exists: false }),
    getTaskNativeSessionLogFile: async () => ({ provider: null, path: null, exists: false }),
    getModelTrajectory: async params => ({ taskId: params.taskId, available: false, records: [], sourceFiles: [], truncated: false }),
    getTaskSessionFilePath: async params => ({ path: `/demo/sessions/${params.taskId}.json`, exists: false }), restartWorkspaceProcess: noRuntime,
    deleteTask: async params => { const value = ensure(params.taskId, params.workspacePath, params.workspaceIdentity); value.deleted = true; changed(value); },
    deleteArchivedTask: async params => { const value = ensure(params.taskId, params.workspacePath, params.workspaceIdentity); if (!value.archived) return false; value.deleted = true; changed(value); return true; },
    deleteArchivedTasks: async params => { const deletedTaskIds: string[] = []; const skippedTaskIds: string[] = []; for (const id of params.taskIds) { const value = ensure(id, params.workspacePath, params.workspaceIdentity); if (value.archived) { value.deleted = true; deletedTaskIds.push(id); changed(value); } else skippedTaskIds.push(id); } return { deletedTaskIds, skippedTaskIds, failedTaskIds: [] }; },
    renameTask: async params => { const value = ensure(params.taskId, params.workspacePath, params.workspaceIdentity); value.meta.title = params.title; value.snapshot.meta.title = params.title; changed(value); return { ...value.meta }; },
    setTaskPinned: async params => { const value = ensure(params.taskId, params.workspacePath, params.workspaceIdentity); value.pinned = params.pinned; changed(value); return { ...value.meta }; },
    setTaskUnread: async params => { const value = ensure(params.taskId, params.workspacePath, params.workspaceIdentity); value.meta.unreadAt = params.unread ? Date.now() : undefined; changed(value); return { ...value.meta }; },
    archiveTask: async params => { const value = ensure(params.taskId, params.workspacePath, params.workspaceIdentity); value.archived = true; changed(value); return { ...value.meta }; },
    unarchiveTask: async params => { const value = ensure(params.taskId, params.workspacePath, params.workspaceIdentity); value.archived = false; changed(value); return { ...value.meta }; },
    branchTaskFromPrompt: noRuntime,
    onDynamicStreamEvent: () => silentPrototypeEvent(), onDynamicTaskTerminalOutcome: () => silentPrototypeEvent(), onDynamicTaskReady: () => silentPrototypeEvent(), onDynamicTaskEvent: () => silentPrototypeEvent(), onDynamicWorkspaceEvent: () => silentPrototypeEvent(), onError: silentPrototypeEvent(),
  };
  const agentService: IServiceAccessor["zcodeAgentService"] = {
    prepareStorage: async () => {}, getStorageStartupState: async () => null, onDynamicStorageStartupState: () => silentPrototypeEvent(),
    initialize: async params => ({ available: true, workspaceKey: params.workspaceIdentity ?? params.workspacePath, protocolName: "prototype-browser-memory", protocolVersion: 1 }),
    syncAppRuntimePreferences: async () => {}, syncDynamicWorkflowUserMode: async () => {},
    getWorkspaceRuntimeIdentity: async params => ({ generation: 1, identity: "prototype-memory-no-process", workspaceKey: params.workspaceIdentity ?? params.workspacePath }),
    createSession: create, resumeSession: read, listSessions: async params => list(params.workspacePath, params.workspaceIdentity).map(info),
    listSessionSubagents: async () => ({ revision: 0, childSessionIds: [], running: [], ended: { total: 0, items: [] } }),
    readSession: read, readSessionMessages: async params => messages(target(params)), readSessionDebug: noRuntime, readSessionEvents: async () => [],
    readWorkspacePresentation: async params => ({ workspace: { ...params, workspaceKey: params.workspaceIdentity ?? params.workspacePath }, mode: "build", slashCommands }),
    grantWorkspaceHookTrust: noRuntime,
    listPlugins: async () => ({ plugins: [], diagnostics: [] }),
    getPluginReferenceCatalog: async params => ({ authority: params.sessionId ? "session" : "workspace", plugins: [] }),
    getSkillReferenceCatalog: async params => ({ authority: params.sessionId ? "session" : "workspace", skills: [] }),
    listSavedWorkflows: async () => ({ workflows: [], invalid: [], dir: "/demo/user/.zcode/workflows" }), getSavedWorkflow: noRuntime, updateSavedWorkflowMeta: noRuntime, deleteSavedWorkflow: noRuntime, listSavedWorkflowRuns: noRuntime, moveSavedWorkflow: noRuntime, saveSavedWorkflowFromRun: noRuntime, findSavedWorkflowForRun: noRuntime,
    resolveSuggestedPluginReference: noRuntime, onDynamicPluginOperationProgress: () => silentPrototypeEvent(),
    getPluginsOverview: async () => ({ marketplaces: [], availablePlugins: [], installedPlugins: [], restorableBuiltins: [], diagnostics: [], capability: { supported: false, reason: "阶段性前端原型没有插件运行时" } }), collectLocalRuntimeChildProcesses: async () => [],
    addPluginMarketplace: noRuntime, removePluginMarketplace: noRuntime, updatePluginMarketplace: noRuntime, installPlugin: noRuntime, cancelPluginOperation: noRuntime, uninstallPlugin: noRuntime, updatePlugin: noRuntime, restoreBuiltinPlugin: noRuntime, configurePlugin: noRuntime, resetPluginConfig: noRuntime, validatePlugin: noRuntime, describePlugin: noRuntime, setPluginEnabled: noRuntime,
    listAutomations: async () => [], listAllAutomations: async () => [], createAutomation: noRuntime, updateAutomation: noRuntime, deleteAutomation: noRuntime, setAutomationEnabled: noRuntime, restartAutomation: noRuntime, runAutomationNow: noRuntime, listAutomationRuns: async () => [], deleteAutomationRun: noRuntime,
    generateWorkspaceText: noRuntime, testModelConnectivity: noRuntime, sendPrompt: noRuntime, compactSession: noRuntime, goalSession: noRuntime,
    closeSession: async () => true,
    setModel: async params => updateModel(target(params), params.model),
    setThoughtLevel: async params => { const value = target(params); value.snapshot.config.thought = params.thoughtLevel ?? ""; changed(value); return legacy(value); },
    setMode: async params => { const value = target(params); value.snapshot.config.mode = params.mode; changed(value); return legacy(value); },
    respondProviderRuntimeHeaders: async () => {}, respondSessionRuntimePreferences: async () => {},
    onDynamicProviderRuntimeHeadersRequest: () => silentPrototypeEvent(), onDynamicWorkspaceProviderRuntimeHeadersRequest: () => silentPrototypeEvent(), onDynamicWorkspaceProviderRuntimeHeadersCancelled: () => silentPrototypeEvent(), onDynamicSessionRuntimePreferencesRequest: () => silentPrototypeEvent(),
    onDynamicProcessResourceSample: () => silentPrototypeEvent(), onDynamicMcpTelemetry: () => silentPrototypeEvent(), onDynamicMcpResourceSamples: () => silentPrototypeEvent(), onDynamicToolExecResource: () => silentPrototypeEvent(), onDynamicSessionEvent: () => silentPrototypeEvent(),
    helloConversationV4: async () => ({ kind: "hello", protocolVersion: V4_WIRE_PROTOCOL_VERSION, connectionId: "prototype-browser-memory", clientMode: "web-remote-replayable", deliveryProfile: "replayable", serverTime: Date.now(), capabilities: { nativeDialogs: false, binaryFrames: false, compression: "none", independentPlanState: true }, auth: {} }),
    initializeConversationV4: async () => {}, setConnectionFlowStateV4: async () => {},
    subscribeConversationV4: async params => { const id = `prototype-sub-${++nextId}`; const sub: Subscription = { id, sessionId: params.sessionId, workspacePath: params.workspacePath, workspaceIdentity: params.workspaceIdentity, ordinal: 0 }; subscriptions.set(id, sub); const value = target(params); setTimeout(() => emit(sub, true), 0); return { ack: { subscriptionId: id, mode: "snapshot", logEpoch: value.snapshot.logEpoch } }; },
    resyncConversationV4: async params => { const sub = subscriptions.get(params.subscriptionId); if (!sub) throw new Error("原型订阅已释放"); setTimeout(() => emit(sub, false, true), 0); return { ack: { subscriptionId: sub.id, mode: "snapshot", logEpoch: target(sub).snapshot.logEpoch } }; },
    unsubscribeConversationV4: async params => { subscriptions.delete(params.subscriptionId); },
    conversationRowsRangeV4: async params => { const value = target(params); const rows = value.snapshot.rows.window.filter(row => params.beforeRowId === undefined || row.rowId < params.beforeRowId); return { rows: structuredClone(rows.slice(-params.limit)), atSeq: value.snapshot.seq, atRevision: value.snapshot.revision, atLogEpoch: value.snapshot.logEpoch, hasMore: rows.length > params.limit }; },
    conversationPlansV4: async params => { const value = target(params); return { plans: [], atSeq: value.snapshot.seq, atLogEpoch: value.snapshot.logEpoch }; },
    conversationInputPredictionV4: async params => ({ decision: "unavailable", candidates: [], topConfidence: 0, requestId: params.requestId }), conversationWorkflowRunEventsV4: noRuntime, conversationWorkflowRunsV4: async () => ({ runs: [] }), conversationWorkflowRunArtifactsV4: noRuntime, conversationWorkflowRunArtifactDataV4: noRuntime, conversationWorkflowRunArtifactReadV4: noRuntime, conversationWorkflowRunWorkspaceV4: noRuntime, conversationWorkflowRunNodeResultV4: noRuntime, backgroundBashOutputV4: noRuntime,
    conversationFileChangesV4: async params => prototypeConversationFileChanges(params.workspacePath), conversationFileRewindPreviewV4: noRuntime,
    sendConversationCommandV4: async params => {
      const envelope = params.envelope;
      const cached = commandResults.get(envelope.commandId); if (cached) return { ...cached, status: "duplicate" };
      let value = ensure(envelope.sessionId ?? `prototype-conversation-${++nextId}`, params.workspacePath, params.workspaceIdentity);
      let ack: CommandAck = { commandId: envelope.commandId, status: "accepted", revisionAtDecision: value.snapshot.revision };
      if (envelope.type === "sendText") {
        const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
        append(value, payload.text, envelope.commandId, payload.attachments);
        ack.result = { type: "inputAccepted", delivery: "startNow", inputId: envelope.commandId, messageId: `${value.meta.taskId}-turn-${value.snapshot.rows.window.length - 2}-user` };
      } else if (envelope.type === "createSession") {
        const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
        value = ensure(payload.sessionId ?? value.meta.taskId, params.workspacePath, params.workspaceIdentity);
        value.snapshot.rows = { window: [], totalCount: 0, firstRowId: null };
        if (payload.firstInput) append(value, payload.firstInput.text, envelope.commandId, payload.firstInput.attachments);
        ack.result = { type: "createSession", sessionId: value.meta.taskId, ...(payload.firstInput ? { input: { delivery: "startNow", inputId: envelope.commandId } } : {}) };
      } else if (envelope.type === "setFollowupMode") {
        const payload = commandPayloadSchemas.setFollowupMode.parse(envelope.payload); value.snapshot.config.followupMode = payload.mode; changed(value);
      } else if (envelope.type === "switchModelConfig") {
        const payload = commandPayloadSchemas.switchModelConfig.parse(envelope.payload);
        updateModel(value, { providerId: payload.provider, modelId: payload.model, ...(payload.thought ? { options: { reasoningLevel: payload.thought } } : {}) });
      } else if (envelope.type === "switchCollaborationMode") {
        const payload = commandPayloadSchemas.switchCollaborationMode.parse(envelope.payload); value.snapshot.config.mode = payload.mode; changed(value);
      } else if (envelope.type === "renameSession") {
        const payload = commandPayloadSchemas.renameSession.parse(envelope.payload); value.meta.title = payload.title; value.snapshot.meta.title = payload.title; changed(value);
      } else if (envelope.type === "stop") {
        ack = { ...ack, status: "noop", reasonCode: "prototype.noRunningWork", message: "阶段性前端原型没有运行中的真实任务。" };
      } else {
        ack = { ...ack, status: "rejected", reasonCode: "prototype.unsupported", message: "此操作需要后续真实后端对接；当前仅演示本地讨论。" };
      }
      ack.revisionAtDecision = value.snapshot.revision; commandResults.set(envelope.commandId, ack); return ack;
    },
    queryConversationCommandsV4: async params => ({ results: params.commands.map(key => ({ key, result: commandResults.get(key.commandId) ?? "unknown" })) }),
    attachmentBeginV4: async params => { uploads.set(params.uploadId, { sessionId: params.sessionId, fileName: params.fileName, mime: params.mime, chunks: [] }); return { uploadId: params.uploadId, state: "staging", nextChunkIndex: 0 }; },
    attachmentChunkV4: async params => {
      const upload = uploads.get(params.uploadId); if (!upload) throw new Error("原型附件上传不存在");
      upload.chunks[params.chunkIndex] = atob(params.dataBase64);
      return { uploadId: params.uploadId, nextChunkIndex: params.chunkIndex + 1 };
    },
    attachmentCommitV4: async params => {
      const upload = uploads.get(params.uploadId); if (!upload) throw new Error("原型附件上传不存在");
      const raw = upload.chunks.join(""); const ref = `prototype-memory:${params.sessionId}:${params.uploadId}`;
      attachments.set(params.uploadId, { ref, bytes: raw.length, adopted: true, sessionId: upload.sessionId, fileName: upload.fileName, mime: upload.mime, bytesBase64: btoa(raw) });
      uploads.delete(params.uploadId); return { ref };
    },
    attachmentAbortV4: async params => { uploads.delete(params.uploadId); },
    attachmentPreviewSourceV4: async () => ({ kind: "chunked" }), attachmentReadV4: readAttachment, conversationAttachmentReadV4: readAttachment,
    conversationAttachmentStatV4: async params => { const value = attachmentFor(params.sessionId, params.ref); return { mediaType: value.mime, totalBytes: value.bytes }; },
    getSessionLifecycle: async () => null, ensureSessionReady: async () => {}, stopSessionRuntime: async () => {}, restartSessionRuntime: noRuntime,
    onDynamicSessionLifecycle: () => silentPrototypeEvent(), onDynamicConversationFrame: () => frames.event, onDynamicLocalTtftFacts: () => silentPrototypeEvent(), onDynamicCuaPermissionObservation: () => silentPrototypeEvent(),
    subscribeSessionsIndexV4: async params => { const id = `prototype-index-${++nextId}`; indexSubscriptions.set(id, { root: params.workspacePath, identity: params.workspaceIdentity, ordinal: 0 }); setTimeout(() => emitIndex(id, true), 0); return { ack: { subscriptionId: id, mode: "snapshot", logEpoch: epoch } }; },
    resyncSessionsIndexV4: async params => { setTimeout(() => emitIndex(params.subscriptionId, false, true), 0); return { ack: { subscriptionId: params.subscriptionId, mode: "snapshot", logEpoch: epoch } }; },
    unsubscribeSessionsIndexV4: async params => { indexSubscriptions.delete(params.subscriptionId); }, onDynamicSessionsIndexFrame: () => indexFrames.event,
    subscribeWorkspaceConfigV4: async params => {
      const id = `prototype-config-${++nextId}`; workspaceSubscriptions.set(id, { root: params.workspacePath, ordinal: 1 });
      const snapshot: WorkspaceConfigSnapshot = { protocolVersion: 1, workspaceId: params.workspaceIdentity ?? params.workspacePath, logEpoch: epoch, config: { configOptions, slashCommands } };
      const topic = `workspace-config/${snapshot.workspaceId}`;
      const frame: WorkspaceConfigTopicFrame = { topic, subscriptionId: id, fromSeq: 0, toSeq: 1, sentAt: Date.now(), payload: { kind: "snapshot", snapshot } };
      setTimeout(() => { if (workspaceSubscriptions.has(id)) configFrames.fire({ wireVersion: V4_WIRE_PROTOCOL_VERSION, kind: "complete", deliveryKind: "initial", logicalFrameId: id, logicalFrameOrdinal: 1, topic, subscriptionId: id, frame }); }, 0);
      return { ack: { subscriptionId: id, mode: "snapshot", logEpoch: epoch } };
    },
    resyncWorkspaceConfigV4: noRuntime, unsubscribeWorkspaceConfigV4: async params => { workspaceSubscriptions.delete(params.subscriptionId); }, onDynamicWorkspaceConfigFrame: () => configFrames.event,
    onAgentRuntimeRestarted: () => ({ dispose() {} }), hasActiveCuaOperationTurn: () => false, disposeWorkspace: async () => {},
    disposeAll() { subscriptions.clear(); indexSubscriptions.clear(); workspaceSubscriptions.clear(); },
  };
  return {
    zcodeTaskService: taskService, zcodeAgentService: agentService,
    zcodeSessionService: {
      initializeWorkspace: async params => ({ available: true, workspaceKey: params.workspaceIdentity ?? params.workspacePath, protocolName: "prototype-browser-memory", protocolVersion: 1 }),
      getWorkspaceRuntimeIdentity: async params => ({ generation: 1, identity: "prototype-memory-no-process", workspaceKey: params.workspaceIdentity ?? params.workspacePath }),
      readWorkspacePresentation: async params => ({ workspace: { workspacePath: params.workspacePath, workspaceIdentity: params.workspaceIdentity, workspaceKey: params.workspaceIdentity ?? params.workspacePath }, mode: "build", slashCommands }),
      createSession: create, resumeSession: read, listSessions: async params => list(params.workspacePath, params.workspaceIdentity).map(info), readSession: read,
      readSessionMessages: async params => messages(target(params)), readSessionEvents: async () => [], promoteDeferredDraftSession: async () => {}, closeSession: async () => {}, closeDeferredDraftSession: async () => true,
      setModel: async params => updateModel(target(params), params.model),
      setThoughtLevel: async params => { const value = target(params); value.snapshot.config.thought = params.thoughtLevel ?? ""; changed(value); return legacy(value); },
      setMode: async params => { const value = target(params); value.snapshot.config.mode = params.mode; changed(value); return legacy(value); }, respondProviderRuntimeHeaders: async () => {},
    },
  };
}
