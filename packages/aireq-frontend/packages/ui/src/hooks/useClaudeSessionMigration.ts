import { useCallback, useMemo, useState } from "react";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";

export type ClaudeMigrationRange = "all" | "7d" | "30d" | "90d";

const DEFAULT_LIMIT = 100;
const MAX_SCAN_LIMIT = 500;
export const UNLIMITED_SCAN_LIMIT_INPUT = "unlimited";

const RANGE_TO_DURATION_MS: Record<Exclude<ClaudeMigrationRange, "all">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

function resolveModifiedSince(range: ClaudeMigrationRange): number | undefined {
  if (range === "all") {
    return undefined;
  }

  return Date.now() - RANGE_TO_DURATION_MS[range];
}

export function resolveClaudeMigrationScanLimit(limitInput: string): number | undefined {
  if (limitInput === UNLIMITED_SCAN_LIMIT_INPUT) {
    return undefined;
  }

  const parsed = Number.parseInt(limitInput.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_SCAN_LIMIT);
}

export interface ClaudeSessionMigrationSupportState {
  supported: boolean;
  reason?: "desktopOnly";
}

export function useClaudeSessionMigration(params: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  const zcodeTaskService = useZCodeTaskService(
    params.workspacePath ?? undefined,
    undefined,
    params.workspaceIdentity,
  );
  const tabStoreApi = useTabStoreApi();
  const [range, setRange] = useState<ClaudeMigrationRange>("30d");
  const [limitInput, setLimitInput] = useState(String(DEFAULT_LIMIT));
  const [candidates, setCandidates] = useState<ZCodeImportableSessionCandidate[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const supportState = useMemo<ClaudeSessionMigrationSupportState>(() => {
    // 关键业务逻辑：Claude 原生历史迁移读取的是“当前机器上的 ~/.claude/projects”。
    // 因此这里只拦 web 场景，扫描所有原始工作目录供首次引导选择。
    if (!params.isDesktop) {
      return {
        supported: false,
        reason: "desktopOnly",
      };
    }

    return {
      supported: true,
    };
  }, [params.isDesktop]);

  const scanLimit = useMemo(
    () => resolveClaudeMigrationScanLimit(limitInput),
    [limitInput],
  );

  const scan = useCallback(async () => {
    if (!supportState.supported) {
      return;
    }

    setIsScanning(true);
    setScanError(null);
    setCandidates([]);

    try {
      logger.info(
        `[Migration] 开始扫描 Claude 原生历史 range=${range} limit=${scanLimit ?? "unlimited"}`,
      );
      const nextCandidates = await zcodeTaskService.scanImportableClaudeSessions({
        modifiedSince: resolveModifiedSince(range),
        ...(scanLimit === undefined ? {} : { limit: scanLimit }),
      });
      setCandidates(nextCandidates);
      logger.info(
        `[Migration] Claude 原生历史扫描完成 count=${nextCandidates.length}`,
      );
      return nextCandidates;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Migration] 扫描 Claude 原生历史失败", error);
      setScanError(message);
    } finally {
      setIsScanning(false);
    }
  }, [
    zcodeTaskService,
    range,
    scanLimit,
    supportState.supported,
  ]);

  const importSessions = useCallback(async (sessionIds: string[]) => {
    if (!supportState.supported || sessionIds.length === 0) {
      return null;
    }

    setIsImporting(true);
    setImportError(null);

    try {
      logger.info(
        `[Migration] 开始导入 Claude 原生历史 selected=${sessionIds.length}`,
      );
      const result = await zcodeTaskService.importClaudeSessions({
        sessionIds,
      });
      if (result.imported.length > 0) {
        const importedWorkspacePaths = new Set(
          result.imported.map((item) => item.workspacePath),
        );
        // Bugfix: Claude 导入之前通过 bumpTaskListVersion 让各处任务列表整轮重查，
        // 但这里真正需要的只是把受影响 workspace 的查询结果失效并重新拉取。
        // 改成局部失效后，仍然能让新导入任务出现在侧边栏，同时避免把无关 workspace 一起带着刷新。
        const importedWorkspaceScopes = result.imported.map((item) => ({
          workspacePath: item.workspacePath,
        }));
        for (const workspacePath of importedWorkspacePaths) {
          tabStoreApi.getState().ensureWorkspaceTab(workspacePath);
        }
        invalidateTaskQueryCacheByScopes(importedWorkspaceScopes);
      }
      logger.info(
        `[Migration] Claude 原生历史导入完成 imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Migration] 导入 Claude 原生历史失败", error);
      setImportError(message);
      throw error;
    } finally {
      setIsImporting(false);
    }
  }, [
    zcodeTaskService,
    supportState.supported,
    tabStoreApi,
  ]);

  return {
    supportState,
    range,
    setRange,
    limitInput,
    setLimitInput,
    scanLimit,
    candidates,
    scanError,
    importError,
    isScanning,
    isImporting,
    scan,
    importSessions,
  };
}
