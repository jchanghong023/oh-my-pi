import { useAIReqDataSource } from "./data-source.js";
import { useEffect, useRef, useState } from "react";
import { USER_INSTRUCTIONS_MAX_BYTES } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AIReqPersonalConfigScope } from "./AIReqPersonalConfigScope.js";
import type { AIReqModelDraftActions } from "./AIReqAgentModelSettings.js";

export function AIReqPersonalizationSettings({ onDraftActionsChange }: { onDraftActionsChange?: (actions: AIReqModelDraftActions | null) => void }) {
 const source = useAIReqDataSource();
 if (!source.prompts || !source.models) return <p className="text-ui-sm text-foreground-subtle">当前数据源尚未接入此功能。</p>;
	const { locale } = useZCodeIntl();
	const zh = locale === "zh-CN";
	const [agents] = useState(() => source.models!.read().agents);
	const [saved, setSaved] = useState(() => source.prompts!.read().saved);
	const [draft, setDraft] = useState(() => source.prompts!.read().draft);
	const [selected, setSelected] = useState("requirements");
	const [message, setMessage] = useState("");
	const dirtyCount = agents.filter(agent => draft[agent.id] !== saved[agent.id]).length;
	const encoder = new TextEncoder();
	const oversized = agents.filter(agent => encoder.encode(draft[agent.id] ?? "").length > USER_INSTRUCTIONS_MAX_BYTES);
	const currentBytes = encoder.encode(draft[selected] ?? "").length;
	const canManage = source.capabilities.settingsWrite === true;
	const canSave = canManage && dirtyCount > 0 && oversized.length === 0;
	const dirty = dirtyCount > 0;
 const [saving, setSaving] = useState(false);
	const draftActions = useRef<AIReqModelDraftActions | null>(null);
	const save = async () => {
		if (!canSave || saving) return false;
  setSaving(true);
  try {
   await source.prompts!.save(draft);
   setSaved({ ...source.prompts!.read().saved });
   setMessage(zh ? "追加提示词已保存。" : "Appended instructions saved.");
   return true;
  } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); return false; }
  finally { setSaving(false); }
	};
	draftActions.current = {
		canSave,
		save,
		discard: () => { setDraft({ ...saved }); source.prompts!.updateDraft(saved); setMessage(""); },
	};
	useEffect(() => {
		onDraftActionsChange?.(dirty && canManage ? {
			canSave,
			save: () => draftActions.current?.save() ?? false,
			discard: () => draftActions.current?.discard(),
		} : null);
	}, [dirty, canManage, canSave, onDraftActionsChange]);
	useEffect(() => () => onDraftActionsChange?.(null), [onDraftActionsChange]);
	return (
		<div className="space-y-5" data-testid="aireq-personalization-settings">
			<p className="text-ui-base leading-6 text-foreground-subtle">{zh ? "为各 Agent 追加表达偏好和工作约定，不替换内置指令。" : "Add preferences and working conventions for each Agent without replacing built-in instructions."}</p>
			<AIReqPersonalConfigScope scopeLabel={zh ? "此配置由共享 Web 启动者管理，其他人只读。" : "The person who started this shared Web manages these settings. Others have read-only access."} />
			<div className="space-y-2">
				<Label htmlFor="personalization-agent">{zh ? "选择 Agent" : "Select Agent"}</Label>
				<Select value={selected} onValueChange={value => { setSelected(value); setMessage(""); }}>
					<SelectTrigger id="personalization-agent" size="lg" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
					<SelectContent>{agents.map(agent => <SelectItem key={agent.id} value={agent.id}>{zh ? agent.name : agent.nameEn}</SelectItem>)}</SelectContent>
				</Select>
			</div>
			<div className="space-y-2">
				<Label htmlFor="agent-system-prompt-append">{zh ? "追加系统提示词" : "Append system instructions"}</Label>
				<SettingsFormTextarea
					id="agent-system-prompt-append"
          readOnly={!canManage}
					className="min-h-64 w-full text-ui-base"
					spellCheck={false}
					value={draft[selected] ?? ""}
					placeholder={zh ? "输入你希望追加给该 Agent 的指令。留空则仅使用原有指令。" : "Enter instructions you want to append for this Agent. Leave empty to use existing instructions only."}
					aria-describedby="agent-prompt-help agent-prompt-size"
					aria-invalid={currentBytes > USER_INSTRUCTIONS_MAX_BYTES}
					onChange={event => { if (!canManage) return; const next = { ...draft, [selected]: event.target.value }; setDraft(next); source.prompts!.updateDraft(next); setMessage(""); }}
					onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); } }}
				/>
				<div className="flex flex-wrap items-start justify-between gap-2 text-ui-sm text-foreground-subtle">
					<p id="agent-prompt-help">{zh ? "留空则不追加指令。" : "Leave empty to add no instructions."}</p>
					<span id="agent-prompt-size">{(currentBytes / 1024).toFixed(1)} / {USER_INSTRUCTIONS_MAX_BYTES / 1024} KB</span>
				</div>
			</div>
			{oversized.length > 0 && <p role="alert" className="text-ui-base text-destructive">{zh ? "以下 Agent 的追加提示词超过大小限制，请缩短后保存：" : "Shorten these Agents' appended instructions before saving: "}{oversized.map(agent => zh ? agent.name : agent.nameEn).join("、")}</p>}
			<SettingsFormActions>
				<Button size="lg" disabled={!canSave} onClick={save}>{zh ? "保存" : "Save"}</Button>
				<Button variant="ghost" size="lg" disabled={!dirtyCount || !canManage} onClick={() => { setDraft({ ...saved }); source.prompts!.updateDraft(saved); setMessage(""); }}>{zh ? "取消" : "Cancel"}</Button>
			</SettingsFormActions>
			<p role="status" className="text-ui-base text-foreground-subtle">{message}</p>
		</div>
	);
}
