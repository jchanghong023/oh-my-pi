import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DevPersonalConfigScope({ scopeLabel }: { scopeLabel?: string } = {}) {
  const { locale } = useZCodeIntl();
  return <p className="text-ui-sm text-foreground-subtle" data-testid="dev-personal-config-scope">{scopeLabel ?? (locale === "zh-CN" ? "所有人可查看全部设置。外观和 Skill 设计所有人可用，其他设置仅启动此共享 OMP Web 的人可修改；切换工号不切换配置归属。" : "Everyone can view all settings and use Appearance and Skill Design. Only the person who started this shared OMP Web can change other settings. Switching employee IDs does not change configuration ownership.")}</p>;
}
