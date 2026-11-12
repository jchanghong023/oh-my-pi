import { FolderGit2, Layers, Plus, UserRound, LogOut, CircleHelp } from "lucide-react";
import {
	DropdownMenuItem, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem,
	DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useAIReqIdentity } from "./AIReqEntry.js";
import { useAIReq } from "./AIReqContext.js";
import { useAIReqDataSource } from "./data-source.js";

export function AIReqProjectReleaseMenu({ onManage, onHelp }: { onManage(): void; onHelp(): void }) {
	const aireq = useAIReq()!;
	const identity = useAIReqIdentity();
	const source = useAIReqDataSource();
	const project = aireq.view?.projects.find(item => item.id === aireq.selection.projectId);
	const release = aireq.view?.releases.find(item => item.id === aireq.releaseId);
	return <>
		{identity && <><DropdownMenuItem disabled><UserRound className="size-4" />工号 {identity.employeeId}</DropdownMenuItem><DropdownMenuItem onSelect={identity.signOut}><LogOut className="size-4" />切换工号</DropdownMenuItem></>}
		<DropdownMenuItem disabled>Web 所有者 {source.backend?.owner ?? "未提供"}{source.provenance.kind === "sample" ? " · 演示" : ""}</DropdownMenuItem>
		<DropdownMenuSub>
			<DropdownMenuSubTrigger data-testid="project-select"><FolderGit2 className="size-4" /><span className="shrink-0">项目</span><span className="ml-4 max-w-40 truncate text-foreground-subtle">{project?.name ?? "请选择项目"}</span></DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="max-h-[60vh] w-72 overflow-y-auto">
				<DropdownMenuRadioGroup value={aireq.selection.projectId} onValueChange={aireq.switchProject}>
					{aireq.view?.projects.map(item => <DropdownMenuRadioItem key={item.id} value={item.id} className="min-w-0"><span className="truncate" title={item.name}>{item.name}</span></DropdownMenuRadioItem>)}
				</DropdownMenuRadioGroup>
				<DropdownMenuItem onSelect={onManage}><Plus className="size-4" />添加或管理项目</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
		<DropdownMenuSub>
			<DropdownMenuSubTrigger data-testid="release-select" disabled={!project}><Layers className="size-4" /><span className="shrink-0">Release</span><span className="ml-4 max-w-40 truncate text-foreground-subtle">{release?.title ?? (project ? "尚无 Release" : "请先选择项目")}</span></DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="max-h-[60vh] w-72 overflow-y-auto">
				<DropdownMenuRadioGroup value={aireq.releaseId} onValueChange={aireq.setReleaseId}>
					{aireq.view?.releases.map(item => <DropdownMenuRadioItem key={item.id} value={item.id}><span className="truncate" title={item.title}>{item.title}</span></DropdownMenuRadioItem>)}
				</DropdownMenuRadioGroup>
				{!aireq.view?.releases.length && <DropdownMenuItem disabled>当前项目尚无 Release</DropdownMenuItem>}
				<DropdownMenuItem onSelect={onManage}><Plus className="size-4" />添加或管理 Release</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
		<DropdownMenuSeparator />
		<DropdownMenuItem onSelect={onHelp} data-testid="aireq-workflow-help-open"><CircleHelp className="size-4" />帮助</DropdownMenuItem>
	</>;
}
