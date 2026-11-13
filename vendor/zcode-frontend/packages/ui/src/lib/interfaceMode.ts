export type InterfaceMode = "office" | "coding";

export const INTERFACE_MODE_STORAGE_KEY = "zcode-interface-mode";

export function normalizeInterfaceMode(_value: unknown): InterfaceMode {
  // 办公模式入口已删除：历史持久值一律归一到 coding。
  return "coding";
}
