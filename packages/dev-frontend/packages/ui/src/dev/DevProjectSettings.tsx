import type { DevWorkflowView } from "./types.js";
import { useDevDataSource } from "./data-source.js";
import { useEffect, useState } from "react";
import { Folder, FolderGit2, FolderOpen, GitBranch, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Badge } from "@/components/ui/badge.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { SettingsGroupCard, SettingsBadge } from "@/settings/SettingsPageParts.js";
import { getEmployeeId } from "./identity.js";
import { useDev } from "./DevContext.js";

export function DevProjectSettings() {
 const source = useDevDataSource();
	const dev = useDev();
	const employeeId = getEmployeeId();
	const [projectOpen, setProjectOpen] = useState(false);
	const [browserOpen, setBrowserOpen] = useState(false);
	const [browsePath, setBrowsePath] = useState("");
	const [root, setRoot] = useState("");
	const [name, setName] = useState("");
	const [projectError, setProjectError] = useState("");
	const [releaseOpen, setReleaseOpen] = useState(false);
	const [releaseProjectId, setReleaseProjectId] = useState("");
	const [releaseTitle, setReleaseTitle] = useState("");
	const [releaseError, setReleaseError] = useState("");
	const [sharedProjectId, setSharedProjectId] = useState("");
  const [sharedRoot, setSharedRoot] = useState("");
  const [sharedError, setSharedError] = useState("");
	const [developmentProjectId, setDevelopmentProjectId] = useState("");
	const [developmentRoot, setDevelopmentRoot] = useState("");
	const [developmentError, setDevelopmentError] = useState("");
	const [message, setMessage] = useState("");
	const [projectViews, setProjectViews] = useState<{ project: DevWorkflowView["projects"][number]; view: DevWorkflowView }[]>([]);
	useEffect(() => {
	 let active = true;
	 Promise.all((dev?.view?.projects ?? []).map(async project => ({ project, view: await source.readWorkflow({ projectId: project.id }) }))).then(views => { if (active) setProjectViews(views); }).catch(cause => { if (active) setMessage(cause instanceof Error ? cause.message : String(cause)); });
	 return () => { active = false; };
	}, [source, dev?.view]);
	if (!dev) return null;
	const projects = dev.view?.projects ?? [];
	const releaseCount = projectViews.reduce((count, item) => count + item.view.releases.length, 0);
	const changeRoot = (value: string) => {
		setRoot(value);
		setProjectError("");
	};
	const openProject = () => {
		setRoot(""); setName(""); setProjectError(""); setBrowsePath("");
		setProjectOpen(true);
	};
	const openRelease = (projectId: string) => {
		setReleaseProjectId(projectId); setReleaseTitle(""); setReleaseError(""); setReleaseOpen(true);
	};
	return (
		<section className="space-y-6" data-testid="dev-project-settings">
			<div className="space-y-2"><SettingsBadge>{source.mode === "prototype" ? "团队共享 · 演示数据" : "OMP 项目数据"}</SettingsBadge><p className="text-ui-sm text-foreground-subtle">{source.mode === "prototype" ? "共享项目路径配置由管理员 j00808874 维护，可修改；目录内容只读，为需求和方案讨论提供代码、文档及现有规格依据。修改代码或执行 Git 时，须使用自己的 OMP Web，并配置自己的开发项目路径。" : "显示当前 OMP 服务返回的项目与 Release。浏览器工号不会切换服务账号或授权。"}</p></div>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<p className="text-ui-base text-foreground-subtle">所有人查看同一份项目与 Release。当前工号：{employeeId}。</p>
					<p className="text-ui-sm text-foreground-subtle">{projects.length} 个项目 · {releaseCount} 个 Release</p>
				</div>
				{source.projects && source.capabilities.workflowCommands.includes("registerProject") && <Button onClick={openProject}><Plus className="size-4" />添加已有项目目录</Button>}
			</div>
			{projectViews.map(({ project, view }) => (
				<SettingsGroupCard key={project.id}>
					<article data-project-id={project.id}>
						<header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4">
							<div className="min-w-0 space-y-2">
								<div className="flex flex-wrap items-center gap-2">
									<FolderGit2 className="size-4 shrink-0 text-foreground-subtle" />
									<h3 className="text-ui-base font-medium">{project.name}</h3>
									<Badge variant="outline">Git 项目</Badge>
									{dev.selection.projectId === project.id && <Badge variant="secondary">当前项目</Badge>}
								</div>
								<div className="space-y-1"><p className="text-ui-sm text-foreground-subtle">共享项目路径 · 目录内容只读</p><div className="flex flex-wrap items-center gap-2"><Input aria-label={`${project.name}共享项目路径`} value={project.root} readOnly className="min-w-0 flex-1 font-mono text-ui-sm" /><Button variant="outline" disabled={!source.capabilities.workflowCommands.includes("setSharedProjectRoot")} onClick={() => { setSharedProjectId(project.id); setSharedRoot(project.root); setSharedError(""); }} aria-label={`修改${project.name}共享项目路径`}>修改共享项目路径</Button></div><p className="text-ui-sm text-foreground-subtle">仅管理员 j00808874 可修改路径配置，其他账号只读。</p></div>
								<div className="flex items-center gap-3 text-ui-sm text-foreground-subtle">
									<span className="inline-flex items-center gap-1"><GitBranch className="size-3.5" />{project.defaultBranch}</span>
									<span>{view.releases.length} 个 Release · 团队共享</span>
								</div>
							</div>
							<Button variant="outline" disabled={!source.capabilities.workflowCommands.includes("createRelease")} onClick={() => openRelease(project.id)} aria-label={`为${project.name}添加 Release`}><Plus className="size-3.5" />添加 Release</Button>
						</header>
						<div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
							<div className="min-w-0 space-y-1">
								<p className="text-ui-base font-medium">我的开发项目 <span className="text-ui-sm font-normal text-foreground-subtle">工号 {employeeId}</span></p>
								<p className="break-all font-mono text-ui-sm text-foreground-subtle" data-testid={`development-root-${project.id}`}>{source.projects?.readDevelopmentRoot(project.id) ?? "尚未配置 · 仅浏览；改代码须使用自己的 Web 并配置 Git 开发路径"}</p>
							</div>
							{source.projects && source.capabilities.workflowCommands.includes("setDevelopmentRoot") && <Button variant="outline" onClick={() => { setDevelopmentProjectId(project.id); setDevelopmentRoot(source.projects?.readDevelopmentRoot(project.id) ?? ""); setDevelopmentError(""); }} aria-label={`配置${project.name}的开发项目`}>{source.projects?.readDevelopmentRoot(project.id) ? "修改开发项目" : "添加开发项目"}</Button>}
						</div>
						{view.releases.length ? (
							<ul className="divide-y divide-border">
								{view.releases.map(release => {
									const groups = view.groups.filter(group => group.releaseId === release.id);
									const draftCount = view.drafts.filter(group => group.releaseId === release.id).length;
									const srCount = groups.reduce((count, group) => count + group.srIds.length, 0);
									return (
										<li key={release.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
											<div className="min-w-0 space-y-1">
												<p className="break-words text-ui-base font-medium">{release.title}</p>
												<p className="text-ui-sm text-foreground-subtle">{groups.length} 个 IR · {srCount} 个 SR{draftCount > 0 && ` · ${draftCount} 个草稿`}</p>
											</div>
											<Badge variant="outline">{groups.length ? "已有需求" : "待规划"}</Badge>
										</li>
									);
								})}
							</ul>
						) : (
							<div className="space-y-2 px-4 py-6 text-ui-base text-foreground-subtle">
								<p>尚未添加 Release。创建第一个 Release，开始整理本项目的需求。</p>
								<Button variant="outline" disabled={!source.capabilities.workflowCommands.includes("createRelease")} onClick={() => openRelease(project.id)}>添加第一个 Release</Button>
							</div>
						)}
					</article>
				</SettingsGroupCard>
			))}
			{!projects.length && <p className="text-ui-base text-foreground-subtle">还没有项目。添加已有 Git 项目目录后，即可创建 Release。</p>}
			<p role="status" className="text-ui-base text-foreground-subtle">{message}</p>
			{source.mode === "prototype" && <p className="text-ui-sm leading-6 text-foreground-subtle">原型演示：共享项目、Release、按工号关联的开发目录及校验均为内存样例；不连接真实数据库或文件系统，不执行 Git，刷新后恢复。</p>}

			<Dialog open={projectOpen} onOpenChange={setProjectOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>添加已有项目目录</DialogTitle>
						<DialogDescription>选择或输入服务端已有 Git 项目目录，登记后所有人可见；目录内容只读，路径配置后续由管理员维护。</DialogDescription>
					</DialogHeader>
					<form className="space-y-4" onSubmit={async event => {
						event.preventDefault();
						const check = await source.projects!.checkProjectDirectory(root, projects.map(project => project.root));
						if (!check.valid) { setProjectError(check.error); return; }
						const projectName = name.trim() || check.directory.name;
						const result = await dev.command({ type: "registerProject", registrationScope: "target-root", root: check.root, name: projectName });
						if (result?.status === "completed") { setProjectOpen(false); setMessage(`已添加项目“${projectName}”。可在该项目下添加 Release。`); }
						else setProjectError("未能添加项目，请检查目录后重试。");
					}}>
						<div className="space-y-2">
							<Label htmlFor="project-directory">项目目录</Label>
							<div className="flex flex-wrap gap-2">
								<Input id="project-directory" className="min-w-0 flex-1 basis-48" placeholder="输入项目根目录" value={root} onChange={event => changeRoot(event.target.value)} aria-invalid={Boolean(projectError)} aria-describedby={projectError ? "project-directory-help project-directory-error" : "project-directory-help"} required />
								<Button type="button" variant="outline" onClick={() => { setBrowsePath(root); setBrowserOpen(true); }}><FolderOpen className="size-4" />浏览目录</Button>
							</div>
							<p id="project-directory-help" className="text-ui-sm text-foreground-subtle">可输入路径或浏览目录。点击“添加项目”时自动检查目录是否为有效 Git 项目。</p>
							{projectError && <p id="project-directory-error" role="alert" className="text-ui-base text-destructive">{projectError}</p>}
						</div>
						<div className="space-y-2">
							<Label htmlFor="project-name">项目名称（选填）</Label>
							<Input id="project-name" value={name} onChange={event => setName(event.target.value)} placeholder="留空时使用目录名称" />
						</div>
						<DialogFooter>
							<Button type="button" variant="outline" onClick={() => setProjectOpen(false)}>取消</Button>
							<Button type="submit" disabled={!root.trim() || dev.pending}>添加项目</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

      <Dialog open={Boolean(sharedProjectId)} onOpenChange={open => { if (!open) setSharedProjectId(""); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>修改共享项目路径</DialogTitle><DialogDescription>{projects.find(item => item.id === sharedProjectId)?.name} · 仅管理员 j00808874 可配置。新目录用于需求和方案讨论的只读依据，不会修改代码、执行 Git、移动已有提案或更改个人开发项目。</DialogDescription></DialogHeader>
          <form className="space-y-4" onSubmit={async event => {
            event.preventDefault();
            if (employeeId !== "j00808874") { setSharedError("只有管理员 j00808874 可修改共享项目路径。"); return; }
            const check = await source.projects!.checkSharedProjectDirectory(sharedRoot, sharedProjectId);
            if (!check.valid) { setSharedError(check.error); return; }
            const result = await dev.command({ type: "setSharedProjectRoot", projectId: sharedProjectId, root: check.root });
            if (result?.status === "completed") { setSharedProjectId(""); setMessage("已更新共享项目路径配置；目录内容仍只读，项目与 Release 关联保留。"); }
          }}>
            <div className="space-y-2"><Label htmlFor="shared-project-directory">共享项目目录</Label><div className="flex gap-2"><Input id="shared-project-directory" value={sharedRoot} onChange={event => { setSharedRoot(event.target.value); setSharedError(""); }} required aria-invalid={Boolean(sharedError)} /><Button type="button" variant="outline" onClick={() => { setBrowsePath(sharedRoot); setBrowserOpen(true); }}><FolderOpen className="size-4" />浏览目录</Button></div><p className="text-ui-sm text-foreground-subtle">支持输入或浏览已有 Git 目录；保存前检查是否对应当前项目的同一仓库。</p></div>
            {sharedError && <p role="alert" className="text-ui-base text-destructive">{sharedError}</p>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => setSharedProjectId("")}>取消</Button><Button type="submit" disabled={employeeId !== "j00808874" || !sharedRoot.trim() || sharedRoot.trim() === projects.find(item => item.id === sharedProjectId)?.root || dev.pending}>保存共享项目路径</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

			<Dialog open={Boolean(developmentProjectId)} onOpenChange={open => { if (!open) setDevelopmentProjectId(""); }}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader><DialogTitle>配置我的开发项目</DialogTitle><DialogDescription>{projects.find(project => project.id === developmentProjectId)?.name} · 工号 {employeeId}。路径位于运行 OMP 的服务器，需与共享项目对应同一 Git 仓库；不会修改共享项目路径。</DialogDescription></DialogHeader>
					<form className="space-y-4" onSubmit={async event => {
						event.preventDefault();
						const project = projects.find(item => item.id === developmentProjectId);
						if (!project) return;
						const check = await source.projects!.checkDevelopmentDirectory(developmentRoot, project.root);
						if (!check.valid) { setDevelopmentError(check.error); return; }
						const result = await dev.command({ type: "setDevelopmentRoot", projectId: project.id, root: check.root });
						if (result?.status === "completed") { setDevelopmentProjectId(""); setMessage(`已保存“${project.name}”的个人开发项目。共享路径保持只读。`); }
					}}>
						<div className="space-y-2"><Label htmlFor="development-directory">开发项目目录</Label><div className="flex gap-2"><Input id="development-directory" value={developmentRoot} onChange={event => { setDevelopmentRoot(event.target.value); setDevelopmentError(""); }} placeholder="例如 /demo/j00808874/mobile-console" required aria-invalid={Boolean(developmentError)} aria-describedby="development-directory-help" /><Button type="button" variant="outline" onClick={() => { setBrowsePath(developmentRoot); setBrowserOpen(true); }}><FolderOpen className="size-4" />浏览目录</Button></div><p id="development-directory-help" className="text-ui-sm text-foreground-subtle">保存时检查 Git 仓库及所属项目。个人路径只用于当前工号在该项目中的开发。</p></div>
						{developmentError && <p role="alert" className="text-ui-base text-destructive">{developmentError}</p>}
						<DialogFooter><Button type="button" variant="outline" onClick={() => setDevelopmentProjectId("")}>取消</Button><Button type="submit" disabled={!developmentRoot.trim() || dev.pending}>保存开发项目</Button></DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader><DialogTitle>选择项目目录</DialogTitle><DialogDescription>演示服务端文件浏览器 · /demo。请选择 Git 项目根目录，不需要选择 .git 子目录。</DialogDescription></DialogHeader>
					<div className="max-h-[45vh] overflow-y-auto rounded-xl border border-border">
						{source.projects?.listDirectories().filter(directory => developmentProjectId || sharedProjectId || !directory.repositoryRoot).map(directory => {
							const added = projects.some(project => project.id !== sharedProjectId && project.root === directory.path);
							return <Button key={directory.path} type="button" variant={browsePath === directory.path ? "secondary" : "ghost"} className="h-auto w-full justify-start gap-3 rounded-none px-3 py-3 text-left" disabled={added} onClick={() => setBrowsePath(directory.path)} aria-pressed={browsePath === directory.path}>
								{directory.git ? <FolderGit2 className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
								<span className="min-w-0 flex-1"><span className="block truncate">{directory.name}</span><span className="block truncate text-ui-sm text-foreground-subtle">{directory.path}</span></span>
								<Badge variant="outline">{added ? "已添加" : directory.git ? "Git 项目" : "普通目录"}</Badge>
							</Button>;
						})}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setBrowserOpen(false)}>取消</Button>
						<Button disabled={!browsePath || projects.some(project => project.id !== sharedProjectId && project.root === browsePath)} onClick={() => { if (sharedProjectId) { setSharedRoot(browsePath); setSharedError(""); } else if (developmentProjectId) { setDevelopmentRoot(browsePath); setDevelopmentError(""); } else changeRoot(browsePath); setBrowserOpen(false); }}>选择此目录</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={releaseOpen} onOpenChange={setReleaseOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader><DialogTitle>添加 Release</DialogTitle><DialogDescription>Release 属于所选共享项目，添加后所有人可见，保存在共享数据库。</DialogDescription></DialogHeader>
					<form className="space-y-4" onSubmit={async event => {
						event.preventDefault();
						if ((await source.readWorkflow({ projectId: releaseProjectId })).releases.some(release => release.title.toLowerCase() === releaseTitle.trim().toLowerCase())) { setReleaseError("此项目中已存在同名 Release，请使用其他名称。"); return; }
						const result = await dev.command({ type: "createRelease", projectId: releaseProjectId, title: releaseTitle });
						if (result?.status === "completed") { setReleaseOpen(false); setMessage(`已为“${projects.find(project => project.id === releaseProjectId)?.name}”添加 Release“${releaseTitle.trim()}”。`); }
						else setReleaseError("未能添加 Release，请检查名称和所属项目。");
					}}>
						<div className="space-y-2">
							<Label htmlFor="release-project">所属项目</Label>
							<Select value={releaseProjectId} onValueChange={value => { setReleaseProjectId(value); setReleaseError(""); }}>
								<SelectTrigger id="release-project" size="lg" className="w-full"><SelectValue /></SelectTrigger>
								<SelectContent>{projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="release-name">Release 名称</Label>
							<Input id="release-name" placeholder="例如：2027.01 · 支付体验优化" value={releaseTitle} onChange={event => { setReleaseTitle(event.target.value); setReleaseError(""); }} required />
						</div>
						{releaseError && <p role="alert" className="text-ui-base text-destructive">{releaseError}</p>}
						<DialogFooter><Button type="button" variant="outline" onClick={() => setReleaseOpen(false)}>取消</Button><Button type="submit" disabled={!releaseTitle.trim() || !releaseProjectId || dev.pending}>添加 Release</Button></DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</section>
	);
}
