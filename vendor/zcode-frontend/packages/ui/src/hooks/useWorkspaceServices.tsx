import type { IServiceAccessor } from "@zcode/services";
import { Event, ProxyChannel, type IChannel } from "@zcode/rpc";
import { useMemo } from "react";
import { useOptionalServices, useServices } from "@/hooks/useServices.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE } from "@/lib/remoteWorkspaceServiceError.js";
import {
  useNativeHostAvailable,
  useNativeWorkspaceSession,
  type NativeWorkspaceSessionScope,
} from "@/hooks/useBackendBusinessAvailability.js";

let disconnectedRemoteServices: IServiceAccessor | null = null;

const nativeScopedServices = new WeakMap<IServiceAccessor, WeakMap<NativeWorkspaceSessionScope, IServiceAccessor>>();
const nativeServiceOwners = new WeakMap<IServiceAccessor, IServiceAccessor>();
const NATIVE_FILE_READ_METHODS = new Set<PropertyKey>([
  "readdir", "stat", "checkFilesExist", "resolvePath", "searchWorkspaceFiles",
  "readTextFile", "readMediaPreview", "readFileRange", "readBinaryPreview",
  "listWorkspaceFilesLength", "listWorkspaceFilesRange", "readWorkspaceFileSearchIgnore",
]);
const NATIVE_GIT_READ_METHODS = new Set<PropertyKey>([
  "getRepositorySummary", "getChanges", "getDiff", "getCommitGraph",
  "getLocalBranches", "refresh",
]);
const NATIVE_WATCH_METHODS = new Set<PropertyKey>(["watch"]);
const NATIVE_CATALOG_READ_METHODS = new Set<PropertyKey>(["list"]);

/** Browser-only read routing. Explicit pane identities remain authoritative; no global current changes. */
export function bindNativeWorkspaceServices(
  services: IServiceAccessor,
  scope: NativeWorkspaceSessionScope,
): IServiceAccessor {
  const owner = nativeServiceOwners.get(services) ?? services;
  let scopes = nativeScopedServices.get(owner);
  if (!scopes) nativeScopedServices.set(owner, scopes = new WeakMap());
  const existing = scopes.get(scope);
  if (existing) return existing;
  const scopedService = <T extends object>(
    service: T, methods: ReadonlySet<PropertyKey>, requiresSession = false,
  ): T => {
    const functions = new Map<PropertyKey, unknown>();
    return new Proxy(service, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function" || !methods.has(key)) return value;
        if (functions.has(key)) return functions.get(key);
        const method = (input: unknown, ...rest: unknown[]) => {
          if (requiresSession && input === undefined) input = {};
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            return Reflect.apply(value, target, [input, ...rest]);
          }
          const params = input as Record<string, unknown>;
          if (params.sessionId !== undefined || (key === "readdir" && params.directoriesOnly === true)) {
            return Reflect.apply(value, target, [input, ...rest]);
          }
          if (!scope.ready) return Promise.reject(new Error("Native session ownership is not confirmed."));
          if (requiresSession && !scope.sessionId) {
            return Promise.reject(new Error("Create a native session before reading its effective catalog."));
          }
          if (typeof params.workspacePath === "string" && params.workspacePath !== scope.workspacePath) {
            return Promise.reject(new Error("The requested workspace is not bound to the selected native session."));
          }
          return Reflect.apply(value, target, [
            scope.sessionId ? { ...params, sessionId: scope.sessionId } : params, ...rest,
          ]);
        };
        functions.set(key, method);
        return method;
      },
    });
  };
  const fileService = scopedService(owner.fileService, NATIVE_FILE_READ_METHODS);
  const fileWatcherService = scopedService(owner.fileWatcherService, NATIVE_WATCH_METHODS);
  const gitService = scopedService(owner.gitService, NATIVE_GIT_READ_METHODS);
  const skillsService = scopedService(owner.skillsService, NATIVE_CATALOG_READ_METHODS, true);
  const commandsService = scopedService(owner.commandsService, NATIVE_CATALOG_READ_METHODS, true);
  const bound = new Proxy(owner, {
    get(target, key) {
      if (key === "fileService") return fileService;
      if (key === "fileWatcherService") return fileWatcherService;
      if (key === "gitService") return gitService;
      if (key === "skillsService") return skillsService;
      if (key === "commandsService") return commandsService;
      return Reflect.get(target, key);
    },
  });
  nativeServiceOwners.set(bound, owner);
  scopes.set(scope, bound);
  return bound;
}

interface WorkspaceServiceTargetTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

function createDisconnectedRemoteServices(): IServiceAccessor {
  const createDisconnectedError = () => {
    const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
      code: string;
    };
    error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
    return error;
  };
  const disconnectedChannel: IChannel = {
    call: () => Promise.reject(createDisconnectedError()),
    listen: () => Event.None,
  };
  // 断连代理曾自行维护普通事件白名单，新增 onAgentRuntimeRestarted 后被误判成
  // RPC 方法并返回 Promise，释放订阅时触发 Promise.dispose 崩溃。这里复用真实 RPC 代理的
  // 事件分类契约：命令明确拒绝，普通/动态事件统一返回空订阅，避免两套规则再次漂移。
  const serviceProxy = ProxyChannel.toService<object>(disconnectedChannel);

  return new Proxy(Object.create(null), {
    get() {
      return serviceProxy;
    },
  }) as IServiceAccessor;
}

export function getDisconnectedRemoteServices(): IServiceAccessor {
  if (!disconnectedRemoteServices) {
    disconnectedRemoteServices = createDisconnectedRemoteServices();
  }
  return disconnectedRemoteServices;
}

export function resolveWorkspaceServicesForTarget(params: {
  currentContextServices: IServiceAccessor;
  resolvedRemoteSessionId: string | null;
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, Pick<RemoteWorkspaceSession, "services">>;
  isRemoteTarget: boolean;
  /** 无 workspace 的设置 user/server scope 可显式指定 SourceSettingsAttachment。 */
  unscopedServices?: IServiceAccessor;
}): IServiceAccessor {
  const resolvedServices = params.resolvedRemoteSessionId
    ? (params.sessionsById[params.resolvedRemoteSessionId]?.services ?? null)
    : params.isRemoteTarget
      ? getDisconnectedRemoteServices()
      : (params.unscopedServices ?? params.baseServices);

  if (params.isRemoteTarget && !resolvedServices) {
    return getDisconnectedRemoteServices();
  }

  return resolvedServices ?? params.currentContextServices;
}

export function resolveBaseWorkspaceServices(
  contextServices: IServiceAccessor,
  registeredBaseServices: IServiceAccessor | null,
): IServiceAccessor {
  return nativeServiceOwners.get(contextServices) === registeredBaseServices
    ? contextServices : registeredBaseServices ?? contextServices;
}

function hasRemoteWorkspaceMetadata(tab: WorkspaceServiceTargetTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

export function resolveWorkspaceServiceIsRemoteTarget(params: {
  workspacePath: string | null | undefined;
  workspaceIdentity?: string | null;
  preferredRemoteSessionId?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeTab?: WorkspaceServiceTargetTab | null;
  workspaceTabs?: readonly WorkspaceServiceTargetTab[];
}): boolean {
  if (params.workspaceIdentity?.trim() || params.preferredRemoteSessionId?.trim()) {
    return true;
  }

  const workspacePath = params.workspacePath?.trim();
  if (!workspacePath) {
    return false;
  }

  if (params.activeWorkspacePath === params.workspacePath) {
    if (params.activeWorkspaceIdentity?.trim()) {
      return true;
    }

    // 日志里远程 SSH workspace 已经恢复成 tab，但草稿预热入口一度只拿到
    // workspacePath，导致 /mnt/... 被当成本地 workspace 走 base services 并在 Windows 上 spawn 本地 agent。
    // 这里用当前 tab 的远程元数据兜住这类 path-only 调用，避免远程目标误回落到本机 host。
    if (
      params.activeTab?.workspacePath === params.workspacePath &&
      hasRemoteWorkspaceMetadata(params.activeTab)
    ) {
      return true;
    }
  }

  const matchingTabs = (params.workspaceTabs ?? []).filter(
    (tab) => tab.workspacePath === params.workspacePath,
  );
  return matchingTabs.length === 1 && hasRemoteWorkspaceMetadata(matchingTabs[0]);
}

export function useBaseWorkspaceServices(): IServiceAccessor {
  const contextServices = useServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // App 会在当前激活 workspace 外层再套一层 ServiceProvider。
  // 激活远端 tab 后，useServices() 读到的是远端 host；但 timeline/search/workspace
  // 这类跨 workspace 查询里的本地 shard 必须继续查本机 host。
  // 这里优先使用 renderer 启动时注册的根 services，避免远端连接污染本地任务列表。
  return resolveBaseWorkspaceServices(contextServices, registeredBaseServices);
}

export function useOptionalBaseWorkspaceServices(): IServiceAccessor | null {
  const contextServices = useOptionalServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // usage entitlement 等 app-global 能力曾从当前 workspace ServiceProvider
  // 取服务；远端 tab 在 attachment ready 前会得到断连代理并产生无效 RPC。base host 才是
  // app-global 权威；Web/SSR 未注册 base services 时保留原有 context/null 降级语义。
  return contextServices
    ? resolveBaseWorkspaceServices(contextServices, registeredBaseServices)
    : registeredBaseServices;
}

export interface WorkspaceServicesResolution {
  services: IServiceAccessor;
  remoteSessionId: string | null;
  isRemoteTarget: boolean;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
  rpcReady: boolean;
}

export function useWorkspaceServicesResolution(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  options?: { unscopedServices?: IServiceAccessor; forceUnscoped?: boolean },
): WorkspaceServicesResolution {
  const currentContextServices = useServices();
  const nativeHostAvailable = useNativeHostAvailable();
  const nativeSessionScope = useNativeWorkspaceSession();
  const resolvedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const inferredRemoteTarget = useTabStore((state) =>
    resolveWorkspaceServiceIsRemoteTarget({
      workspacePath,
      workspaceIdentity,
      preferredRemoteSessionId,
      activeWorkspacePath: state.activeWorkspacePath,
      activeWorkspaceIdentity: state.activeWorkspaceIdentity,
      activeTab: (() => {
        const activeTab = state.activeTabId
          ? state.tabs.find((tab) => tab.id === state.activeTabId)
          : null;
        return activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
      })(),
      workspaceTabs: state.tabs.filter(isWorkspaceTab),
    }),
  );
  const isRemoteTarget = options?.forceUnscoped ? false : inferredRemoteTarget;
  const effectiveRemoteSessionId = options?.forceUnscoped ? null : resolvedRemoteSessionId;
  const resolvedServices = useRemoteWorkspaceSessionStore((state) =>
    resolveWorkspaceServicesForTarget({
      currentContextServices,
      resolvedRemoteSessionId: effectiveRemoteSessionId,
      baseServices: state.baseServices,
      sessionsById: state.sessionsById,
      isRemoteTarget,
      unscopedServices: options?.unscopedServices,
    }),
  );
  const connectionKind = isRemoteTarget
    ? effectiveRemoteSessionId
      ? "remote-ready"
      : "remote-waiting"
    : "local-ready";
  const scopedServices = useMemo(() => {
    if (!nativeHostAvailable || !nativeSessionScope || isRemoteTarget) return resolvedServices;
    const scope = workspacePath && workspacePath !== nativeSessionScope.workspacePath
      ? { ...nativeSessionScope, ready: false } : nativeSessionScope;
    return bindNativeWorkspaceServices(resolvedServices, scope);
  }, [nativeHostAvailable, nativeSessionScope, isRemoteTarget, resolvedServices, workspacePath]);

  // 远程 SSH host 断开后，若在 resolvedRemoteSessionId 为空时回退到 baseServices，
  // /root 这类远程 task 会被本机 host 查询并报“task 不存在”。远程目标缺少 session 时必须保持断连态，
  // 由上面的断连代理给出可恢复错误，而不是把请求误路由到本机 workspace。
  // 启动重连期仅有 tab 元数据、真实 remote services 尚未注册时属于 remote-waiting；
  // 调用方必须暂停 workspace RPC，断连代理只保留为最终越界保护，不能把预期等待态当失败重试。
  return useMemo(
    () => ({
      services: scopedServices,
      remoteSessionId: effectiveRemoteSessionId,
      isRemoteTarget,
      connectionKind,
      rpcReady: connectionKind !== "remote-waiting",
    }),
    [connectionKind, effectiveRemoteSessionId, isRemoteTarget, scopedServices],
  );
}

export function useWorkspaceServices(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  options?: { unscopedServices?: IServiceAccessor; forceUnscoped?: boolean },
): IServiceAccessor {
  return useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
    options,
  ).services;
}
