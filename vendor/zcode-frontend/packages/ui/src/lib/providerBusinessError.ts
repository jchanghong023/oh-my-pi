/** 与 core `model-errors.ts` 中 anomaly guard 文案保持一致。 */
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

import {
  requestVerificationActionMessages,
  requestVerificationRecoveryAction,
  type RequestVerificationRecoveryAction,
} from "@/request-security-edition/errors.js";
export {
  resolveRequestVerificationBusinessCode,
  isRequestVerificationTerminalError,
  isRequestVerificationRejectedMessage,
  REQUEST_VERIFICATION_REJECTED_MESSAGE,
} from "@/request-security-edition/errors.js";
/**
 * zcode-plan / Coding Plan 业务错误码与前端处理约定。
 *
 * | 场景           | code | HTTP | 前端处理 |
 * |----------------|------|------|----------|
 * | JWT 缺失/失效  | 1006 | 200  | 跳登录或重新授权 |
 * | 配额不足       | 1005 | 200  | 禁用入口，刷新配额 |
 * | 模型不可用     | 3006 | 400  | 切换到 Built-in Provider 中的其他模型 |
 * | 参数错误       | 3001 | 400  | 检查请求体 |
 * | 安全校验拒绝   | 3007 | 403  | 客户端无法完成安全校验，提示联系支持 |
 * | 模型并发上限   | 3010 | 429  | 并发限制提示 |
 * | 请求过频       | 3002/429 | 429 | 限流提示，稍后重试 |
 * | 闲时票据过期 | 3102 | 400  | 过号或旧版过期，提示手动新建任务 |
 * | 闲时运行超时 | 3106 | 400  | 单次运行时间到顶，提示手动新建任务 |
 * | 上游 HTTP 异常 | 2007 | 500  | 可重试；刷新配额，勿本地扣额度 |
 */

export const PROVIDER_BUSINESS_ERROR_CODES = [
  "1006",
  "1005",
  "3006",
  "3001",
  "3007",
  "3008",
  "3009",
  "3010",
  "3002",
  "3102",
  "3106",
  "2007",
  "429",
] as const;

export type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

export type ProviderBusinessErrorUiAction =
  | "login"
  | "refresh-quota"
  | "switch-model"
  | RequestVerificationRecoveryAction
  | "retry-later"
  | "upgrade";

export const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
  "1006": "zcode.error.providerBusiness.1006",
  "1005": "zcode.error.providerBusiness.1005",
  "3006": "zcode.error.providerBusiness.3006",
  "3002": "zcode.error.providerBusiness.3002",
  "3001": "zcode.error.providerBusiness.3001",
  "3007": "zcode.error.providerBusiness.3007",
  "3008": "zcode.error.providerBusiness.3008",
  "3009": "zcode.error.providerBusiness.3009",
  "3010": "zcode.error.providerBusiness.3010",
  "3102": "zcode.error.providerBusiness.3102",
  "3106": "zcode.error.providerBusiness.3106",
  "2007": "zcode.error.providerBusiness.2007",
  "429": "zcode.error.providerBusiness.429",
};

export const PROVIDER_BUSINESS_ERROR_ACTION_MESSAGE_IDS: Record<
  ProviderBusinessErrorUiAction,
  string
> = {
  login: "chat.error.action.relogin",
  "refresh-quota": "chat.error.action.refreshQuota",
  "switch-model": "chat.error.action.switchModel",
  ...requestVerificationActionMessages,
  "retry-later": "chat.error.action.retryLater",
  upgrade: "chat.quota.action.upgrade",
};

const PROVIDER_BUSINESS_ERROR_UI_ACTIONS: Record<
  ProviderBusinessErrorCode,
  ProviderBusinessErrorUiAction | null
> = {
  "1006": "login",
  "1005": "refresh-quota",
  "3006": "switch-model",
  "3001": null,
  "3007": requestVerificationRecoveryAction,
  // 3008/3009/3010：并发上限业务错误。
  "3008": "upgrade",
  "3009": "upgrade",
  "3010": "upgrade",
  "3002": "retry-later",
  // 过号和运行超时都需要新票，横幅重试或切模型不能恢复原票。
  "3102": null,
  "3106": null,
  "2007": "retry-later",
  "429": "retry-later",
};

export function isProviderBusinessErrorCode(
  code: string | undefined,
): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (!isProviderBusinessErrorCode(code)) {
    return undefined;
  }
  return PROVIDER_BUSINESS_ERROR_MESSAGE_IDS[code];
}

export function getProviderBusinessErrorUiAction(
  code: string | undefined,
): ProviderBusinessErrorUiAction | null {
  if (!isProviderBusinessErrorCode(code)) {
    return null;
  }
  return PROVIDER_BUSINESS_ERROR_UI_ACTIONS[code];
}

const CONCURRENT_LIMIT_BUSINESS_CODES = new Set(["3008", "3009", "3010"]);

export const GLM_QUOTA_BANNER_BUSINESS_CODES = [
  "1308",
  "1309",
  "1310",
  "1311",
  "1313",
  "1314",
  "1315",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
] as const;

export type GlmQuotaBannerBusinessCode = (typeof GLM_QUOTA_BANNER_BUSINESS_CODES)[number];

const GLM_QUOTA_BANNER_BUSINESS_CODE_SET = new Set<string>(GLM_QUOTA_BANNER_BUSINESS_CODES);

/** 判断业务码是否为并发上限类型。 */
export function isConcurrentLimitBusinessCode(code: string | undefined): boolean {
  return Boolean(code && CONCURRENT_LIMIT_BUSINESS_CODES.has(code));
}

export function resolveGlmQuotaBannerBusinessCode(
  code: string | undefined,
): GlmQuotaBannerBusinessCode | undefined {
  const normalizedCode = code?.trim();
  if (normalizedCode && GLM_QUOTA_BANNER_BUSINESS_CODE_SET.has(normalizedCode)) {
    // GLM API 1308/1309/1310/1311/1313-1321 都是额度、
    // 套餐或账号使用边界，不应被普通错误横幅盖住升级入口。
    return normalizedCode as GlmQuotaBannerBusinessCode;
  }
  return undefined;
}

/** 上游 500 类错误：重试前建议刷新配额快照，避免 UI 本地误扣额度。 */
export function shouldRefreshQuotaOnProviderBusinessRetry(code: string | undefined): boolean {
  return code === "2007" || code === "1005";
}


export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes(SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE) ||
    message.includes("Model returned no text")
  );
}
