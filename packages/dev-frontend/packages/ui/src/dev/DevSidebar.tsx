import { useDevDataSource } from "./data-source.js";
import { DevWorkflowHelp } from "./DevWorkflowHelp.js";
import { IR_ACCEPTANCE_LABELS, irAcceptanceVersionBlocker } from "./domain.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarClock, Plus, MessageCirclePlus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useDev, DEV_STAGE_LABELS } from "./DevContext.js";
import { readSidebarPreferences, updateSidebarPreferences } from "./navigation.js";
import { DevProjectReleaseMenu } from "./DevProjectReleaseMenu.js";
import { DevRequirementSearch } from "./DevRequirementSearch.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { DevRequirementList } from "./DevRequirementList.js";
import { getEmployeeId } from "./identity.js";

interface DevSidebarProps { projects: ReactNode; onNavigate?: () => void; onOpenAutomations?: () => void; automationsActive?: boolean }

export function DevSidebar(props: DevSidebarProps) {
	const dev = useDev()!;
	return <DevSidebarContent key={`${dev.selection.projectId}:${dev.releaseId}`} {...props} />;
}

function DevSidebarContent({ projects, onNavigate, onOpenAutomations, automationsActive }: DevSidebarProps) {
 const source = useDevDataSource();
	const dev = useDev()!;
	const { view, selection, select, command, pending, releaseId } = dev;
	const scope = `${selection.projectId}:${releaseId}`;
	const [preferences, setPreferences] = useState(() => readSidebarPreferences(scope));
	const [searchOpen, setSearchOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const helpReturnFocusRef = useRef<HTMLButtonElement>(null);
	const [searchScope, setSearchScope] = useState<"proposals" | "formal">("formal");
	const openSettings = useTabStore(state => state.openSettingsTab);
	const theme = useZCodeStore(state => state.theme);
	const setTheme = useZCodeStore(state => state.setTheme);
	const project = view?.projects.find(item => item.id === selection.projectId);
	const selectedRelease = view?.releases.find(item => item.id === releaseId);
	const allGroups = releaseId ? view?.groups.filter(group => group.releaseId === releaseId) ?? [] : [];
	const allDrafts = releaseId ? view?.drafts.filter(group => group.releaseId === releaseId && !group.pendingFirstMessage) ?? [] : [];
	const employeeId = getEmployeeId();
	const development = view?.repositoryDevelopment;
	const activeSrs = development?.activeSrs ?? [];
	const activeAcceptance = view?.groups.find(group => group.acceptance && group.acceptance.status !== "completed");
	const idleOwner = !activeSrs.length && !activeAcceptance ? view?.groups.find(group => development?.owners.some(owner => owner.irId === group.id && owner.projectId === group.projectId)) : undefined;
	const updatePreferences = (patch: Partial<typeof preferences>) => {
		updateSidebarPreferences(scope, patch);
		setPreferences(current => ({ ...current, ...patch }));
	};
	useEffect(() => {
        // Root 切换会话会重挂侧栏；记录查看目标，避免重挂或刷新反复打开用户刚收起的 IR。
        const target = JSON.stringify([selection.irId ?? null, selection.srId ?? null]);
        const saved = readSidebarPreferences(scope);
        if (saved.lastViewedTarget === target) return;
        const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId && item.releaseId === releaseId);
        const patch = group ? {
            lastViewedTarget: target,
            expandedIrIds: [...new Set([...saved.expandedIrIds, group.id])],
            ...(view?.drafts.some(item => item.id === group.id) ? { proposalSectionOpen: true } : { formalSectionOpen: true }),
        } : { lastViewedTarget: target };
        updateSidebarPreferences(scope, patch);
        setPreferences(current => ({ ...current, ...patch }));
    }, [selection.irId, selection.srId, scope, releaseId, view?.groups, view?.drafts]);

	const manageProjects = () => { setPendingSettingsSectionIntent("general"); openSettings(); };
	return (
		<nav data-testid="dev-workflow-root" aria-label="Dev 需求导航" className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-ui-base">
			<div className="shrink-0 space-y-3 px-2 pt-3 pb-4">
				{source.capabilities.freeChat && <Button variant="ghost" size="lg" className="w-full justify-start gap-2" disabled={pending || !project} data-testid="dev-new-free-chat" onClick={() => { dev.startFreeChat(); onNavigate?.(); }}><MessageCirclePlus className="size-4" />新建会话</Button>}
				{source.capabilities.workflowCommands.includes("createProposal") && <Button variant="ghost" size="lg" className="w-full justify-start gap-2" disabled={pending || !project || !releaseId} data-testid="new-requirement" onClick={() => { dev.startProposalDraft(); onNavigate?.(); }}><Plus className="size-4" />新建需求提案</Button>}
				{source.mode === "prototype" && onOpenAutomations && <Button variant="ghost" size="lg" className={`w-full justify-start gap-2 ${automationsActive ? "bg-selected text-foreground" : ""}`} aria-pressed={automationsActive ?? false} data-testid="dev-automations-open" onClick={onOpenAutomations}><CalendarClock className="size-4" />自动化</Button>}
			</div>
            {activeSrs.length > 0 && <section className="shrink-0 space-y-1 border-t border-border/50 px-2 py-3" aria-label="仓库正在开发">
              <div className="flex items-center justify-between px-2.5 text-ui-sm text-foreground-subtle"><span>正在开发</span><span data-testid="repository-sr-capacity">{activeSrs.length}/{development!.limit} 个 SR</span></div>
              {activeSrs.map(sr => {
                const group = view?.groups.find(item => item.id === sr.irId && item.projectId === sr.projectId);
                const owner = development?.owners.find(item => item.irId === sr.irId && item.projectId === sr.projectId);
                const release = view?.releases.find(item => item.id === group?.releaseId);
                const stage = sr.stage ? DEV_STAGE_LABELS[sr.stage] : "开发中";
                const developer = sr.developerEmployeeId === employeeId ? "我 · 可继续开发" : `${sr.developerEmployeeId ?? "开发人待确认"} · 只读查看`;
                const details = [sr.title, group?.title ?? owner?.title, stage, developer, group && group.releaseId !== releaseId ? release?.title : undefined].filter(Boolean).join(" · ");
                return <Button key={`${sr.projectId}:${sr.id}`} variant={!automationsActive && selection.srId === sr.id && selection.projectId === sr.projectId ? "secondary" : "ghost"} className="h-8 w-full min-w-0 justify-start gap-2 px-2.5 text-left font-normal" title={details} aria-label={details} data-testid="active-sr" data-active-sr-id={sr.id} aria-current={!automationsActive && selection.srId === sr.id && selection.projectId === sr.projectId ? "page" : undefined} onClick={() => {
                  select({ projectId: sr.projectId, irId: sr.irId, srId: sr.id });
                  if (group) dev.setReleaseId(group.releaseId);
                  onNavigate?.();
                }}>
                  <Badge variant="outline" className="h-4 min-w-5 shrink-0 justify-center rounded-sm border-border/70 bg-transparent px-0.5 font-mono text-ui-xs font-medium text-foreground-subtle">SR</Badge>
                  <span className="min-w-0 flex-1 truncate">{sr.title}</span>
                  <span className="shrink-0 text-ui-sm text-foreground-subtlest">{stage}</span>
                </Button>;
              })}
            </section>}
            {idleOwner && <section className="shrink-0 border-t border-border/50 px-2 py-3" aria-label="仓库当前 IR">
              <p className="px-2.5 pb-1 text-ui-sm text-foreground-subtle">正在开发 · 仓库仍占用</p>
              <Button variant="ghost" className="h-auto w-full min-w-0 justify-start gap-2 px-2.5 py-2" data-testid="active-ir-awaiting-acceptance" onClick={() => { const complete = view!.srs.filter(sr => sr.irId === idleOwner.id).every(sr => sr.status === "completed"); select({ projectId: idleOwner.projectId, irId: idleOwner.id, ...(complete ? { irAcceptance: true } : {}) }); dev.setReleaseId(idleOwner.releaseId); onNavigate?.(); }}>
                <Badge variant="outline" className="h-4 min-w-5 shrink-0 justify-center rounded-sm px-0.5 font-mono text-ui-xs">IR</Badge><span className="min-w-0 truncate">{idleOwner.title}</span>
              </Button>
            </section>}
            {activeAcceptance && <section className="shrink-0 space-y-1 border-t border-border/50 px-2 py-3" aria-label="正在开发的 IR">
              <p className="px-2.5 text-ui-sm text-foreground-subtle">正在开发</p>
              <Button variant={selection.irId === activeAcceptance.id && selection.irAcceptance ? "secondary" : "ghost"} className="h-auto w-full min-w-0 items-start justify-start gap-2 px-2.5 py-2" data-testid="active-ir-acceptance" onClick={() => { select({ projectId: activeAcceptance.projectId, irId: activeAcceptance.id, irAcceptance: true }); dev.setReleaseId(activeAcceptance.releaseId); onNavigate?.(); }}>
                <Badge variant="outline" className="mt-0.5 h-4 min-w-5 shrink-0 justify-center rounded-sm border-border/70 bg-transparent px-0.5 font-mono text-ui-xs text-foreground-subtle">IR</Badge>
                <span className="min-w-0 flex-1 text-left"><span className="block truncate">{activeAcceptance.title}</span><span className="mt-1 block truncate text-ui-sm text-foreground-subtle">{view && irAcceptanceVersionBlocker(view, activeAcceptance) ? "待重新验收" : IR_ACCEPTANCE_LABELS[activeAcceptance.acceptance!.status]} · {activeAcceptance.acceptance!.employeeId}</span></span>
              </Button>
            </section>}
			<div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto border-t border-border/50 py-3">
				{source.capabilities.freeChat && <DevFreeProjectBoundary>{projects}</DevFreeProjectBoundary>}
				<DevRequirementList open={preferences.formalSectionOpen} onOpenChange={formalSectionOpen => updatePreferences({ formalSectionOpen })} title="正式需求" groups={allGroups} expandedIrIds={preferences.expandedIrIds} onExpandedChange={expandedIrIds => updatePreferences({ expandedIrIds })} onSearch={() => { setSearchScope("formal"); setSearchOpen(true); }} onNavigate={onNavigate} automationsActive={automationsActive} />
				<DevRequirementList open={preferences.proposalSectionOpen} onOpenChange={proposalSectionOpen => updatePreferences({ proposalSectionOpen })} title="需求提案" groups={allDrafts} proposal expandedIrIds={preferences.expandedIrIds} onExpandedChange={expandedIrIds => updatePreferences({ expandedIrIds })} onSearch={() => { setSearchScope("proposals"); setSearchOpen(true); }} onNavigate={onNavigate} automationsActive={automationsActive} />
			</div>
			<DevRequirementSearch scope={searchScope} open={searchOpen} onOpenChange={setSearchOpen} query={preferences.query} onQueryChange={query => updatePreferences({ query })} onNavigate={onNavigate} />
			<WorkspaceSidebarFooter menuTriggerRef={helpReturnFocusRef} className="border-t border-border/50 px-4 pt-2 pb-3" menuContent={<DevProjectReleaseMenu onManage={manageProjects} onHelp={() => setHelpOpen(true)} />} menuDescription={<span className="flex min-w-0 flex-col text-ui-sm text-foreground-subtle" data-testid="project-release-context"><span className="truncate" title={project?.name}>{project?.name ?? "请选择项目"}</span><span className="truncate" title={selectedRelease?.title}>Release · {selectedRelease?.title ?? "尚未选择"}</span></span>} theme={theme} onThemeChange={value => { if (value === "system" || value === "zai-dark" || value === "zai-light") setTheme(value); }} onSettingsButtonClick={openSettings} />
			<DevWorkflowHelp open={helpOpen} onOpenChange={setHelpOpen} returnFocusRef={helpReturnFocusRef} />
		</nav>
	);
}

function DevFreeProjectBoundary({ children }: { children: ReactNode }) {
 const source = useDevDataSource();
 const { refresh } = useProjectDirectory();
 const dev = useDev()!;
 useEffect(() => { void refresh(); return source.freeChats?.subscribe(() => { void refresh(); }); }, [refresh, dev.view?.projects.length]);
 return <>{children}</>;
}
