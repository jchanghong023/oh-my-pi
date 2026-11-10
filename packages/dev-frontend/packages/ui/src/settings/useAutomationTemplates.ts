import { useEffect, useMemo } from "react";
import { isValidCronExpr, type IClientScenesService } from "@zcode/services";
import {
  isClientScenesBusinessError,
  useClientScenesResource,
} from "@/hooks/useClientScenesResource.js";
import { logger } from "@/logger.js";
import {
  mapClientScenesToAutomationTemplates,
  type AutomationTemplateCatalog,
} from "@/settings/automationTemplateCatalog.js";

export type AutomationTemplateCatalogState = AutomationTemplateCatalog & {
  loading: boolean;
  availability: "available" | "unavailable";
};

export function useAutomationTemplates(
  clientScenesService: IClientScenesService | null | undefined,
): AutomationTemplateCatalogState {
  const { scenes, loading, error, available } = useClientScenesResource(clientScenesService);
  const catalog = useMemo(
    () => mapClientScenesToAutomationTemplates(scenes, isValidCronExpr),
    [scenes],
  );

  useEffect(() => {
    if (!error) return;
    if (isClientScenesBusinessError(error)) {
      logger.warn("[automation-templates] Client Scenes 返回失败，保留手动创建入口", {
        code: error.code,
        message: error.responseMessage,
      });
      return;
    }
    logger.warn("[automation-templates] Client Scenes 请求失败，保留手动创建入口", {
      error: error.message,
    });
  }, [error]);

  useEffect(() => {
    if (catalog.rejectedScheduledTemplateIds.length === 0) return;
    logger.warn("[automation-templates] 已拒绝标题为空或调度无法安全编辑的定时模板", {
      templateIds: catalog.rejectedScheduledTemplateIds,
    });
  }, [catalog.rejectedScheduledTemplateIds]);

  return {
    ...catalog,
    loading,
    availability: available ? "available" : "unavailable",
  };
}
