import { useDevDataSource } from "./data-source.js";
import type { DevSkillDesignDraft } from "./types.js";
import { SKILL_DESIGN_FIELDS, skillName } from "./skill-design-fields.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileCode2, FolderGit2, MessageSquare, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useDev } from "./DevContext.js";
import { useServices } from "@/hooks/useServices.js";
import { bindRemoteWorkspaceIdentity, registerRemoteWorkspaceSession, unregisterRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";

interface SkillPreview { content: string; digest: string; name: string; draft: DevSkillDesignDraft }

export function DevSkillDesignSettings() {
 const source = useDevDataSource();
 if (source.mode !== "prototype" || !source.skillDesign) return <p className="text-ui-sm text-foreground-subtle">当前数据源尚未接入此功能。</p>;
	const dev = useDev();
	const project = dev?.view?.projects.find(item => item.id === dev.selection.projectId);
	if (!project) return <p className="text-ui-base text-foreground-subtle">请先在主页面选择一个已登记的 Git 项目，再设计项目技能。</p>;
	return <SkillDesignEditor key={project.id} projectId={project.id} projectName={project.name} workspacePath={source.projects?.readDevelopmentRoot(project.id) ?? project.root} developmentRoot={source.projects?.readDevelopmentRoot(project.id)} />;
}

function SkillDesignEditor({ projectId, projectName, workspacePath, developmentRoot }: { projectId: string; projectName: string; workspacePath: string; developmentRoot?: string }) {
	const source = useDevDataSource();
	const services = useServices();
	const sessionId = source.skillDesign!.session(projectId);
	const scope = useMemo(() => ({ workspacePath, workspaceIdentity: `${source.skillDesign!.workspaceIdentity(projectId)}:skill-design` }), [source, workspacePath, projectId]);
	useEffect(() => {
		const registrationId = `dev-skill-designer:${source.clientId}:${crypto.randomUUID()}`;
		registerRemoteWorkspaceSession({ sessionId: registrationId, workspacePath: scope.workspacePath, workspaceIdentity: scope.workspaceIdentity, services });
		bindRemoteWorkspaceIdentity(scope.workspaceIdentity, registrationId);
		return () => unregisterRemoteWorkspaceSession(registrationId);
	}, [source, scope, services]);
	const [draft, setDraft] = useState(() => source.skillDesign!.read(sessionId));
	const [preview, setPreview] = useState<SkillPreview | null>(null);
	const [tab, setTab] = useState("chat");
	const [optionalOpen, setOptionalOpen] = useState(false);
	const [chatFocused, setChatFocused] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [savedPath, setSavedPath] = useState("");
	const previewTitle = useRef<HTMLHeadingElement>(null);
	const previewScroll = useRef<HTMLDivElement>(null);
	const required = SKILL_DESIGN_FIELDS.filter(field => field.required);
	const missing = required.filter(field => !draft[field.id].trim());
	const completed = required.length - missing.length;
	const canGenerate = !missing.length;
	const targetName = skillName(draft);
	const targetPath = developmentRoot ? `${developmentRoot}/.omp/skills/${targetName}/SKILL.md` : "请先在 Dev 项目与 Release 中配置我的开发项目；共享目录只读。";
	const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(targetName) && targetName.length <= 64;
	const previewCurrent = Boolean(preview && preview.digest === JSON.stringify(draft));
	const changedFields = preview ? [
		...SKILL_DESIGN_FIELDS.filter(field => draft[field.id] !== preview.draft[field.id]).map(field => ({ label: field.label, before: preview.draft[field.id], after: draft[field.id] })),
		...(draft.name !== preview.draft.name ? [{ label: "技能标识", before: preview.draft.name, after: draft.name }] : []),
		...(JSON.stringify(draft.notes) !== JSON.stringify(preview.draft.notes) ? [{ label: "补充讨论", before: preview.draft.notes.join("\n"), after: draft.notes.join("\n") }] : []),
	] : [];
	const collision = source.skillDesign!.listSkills(workspacePath).some(skill => skill.name === targetName);
	const updateDraft = (next: DevSkillDesignDraft) => {
		setDraft(next); source.skillDesign!.saveDraft(sessionId, next);
		setError(""); setNotice(""); setSavedPath("");
	};
	useEffect(() => {
		const subscription = source.skillDesign!.subscribe(id => {
			if (id !== sessionId) return;
			const next = source.skillDesign!.read(sessionId);
			setDraft(next); setSavedPath(""); setError("");
		});
		return () => subscription.dispose();
	}, [sessionId]);
	useEffect(() => {
		if (!preview) return;
		previewScroll.current?.scrollTo({ top: 0 });
		previewTitle.current?.focus({ preventScroll: true });
	}, [preview]);
	const generate = () => {
		if (!canGenerate) return;
		if (!validName) { setError("技能标识需为不超过 64 个字符的小写字母、数字和连字符，且不能以连字符开头或结尾。"); return; }
		if (draft.when.trim().replace(/\s+/g, " ").length > 1024) { setError("适用场景过长，请精简到 1024 个字符以内。"); return; }
		const next = { ...draft, name: targetName };
		updateDraft(next);
		setPreview({ content: source.skillDesign!.render(targetName, next), digest: JSON.stringify(next), name: targetName, draft: structuredClone(next) });
		setTab("preview");
	};
	const fillExample = () => {
		const example = source.skillDesign!.sample!;
		const next = { ...draft };
		for (const field of SKILL_DESIGN_FIELDS) if (!next[field.id].trim()) next[field.id] = example[field.id];
		if (!next.name.trim()) next.name = example.name;
		updateDraft(next); setOptionalOpen(true);
		setNotice("已填入空白字段，保留已有内容与讨论。");
	};
	const focusMissing = () => document.getElementById(`skill-design-${missing[0]?.id}`)?.focus();
	const save = () => {
		if (!developmentRoot || !preview || !previewCurrent || collision || !validName || savedPath) return;
		try { setSavedPath(source.skillDesign!.saveSkill(developmentRoot, preview.name, draft.when, preview.content)); setError(""); }
		catch (cause) { setError(cause instanceof Error ? cause.message : "演示保存失败，请检查标识。"); }
	};
	return <div className="flex h-[calc(100dvh-9rem)] min-h-[34rem] flex-col gap-3" data-testid="dev-skill-design">
		<div className="flex flex-wrap items-center justify-between gap-2">
			<p className="text-ui-sm text-foreground-subtle">填写说明，与 AI 补充细节，再检查文件并保存。</p>
			<div className="flex min-w-0 items-center gap-2 text-ui-sm"><FolderGit2 className="size-3.5 text-foreground-subtle" /><span className="truncate">{projectName}</span><Badge variant="outline">项目技能 · 内存演示</Badge></div>
		</div>
		<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
			<section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border" aria-labelledby="skill-design-brief-title">
				<div className="shrink-0 space-y-3 border-b border-border p-4">
					<div className="flex items-center justify-between gap-2"><h3 id="skill-design-brief-title" className="text-ui-base font-medium">技能说明</h3><div className="flex items-center gap-3"><span role="status" className="text-ui-sm text-foreground-subtle">必填 {completed}/{required.length}</span>{source.mode === "prototype" && source.skillDesign!.sample && <Button variant="ghost" size="sm" onClick={fillExample}>填入示例</Button>}</div></div>
				</div>
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="skill-design-fields">
					{required.map(field => <div key={field.id} className="space-y-1.5"><div className="flex items-center justify-between gap-2"><Label htmlFor={`skill-design-${field.id}`}>{field.label}<span className="ml-1 text-foreground-subtle">*</span></Label>{Boolean(draft[field.id].trim()) && <Check className="size-3.5 text-foreground-subtle" aria-label="已填写" />}</div><SettingsFormTextarea id={`skill-design-${field.id}`} rows={2} required className="min-h-20 w-full" value={draft[field.id]} placeholder={field.placeholder} onChange={event => updateDraft({ ...draft, [field.id]: event.target.value })} aria-describedby={`skill-design-${field.id}-help`} /><p id={`skill-design-${field.id}-help`} className="text-ui-sm text-foreground-subtle">{field.hint}</p></div>)}
					<Collapsible open={optionalOpen} onOpenChange={setOptionalOpen}>
						<CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="px-0"><ChevronDown className={`size-3 transition-transform ${optionalOpen ? "" : "-rotate-90"}`} />补充字段（选填）</Button></CollapsibleTrigger>
						<CollapsibleContent><div className="space-y-4 pt-3">{SKILL_DESIGN_FIELDS.filter(field => !field.required).map(field => <div key={field.id} className="space-y-1.5"><Label htmlFor={`skill-design-${field.id}`}>{field.label}</Label><SettingsFormTextarea id={`skill-design-${field.id}`} rows={3} className="w-full" value={draft[field.id]} placeholder={field.placeholder} onChange={event => updateDraft({ ...draft, [field.id]: event.target.value })} /><p className="text-ui-sm text-foreground-subtle">{field.hint}</p></div>)}</div></CollapsibleContent>
					</Collapsible>
				</div>
				<div className="shrink-0 space-y-2 border-t border-border p-3">
					{notice && <p role="status" className="text-ui-sm text-foreground-subtle">{notice}</p>}
					{error && <p role="alert" className="text-ui-sm text-destructive">{error}</p>}
					<div className="flex items-start justify-between gap-2"><p className="text-ui-sm text-foreground-subtle" data-testid="skill-design-missing">{canGenerate ? "核心信息已齐全，可生成文件预览。" : `还缺：${missing.map(field => field.label).join("、")}`}</p>{!canGenerate && <Button size="sm" variant="ghost" className="shrink-0" onClick={focusMissing}>去填写</Button>}</div>
					<Button className="w-full" disabled={!canGenerate} onClick={generate}><Sparkles className="size-3.5" />{preview ? "重新生成预览" : "生成预览"}</Button>
				</div>
			</section>
			<Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border">
				<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2"><TabsList aria-label="技能设计工作区"><TabsTrigger value="chat"><MessageSquare className="size-3.5" />补充讨论</TabsTrigger><TabsTrigger value="preview"><FileCode2 className="size-3.5" />文件预览</TabsTrigger></TabsList>{preview && <span className="text-ui-sm text-foreground-subtle">{savedPath ? "已保存（演示）" : previewCurrent ? "预览已更新" : "预览待更新"}</span>}</div>
				<TabsContent forceMount value="chat" className={tab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
					<div className="relative min-h-0 flex-1" data-testid="skill-design-chat" onFocusCapture={() => setChatFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setChatFocused(false); }}>
						<V4PaneConversationProvider scope={scope} sessionId={sessionId}><SessionPane paneId={`skill-designer-${projectId}`} sessionId={sessionId} rootSessionId={sessionId} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} embedded focused={chatFocused && tab === "chat"} /></V4PaneConversationProvider>
					</div>
				</TabsContent>
				<TabsContent forceMount value="preview" className={tab === "preview" ? "flex min-h-0 flex-col" : "hidden"}>
					<div ref={previewScroll} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="skill-design-preview">
						{!preview ? <div className="flex h-full flex-col items-center justify-center gap-3 text-center"><FileCode2 className="size-6 text-foreground-subtle" /><p className="text-ui-base">还没有文件预览</p><p className="max-w-sm text-ui-sm text-foreground-subtle">填写左侧四项必填说明，再点击“生成预览”。原型使用静态模板，不调用真实模型。</p></div> : <>
							<h3 ref={previewTitle} tabIndex={-1} aria-label="生成的技能预览" className="text-ui-base font-medium outline-none">SKILL.md · {previewCurrent ? "当前预览" : "上次生成的预览"}</h3>
							{changedFields.length > 0 && <div className="space-y-2 rounded-lg border border-border p-3" data-testid="skill-preview-changes"><p className="text-ui-sm font-medium">预览待更新 · 旧内容保留供对照</p><p className="text-ui-sm text-foreground-subtle">已修改：{changedFields.map(field => field.label).join("、")}。重新生成后才能保存。</p><Collapsible><CollapsibleTrigger asChild><Button size="sm" variant="ghost">查看修改前后<ChevronDown className="size-3" /></Button></CollapsibleTrigger><CollapsibleContent><div className="space-y-3 pt-2">{changedFields.map(field => <div key={field.label} className="space-y-1 text-ui-sm"><p className="font-medium">{field.label}</p><p className="whitespace-pre-wrap break-words text-foreground-subtle">生成时：{field.before || "未填写"}</p><p className="whitespace-pre-wrap break-words">现在：{field.after || "已清空"}</p></div>)}</div></CollapsibleContent></Collapsible></div>}
							<SettingsGroupCard><pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-ui-sm">{preview.content}</pre></SettingsGroupCard>
							<SettingsGroupCard><div className="border-b border-border px-4 py-3 text-ui-base font-medium">建议验证例子 · 均未执行</div>{[
								{ title: "正常使用", text: `提供“${preview.draft.inputs || "所需输入"}”，检查能否按成功标准输出结果。` },
								{ title: "不应触发", text: preview.draft.boundaries || "选择与核心任务无关的请求，检查是否说明不适用。" },
								{ title: "输入不足", text: "缺少关键输入时，应报告缺口，不编造事实或声称完成。" },
							].map(example => <div key={example.title} className="space-y-1 border-b border-border px-4 py-3 last:border-0"><div className="flex items-center justify-between gap-2"><span className="text-ui-sm font-medium">{example.title}</span><Badge variant="outline">待试用</Badge></div><p className="text-ui-sm leading-6 text-foreground-subtle">{example.text}</p></div>)}</SettingsGroupCard>
						</>}
					</div>
					<div className="shrink-0 space-y-2 border-t border-border p-3" data-testid="skill-design-save-target">
						<div className="flex items-center gap-3"><Label htmlFor="skill-design-name" className="shrink-0">技能标识</Label><Input id="skill-design-name" value={draft.name} placeholder={targetName} className="min-w-0 flex-1" aria-invalid={!validName || (collision && !savedPath)} aria-describedby="skill-save-path skill-name-help" onChange={event => updateDraft({ ...draft, name: event.target.value })} /></div>
						<p className="text-ui-sm text-foreground-subtle">目标项目：{projectName}</p><p id="skill-save-path" className="break-all font-mono text-ui-sm text-foreground-subtle">{targetPath}</p>
						<p id="skill-name-help" className={`text-ui-sm ${!validName || (collision && !savedPath) ? "text-destructive" : "text-foreground-subtle"}`}>{!validName ? "标识只能包含小写字母、数字和连字符，最长 64 个字符。" : collision && !savedPath ? "此项目或已加载目录中已有同名技能，请修改标识；不会覆盖原文件。" : "保存在项目级 OMP 默认技能目录；当前仅演示，不写入真实文件。"}</p>
						{savedPath && <p role="status" className="text-ui-sm text-foreground-subtle">已演示保存到 {savedPath}，未写入真实文件。</p>}
						<div className="flex items-center justify-end gap-2"><Button variant="ghost" onClick={() => { setTab("chat"); document.getElementById("skill-design-goal")?.focus(); }}>返回修改</Button><Button disabled={!developmentRoot || !previewCurrent || collision || !validName || Boolean(savedPath)} onClick={save}>保存到项目（演示）</Button></div>
					</div>
				</TabsContent>
			</Tabs>
		</div>
	</div>;
}
