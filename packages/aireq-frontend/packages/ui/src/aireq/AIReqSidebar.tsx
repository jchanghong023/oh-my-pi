import { WorkspaceSidebarToolbar } from "@/WorkspaceSidebarToolbar.js";
import type { WorkspaceSidebarToolbarProps } from "@/WorkspaceSidebarToolbar.js";
import { useAIReqDataSource } from "./data-source.js";
import { AIReqWorkflowHelp } from "./AIReqWorkflowHelp.js";
import { useRef, useState } from "react";
import { CalendarClock, MessageCirclePlus, TableProperties, WandSparkles, FileSearch, CirclePlus, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DefaultAvatar } from "@/components/DefaultAvatar.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useAIReq } from "./AIReqContext.js";
import { readSidebarPreferences, updateSidebarPreferences } from "./navigation.js";
import { AIReqProjectReleaseMenu } from "./AIReqProjectReleaseMenu.js";
import { AIReqRequirementSearch } from "./AIReqRequirementSearch.js";
import { AIReqRequirementList } from "./AIReqRequirementList.js";

interface AIReqSidebarProps { onOpenIssue?: (page: "issueCreate" | "issueAnalysis" | "issueProgress") => void; issuePage?: string; onNavigate?: () => void; onOpenAutomations?: () => void; automationsActive?: boolean; onOpenSkillDesign?: () => void; skillDesignActive?: boolean; onOpenRequirementAnalysis?: () => void; requirementAnalysisActive?: boolean; toolbar: WorkspaceSidebarToolbarProps }

export function AIReqSidebar(props: AIReqSidebarProps) {
	const aireq = useAIReq()!;
	const source = useAIReqDataSource();
	return <AIReqSidebarContent key={`${source.backend?.id ?? source.clientId}:${aireq.selection.projectId}:${aireq.releaseId}`} {...props} />;
}

function AIReqSidebarContent({ onOpenIssue, issuePage, onNavigate, onOpenAutomations, automationsActive, onOpenSkillDesign, skillDesignActive, onOpenRequirementAnalysis, requirementAnalysisActive, toolbar }: AIReqSidebarProps) {
 const source = useAIReqDataSource();
	const aireq = useAIReq()!;
	const { view, selection, select, pending, releaseId } = aireq;
	const scope = `${source.backend?.id ?? source.clientId}:${selection.projectId}:${releaseId}`;
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
	const updatePreferences = (patch: Partial<typeof preferences>) => {
		updateSidebarPreferences(scope, patch);
		setPreferences(current => ({ ...current, ...patch }));
	};


	const manageProjects = () => { setPendingSettingsSectionIntent("general"); openSettings(); };
	return (
		<nav data-testid="aireq-workflow-root" aria-label="AIReq 工作台导航" className="flex h-full min-h-0 flex-col overflow-hidden text-ui-base">
			<WorkspaceSidebarToolbar {...toolbar} />
			<div className="flex shrink-0 flex-col gap-1 px-2 py-3">
				{source.capabilities.workflowCommands.includes("createProposal") && <Button variant="ghost" size="lg" className="w-full justify-start gap-2 text-ui-base font-normal" disabled={pending || !project || !releaseId} data-testid="new-requirement" onClick={() => { aireq.startProposalDraft(); onNavigate?.(); }}><MessageCirclePlus aria-hidden="true" className="size-4" /><span>新建需求提案</span></Button>}
				{onOpenAutomations && <Button variant="ghost" size="lg" className={`w-full justify-start gap-2 ${automationsActive ? "bg-selected text-foreground" : ""}`} aria-pressed={automationsActive ?? false} data-testid="aireq-automations-open" onClick={onOpenAutomations}><CalendarClock className="size-4" />自动化</Button>}
				{onOpenSkillDesign && <Button variant="ghost" size="lg" className={`w-full justify-start gap-2 ${skillDesignActive ? "bg-selected text-foreground" : ""}`} aria-pressed={skillDesignActive ?? false} data-testid="aireq-skill-design-open" onClick={onOpenSkillDesign}><WandSparkles className="size-4" />Skill 设计</Button>}
				{onOpenRequirementAnalysis && <Button variant="ghost" size="lg" className={`w-full justify-start gap-2 ${requirementAnalysisActive ? "bg-selected text-foreground" : ""}`} aria-pressed={requirementAnalysisActive ?? false} data-testid="aireq-requirement-analysis-open" onClick={onOpenRequirementAnalysis}><FileSearch className="size-4" />需求分析</Button>}
				<Button variant="ghost" size="lg" className={`w-full justify-start gap-2 ${!issuePage && !automationsActive && !skillDesignActive && !requirementAnalysisActive && (selection.formalView || allGroups.some(group => group.id === selection.irId)) ? "bg-selected text-foreground" : ""}`} aria-pressed={!issuePage && !automationsActive && !skillDesignActive && !requirementAnalysisActive && Boolean(selection.formalView || allGroups.some(group => group.id === selection.irId))} data-testid="aireq-formal-open" disabled={!project} onClick={() => { select({ projectId: selection.projectId, formalView: "list" }); onNavigate?.(); }}><TableProperties className="size-4" />正式需求</Button>
        {onOpenIssue && ([{ page: "issueCreate", label: "新建 Issue", icon: CirclePlus }, { page: "issueAnalysis", label: "Issue 分析", icon: FileSearch }, { page: "issueProgress", label: "Issue 进度", icon: ListChecks }] as const).map(({ page, label, icon: Icon }) => <Button key={page} variant="ghost" size="lg" className={`w-full justify-start gap-2 ${issuePage === page ? "bg-selected text-foreground" : ""}`} aria-pressed={issuePage === page} disabled={!project || !releaseId} onClick={() => onOpenIssue(page)}><Icon aria-hidden="true" className="size-4" />{label}</Button>)}
			</div>
			<div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto border-t border-border/50 py-3">
				<AIReqRequirementList open={preferences.proposalSectionOpen} onOpenChange={proposalSectionOpen => updatePreferences({ proposalSectionOpen })} title="需求提案" groups={allDrafts} onSearch={() => { setSearchScope("proposals"); setSearchOpen(true); }} onNavigate={onNavigate} automationsActive={Boolean(issuePage) || automationsActive || skillDesignActive || requirementAnalysisActive} />
			</div>
			<AIReqRequirementSearch scope={searchScope} open={searchOpen} onOpenChange={setSearchOpen} query={preferences.query} onQueryChange={query => updatePreferences({ query })} onNavigate={onNavigate} />
			<WorkspaceSidebarFooter menuTriggerRef={helpReturnFocusRef} className="px-4 pt-2 pb-4" menuContent={<AIReqProjectReleaseMenu onManage={manageProjects} onHelp={() => setHelpOpen(true)} />} menuIcon={<DefaultAvatar />} menuDescription={<span className="flex min-w-0 flex-col text-left" data-testid="project-release-context"><span className="truncate text-ui-base font-semibold text-foreground" title={project?.name}>{project?.name ?? "请选择项目"}</span><span className="truncate text-ui-xs font-normal text-foreground-subtle" title={selectedRelease?.title}>Release · {selectedRelease?.title ?? "尚未选择"}</span></span>} theme={theme} onThemeChange={value => { if (value === "system" || value === "zai-dark" || value === "zai-light") setTheme(value); }} onSettingsButtonClick={openSettings} />
			<AIReqWorkflowHelp open={helpOpen} onOpenChange={setHelpOpen} returnFocusRef={helpReturnFocusRef} />
		</nav>
	);
}
