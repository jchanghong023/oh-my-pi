import { useState } from "react";
import { Folder, FolderGit2, FolderOpen, GitBranch, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Badge } from "@/components/ui/badge.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { DevPersonalConfigScope } from "./DevPersonalConfigScope.js";
import { useDev } from "./DevContext.js";
import { getPrototypeWorkflow } from "./mock/workflow.js";
import { PROTOTYPE_PROJECT_DIRECTORIES, checkPrototypeProjectDirectory } from "./mock/project-directories.js";

export function DevProjectSettings() {
	const dev = useDev();
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
	const [message, setMessage] = useState("");
	if (!dev) return null;
	const projects = dev.view?.projects ?? [];
	const projectViews = projects.map(project => ({ project, view: getPrototypeWorkflow({ projectId: project.id }) }));
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
			<DevPersonalConfigScope scopeLabel="项目清单 · 个人配置" />
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<p className="text-ui-base text-foreground-subtle">Dev 管理的项目清单保存在 OMP 个人配置目录；各项目的 Release 清单保存在各自 Git 仓库。</p>
					<p className="text-ui-sm text-foreground-subtle">{projects.length} 个项目 · {releaseCount} 个 Release</p>
				</div>
				<Button onClick={openProject}><Plus className="size-4" />添加已有项目目录</Button>
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
								<p className="break-all font-mono text-ui-sm text-foreground-subtle">{project.root}</p>
								<div className="flex items-center gap-3 text-ui-sm text-foreground-subtle">
									<span className="inline-flex items-center gap-1"><GitBranch className="size-3.5" />{project.defaultBranch}</span>
									<span>{view.releases.length} 个 Release · 项目 Git 管理</span>
								</div>
							</div>
							<Button variant="outline" onClick={() => openRelease(project.id)} aria-label={`为${project.name}添加 Release`}><Plus className="size-3.5" />添加 Release</Button>
						</header>
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
								<Button variant="outline" onClick={() => openRelease(project.id)}>添加第一个 Release</Button>
							</div>
						)}
					</article>
				</SettingsGroupCard>
			))}
			{!projects.length && <p className="text-ui-base text-foreground-subtle">还没有项目。添加已有 Git 项目目录后，即可创建 Release。</p>}
			<p role="status" className="text-ui-base text-foreground-subtle">{message}</p>
			<p className="text-ui-sm leading-6 text-foreground-subtle">原型演示：个人项目清单、各项目 Git 中的 Release 清单、目录浏览及校验均为内存样例；不访问真实 OMP 配置或项目文件，不执行 Git 提交，刷新后恢复。</p>

			<Dialog open={projectOpen} onOpenChange={setProjectOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>添加已有项目目录</DialogTitle>
						<DialogDescription>选择或输入已有 Git 项目的根目录。</DialogDescription>
					</DialogHeader>
					<form className="space-y-4" onSubmit={async event => {
						event.preventDefault();
						const check = checkPrototypeProjectDirectory(root, projects.map(project => project.root));
						if (!check.valid) { setProjectError(check.error); return; }
						const projectName = name.trim() || check.directory.name;
						const result = await dev.command({ type: "registerProject", registrationScope: "target-root", root: check.root, name: projectName });
						if (result?.status === "completed") { setProjectOpen(false); setMessage(`已添加项目“${projectName}”。可在该项目下添加 Release。`); }
						else setProjectError("未能添加项目，请检查目录后重试。");
					}}>
						<div className="space-y-2">
							<Label htmlFor="project-directory">项目目录</Label>
							<div className="flex flex-wrap gap-2">
								<Input id="project-directory" className="min-w-0 flex-1 basis-48" placeholder="输入项目根目录，如 /demo/payment-service" value={root} onChange={event => changeRoot(event.target.value)} aria-invalid={Boolean(projectError)} aria-describedby={projectError ? "project-directory-help project-directory-error" : "project-directory-help"} required />
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

			<Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader><DialogTitle>选择项目目录</DialogTitle><DialogDescription>演示文件浏览器 · /demo。请选择项目根目录，不需要选择 .git 子目录。</DialogDescription></DialogHeader>
					<div className="max-h-[45vh] overflow-y-auto rounded-xl border border-border">
						{PROTOTYPE_PROJECT_DIRECTORIES.map(directory => {
							const added = projects.some(project => project.root === directory.path);
							return <Button key={directory.path} type="button" variant={browsePath === directory.path ? "secondary" : "ghost"} className="h-auto w-full justify-start gap-3 rounded-none px-3 py-3 text-left" disabled={added} onClick={() => setBrowsePath(directory.path)} aria-pressed={browsePath === directory.path}>
								{directory.git ? <FolderGit2 className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
								<span className="min-w-0 flex-1"><span className="block truncate">{directory.name}</span><span className="block truncate text-ui-sm text-foreground-subtle">{directory.path}</span></span>
								<Badge variant="outline">{added ? "已添加" : directory.git ? "Git 项目" : "普通目录"}</Badge>
							</Button>;
						})}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setBrowserOpen(false)}>取消</Button>
						<Button disabled={!browsePath || projects.some(project => project.root === browsePath)} onClick={() => { changeRoot(browsePath); setBrowserOpen(false); }}>选择此目录</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={releaseOpen} onOpenChange={setReleaseOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader><DialogTitle>添加 Release</DialogTitle><DialogDescription>Release 属于所选项目，用于组织需求与交付，随该项目 Git 仓库管理。</DialogDescription></DialogHeader>
					<form className="space-y-4" onSubmit={async event => {
						event.preventDefault();
						if (getPrototypeWorkflow({ projectId: releaseProjectId }).releases.some(release => release.title.toLowerCase() === releaseTitle.trim().toLowerCase())) { setReleaseError("此项目中已存在同名 Release，请使用其他名称。"); return; }
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
