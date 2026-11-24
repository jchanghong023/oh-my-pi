/** The settings window's pages: label and lead sentence per settings tab. */
import type { SettingTab } from "../../../config/settings-defs";

/** A settings page's title and the sentence under it. */
export interface SettingsPage {
	readonly label: string;
	readonly lead: string;
}

export const SETTINGS_PAGES: Readonly<Record<SettingTab, SettingsPage>> = {
	appearance: { label: "外观", lead: "主题、输入区、状态栏及对话记录的显示方式。" },
	model: { label: "模型", lead: "思考、采样、系统 Prompt、重试及辅助模型。" },
	interaction: { label: "交互", lead: "输入、授权、通知、语音及启动行为。" },
	context: { label: "上下文", lead: "模型能看到的内容，以及压缩对话的时机与方式。" },
	memory: { label: "记忆", lead: "OMP 跨会话记住的内容及其保存位置。" },
	files: { label: "文件", lead: "文件读取、摘要、编辑及语言服务器。" },
	shell: { label: "Shell", lead: "Bash 工具与 Eval 运行时。" },
	tools: { label: "工具", lead: "模型可用的工具、限制及外部集成。" },
	tasks: { label: "任务", lead: "模式、Subagent、隔离与自定义命令。" },
	providers: { label: "Provider", lead: "服务、Provider 协议、超时及隐私。" },
};
