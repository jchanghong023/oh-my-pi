import { createContext, useContext } from "react";
import type { Context, ReactNode } from "react";
import type { Locale } from "@zcode/shared";
import zhCN from "./locales/zh-CN.js";

/** 简易 intl 工具：根据 id 查找翻译，支持 {key} 占位符替换 */
export interface IntlInstance {
  formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
}

interface IntlContextValue {
  intl: IntlInstance;
  locale: Locale;
}

const value: IntlContextValue = {
  locale: "zh-CN",
  intl: {
    formatMessage({ id }, values) {
      let message = zhCN[id] ?? id;
      if (values) {
        for (const [key, val] of Object.entries(values)) {
          message = message.replaceAll(`{${key}}`, String(val));
        }
      }
      return message;
    },
  },
};

// Fast Refresh can retain memoized consumers from an older module while replacing
// the provider. Keep their Context identity shared across HMR generations.
const hotData = import.meta.hot?.data as
  | { zcodeIntlContext?: Context<IntlContextValue | null> }
  | undefined;
const IntlContext = hotData?.zcodeIntlContext ?? createContext<IntlContextValue | null>(null);
if (hotData) hotData.zcodeIntlContext = IntlContext;

/** 界面固定使用中文，不读取或改写用户保存的语言偏好。 */
export function ZCodeIntlProvider({ children }: { children: ReactNode }) {
  return <IntlContext value={value}>{children}</IntlContext>;
}

/** 获取 intl 上下文 */
export function useZCodeIntl(): IntlContextValue {
  const ctx = useContext(IntlContext);
  if (!ctx) {
    throw new Error("useZCodeIntl 必须在 ZCodeIntlProvider 内使用");
  }
  return ctx;
}
