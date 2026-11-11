import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DevPersonalConfigScope({ scopeLabel }: { scopeLabel?: string } = {}) {
  const { locale } = useZCodeIntl();
  return <p className="text-ui-sm text-foreground-subtle" data-testid="dev-personal-config-scope">{scopeLabel ?? (locale === "zh-CN" ? "个性化、模型与个人技能使用当前 OMP 的配置；项目技能保存在所选开发项目中。" : "Personalization, models and personal skills use the current OMP configuration. Project skills are saved in the selected development project.")}</p>;
}
