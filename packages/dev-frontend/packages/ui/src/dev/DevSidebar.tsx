import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleDot, FileInput, FileText, Folder, FolderOpen, FolderGit2, ListFilter, MessagesSquare, PanelLeftClose, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useDev, DEV_STAGE_LABELS } from "./DevContext.js";
import { readPrototypeSidebarPreferences, updatePrototypeSidebarPreferences, type PrototypeRequirementFilter } from "./mock/navigation.js";
import { DevRequirementSearch } from "./DevRequirementSearch.js";
import type { DevRequirementGroup } from "./mock/types.js";

const FILTERS: { id: PrototypeRequirementFilter; title: string }[] = [
	{ id: "all", title: "全部需求" },
	{ id: "developing", title: "开发中" },
	{ id: "pending", title: "待开发" },
	{ id: "completed", title: "已完成" },
];

export function DevSidebar({ onNavigate }: { onNavigate?: () => void }) {
	const dev = useDev()!;
	return <DevSidebarContent key={`${dev.selection.projectId}:${dev.releaseId}`} onNavigate={onNavigate} />;
}

function DevSidebarContent({ onNavigate }: { onNavigate?: () => void }) {
	const dev = useDev()!;
	const { view, selection, select, command, pending, releaseId } = dev;
	const scope = `${selection.projectId}:${releaseId}`;
	const [preferences, setPreferences] = useState(() => readPrototypeSidebarPreferences(scope));
	const [searchOpen, setSearchOpen] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const openSettings = useTabStore(state => state.openSettingsTab);
	const theme = useZCodeStore(state => state.theme);
	const setTheme = useZCodeStore(state => state.setTheme);
	const project = view?.projects.find(item => item.id === selection.projectId);
	const allGroups = view?.groups.filter(group => group.releaseId === releaseId) ?? [];
	const allDrafts = view?.drafts.filter(group => group.releaseId === releaseId) ?? [];
	const activeSr = view?.srs.find(sr => sr.id === view.activeSrId) ?? view?.srs.find(sr => sr.status === "developing");
	const activeIr = view?.groups.find(group => group.id === activeSr?.irId);
	const activeRelease = view?.releases.find(release => release.id === activeIr?.releaseId);
	const updatePreferences = (patch: Partial<typeof preferences>) => {
		updatePrototypeSidebarPreferences(scope, patch);
		setPreferences(current => ({ ...current, ...patch }));
	};
	const status = (group: DevRequirementGroup): PrototypeRequirementFilter => {
		const srs = view?.srs.filter(sr => sr.irId === group.id) ?? [];
		return srs.some(sr => sr.status === "developing") ? "developing"
			: srs.length > 0 && srs.every(sr => sr.status === "completed") ? "completed" : "pending";
	};
	const groups = allGroups.filter(group => preferences.filter === "all" || status(group) === preferences.filter);
	const drafts = allDrafts;
	useEffect(() => {
		if (selection.irId && !preferences.expandedIrIds.includes(selection.irId)) {
			const expandedIrIds = [...preferences.expandedIrIds, selection.irId];
			updatePrototypeSidebarPreferences(scope, { expandedIrIds });
			setPreferences(current => ({ ...current, expandedIrIds }));
		}
		// 仅在查看目标变化时展开所属 IR，允许手动收起当前 IR。
	}, [selection.irId, selection.srId, scope]);
	const selectedDraft = allDrafts.some(draft => draft.id === selection.irId);
	const draftExpanded = preferences.draftsOpen || selectedDraft;
	const choose = (irId: string) => { select({ projectId: selection.projectId, irId }); onNavigate?.(); };
	const manageProjects = () => { setPendingSettingsSectionIntent("general"); openSettings(); };
	return (
		<nav data-testid="dev-workflow-root" aria-label="Dev 需求导航" className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-ui-base">
			<div className="shrink-0 space-y-3 px-2 pt-3 pb-4">
				<div className="space-y-1" data-testid="project-release-context">
					<Select value={selection.projectId} onValueChange={projectId => select({ projectId })}>
						<SelectTrigger variant="ghost" size="lg" className="w-full min-w-0 justify-between gap-2 px-2.5" data-testid="project-select" aria-label="项目"><FolderGit2 className="size-4 shrink-0 text-foreground-subtle" /><span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder="选择项目" /></span></SelectTrigger>
						<SelectContent>{view?.projects.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
					</Select>
					<div className="pl-6">
						<Select value={releaseId || undefined} onValueChange={dev.setReleaseId} disabled={!project || !view?.releases.length}>
							<SelectTrigger variant="ghost" size="lg" className="w-full min-w-0 justify-between px-2.5" data-testid="release-select" aria-label="Release"><span className="mr-1 shrink-0 text-ui-sm text-foreground-subtle">Release</span><span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder={project ? "尚无 Release" : "请先选择项目"} /></span></SelectTrigger>
							<SelectContent>{view?.releases.map(release => <SelectItem key={release.id} value={release.id}>{release.title}</SelectItem>)}</SelectContent>
						</Select>
					</div>
				</div>
				<div className="flex items-center gap-1">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="lg" className="min-w-0 flex-1 justify-start gap-2" disabled={pending || !project || !releaseId} data-testid="new-requirement"><Plus className="size-4" />新建需求<ChevronDown className="ml-auto size-3.5 text-foreground-subtle" /></Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-72">
							<DropdownMenuItem data-testid="new-local" onSelect={() => { void command({ type: "createLocalDraft", releaseId }); onNavigate?.(); }}>
								<FolderGit2 className="size-4 shrink-0" /><span><span className="block">项目内新建</span><span className="block text-ui-sm text-foreground-subtle">创建需求工作目录，开始整理需求</span></span>
							</DropdownMenuItem>
							<DropdownMenuItem data-testid="new-browser" onSelect={() => { void command({ type: "createBrowserDraft", releaseId }); onNavigate?.(); }}>
								<FileText className="size-4 shrink-0" /><span><span className="block">整理并交接需求</span><span className="block text-ui-sm text-foreground-subtle">不创建 Git 工作区，确认后导出需求包</span></span>
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => fileInput.current?.click()}><FileInput className="size-4 shrink-0" /><span><span className="block">导入需求包</span><span className="block text-ui-sm text-foreground-subtle">接收已有 IR 与 SR，关联当前项目和 Release</span></span></DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					{onNavigate && <ControlHintTooltip title="返回聊天"><Button variant="ghost" size="icon-sm" aria-label="返回聊天" onClick={onNavigate}><PanelLeftClose className="size-4" /></Button></ControlHintTooltip>}
				</div>
				<input ref={fileInput} type="file" accept=".zip,application/zip" className="sr-only" data-testid="import-package" onChange={event => {
					const file = event.target.files?.[0]; event.target.value = "";
					if (file) { void command({ type: "importPackage", projectId: selection.projectId, releaseId, packageId: `local-preview:${file.name}` }); onNavigate?.(); }
				}} />
			</div>
			{activeSr && activeIr && <section className="shrink-0 space-y-1 border-t border-border/50 px-2 py-3" aria-label="正在开发">
				<p className="px-2.5 text-ui-sm text-foreground-subtle">正在开发</p>
				<Button variant={selection.srId === activeSr.id ? "secondary" : "ghost"} className="h-auto w-full min-w-0 items-start justify-start gap-2 px-2.5 py-2" data-testid="active-sr" aria-current={selection.srId === activeSr.id ? "page" : undefined} onClick={() => {
					select({ projectId: selection.projectId, irId: activeIr.id, srId: activeSr.id });
					dev.setReleaseId(activeIr.releaseId);
					onNavigate?.();
				}}>
					<CircleDot className="mt-0.5 size-3.5 shrink-0 text-foreground-subtle" />
					<span className="min-w-0 flex-1 text-left"><span className="block truncate" title={activeSr.title}>{activeSr.title}</span><span className="mt-1 block truncate text-ui-sm text-foreground-subtle">{activeIr.title} · {activeSr.stage ? DEV_STAGE_LABELS[activeSr.stage] : "开发中"}</span>{activeIr.releaseId !== releaseId && <span className="mt-1 block truncate text-ui-sm text-foreground-subtle">{activeRelease?.title} · 点击返回</span>}</span>
				</Button>
			</section>}
			<div className="flex min-h-0 flex-1 flex-col border-t border-border/50 pt-3">
				<div className="flex shrink-0 items-center gap-1 px-2 pb-2">
					<span className="min-w-0 flex-1 px-2.5 text-ui-base font-medium text-foreground-subtle">需求</span>
					<ControlHintTooltip title="搜索需求"><Button variant="ghost" size="icon-sm" aria-label="搜索需求" aria-haspopup="dialog" aria-expanded={searchOpen} className="shrink-0 text-foreground-subtle hover:text-foreground" onClick={() => setSearchOpen(true)}><Search className="size-3.5" /></Button></ControlHintTooltip>
					<DropdownMenu>
						<ControlHintTooltip title="筛选需求"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="筛选需求" className={`shrink-0 text-foreground-subtle hover:text-foreground ${preferences.filter !== "all" ? "bg-selected" : ""}`}><ListFilter className="size-3.5" /></Button></DropdownMenuTrigger></ControlHintTooltip>
						<DropdownMenuContent align="end"><DropdownMenuRadioGroup value={preferences.filter} onValueChange={value => { const filter = FILTERS.find(item => item.id === value); if (filter) updatePreferences({ filter: filter.id }); }}>{FILTERS.map(filter => <DropdownMenuRadioItem key={filter.id} value={filter.id}><CircleDot className="size-4 text-foreground-subtle" aria-hidden="true" />{filter.title}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent>
					</DropdownMenu>
				</div>
				{preferences.filter !== "all" && <div className="flex shrink-0 items-center justify-between px-4 pb-2 text-ui-sm text-foreground-subtle"><span>{FILTERS.find(filter => filter.id === preferences.filter)?.title}</span><Button variant="ghost" size="icon-xs" aria-label="清除筛选" onClick={() => updatePreferences({ filter: "all" })}><X className="size-3" /></Button></div>}
				<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
					{groups.map(group => {
						const expanded = preferences.expandedIrIds.includes(group.id);
						const srs = view?.srs.filter(sr => sr.irId === group.id) ?? [];
						const FolderIcon = expanded ? FolderOpen : Folder;
						return <Collapsible key={group.id} open={expanded} onOpenChange={open => updatePreferences({ expandedIrIds: open ? [...preferences.expandedIrIds, group.id] : preferences.expandedIrIds.filter(id => id !== group.id) })} className="mb-1">
							<div className="group/ir-row flex min-w-0 items-center rounded-lg hover:bg-menu-hover">
								<CollapsibleTrigger asChild><Button variant="ghost" className="h-8 min-w-0 flex-1 justify-start gap-2 rounded-lg pr-1 pl-2.5 text-left hover:bg-transparent" data-ir-id={group.id}>
									<FolderIcon className="size-4 shrink-0 text-foreground-subtle" /><span className="min-w-0 flex-1 truncate text-foreground-subtle" title={group.title}>{group.title}</span><span className="text-ui-sm text-foreground-subtlest">{srs.length}</span>
								</Button></CollapsibleTrigger>
								<div className="mr-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover/ir-row:opacity-100 group-focus-within/ir-row:opacity-100 [@media(hover:none)]:opacity-100"><ControlHintTooltip title="需求讨论"><Button variant="ghost" size="icon-sm" aria-label={`${group.title}：需求讨论`} aria-pressed={selection.irId === group.id && !selection.srId} onClick={() => choose(group.id)}><MessagesSquare className="size-3.5 text-foreground-subtle" /></Button></ControlHintTooltip></div>
							</div>
							<CollapsibleContent data-testid={`ir-srs-${group.id}`}><div className="space-y-1 pt-1 pl-2">
								{srs.map(sr => <Button key={sr.id} variant={selection.srId === sr.id ? "secondary" : "ghost"} className="h-8 w-full min-w-0 justify-start gap-2 pr-2.5 pl-6.5 text-left font-normal" data-sr-id={sr.id} aria-current={selection.srId === sr.id ? "page" : undefined} onClick={() => { select({ projectId: selection.projectId, irId: group.id, srId: sr.id }); onNavigate?.(); }}>
									<span className="min-w-0 flex-1 truncate" title={sr.title}>{sr.title}</span><span className="shrink-0 text-ui-sm text-foreground-subtlest">{sr.status === "completed" ? "已完成" : sr.stage ? DEV_STAGE_LABELS[sr.stage] : "待开始"}</span>
								</Button>)}
							</div></CollapsibleContent>
						</Collapsible>;
					})}
					{!groups.length && <div className="space-y-2 px-2.5 py-3 text-ui-sm leading-6 text-foreground-subtle"><p>{!project ? "添加已有 Git 项目后，开始整理需求。" : !releaseId ? "当前项目还没有 Release。" : preferences.filter !== "all" ? "没有匹配的正式需求。" : "还没有正式需求。新建需求会先保存在草稿中。"}</p>{(!project || !releaseId) && <Button variant="outline" size="sm" onClick={manageProjects}>{!project ? "添加项目" : "添加 Release"}</Button>}</div>}
					{allDrafts.length > 0 && <Collapsible open={draftExpanded} onOpenChange={value => updatePreferences({ draftsOpen: value })} className="mt-3" data-testid="dev-drafts">
						<CollapsibleTrigger asChild><Button variant="ghost" className="w-full justify-start gap-2 px-2.5 text-foreground-subtle"><ChevronDown className={`size-3 transition-transform ${draftExpanded ? "" : "-rotate-90"}`} />草稿<span className="ml-auto text-ui-sm">{drafts.length}</span></Button></CollapsibleTrigger>
						<CollapsibleContent>{drafts.map(draft => <Button key={draft.id} variant={selection.irId === draft.id ? "secondary" : "ghost"} className="h-auto w-full justify-start px-2.5 py-2 text-left" data-ir-id={draft.id} data-dev-draft="true" aria-current={selection.irId === draft.id ? "page" : undefined} onClick={() => choose(draft.id)}><span className="min-w-0 truncate" title={draft.title}>{draft.title || "需求讨论"}</span></Button>)}{!drafts.length && <p className="px-2.5 py-2 text-ui-sm text-foreground-subtle">没有匹配的草稿。</p>}</CollapsibleContent>
					</Collapsible>}
				</div>
			</div>
			<DevRequirementSearch open={searchOpen} onOpenChange={setSearchOpen} query={preferences.query} onQueryChange={query => updatePreferences({ query })} onNavigate={onNavigate} />
			<WorkspaceSidebarFooter className="px-4 pt-1 pb-3" theme={theme} onThemeChange={value => { if (value === "system" || value === "zai-dark" || value === "zai-light") setTheme(value); }} onSettingsButtonClick={openSettings} />
		</nav>
	);
}
