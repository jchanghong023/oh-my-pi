import { useDevDataSource } from "./data-source.js";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DevPersonalConfigScope } from "./DevPersonalConfigScope.js";

export interface DevModelDraftActions { save(): void; discard(): void }

export function DevAgentModelSettings({ onDraftActionsChange }: { onDraftActionsChange?: (actions: DevModelDraftActions | null) => void }) {
 const source = useDevDataSource();
 if (!source.models) return <p className="text-ui-sm text-foreground-subtle">当前数据源尚未接入此功能。</p>;
	const { locale } = useZCodeIntl();
	const zh = locale === "zh-CN";
	const [saved, setSaved] = useState(source.models!.read);
	const [draft, setDraft] = useState(source.models!.read);
	const [message, setMessage] = useState("");
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	useEffect(() => {
		onDraftActionsChange?.(dirty ? {
			save: () => { source.models!.save(draft); setSaved(structuredClone(draft)); },
			discard: () => { setDraft(structuredClone(saved)); setMessage(""); },
		} : null);
		return () => onDraftActionsChange?.(null);
	}, [dirty, draft, saved, source, onDraftActionsChange]);
	const modelName = (id: string) => source.models!.choices.find(model => model.id === id)?.name ?? id;
	const updateAgent = (id: string, patch: { model?: string; reasoning?: string }) => {
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
				{zh ? "为 Dev 核心 Agent 分别选择模型与思考强度。未单独指定模型时，跟随默认模型。" : "Choose a model and reasoning level for each core Dev Agent. Agents without a model override follow the default model."}
			</p>
			<DevPersonalConfigScope />
            <p className="text-ui-sm leading-6 text-foreground-subtle" data-testid="agent-model-effective-scope">{zh ? "保存后用于之后新建的角色会话，包括新阶段和返工新轮次。已有会话与历史消息保留创建时的模型和思考强度；不会自动切换运行中的 Agent。自由会话沿用原模型设置方式。" : "Saved settings apply to newly created role sessions, including new stages and rework rounds. Existing sessions and history keep their original model and reasoning level. Free conversations retain their existing model controls."}</p>
			<section className="space-y-3" aria-labelledby="agent-default-model-title">
				<h3 id="agent-default-model-title" className="text-ui-base font-medium">{zh ? "默认模型" : "Default model"}</h3>
				<SettingsGroupCard>
					<SettingsRow
						label={zh ? "工作流默认模型" : "Workflow default model"}
						description={zh ? "下方选择“跟随默认”的 Dev Agent 使用此模型。" : "Used by the Dev Agents below that are set to follow the default."}
						controlLayout="wide"
						control={
							<Select value={draft.defaultModel} onValueChange={defaultModel => { setDraft(current => ({ ...current, defaultModel })); setMessage(""); }}>
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
										<Select value={agent.model} onValueChange={model => updateAgent(agent.id, { model })}>
											<SelectTrigger size="lg" className="w-full min-w-0" aria-label={`${name} ${zh ? "模型" : "model"}`}><SelectValue /></SelectTrigger>
											<SelectContent>
												<SelectItem value="inherit">{zh ? "跟随默认" : "Follow default"} · {modelName(draft.defaultModel)}</SelectItem>
												{modelOptions}
											</SelectContent>
										</Select>
										<div className="flex items-center justify-between gap-2">
											<span className="shrink-0 text-ui-sm text-foreground-subtle">{zh ? "思考强度" : "Reasoning"}</span>
											<Select value={agent.reasoning} onValueChange={reasoning => updateAgent(agent.id, { reasoning })}>
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
					{zh ? "测试与代码审查按需复用 OMP 原生子代理，无需重复配置专有 Agent。IR 验收 Agent 负责全部 SR 合并后的整体验收，以及最终修复与归档 PR 材料。" : "Testing and code review reuse OMP native subagents without separate dedicated Agent settings. The IR Acceptance Agent verifies the integrated IR after all SRs merge and prepares the final fixes and archive PR materials."}
				</p>
			</section>
			<div className="flex flex-wrap items-center justify-between gap-3">
				{source.mode === "prototype" && source.models!.samples && <Button variant="ghost" onClick={() => { setDraft(source.models!.samples!()); setMessage(""); }}>{zh ? "恢复演示配置" : "Restore demo configuration"}</Button>}
				<div className="flex items-center gap-2">
					{dirty && <span className="text-ui-sm text-foreground-subtle">{zh ? "有未保存的更改" : "Unsaved changes"}</span>}
					<Button variant="outline" disabled={!dirty} onClick={() => { setDraft(structuredClone(saved)); setMessage(""); }}>{zh ? "取消" : "Cancel"}</Button>
					<Button disabled={!dirty} onClick={() => { source.models!.save(draft); setSaved(structuredClone(draft)); setMessage(zh ? "服务配置已保存" : "Service configuration saved"); }}>{zh ? "保存配置" : "Save configuration"}</Button>
				</div>
			</div>
			<p role="status" className="text-ui-base text-foreground-subtle">{message}</p>
			{source.mode === "prototype" && <p className="text-ui-sm leading-6 text-foreground-subtle">
				{zh ? "原型演示：模型及思考强度为样例选项，未连接真实模型。保存仅在本页内存生效，刷新后恢复初始样例。" : "Prototype: models and reasoning levels are sample options with no live connection. Saved changes stay in page memory and reset on refresh."}
			</p>}
		</div>
	);
}
