import type { FloatingAnchor } from "@/side-pane-full-view/contract.js";
import { DEFAULT_FLOATING_ANCHOR, parseFloatingAnchor } from "@/side-pane-full-view/model.js";
import { logger } from "@/logger.js";

/** 浮窗吸附位置是全局偏好（spec：docs/ui/side-pane-full-view.md），不随对话切换。 */
const FLOATING_ANCHOR_STORAGE_KEY = "zcode:side-pane-full-view:floating-anchor";

export function readFloatingAnchorPreference(): FloatingAnchor {
  try {
    return (
      parseFloatingAnchor(globalThis.__ompAIReqLocalStorage.getItem(FLOATING_ANCHOR_STORAGE_KEY)) ??
      DEFAULT_FLOATING_ANCHOR
    );
  } catch {
    return DEFAULT_FLOATING_ANCHOR;
  }
}

export function writeFloatingAnchorPreference(anchor: FloatingAnchor): void {
  try {
    globalThis.__ompAIReqLocalStorage.setItem(FLOATING_ANCHOR_STORAGE_KEY, anchor);
  } catch (error) {
    logger.warn("[SidePaneFullView] 浮窗吸附位置写入失败", { anchor, error });
  }
}
