import { useEffect, useState, type ReactNode } from "react";
import { CalendarClock, Plus, MessageCirclePlus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useDev, DEV_STAGE_LABELS } from "./DevContext.js";
import { readPrototypeSidebarPreferences, updatePrototypeSidebarPreferences } from "./mock/navigation.js";
import { DevProjectReleaseMenu } from "./DevProjectReleaseMenu.js";
import { DevRequirementSearch } from "./DevRequirementSearch.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { subscribePrototypeFreeChats } from "./mock/free-chats.js";
import { DevRequirementList } from "./DevRequirementList.js";

interface DevSidebarProps { projects: ReactNode; onNavigate?: () => void; onOpenAutomations?: () => void; automationsActive?: boolean }

export function DevSidebar(props: DevSidebarProps) {
	const dev = useDev()!;
	return <DevSidebarContent key={`${dev.selection.projectId}:${dev.releaseId}`} {...props} />;
}

function DevSidebarContent({ projects, onNavigate, onOpenAutomations, automationsActive }: DevSidebarProps) {
	const dev = useDev()!;
	const { view, selection, select, command, pending, releaseId } = dev;
	const scope = `${selection.projectId}:${releaseId}`;
	const [preferences, setPreferences] = useState(() => readPrototypeSidebarPreferences(scope));
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchScope, setSearchScope] = useState<"proposals" | "formal">("formal");
	const openSettings = useTabStore(state => state.openSettingsTab);
	const theme = useZCodeStore(state => state.theme);
	const setTheme = useZCodeStore(state => state.setTheme);
	const project = view?.projects.find(item => item.id === selection.projectId);
	const selectedRelease = view?.releases.find(item => item.id === releaseId);
	const allGroups = view?.groups.filter(group => group.releaseId === releaseId) ?? [];
	const allDrafts = view?.drafts.filter(group => group.releaseId === releaseId) ?? [];
	const activeSr = view?.srs.find(sr => sr.id === view.activeSrId) ?? view?.srs.find(sr => sr.status === "developing");
	const activeIr = view?.groups.find(group => group.id === activeSr?.irId);
	const activeRelease = view?.releases.find(release => release.id === activeIr?.releaseId);
	const updatePreferences = (patch: Partial<typeof preferences>) => {
		updatePrototypeSidebarPreferences(scope, patch);
		setPreferences(current => ({ ...current, ...patch }));
	};
	useEffect(() => {
		if (selection.irId && !preferences.expandedIrIds.includes(selection.irId)) {
			const expandedIrIds = [...preferences.expandedIrIds, selection.irId];
			updatePrototypeSidebarPreferences(scope, { expandedIrIds });
			setPreferences(current => ({ ...current, expandedIrIds }));
		}
		// 仅在查看目标变化时展开所属 IR，允许手动收起当前 IR。
	}, [selection.irId, selection.srId, scope]);
	const manageProjects = () => { setPendingSettingsSectionIntent("general"); openSettings(); };
	return (
		<nav data-testid="dev-workflow-root" aria-label="Dev 需求导航" className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-ui-base">
			<div className="shrink-0 space-y-3 px-2 pt-3 pb-4">
				<Button variant="ghost" size="lg" className="w-full justify-start gap-2" disabled={pending || !project} data-testid="dev-new-free-chat" onClick={() => { dev.startFreeChat(); onNavigate?.(); }}><MessageCirclePlus className="size-4" />新建会话</Button>
				<Button variant="ghost" size="lg" className="w-full justify-start gap-2" disabled={pending || !project || !releaseId} data-testid="new-requirement" onClick={() => { void command({ type: "createProposal", releaseId }); onNavigate?.(); }}><Plus className="size-4" />新建需求提案</Button>
				{onOpenAutomations && <Button variant="ghost" size="lg" className={`w-full justify-start gap-2 ${automationsActive ? "bg-selected text-foreground" : ""}`} aria-pressed={automationsActive ?? false} data-testid="dev-automations-open" onClick={onOpenAutomations}><CalendarClock className="size-4" />自动化</Button>}
			</div>
			{!selection.freeSessionId && activeSr && activeIr && <section className="shrink-0 space-y-1 border-t border-border/50 px-2 py-3" aria-label="正在开发">
				<p className="px-2.5 text-ui-sm text-foreground-subtle">正在开发</p>
				<Button variant={!automationsActive && selection.srId === activeSr.id ? "secondary" : "ghost"} className="h-auto w-full min-w-0 items-start justify-start gap-2 px-2.5 py-2" data-testid="active-sr" aria-current={!automationsActive && selection.srId === activeSr.id ? "page" : undefined} onClick={() => {
					select({ projectId: selection.projectId, irId: activeIr.id, srId: activeSr.id });
					dev.setReleaseId(activeIr.releaseId);
					onNavigate?.();
				}}>
					<Badge variant="outline" className="mt-0.5 h-4 min-w-5 shrink-0 justify-center rounded-sm border-border/70 bg-transparent px-0.5 font-mono text-ui-xs font-medium text-foreground-subtle">SR</Badge>
					<span className="min-w-0 flex-1 text-left"><span className="block truncate" title={activeSr.title}>{activeSr.title}</span><span className="mt-1 block truncate text-ui-sm text-foreground-subtle">{activeIr.title} · {activeSr.stage ? DEV_STAGE_LABELS[activeSr.stage] : "开发中"}</span>{activeIr.releaseId !== releaseId && <span className="mt-1 block truncate text-ui-sm text-foreground-subtle">{activeRelease?.title} · 点击返回</span>}</span>
				</Button>
			</section>}
			<div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto border-t border-border/50 py-3">
				<DevFreeProjectBoundary>{projects}</DevFreeProjectBoundary>
				<DevRequirementList open={preferences.formalSectionOpen} onOpenChange={formalSectionOpen => updatePreferences({ formalSectionOpen })} title="正式需求" groups={allGroups} expandedIrIds={preferences.expandedIrIds} onExpandedChange={expandedIrIds => updatePreferences({ expandedIrIds })} onSearch={() => { setSearchScope("formal"); setSearchOpen(true); }} onNavigate={onNavigate} automationsActive={automationsActive} />
				<DevRequirementList open={preferences.proposalSectionOpen} onOpenChange={proposalSectionOpen => updatePreferences({ proposalSectionOpen })} title="需求提案" groups={allDrafts} proposal expandedIrIds={preferences.expandedIrIds} onExpandedChange={expandedIrIds => updatePreferences({ expandedIrIds })} onSearch={() => { setSearchScope("proposals"); setSearchOpen(true); }} onNavigate={onNavigate} automationsActive={automationsActive} />
			</div>
			<DevRequirementSearch scope={searchScope} open={searchOpen} onOpenChange={setSearchOpen} query={preferences.query} onQueryChange={query => updatePreferences({ query })} onNavigate={onNavigate} />
			<WorkspaceSidebarFooter className="border-t border-border/50 px-4 pt-2 pb-3" menuContent={<DevProjectReleaseMenu onManage={manageProjects} />} menuDescription={<span className="flex min-w-0 flex-col text-ui-sm text-foreground-subtle" data-testid="project-release-context"><span className="truncate" title={project?.name}>{project?.name ?? "请选择项目"}</span><span className="truncate" title={selectedRelease?.title}>Release · {selectedRelease?.title ?? "尚未选择"}</span></span>} theme={theme} onThemeChange={value => { if (value === "system" || value === "zai-dark" || value === "zai-light") setTheme(value); }} onSettingsButtonClick={openSettings} />
		</nav>
	);
}

function DevFreeProjectBoundary({ children }: { children: ReactNode }) {
 const { refresh } = useProjectDirectory();
 const dev = useDev()!;
 useEffect(() => { void refresh(); return subscribePrototypeFreeChats(() => { void refresh(); }); }, [refresh, dev.view?.projects.length]);
 return <>{children}</>;
}
