import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { PluginUiSessionScope, PluginUiSessionCommandPort } from "../contract.js";
import { createPluginUiSessionActions } from "./pluginUiSessionBinding.js";
import { registerPluginUiSessionActions } from "./pluginUiSessionActions.js";


/** Bind generated-UI sandbox actions to the active session lifecycle. */
export function SandboxSessionActionsProvider({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  sessionId,
  readOnly,
  sendText,
  children,
}: Omit<PluginUiSessionScope, "sessionId"> & {
  sessionId: string | null;
  readOnly: boolean;
  children: ReactNode;
} & PluginUiSessionCommandPort) {
  const scope = useMemo(
    () => (sessionId ? { workspacePath, workspaceIdentity, remoteSessionId, sessionId } : null),
    [workspacePath, workspaceIdentity, remoteSessionId, sessionId],
  );
  const port = useRef({ sendText });
  port.current = { sendText };
  useEffect(() => {
    if (!scope || readOnly) return;
    // 修复：发送配置变更会重建回调，但不应让同一挂载中的待确认请求失效。
    return registerPluginUiSessionActions(
      scope,
      createPluginUiSessionActions({
        sendText: (...args) => port.current.sendText(...args),
      }),
    );
  }, [scope, readOnly]);
  return children;
}

