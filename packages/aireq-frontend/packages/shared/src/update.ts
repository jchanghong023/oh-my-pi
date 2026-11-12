import type { ElectronReleaseChannel } from "./protocol.js";

/**
 * 用户从菜单手动点击"检查更新"后，main 进程回传给 renderer 的结果。
 * Renderer 根据 kind 展示对应的 toast；不要与启动时的自动 check 混用。
 */
export type UpdateCheckResultPayload =
  | { kind: "up-to-date"; currentVersion: string }
  | {
      kind: "available";
      version: string;
      channel?: ElectronReleaseChannel;
    }
  | { kind: "downloading"; version: string }
  | { kind: "already-downloading"; version: string; progress: string }
  | { kind: "ready"; version: string }
  | { kind: "dev-skipped" }
  | { kind: "error"; message: string };
