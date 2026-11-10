import { useEffect, useMemo, useState } from "react";
import { FileCode2, FolderGit2, MessageSquare, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useDev } from "./DevContext.js";
import { savePrototypeDesignedSkill } from "./mock/skills.js";
import {
	SKILL_DESIGN_FIELDS, PROTOTYPE_SKILL_DESIGN_SAMPLE, SKILL_DESIGN_BOUNDARY_SUGGESTION,
	readPrototypeSkillDesign, savePrototypeSkillDesignDraft, prototypeSkillDesignSession,
	renderPrototypeSkillDesign, onPrototypeSkillDesignSupplement,
	type PrototypeSkillDesignDraft,
} from "./mock/skill-design.js";

interface SkillPreview { content: string; digest: string; name: string; draft: PrototypeSkillDesignDraft }

export function DevSkillDesignSettings() {
	const dev = useDev();
	const project = dev?.view?.projects.find(item => item.id === dev.selection.projectId);
	if (!project) return <p className="text-ui-base text-foreground-subtle">请先在主页面选择一个已登记的 Git 项目，再设计项目技能。</p>;
	return <SkillDesignEditor key={project.id} projectId={project.id} projectName={project.name} workspacePath={project.root} />;
}

function SkillDesignEditor({ projectId, projectName, workspacePath }: { projectId: string; projectName: string; workspacePath: string }) {
	const sessionId = prototypeSkillDesignSession(projectId);
	const scope = useMemo(() => ({ workspacePath, workspaceIdentity: `dev-ui-prototype:${projectId}` }), [workspacePath, projectId]);
	const [draft, setDraft] = useState(() => readPrototypeSkillDesign(sessionId));
	const [preview, setPreview] = useState<SkillPreview | null>(null);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [suggestion, setSuggestion] = useState(false);
	const [chatFocused, setChatFocused] = useState(false);
	const [optionalOpen, setOptionalOpen] = useState(false);
	const required = SKILL_DESIGN_FIELDS.filter(field => field.required);
	const completed = required.filter(field => draft[field.id].trim()).length;
	const canGenerate = completed === required.length;
	const name = draft.name;
	const slug = name.trim();
	const path = `${workspacePath}/.omp/skills/${slug || "<skill-name>"}/SKILL.md`;
	const previewCurrent = Boolean(preview && preview.digest === JSON.stringify(draft) && preview.name === slug);
	const updateDraft = (next: PrototypeSkillDesignDraft) => { setDraft(next); savePrototypeSkillDesignDraft(sessionId, next); setError(""); setMessage(""); };
	useEffect(() => {
		const subscription = onPrototypeSkillDesignSupplement(id => {
			if (id !== sessionId) return;
			setDraft(readPrototypeSkillDesign(sessionId)); setSuggestion(true); setMessage("");
		});
		return () => subscription.dispose();
	}, [sessionId]);
	const generate = () => {
		if (!canGenerate) return;
		const generatedName = slug || (draft.goal.toLowerCase().includes("接口") || draft.goal.toLowerCase().includes("api") ? "review-api-changes" : "project-skill");
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(generatedName) || generatedName.length > 64) { setError("技能标识需为不超过 64 个字符的小写字母、数字和连字符，且不能以连字符开头或结尾。"); return; }
		if (draft.when.trim().replace(/\s+/g, " ").length > 1024) { setError("适用场景过长，请精简到 1024 个字符以内，再生成 description。"); return; }
		const nextDraft = { ...draft, name: generatedName };
		updateDraft(nextDraft);
		setPreview({ content: renderPrototypeSkillDesign(generatedName, nextDraft), digest: JSON.stringify(nextDraft), name: generatedName, draft: structuredClone(nextDraft) });
		setError(""); setMessage("");
	};
	return (
		<div className="space-y-6" data-testid="dev-skill-design">
			<div className="space-y-2">
				<p className="text-ui-base leading-6 text-foreground-subtle">先用表单说明关键要求，再通过补充讨论完善细节，最后预览技能文件并保存到项目。</p>
				<Badge variant="outline">前端原型 · 预置回复 · 不写入真实文件</Badge>
			</div>
			<SettingsGroupCard>
				<div className="space-y-2 px-4 py-3">
					<p className="flex items-center gap-2 text-ui-base font-medium"><FolderGit2 className="size-4" />{projectName}<Badge variant="secondary">当前项目</Badge></p>
					<p className="text-ui-sm text-foreground-subtle">技能保存在项目级 OMP 默认发现目录，不存入个人模型／提示词配置。</p>
					<p className="break-all font-mono text-ui-sm text-foreground-subtle">{path}</p>
				</div>
			</SettingsGroupCard>
			<section className="space-y-4" aria-labelledby="skill-design-brief-title">
				<div className="flex flex-wrap items-center justify-between gap-2"><h3 id="skill-design-brief-title" className="text-ui-base font-medium">1. 描述技能</h3><Button variant="ghost" size="sm" onClick={() => { updateDraft({ ...structuredClone(PROTOTYPE_SKILL_DESIGN_SAMPLE), notes: draft.notes }); setOptionalOpen(true); setPreview(null); }}>填入示例</Button></div>
				<div className="grid gap-x-5 gap-y-5 md:grid-cols-2">
					{required.map(field => <div key={field.id} className="space-y-2">
						<Label htmlFor={`skill-design-${field.id}`}>{field.label}<span className="ml-1 text-foreground-subtle" aria-hidden="true">*</span></Label>
						<SettingsFormTextarea id={`skill-design-${field.id}`} rows={3} required className="min-h-24 w-full" value={draft[field.id]} placeholder={field.placeholder} onChange={event => updateDraft({ ...draft, [field.id]: event.target.value })} aria-describedby={`skill-design-${field.id}-help`} />
						<p id={`skill-design-${field.id}-help`} className="text-ui-sm text-foreground-subtle">{field.hint}</p>
					</div>)}
				</div>
				<Collapsible open={optionalOpen} onOpenChange={setOptionalOpen}>
					<CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="px-0">{optionalOpen ? "收起" : "展开"}补充字段（选填）</Button></CollapsibleTrigger>
					<CollapsibleContent className="space-y-4 pt-3">{SKILL_DESIGN_FIELDS.filter(field => !field.required).map(field => <div key={field.id} className="space-y-2"><Label htmlFor={`skill-design-${field.id}`}>{field.label}</Label><SettingsFormTextarea id={`skill-design-${field.id}`} rows={2} value={draft[field.id]} placeholder={field.placeholder} onChange={event => updateDraft({ ...draft, [field.id]: event.target.value })} /><p className="text-ui-sm text-foreground-subtle">{field.hint}</p></div>)}</CollapsibleContent>
				</Collapsible>
			</section>
			<section className="space-y-3" aria-labelledby="skill-design-chat-title">
				<div className="flex flex-wrap items-center justify-between gap-2"><h3 id="skill-design-chat-title" className="flex items-center gap-2 text-ui-base font-medium"><MessageSquare className="size-4" />2. 补充讨论</h3><span className="text-ui-sm text-foreground-subtle">表单上下文已同步 · 核心信息 {completed}/{required.length}</span></div>
				<p className="text-ui-sm text-foreground-subtle">可补充表单未覆盖的细节或添加附件。此讨论使用独立演示会话，与主页面需求讨论分开。</p>
				<div className="relative h-[28rem] min-h-0 overflow-hidden rounded-xl border border-border bg-background" data-testid="skill-design-chat" onFocusCapture={() => setChatFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setChatFocused(false); }}>
					<V4PaneConversationProvider scope={scope} sessionId={sessionId}>
						<SessionPane paneId={`skill-designer-${projectId}`} sessionId={sessionId} rootSessionId={sessionId} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} embedded focused={chatFocused} />
					</V4PaneConversationProvider>
				</div>
				{suggestion && <SettingsGroupCard><div className="space-y-2 px-4 py-3"><p className="text-ui-sm text-foreground-subtle">待确认的补充建议（样例）</p><p className="text-ui-base">{SKILL_DESIGN_BOUNDARY_SUGGESTION}</p><Button size="sm" variant="outline" onClick={() => { updateDraft({ ...draft, boundaries: [draft.boundaries, SKILL_DESIGN_BOUNDARY_SUGGESTION].filter(Boolean).join("\n") }); setSuggestion(false); setOptionalOpen(true); }}>应用到边界</Button><Button size="sm" variant="ghost" onClick={() => setSuggestion(false)}>忽略</Button></div></SettingsGroupCard>}
			</section>
			<section className="space-y-3" aria-labelledby="skill-design-preview-title">
				<div className="flex flex-wrap items-center justify-between gap-2"><h3 id="skill-design-preview-title" className="flex items-center gap-2 text-ui-base font-medium"><FileCode2 className="size-4" />3. 预览并保存</h3><Button disabled={!canGenerate} onClick={generate}><Sparkles className="size-3.5" />{preview ? "重新生成预览" : "生成预览"}</Button></div>
				<p className="text-ui-sm text-foreground-subtle">{canGenerate ? "演示生成将把表单与补充讨论整理为文件预览，不调用真实模型。" : "填写上方 4 项必填信息后，即可生成预览。"}</p>
				<div className="space-y-2"><Label htmlFor="skill-design-name">技能标识（可选，生成时自动填写）</Label><Input id="skill-design-name" value={name} placeholder="例如 review-api-changes" onChange={event => { updateDraft({ ...draft, name: event.target.value }); }} className="sm:max-w-sm" /><p className="text-ui-sm text-foreground-subtle">用于目录名与 name，小写字母、数字和连字符，最长 64 个字符。</p></div>
				{preview && <>
					<SettingsGroupCard><div className="border-b border-border px-4 py-3 text-ui-sm font-medium">SKILL.md · 只读预览</div><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-ui-sm">{preview.content}</pre></SettingsGroupCard>
					{!previewCurrent && <p role="status" className="text-ui-sm text-foreground-subtle">设计内容或标识已更新，请重新生成预览后再保存。</p>}
					<SettingsGroupCard><div className="border-b border-border px-4 py-3 text-ui-base font-medium">建议验证例子 · 均未执行</div>{[
						{ title: "正常使用", text: `提供“${preview.draft.inputs || "所需输入"}”，检查能否按成功标准输出结果。` },
						{ title: "不应触发", text: preview.draft.boundaries || "选择与核心任务无关的请求，检查是否说明不适用。" },
						{ title: "输入不足", text: "缺少关键输入时，应报告缺口，不编造事实或声称完成。" },
					].map(example => <div key={example.title} className="space-y-1 border-b border-border px-4 py-3 last:border-0"><div className="flex items-center justify-between gap-2"><span className="text-ui-base font-medium">{example.title}</span><Badge variant="outline">待试用</Badge></div><p className="text-ui-sm leading-6 text-foreground-subtle">{example.text}</p></div>)}</SettingsGroupCard>
					<div className="flex flex-wrap items-center justify-end gap-2"><Button variant="outline" onClick={() => setPreview(null)}>返回修改</Button><Button disabled={!previewCurrent || Boolean(message)} onClick={() => {
						try { const savedPath = savePrototypeDesignedSkill(workspacePath, preview.name, draft.when, preview.content); setMessage(`已演示保存到 ${savedPath}，未写入真实文件。`); setError(""); }
						catch (cause) { setError(cause instanceof Error ? cause.message : "演示保存失败，请检查标识。"); }
					}}>保存到项目（演示）</Button></div>
				</>}
				{error && <p role="alert" className="text-ui-base text-destructive">{error}</p>}
				{message && <div className="space-y-2"><p role="status" className="break-all text-ui-base text-foreground-subtle">{message}</p><Badge variant="outline">项目技能 · 内存演示</Badge></div>}
			</section>
		</div>
	);
}
