import { SettingsBadge } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DevPersonalConfigScope({ scopeLabel }: { scopeLabel?: string } = {}) {
	const { locale } = useZCodeIntl();
	const zh = locale === "zh-CN";
	return (
		<div className="space-y-2" data-testid="dev-personal-config-scope">
			<SettingsBadge>{scopeLabel ?? (zh ? "个人配置 · 所有项目共用" : "Personal settings · All projects")}</SettingsBadge>
			<p className="text-ui-sm leading-6 text-foreground-subtle">
				{zh ? "使用当前 OMP 的个人配置目录；自定义配置目录或 profile 时，沿用其对应目录。" : "Uses the current OMP personal configuration directory, including the active custom directory or profile."}
			</p>
			<p className="break-all text-ui-sm text-foreground-subtle">{zh ? "目录示例：" : "Example directory: "}<code>~/.omp/agent</code></p>
		</div>
	);
}
