import { type ReactNode, useEffect, useMemo } from "react";
import {
  WorkerPoolContext,
  WorkerPoolContextProvider,
  useWorkerPool,
  type WorkerInitializationRenderOptions,
} from "@pierre/diffs/react";
import { createDiffsWorkerHighlighterOptions } from "@/lib/diffsHighlighterEngine.js";
import { logger } from "@/logger.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/store/index.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

function createDiffsWorker(): Worker {
  return new Worker(new URL("../workers/diffs.worker.ts", import.meta.url), {
    type: "module",
    name: "zcode-diffs-worker",
  });
}

function resolveWorkerPoolSize(): number {
  if (typeof navigator === "undefined") {
    return 2;
  }

  const hardwareConcurrency = navigator.hardwareConcurrency;
  if (!Number.isFinite(hardwareConcurrency) || hardwareConcurrency <= 0) {
    return 2;
  }

  return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 2)));
}

function WorkerRenderOptionsSync({
  highlighterOptions,
}: {
  highlighterOptions: WorkerInitializationRenderOptions;
}) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    void workerPool
      .setRenderOptions({
        theme: highlighterOptions.theme,
        lineDiffType: highlighterOptions.lineDiffType,
        maxLineDiffLength: highlighterOptions.maxLineDiffLength,
        tokenizeMaxLineLength: highlighterOptions.tokenizeMaxLineLength,
        useTokenTransformer: highlighterOptions.useTokenTransformer,
      })
      .catch((error: unknown) => {
        logger.warn("[DiffsWorkerPoolProvider] 同步渲染参数失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [highlighterOptions, workerPool]);

  return null;
}

function areRenderOptionsCompatible(
  requested: WorkerInitializationRenderOptions | undefined,
  shared: WorkerInitializationRenderOptions,
): boolean {
  const theme = requested?.theme;
  const sharedTheme = shared.theme;
  if (
    theme !== undefined &&
    theme !== sharedTheme &&
    !(
      typeof theme === "object" &&
      typeof sharedTheme === "object" &&
      theme.light === sharedTheme.light &&
      theme.dark === sharedTheme.dark
    )
  ) {
    return false;
  }

  return (
    (requested?.lineDiffType === undefined || requested.lineDiffType === shared.lineDiffType) &&
    (requested?.maxLineDiffLength === undefined ||
      requested.maxLineDiffLength === shared.maxLineDiffLength) &&
    (requested?.tokenizeMaxLineLength === undefined ||
      requested.tokenizeMaxLineLength === shared.tokenizeMaxLineLength) &&
    (requested?.useTokenTransformer === undefined ||
      requested.useTokenTransformer === shared.useTokenTransformer) &&
    (requested?.preferredHighlighter === undefined ||
      requested.preferredHighlighter === shared.preferredHighlighter)
  );
}

export function DiffsWorkerPoolProvider({
  children,
  renderOptions,
  disabled = false,
}: {
  children: ReactNode;
  renderOptions?: WorkerInitializationRenderOptions;
  disabled?: boolean;
}) {
  const inheritedPool = useWorkerPool();
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );

  const highlighterOptions = useMemo<WorkerInitializationRenderOptions>(
    () =>
      createDiffsWorkerHighlighterOptions({
        lightTheme: codePreviewSettings.lightTheme,
        darkTheme: codePreviewSettings.darkTheme,
      }),
    [codePreviewSettings.darkTheme, codePreviewSettings.lightTheme],
  );

  const poolSize = useMemo(() => resolveWorkerPoolSize(), []);
  const canUseWorkerPool = typeof window !== "undefined" && typeof Worker !== "undefined";

  // The library's providers share one singleton. Local overrides must not mutate
  // it, and must also hide an inherited pool so renderers honor their own options.
  if (disabled || !areRenderOptionsCompatible(renderOptions, highlighterOptions)) {
    return <WorkerPoolContext.Provider value={undefined}>{children}</WorkerPoolContext.Provider>;
  }

  if (inheritedPool || !canUseWorkerPool) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: createDiffsWorker,
        poolSize,
      }}
      highlighterOptions={highlighterOptions}
    >
      <WorkerRenderOptionsSync highlighterOptions={highlighterOptions} />
      {children}
    </WorkerPoolContextProvider>
  );
}
