import type { ReactNode } from "react";
import {
  CODING_PLAN_SYSTEM_BUSY,
  type BuiltinModelProviderId,
  type OAuthProviderId,
} from "@zcode/shared";
import { PackageIcon } from "lucide-react";
import { ProviderLogo } from "./ProviderLogo.js";
import {
  CODING_PLAN_PROVIDER_SPECS,
  PRESET_PROVIDER_SPEC_BY_ID,
  type ModelProviderNavItem,
} from "./constants.js";

export function createPresetProviderNodeKey(id: BuiltinModelProviderId): string {
  return `preset:${id}`;
}

export function createCodingPlanProviderNodeKey(id: BuiltinModelProviderId): string {
  return `coding-plan:${id}`;
}

export function createCustomProviderNodeKey(id: string): string {
  return `custom:${id}`;
}

export function resolveOAuthProviderIdByPreset(
  presetId: BuiltinModelProviderId,
): OAuthProviderId | null {
  return (
    PRESET_PROVIDER_SPEC_BY_ID.get(presetId)?.oauthProviderId ??
    CODING_PLAN_PROVIDER_SPECS.find((spec) => spec.id === presetId)?.oauthProviderId ??
    null
  );
}

export function resolveModelProviderNavLogo(item: ModelProviderNavItem) {
  // 品牌主入口沿用 Start 导航 ID，但不能因此显示体验套餐图标。
  if (item.type === "preset") return item.logo;
  return "provider" in item ? item.provider?.config.logo : undefined;
}

export function renderModelProviderNavIcon(item: ModelProviderNavItem): ReactNode {
  if ("provider" in item && item.provider) {
    return <ProviderLogo logo={resolveModelProviderNavLogo(item)} className="size-4" />;
  }
  return <PackageIcon className="size-4 shrink-0" />;
}

export function fuzzyMatch(text: string, query: string): boolean {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const queryParts = normalizedQuery.split(/\s+/).filter(Boolean);
  return queryParts.every((part) => {
    let searchIndex = 0;
    for (const char of part) {
      const foundIndex = normalizedText.indexOf(char, searchIndex);
      if (foundIndex < 0) {
        return false;
      }
      searchIndex = foundIndex + 1;
    }
    return true;
  });
}

export function handleEndpointSuggestionPopoverOpenAutoFocus({
  keepInputFocus,
  preventDefault,
  focusInput,
}: {
  keepInputFocus: boolean;
  preventDefault: () => void;
  focusInput: () => void;
}): boolean {
  if (!keepInputFocus) {
    return false;
  }

  preventDefault();
  focusInput();
  return true;
}

export function resolveEndpointSuggestionOpenRequest({
  nowMs,
  suppressOpenUntilMs,
}: {
  nowMs: number;
  suppressOpenUntilMs: number;
}): { shouldOpen: boolean } {
  return { shouldOpen: nowMs >= suppressOpenUntilMs };
}

const CODING_PLAN_OAUTH_REQUIRED_ERROR = "coding_plan_oauth_required";

export function normalizeErrorMessage(error: unknown): string {
  const message = readErrorMessage(error);
  if (isCodingPlanSystemBusyMessage(message)) {
    // 远端接口可能返回 WAF HTML 或 JSON 解析错误，统一提示系统繁忙。
    return CODING_PLAN_SYSTEM_BUSY;
  }
  if (isCodingPlanOAuthRequiredMessage(message)) {
    // 套餐接口依赖 OAuth 登录态，不能直接展示后端原始 token 错误。
    return CODING_PLAN_OAUTH_REQUIRED_ERROR;
  }
  return message;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return String(error);
}

function isCodingPlanSystemBusyMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("<!doctype") ||
    /<\s*(html|head|body|script|style|title|meta)\b/.test(normalized) ||
    normalized.includes("errors.aliyun.com") ||
    normalized.includes("request has been blocked") ||
    normalized.includes("unexpected token '<'") ||
    normalized.includes("unexpected end of json input") ||
    normalized.includes("invalid json response")
  );
}

function isCodingPlanOAuthRequiredMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized === "bigmodel_oauth_required" ||
    normalized === "zai_oauth_required" ||
    normalized.includes("oauth_required") ||
    /\b401\b|\b403\b/.test(normalized) ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("token expired") ||
    normalized.includes("expired or incorrect") ||
    normalized.includes("invalid token") ||
    normalized.includes("access token")
  );
}
