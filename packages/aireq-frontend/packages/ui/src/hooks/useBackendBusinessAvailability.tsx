import { createContext, useContext, type ReactNode } from "react";

// Standalone OMP browser presentation must not call unavailable ZCode business services.
// Other hosts retain their existing service and permission paths unless explicitly opted out.
const BackendBusinessAvailabilityContext = createContext(true);
const NativeHostAvailabilityContext = createContext(false);
export type NativeProjectNavigation = (
  path: string, create?: boolean, newSession?: boolean, showFiles?: boolean,
) => Promise<void>;
const NativeProjectNavigationContext = createContext<NativeProjectNavigation | undefined>(undefined);

export interface NativeWorkspaceSessionScope {
  readonly workspacePath: string;
  readonly sessionId?: string;
  readonly ready: boolean;
}
const NativeWorkspaceSessionContext = createContext<NativeWorkspaceSessionScope | undefined>(undefined);

export function NativeWorkspaceSessionProvider({
  scope,
  children,
}: {
  scope: NativeWorkspaceSessionScope;
  children: ReactNode;
}) {
  return (
    <NativeWorkspaceSessionContext.Provider value={scope}>
      {children}
    </NativeWorkspaceSessionContext.Provider>
  );
}

export function useNativeWorkspaceSession(): NativeWorkspaceSessionScope | undefined {
  return useContext(NativeWorkspaceSessionContext);
}

export function BackendBusinessAvailabilityProvider({
  available,
  children,
}: {
  available: boolean;
  children: ReactNode;
}) {
  return (
    <BackendBusinessAvailabilityContext.Provider value={available}>
      {children}
    </BackendBusinessAvailabilityContext.Provider>
  );
}

export function useBackendBusinessAvailable(): boolean {
  return useContext(BackendBusinessAvailabilityContext);
}

export function NativeHostAvailabilityProvider({
  available,
  children,
  openProject,
}: {
  available: boolean;
  children: ReactNode;
  openProject?: NativeProjectNavigation;
}) {
  return (
    <NativeHostAvailabilityContext.Provider value={available}>
      <NativeProjectNavigationContext.Provider value={openProject}>
        {children}
      </NativeProjectNavigationContext.Provider>
    </NativeHostAvailabilityContext.Provider>
  );
}

export function useNativeHostAvailable(): boolean {
  return useContext(NativeHostAvailabilityContext);
}

export function useNativeProjectNavigation(): NativeProjectNavigation | undefined {
  return useContext(NativeProjectNavigationContext);
}
