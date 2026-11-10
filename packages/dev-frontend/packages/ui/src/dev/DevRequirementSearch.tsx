import { Command as CommandPrimitive } from "cmdk";
import { FileText, MessageSquare, Search } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command.js";
import { quickPickCommandClassName, quickPickDialogClassName, quickPickItemClassName, quickPickMetadataClassName } from "@/quickpick/quickPickStyles.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import { PROPOSAL_STATUS_LABELS } from "./domain.js";
import { useDev, DEV_STAGE_LABELS } from "./DevContext.js";

/** 与 WebGUI 命令中心共用弹层、输入、键盘选择及动效，仅替换需求数据。 */
export function DevRequirementSearch({ open, onOpenChange, query, onQueryChange, onNavigate, scope }: {
	scope: "proposals" | "formal";
	open: boolean;
	onOpenChange(open: boolean): void;
	query: string;
	onQueryChange(query: string): void;
	onNavigate?: () => void;
}) {
	const dev = useDev()!;
	const groups = (scope === "proposals" ? dev.view?.drafts ?? [] : dev.view?.groups ?? []).filter(group => group.releaseId === dev.releaseId);
	const normalized = query.trim().toLocaleLowerCase();
	const choose = (irId: string, srId?: string) => {
		dev.select({ projectId: dev.selection.projectId, irId, srId });
		onOpenChange(false);
		onNavigate?.();
	};
	return <CommandDialog open={open} onOpenChange={onOpenChange} title={scope === "proposals" ? "搜索需求提案" : "搜索正式需求"} description="搜索当前列表的 IR 和 SR，选择后查看已有内容。" className={`${quickPickDialogClassName} top-16 max-h-[calc(100dvh-4.5rem)] -translate-y-0 sm:top-20 sm:max-h-[calc(100dvh-6rem)] platform-linux-desktop:top-16 sm:platform-linux-desktop:top-20`}>
		<Command shouldFilter={false} loop className={quickPickCommandClassName}>
			<div className="border-b border-border px-2 pt-2 pb-2"><div className="flex h-8 items-center gap-2 rounded-full border border-input-border bg-input px-2.5 transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
				<Search className="size-4 shrink-0 text-foreground-subtlest" />
				<CommandPrimitive.Input aria-label="搜索需求标题" value={query} onValueChange={onQueryChange} placeholder="搜索 IR 或 SR…" className="min-w-0 flex-1 bg-transparent text-ui-base leading-5 text-foreground outline-none placeholder:text-foreground-subtlest" />
			</div></div>
			<CommandList className="max-h-[min(440px,calc(100dvh-15rem))] py-0.5">
				<CommandEmpty>没有匹配的需求。</CommandEmpty>
				{groups.map(group => {
					const matchesGroup = !normalized || group.title.toLocaleLowerCase().includes(normalized);
					const srs = dev.view?.srs.filter(sr => sr.irId === group.id && (matchesGroup || sr.title.toLocaleLowerCase().includes(normalized))) ?? [];
					if (!matchesGroup && !srs.length) return null;
					return <CommandGroup key={group.id} heading={group.title}>
						{matchesGroup && <CommandItem value={`ir:${group.id}`} className={quickPickItemClassName} onSelect={() => choose(group.id)}><FileText className="size-3.5 shrink-0 text-foreground-subtle" /><span className="min-w-0 flex-1 truncate"><HighlightedMatchText text={group.title} query={query} /></span><CommandShortcut className={quickPickMetadataClassName}>需求讨论</CommandShortcut></CommandItem>}
						{srs.map(sr => <CommandItem key={sr.id} value={`sr:${sr.id}`} className={quickPickItemClassName} onSelect={() => choose(group.id, sr.id)}><MessageSquare className="size-3.5 shrink-0 text-foreground-subtle" /><span className="min-w-0 flex-1 truncate"><HighlightedMatchText text={sr.title} query={query} /></span><CommandShortcut className={quickPickMetadataClassName}>{scope === "proposals" ? `${PROPOSAL_STATUS_LABELS[group.status]} · ${group.proposalStage === "solution" ? "方案" : "业务需求"}` : sr.status === "completed" ? "已完成" : sr.stage ? DEV_STAGE_LABELS[sr.stage] : "待开始"}</CommandShortcut></CommandItem>)}
					</CommandGroup>;
				})}
			</CommandList>
		</Command>
	</CommandDialog>;
}
