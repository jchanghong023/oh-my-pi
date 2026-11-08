import { createContext, useContext, type ReactNode } from "react";

// Standalone OMP browser presentation must not call unavailable ZCode business services.
// Other hosts retain their existing service and permission paths unless explicitly opted out.
const BackendBusinessAvailabilityContext = createContext(true);

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
