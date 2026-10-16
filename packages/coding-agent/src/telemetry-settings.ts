/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "./config/registry";

/** Whether OMP may register process-global OTLP exporters. */
export const cfgTelemetryOtlpExportEnabled = register({
	id: "telemetry.otlpExportEnabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "隐私",
		label: "OTLP 遥测导出",
		description: "允许 OMP 通过 OTEL_* 端点导出跟踪、日志和指标。更改在下次启动时生效。",
	},
});
