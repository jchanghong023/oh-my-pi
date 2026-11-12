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
   setMessage(zh ? "我的模型配置已保存" : "My model configuration saved");
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
				{zh ? "为 AIReq 核心 Agent 分别选择模型与思考强度。未单独指定模型时，跟随默认模型。" : "Choose a model and reasoning level for each core AIReq Agent. Agents without a model override follow the default model."}
			</p>
			<AIReqPersonalConfigScope />
      {!canManage && <p className="text-ui-sm text-foreground-subtle">当前账号只读，可以查看全部模型和 Agent 配置；仅启动此 OMP Web 的人可修改。</p>}
            <p className="text-ui-sm leading-6 text-foreground-subtle" data-testid="agent-model-effective-scope">{zh ? "保存后用于之后新建的角色会话，包括新阶段和返工新轮次。已有会话与历史消息保留创建时的模型和思考强度；不会自动切换运行中的 Agent。自由会话沿用原模型设置方式。" : "Saved settings apply to newly created role sessions, including new stages and rework rounds. Existing sessions and history keep their original model and reasoning level. Free conversations retain their existing model controls."}</p>
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
				<p className="text-ui-sm leading-6 text-foreground-subtle">
					{zh ? "方案 Agent 负责提案技术方案、SR 依赖及建议排期；需求分析 Agent 根据代码证据报告进度、遗留问题与合入情况。两者均不编码、不修复代码；AIReq 不提供 IR 验收或归档 PR 流水线，实际开发、测试与代码评审在平台外完成。" : "The Solution Agent handles proposal design, SR dependencies and suggested dates. The Requirement Analysis Agent reports progress, outstanding issues and merge evidence. Neither writes or fixes code. AIReq has no IR acceptance or archive-PR pipeline; development, testing and code review happen outside the platform."}
				</p>
			</section>
			<div className="flex flex-wrap items-center justify-between gap-3">
				{source.models!.samples && <Button variant="ghost" disabled={!canManage} onClick={() => { setDraft(source.models!.samples!()); setMessage(""); }}>{zh ? "恢复演示配置" : "Restore demo configuration"}</Button>}
				<div className="flex items-center gap-2">
					{dirty && <span className="text-ui-sm text-foreground-subtle">{zh ? "有未保存的更改" : "Unsaved changes"}</span>}
					<Button variant="outline" disabled={!dirty || !canManage} onClick={() => { setDraft(structuredClone(saved)); setMessage(""); }}>{zh ? "取消" : "Cancel"}</Button>
					<Button disabled={!dirty || !canManage || saving} onClick={() => { void save(); }}>{zh ? "保存配置" : "Save configuration"}</Button>
				</div>
			</div>
			<p role="status" className="text-ui-base text-foreground-subtle">{message}</p>
			{source.provenance.kind === "sample" && <p className="text-ui-sm leading-6 text-foreground-subtle">
				{zh ? "原型演示：模型及思考强度为样例选项，未连接真实模型。保存于后端内存，刷新保留，后端重启恢复初始样例。" : "Prototype: sample models only. Changes stay in backend memory across refreshes and reset when the backend restarts."}
			</p>}
		</div>
	);
}
