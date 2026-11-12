import { useAIReqDataSource } from "./data-source.js";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AIReqPersonalConfigScope } from "./AIReqPersonalConfigScope.js";

export interface AIReqModelDraftActions { save(): boolean | Promise<boolean>; discard(): void; canSave?: boolean }

export function AIReqAgentModelSettings({ onDraftActionsChange }: { onDraftActionsChange?: (actions: AIReqModelDraftActions | null) => void }) {
 const source = useAIReqDataSource();
 if (!source.models) return <p className="text-ui-sm text-foreground-subtle">当前数据源尚未接入此功能。</p>;
	const { locale } = useZCodeIntl();
	const zh = locale === "zh-CN";
	const [saved, setSaved] = useState(source.models!.read);
	const [draft, setDraft] = useState(source.models!.read);
	const [message, setMessage] = useState("");
	const canManage = source.capabilities.settingsWrite === true;
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
 const [saving, setSaving] = useState(false);
 const save = async () => {
  if (!canManage || saving) return false;
  setSaving(true);
  try {
   await source.models!.save(draft);
   setSaved(structuredClone(source.models!.read()));
   setMessage(zh ? "模型配置已保存" : "Model configuration saved");
   return true;
  } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); return false; }
  finally { setSaving(false); }
 };
	useEffect(() => {
		onDraftActionsChange?.(dirty && canManage ? {
			save,
			discard: () => { setDraft(structuredClone(saved)); setMessage(""); },
		} : null);
		return () => onDraftActionsChange?.(null);
	}, [dirty, canManage, draft, saved, source, onDraftActionsChange]);
	const modelName = (id: string) => source.models!.choices.find(model => model.id === id)?.name ?? id;
	const updateAgent = (id: string, patch: { model?: string; reasoning?: string }) => {
    if (!canManage) return;
		setDraft(current => ({ ...current, agents: current.agents.map(agent => agent.id === id ? { ...agent, ...patch } : agent) }));
		setMessage("");
	};
	const modelOptions = source.models!.choices.map(model => (
		<SelectItem key={model.id} value={model.id}>
			{model.name} · {model.provider}
		</SelectItem>
	));
	return (
		<div className="space-y-6" data-testid="agent-model-settings">
			<p className="text-ui-base leading-6 text-foreground-subtle">
				{zh ? "为各 Agent 设置模型与思考强度，选择“跟随默认”时使用默认模型。" : "Set a model and reasoning level for each Agent. Choose “Follow default” to use the default model."}
			</p>
			<AIReqPersonalConfigScope scopeLabel={zh ? "此配置由共享 Web 启动者管理，其他人只读。" : "The person who started this shared Web manages these settings. Others have read-only access."} />
            <p className="text-ui-sm leading-6 text-foreground-subtle" data-testid="agent-model-effective-scope">{zh ? "保存后对新建会话生效，已有会话保留原配置。" : "Saved settings apply to new sessions. Existing sessions keep their original configuration."}</p>
			<section className="space-y-3" aria-labelledby="agent-default-model-title">
				<h3 id="agent-default-model-title" className="text-ui-base font-medium">{zh ? "默认模型" : "Default model"}</h3>
				<SettingsGroupCard>
					<SettingsRow
						label={zh ? "工作流默认模型" : "Workflow default model"}
						description={zh ? "下方选择“跟随默认”的 AIReq Agent 使用此模型。" : "Used by the AIReq Agents below that are set to follow the default."}
						controlLayout="wide"
						control={
							<Select disabled={!canManage} value={draft.defaultModel} onValueChange={defaultModel => { setDraft(current => ({ ...current, defaultModel })); setMessage(""); }}>
								<SelectTrigger size="lg" className="w-full min-w-0" aria-label={zh ? "默认模型" : "Default model"}><SelectValue /></SelectTrigger>
								<SelectContent>{modelOptions}</SelectContent>
							</Select>
						}
					/>
				</SettingsGroupCard>
			</section>
			<section className="space-y-3" aria-labelledby="agent-model-overrides-title">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h3 id="agent-model-overrides-title" className="text-ui-base font-medium">{zh ? "Agent 模型配置" : "Agent models"}</h3>
					<span className="text-ui-sm text-foreground-subtle">{zh ? `${draft.agents.length} 个 Agent` : `${draft.agents.length} Agents`}</span>
				</div>
				<SettingsGroupCard>
					{draft.agents.map(agent => {
						const name = zh ? agent.name : agent.nameEn;
						return (
							<SettingsRow key={agent.id}
								label={name}
								description={zh ? agent.description : agent.descriptionEn}
								controlLayout="wide"
								control={
									<div className="w-full min-w-0 space-y-2">
										<Select disabled={!canManage} value={agent.model} onValueChange={model => updateAgent(agent.id, { model })}>
											<SelectTrigger size="lg" className="w-full min-w-0" aria-label={`${name} ${zh ? "模型" : "model"}`}><SelectValue /></SelectTrigger>
											<SelectContent>
												<SelectItem value="inherit">{zh ? "跟随默认" : "Follow default"} · {modelName(draft.defaultModel)}</SelectItem>
												{modelOptions}
											</SelectContent>
										</Select>
										<div className="flex items-center justify-between gap-2">
											<span className="shrink-0 text-ui-sm text-foreground-subtle">{zh ? "思考强度" : "Reasoning"}</span>
											<Select disabled={!canManage} value={agent.reasoning} onValueChange={reasoning => updateAgent(agent.id, { reasoning })}>
												<SelectTrigger size="sm" variant="ghost" aria-label={`${name} ${zh ? "思考强度" : "reasoning"}`}><SelectValue /></SelectTrigger>
												<SelectContent>
													<SelectItem value="default">{zh ? "模型默认" : "Model default"}</SelectItem>
													<SelectItem value="low">{zh ? "低" : "Low"}</SelectItem>
													<SelectItem value="medium">{zh ? "中" : "Medium"}</SelectItem>
													<SelectItem value="high">{zh ? "高" : "High"}</SelectItem>
												</SelectContent>
											</Select>
										</div>
									</div>
								}
							/>
						);
					})}
				</SettingsGroupCard>
			</section>
			<div className="flex flex-wrap items-center justify-end gap-2">
					<Button variant="outline" disabled={!dirty || !canManage} onClick={() => { setDraft(structuredClone(saved)); setMessage(""); }}>{zh ? "取消" : "Cancel"}</Button>
					<Button disabled={!dirty || !canManage || saving} onClick={() => { void save(); }}>{zh ? "保存配置" : "Save configuration"}</Button>
			</div>
			<p role="status" className="text-ui-base text-foreground-subtle">{message}</p>
		</div>
	);
}
