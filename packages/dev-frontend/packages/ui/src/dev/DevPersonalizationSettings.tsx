import { useState } from "react";
import { USER_INSTRUCTIONS_MAX_BYTES } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DevPersonalConfigScope } from "./DevPersonalConfigScope.js";
import { readPrototypeAgentModels } from "./mock/agent-models.js";
import { readPrototypeAgentPrompts, savePrototypeAgentPrompts, updatePrototypeAgentPromptDrafts } from "./mock/personalization.js";

export function DevPersonalizationSettings() {
	const { locale } = useZCodeIntl();
	const zh = locale === "zh-CN";
	const [agents] = useState(() => readPrototypeAgentModels().agents);
	const [saved, setSaved] = useState(() => readPrototypeAgentPrompts().saved);
	const [draft, setDraft] = useState(() => readPrototypeAgentPrompts().draft);
	const [selected, setSelected] = useState("requirements");
	const [message, setMessage] = useState("");
	const dirtyCount = agents.filter(agent => draft[agent.id] !== saved[agent.id]).length;
	const encoder = new TextEncoder();
	const oversized = agents.filter(agent => encoder.encode(draft[agent.id] ?? "").length > USER_INSTRUCTIONS_MAX_BYTES);
	const currentBytes = encoder.encode(draft[selected] ?? "").length;
	const canSave = dirtyCount > 0 && oversized.length === 0;
	const save = () => {
		if (!canSave) return;
		savePrototypeAgentPrompts(draft);
		setSaved({ ...draft });
		setMessage(zh ? "追加提示词已保存到演示个人配置，所有项目共用。" : "Appended prompts saved to the demo personal configuration for all projects.");
	};
	return (
		<div className="space-y-5" data-testid="dev-personalization-settings">
			<p className="text-ui-base leading-6 text-foreground-subtle">{zh ? "为每个 Dev Agent 追加个人系统提示词，补充表达偏好和工作习惯。追加内容不替换 Agent 内置指令。" : "Append personal system instructions for each Dev Agent to describe your preferences and working habits. These additions do not replace built-in instructions."}</p>
			<DevPersonalConfigScope />
			<div className="space-y-2">
				<Label htmlFor="personalization-agent">{zh ? "选择 Agent" : "Select Agent"}</Label>
				<Select value={selected} onValueChange={value => { setSelected(value); setMessage(""); }}>
					<SelectTrigger id="personalization-agent" size="lg" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
					<SelectContent>{agents.map(agent => <SelectItem key={agent.id} value={agent.id}>{zh ? agent.name : agent.nameEn}{draft[agent.id] !== saved[agent.id] ? zh ? " · 未保存" : " · Unsaved" : ""}</SelectItem>)}</SelectContent>
				</Select>
			</div>
			<div className="space-y-2">
				<Label htmlFor="agent-system-prompt-append">{zh ? "追加系统提示词" : "Append system instructions"}</Label>
				<SettingsFormTextarea
					id="agent-system-prompt-append"
					className="min-h-64 w-full text-ui-base"
					spellCheck={false}
					value={draft[selected] ?? ""}
					placeholder={zh ? "输入希望追加给此 Agent 的个人指令。留空则仅使用原有指令。" : "Enter personal instructions for this Agent. Leave empty to use existing instructions only."}
					aria-describedby="agent-prompt-help agent-prompt-size"
					aria-invalid={currentBytes > USER_INSTRUCTIONS_MAX_BYTES}
					onChange={event => { const next = { ...draft, [selected]: event.target.value }; setDraft(next); updatePrototypeAgentPromptDrafts(next); setMessage(""); }}
					onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); } }}
				/>
				<div className="flex flex-wrap items-start justify-between gap-2 text-ui-sm text-foreground-subtle">
					<p id="agent-prompt-help">{zh ? "留空可清除个人追加内容，保留内置指令。" : "Leave empty to clear personal additions and retain built-in instructions."}</p>
					<span id="agent-prompt-size">{(currentBytes / 1024).toFixed(1)} / {USER_INSTRUCTIONS_MAX_BYTES / 1024} KB</span>
				</div>
			</div>
			{oversized.length > 0 && <p role="alert" className="text-ui-base text-destructive">{zh ? "以下 Agent 的追加提示词超过大小限制，请缩短后保存：" : "Shorten these Agents' appended instructions before saving: "}{oversized.map(agent => zh ? agent.name : agent.nameEn).join("、")}</p>}
			<SettingsFormActions>
				{dirtyCount > 0 && <span className="text-ui-sm text-foreground-subtle">{zh ? `${dirtyCount} 个 Agent 有未保存的更改` : `${dirtyCount} Agents have unsaved changes`}</span>}
				<Button size="lg" disabled={!canSave} onClick={save}>{zh ? "保存" : "Save"}</Button>
				<Button variant="ghost" size="lg" disabled={!dirtyCount} onClick={() => { setDraft({ ...saved }); updatePrototypeAgentPromptDrafts(saved); setMessage(""); }}>{zh ? "取消" : "Cancel"}</Button>
			</SettingsFormActions>
			<p role="status" className="text-ui-base text-foreground-subtle">{message}</p>
			<p className="text-ui-sm leading-6 text-foreground-subtle">{zh ? "原型演示：保存仅改变本页内存，不写入真实 OMP 配置目录，也不启动 Agent。刷新后恢复样例。" : "Prototype: saving changes page memory only. It does not write real OMP configuration or start an Agent. Refreshing restores samples."}</p>
		</div>
	);
}
