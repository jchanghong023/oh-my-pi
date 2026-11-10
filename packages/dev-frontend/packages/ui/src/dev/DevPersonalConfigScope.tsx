import { SettingsBadge } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DevPersonalConfigScope({ scopeLabel }: { scopeLabel?: string } = {}) {
	const { locale } = useZCodeIntl();
	const zh = locale === "zh-CN";
	return (
		<div className="space-y-2" data-testid="dev-personal-config-scope">
			<SettingsBadge>{scopeLabel ?? (zh ? "OMP 服务配置 · 当前 profile 共用" : "OMP service configuration · Current profile")}</SettingsBadge>
			<p className="text-ui-sm leading-6 text-foreground-subtle">
				{zh ? "模型、Token 和追加提示词使用启动此 Web 服务的账号 A 的 OMP 配置，同一服务下的项目与访问者共用。" : "Models, tokens and appended instructions use the OMP configuration of account A, which runs this Web service. Projects and visitors using this service share that configuration."}
			</p>
			<p className="text-ui-sm leading-6 text-foreground-subtle" data-testid="dev-config-employee-boundary">
                {zh ? "输入或切换工号只记录操作人，不会切换模型 Token 或 OMP profile。个人开发目录仍按工号和项目分别配置。" : "Entering or switching an employee ID only identifies the operator; it does not switch model tokens or the OMP profile. Development directories are configured separately for each employee and project."}
            </p>
            <p className="break-all text-ui-sm text-foreground-subtle">{zh ? "账号 A 的配置目录示例：" : "Example configuration directory for account A: "}<code>~/.omp/agent</code>{zh ? "（实际目录沿用服务的自定义配置或 profile）" : " (the service's custom directory or profile applies)"}</p>
		</div>
	);
}
