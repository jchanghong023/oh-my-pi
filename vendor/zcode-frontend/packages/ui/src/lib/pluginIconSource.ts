import { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";

/** 最小 WebGUI 不打包官方插件图标；只接受明确可信的 HTTPS 图片，其余走调用方回退。 */
export function resolvePluginIconSource(
  _pluginId: string | undefined,
  icon?: string,
): string | undefined {
  return isTrustedImageUrl(icon) ? icon : undefined;
}

/** Session 投影已完成身份匹配；仅放行可信图片 URL，不放宽任意本地 URL。 */
export function isTrustedPluginIconSource(icon: string | undefined): icon is string {
  return isTrustedImageUrl(icon);
}
