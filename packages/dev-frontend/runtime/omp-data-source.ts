import { connectViaWebSocket } from "@zcode/client";
import type { IServiceAccessor } from "@zcode/services";
import type { DevDataSource } from "../packages/ui/src/dev/data-source.js";
import type { DevAction, DevMaterialView, DevNativeSessionRef, DevSelection, DevWorkflowResult, DevWorkflowView, DevWorkspace } from "../packages/ui/src/dev/types.js";

export interface OmpDataSourceOptions {
  /** Directory URL of the capability-scoped Dev document, not the origin root. */
  baseUrl?: string | URL;
  clientId?: string;
  fetch?: typeof globalThis.fetch;
  WebSocket?: typeof globalThis.WebSocket;
  connect?: typeof connectViaWebSocket;
}

const commands = ["registerProject", "createRelease", "deleteRequirement", "stop"] as const satisfies readonly DevAction["type"][];
type OmpCommandAction = Extract<DevAction, { type: (typeof commands)[number] }>;
function supportsCommand(action: DevAction): action is OmpCommandAction {
  return commands.some(type => type === action.type);
}
const unsupported = (feature: string): never => { throw new Error(`当前 OMP Dev 宿主未提供${feature}；不会使用原型数据或模拟执行。`); };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Preserve the host's recorded facts, including legacy statuses and solution-stage materials. */
export function projectOmpWorkflow(view: DevWorkflowView): DevWorkflowView {
  if (view.version !== 1 || !Array.isArray(view.projects) || !Array.isArray(view.sessions))
    throw new Error("Unsupported OMP Dev workflow response");
  return view;
}

export async function createOmpDataSource(options: OmpDataSourceOptions = {}): Promise<DevDataSource> {
  const base = new URL("./", options.baseUrl ?? document.baseURI);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("OMP Dev requires an HTTP document URL");
  const clientId = options.clientId ?? crypto.randomUUID();
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const connect = options.connect ?? connectViaWebSocket;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const connections = new Set<AbortController>();
  let eventSocket: WebSocket | undefined;
  let eventError: Error | undefined;
  let selectedProject: string | undefined;
  let disposed = false;
  const emit = () => { for (const listener of listeners) listener(); };
  const url = (route: string, parameters: Record<string, string | number | undefined> = {}) => {
    const target = new URL(route, base);
    target.searchParams.set("clientId", clientId);
    for (const [key, value] of Object.entries(parameters)) if (value !== undefined) target.searchParams.set(key, String(value));
    return target;
  };
  const json = async <T>(route: string, parameters: Record<string, string | number | undefined> = {}, body?: unknown): Promise<T> => {
    if (disposed) throw new Error("OMP Dev data source is disposed");
    const response = await request(url(route, parameters), {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: lifetime.signal,
      headers: { "x-dev-client": clientId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(value.error ?? `OMP Dev ${route}: HTTP ${response.status}`);
    return value;
  };
  const selected = (selection: DevSelection) => ({ projectId: selection.projectId ?? selectedProject, irId: selection.irId, srId: selection.srId });
  const openEvents = async () => {
    const previous = eventSocket;
    eventSocket = undefined;
    previous?.close();
    eventError = undefined;
    const target = url("workflow/events", { scope: "application" });
    target.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = new Socket(target.toString());
    eventSocket = socket;
    let opened = false;
    const fail = (cause: Error) => {
      if (disposed || eventSocket !== socket) return;
      eventError = cause;
      if (!opened) reject(cause);
      emit();
    };
    socket.addEventListener("open", () => { opened = true; resolve(); }, { once: true });
    socket.addEventListener("error", () => fail(new Error("OMP Dev workflow event connection failed")));
    socket.addEventListener("close", event => fail(new Error(`OMP Dev workflow event connection closed (${event.code}): ${event.reason}`)));
    socket.addEventListener("message", event => {
      if (eventSocket !== socket || disposed) return;
      try {
        const frame = JSON.parse(String(event.data)) as { t?: string; error?: string };
        if (frame.t === "error") fail(new Error(frame.error ?? "OMP Dev workflow event error"));
        else if (frame.t === "workflow" || frame.t === "binding") emit();
      } catch (error) { fail(new Error(`Invalid OMP Dev workflow event: ${message(error)}`)); }
    });
    await promise;
  };
  const browser = await json<{ browserId: string; launchProjectId: string }>("api/browser");
  if (!browser.browserId || !browser.launchProjectId) throw new Error("OMP Dev browser initialization did not provide its launch project");
  selectedProject = browser.launchProjectId;
  try { await openEvents(); } catch (error) { disposed = true; lifetime.abort(); eventSocket?.close(); throw error; }

  const source: DevDataSource = {
    mode: "omp", clientId,
    capabilities: { workflowCommands: commands, prototypeBusiness: false, freeChat: false, nativeChat: true, nativeSurface: false },
    initialSelection: { projectId: browser.launchProjectId },
    async readWorkflow(selection) {
      if (eventError) throw eventError;
      const target = selected(selection);
      const view = await json<DevWorkflowView>("workflow", target);
      const detailed = await Promise.all(view.materials.map(async material => {
        if (!target.irId || material.irId !== target.irId) return material;
        return json<DevMaterialView>("workflow/material", { projectId: material.projectId, irId: material.irId, srId: material.srId, path: material.path });
      }));
      view.materials = detailed;
      return projectOmpWorkflow(view);
    },
    subscribeWorkflow(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async command(action, selection, revision) {
      if (!supportsCommand(action)) return unsupported(`工作流操作 ${action.type}`);
      const identity = selected(selection);
      if (action.type !== "registerProject") await json("workflow/bind", {}, identity);
      const payload: OmpCommandAction & { operationId: string; expectedRevision: number } = {
        ...(action.type === "registerProject" ? {} : identity), ...action,
        operationId: crypto.randomUUID(), expectedRevision: action.type === "registerProject" ? 0 : revision,
      };
      const result = await json<DevWorkflowResult>("workflow/command", {}, payload);
      emit();
      return { ...result, ...(result.view ? { view: projectOmpWorkflow(result.view) } : {}) } satisfies DevWorkflowResult;
    },
    resolveSession(view, selection) {
      if (selection.freeSessionId || selection.irAcceptance) return undefined;
      const sessions = view.sessions.filter(item => item.projectId === selection.projectId && item.irId === selection.irId && item.srId === selection.srId && item.role !== "reviewer");
      if (selection.stage) return sessions.filter(item => item.phase === selection.stage && (selection.stageRound === undefined || item.round === selection.stageRound)).at(-1);
      if (selection.discussionPhase) return sessions.filter(item => item.phase === selection.discussionPhase).at(-1);
      return sessions.at(-1);
    },
    async retryMaterial(path, selection) {
      const target = selected(selection);
      if (!target.projectId || !target.irId) throw new Error("Select the material's project and IR first");
      const material = await json<DevMaterialView>("workflow/material", { ...target, path });
      if (material.error) throw new Error(material.error);
      emit();
      return material.content !== undefined;
    },
    async retrySession(selection) {
      if (eventError) await openEvents();
      const view = await source.readWorkflow(selection);
      const session = source.resolveSession(view, selection);
      await json("workflow/bind", {}, { ...selected(selection), ...(session ? { sessionId: session.sessionId, round: session.round } : {}) });
      emit();
    },
    async createFreeChat() { return unsupported("自由会话创建"); },
    async readFreeChat() { return unsupported("自由会话绑定"); },
    async readRecentFreeChats() { return []; },
    selectProject(projectId) { selectedProject = projectId; },
    resolveWorkspace(view, selection): DevWorkspace {
      const target = selected(selection);
      const identity = JSON.stringify({ projectId: target.projectId });
      const unavailable = (error: string): DevWorkspace => ({ identity, kind: "unavailable", error });
      if (selection.freeSessionId || selection.irAcceptance) return unavailable("当前 OMP Dev 宿主不提供自由会话或新版 IR 验收流程。");
      if (!view) return unavailable("正在读取 OMP Dev 工作区。");
      const project = view.projects.find(item => item.id === target.projectId);
      if (!project) return unavailable("请选择真实 OMP Dev 项目。");
      if (!target.irId) return { path: project.root, identity, kind: "reference" };
      if ((selection.stage || selection.stageRound !== undefined || selection.discussionPhase) && !source.resolveSession(view, selection))
        return unavailable("所选阶段或轮次没有真实原生会话。");
      const metadata = view.workspace;
      if (!view.selected || view.selected.projectId !== target.projectId || view.selected.irId !== target.irId || view.selected.srId !== target.srId || !metadata)
        return unavailable("所选需求的真实工作区尚未读取。");
      return { path: metadata.path, identity: metadata.identity, kind: target.srId ? "development" : "proposal" };
    },
    async connectWorkspace(workspace, selection, session) {
      if (!workspace.path || workspace.kind === "unavailable") throw new Error(workspace.error ?? "OMP Dev workspace is unavailable");
      if (selection.freeSessionId || selection.irAcceptance) return unsupported("所选会话绑定");
      const target = selected(selection);
      const bound = await json<{ session?: DevNativeSessionRef }>("workflow/bind", {}, { ...target, ...(session ? { sessionId: session.sessionId, round: session.round } : {}) });
      if (session && (bound.session?.sessionId !== session.sessionId || bound.session.round !== session.round)) throw new Error("OMP Dev native session binding changed");
      if (!session && bound.session) throw new Error("OMP Dev prepared a native session after the last read; refresh the selection");
      const metadata = await json<{ workspaces: { path: string; workspaceIdentity: string }[] }>("server-info", { projectId: target.projectId });
      if (metadata.workspaces[0]?.path !== workspace.path || metadata.workspaces[0].workspaceIdentity !== workspace.identity)
        throw new Error("OMP Dev native workspace binding changed; refresh the selection");
      const address = url("ws", { ...target, ...(session ? { sessionId: session.sessionId, round: session.round } : {}) });
      address.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      const controller = new AbortController();
      connections.add(controller);
      const dispose = () => { controller.abort(); connections.delete(controller); };
      try {
        const services: IServiceAccessor = await connect(address.toString(), { signal: controller.signal, onClose: event => {
          if (!controller.signal.aborted && !disposed) { eventError = new Error(`OMP Dev native RPC connection closed (${event.code}): ${event.reason}`); emit(); }
        } });
        return { services, dispose };
      } catch (error) { dispose(); throw error; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      eventSocket?.close();
      for (const controller of connections) controller.abort();
      connections.clear();
      listeners.clear();
    },
  };
  return source;
}
