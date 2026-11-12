import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function AIReqPersonalConfigScope({ scopeLabel }: { scopeLabel?: string } = {}) {
  const { locale } = useZCodeIntl();
  return <p className="text-ui-sm text-foreground-subtle" data-testid="aireq-personal-config-scope">{scopeLabel ?? (locale === "zh-CN" ? "所有人可查看全部设置。外观所有人可用，其他设置仅启动此共享 OMP Web 的人可修改；切换工号不切换配置归属。Skill 设计已移至主页“自动化”下方，所有人可用。" : "Everyone can view all settings and use Appearance. Only the person who started this shared OMP Web can change other settings. Switching employee IDs does not change configuration ownership. Skill Design is available to everyone from the main sidebar below Automations.")}</p>;
}
