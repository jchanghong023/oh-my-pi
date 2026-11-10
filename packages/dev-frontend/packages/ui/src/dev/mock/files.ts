import { prototypeProjectDirectories } from "./project-directories.js";
import { readPrototypeDevelopmentRoot, readPrototypeProjectSettings } from "./project-settings.js";
import type { IServiceAccessor } from "@zcode/services";
import type { GitFileChange, GitRepositorySummary, WorkspaceFileEntry } from "@zcode/shared";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import { createPrototypeEvent } from "./events.js";
import type { FileWatchEvent } from "@zcode/shared";
import { unavailablePrototypeOperation } from "./events.js";

export const PROTOTYPE_FILE_CONTENTS: Readonly<Record<string, string>> = {
  "README.md": "# Aurora Console（阶段性前端原型样例）\n\n企业工作台的需求、方案与任务协作示例。\n此目录为内存文件树，不对应磁盘，也不是执行结果。\n",
  "package.json": '{\n  "name": "aurora-console-demo",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n',
  "src/auth/session.ts": 'export interface Session {\n  userId: string;\n  expiresAt: number;\n}\n\nexport function isSessionValid(session: Session, now: number): boolean {\n  return session.expiresAt > now;\n}\n',
  "src/auth/LoginForm.tsx": 'export function LoginForm() {\n  return (\n    <form aria-label="企业账号登录">\n      <label>企业邮箱<input type="email" autoComplete="username" /></label>\n      <button type="submit">继续</button>\n    </form>\n  );\n}\n',
  "src/dashboard/Overview.tsx": 'export function Overview() {\n  return <section aria-label="项目概览">\n    <h1>Aurora 项目概览</h1>\n    <p>发布 release-2026-11 · 样例数据</p>\n  </section>;\n}\n',
  "src/styles/tokens.css": ':root {\n  --surface: #10151f;\n  --accent: #7c9cff;\n  --radius: 8px;\n}\n',
  "docs/requirements.md": '# 登录与会话管理 · 样例需求\n\n- 企业邮箱登录与单点登录入口\n- 清晰展示过期状态及错误原因\n- 支持键盘导航与可访问标签\n\n验收点是演示材料，不表示已执行真实测试。\n',
  "docs/solution.md": '# 样例方案\n\n将展示组件、会话状态和认证适配层分离。\n第一阶段只评审交互；用户确认后进入真实 OMP 对接阶段。\n',
  "docs/acceptance.md": '# 待真实验证的验收清单\n\n- [ ] 对接真实认证环境\n- [ ] 执行自动化与人工验收\n- [ ] 安全与权限审查\n',
};
export const PROTOTYPE_REVIEW_BEFORE = 'export interface Session {\n  userId: string;\n}\n\nexport function isSessionValid(session: Session): boolean {\n  return Boolean(session.userId);\n}\n';
export const PROTOTYPE_REVIEW_PATCH = 'diff --git a/src/auth/session.ts b/src/auth/session.ts\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1,7 +1,8 @@\n export interface Session {\n   userId: string;\n+  expiresAt: number;\n }\n \n-export function isSessionValid(session: Session): boolean {\n-  return Boolean(session.userId);\n+export function isSessionValid(session: Session, now: number): boolean {\n+  return session.expiresAt > now;\n }\n';

export function prototypeConversationFileChanges(root: string): V4ConversationFileChangesResult {
  return { files: 1, additions: 3, deletions: 2, state: "active", items: [{
    path: `${root}/src/auth/session.ts`, additions: 3, deletions: 2, writeCount: 1,
    toolNames: ["阶段性原型样例"], patches: [{ oldStart: 1, oldLines: 7, newStart: 1, newLines: 8,
      lines: [' export interface Session {', '   userId: string;', '+  expiresAt: number;', ' }', ' ', '-export function isSessionValid(session: Session): boolean {', '-  return Boolean(session.userId);', '+export function isSessionValid(session: Session, now: number): boolean {', '+  return session.expiresAt > now;', ' }'],
    }],
  }] };
}

function rootFor(path: string): string {
  // 自由会话可使用已绑定的个人目录，文件样例按实际会话根解析。
  const roots = [...prototypeProjectDirectories().map(item => item.path), ...readPrototypeProjectSettings().projects.flatMap(item => [item.root, readPrototypeDevelopmentRoot(item.id)].filter((root): root is string => Boolean(root)))];
  return roots.sort((a, b) => b.length - a.length).find(root => path === root || path.startsWith(`${root}/`)) ?? "/demo/aurora-console";
}
function relative(path: string): string { return path.slice(rootFor(path).length).replace(/^\//, ""); }
const encoder = new TextEncoder();
function base64(bytes: Uint8Array): string { return btoa(Array.from(bytes, value => String.fromCharCode(value)).join("")); }

export function createPrototypeFileServices(): Pick<IServiceAccessor, "fileService" | "gitService" | "gitCheckpointService" | "fileWatcherService"> {
  const files = new Map(Object.entries(PROTOTYPE_FILE_CONTENTS));
  const staged = new Set<string>();
  const changes = createPrototypeEvent<FileWatchEvent>();
  let branch = "demo/ir-auth";
  let ignore = "node_modules/\ndist/\n.env\n";
  const text = (path: string): string => {
    const content = files.get(relative(path));
    if (content === undefined) throw new Error(`样例文件不存在：${path}`);
    return content;
  };
  const entries = (root: string): WorkspaceFileEntry[] => {
    const directories = new Set<string>();
    for (const path of files.keys()) {
      const pieces = path.split("/");
      for (let i = 1; i < pieces.length; i++) directories.add(pieces.slice(0, i).join("/"));
    }
    return [...Array.from(directories, path => ({ name: path.split("/").at(-1)!, path: `${root}/${path}`, relativePath: path, type: "directory" as const })),
      ...Array.from(files.keys(), path => ({ name: path.split("/").at(-1)!, path: `${root}/${path}`, relativePath: path, type: "file" as const }))];
  };
  const summary = (root: string): GitRepositorySummary => ({ workspacePath: root, repoRoot: root, workspaceInRepoPath: "", autoRefreshWatchPaths: [], branchName: branch, trackingBranchName: null, headRefType: "branch", ahead: 0, behind: 0, isDirty: files.has("src/auth/session.ts"), isGitAvailable: true, isRepository: true });
  const changeList = (root: string): GitFileChange[] => files.has("src/auth/session.ts") ? [{ path: `${root}/src/auth/session.ts`, repoRelativePath: "src/auth/session.ts", workspaceRelativePath: "src/auth/session.ts", kind: "modified", section: staged.has("src/auth/session.ts") ? "staged" : "unstaged", added: 3, removed: 2, isStaged: staged.has("src/auth/session.ts"), isUntracked: false, isConflicted: false }] : [];
  const identity = { userName: "原型演示用户", userEmail: "demo@example.invalid", nameSource: "阶段性原型样例", emailSource: "阶段性原型样例", scopeLabel: "仅内存" };
  const packed = (root: string) => entries(root).map(entry => `${entry.type}\t${entry.relativePath}`).join("\n");
  return {
    fileService: {
      searchWorkspaceFiles: async params => entries(params.rootPath).filter(entry => entry.relativePath.toLowerCase().includes(params.query.toLowerCase())).slice(0, params.limit ?? 100),
      readdir: async params => {
        const path = params.path.replace(/\/$/, "");
        if (path === "/" || path === "/demo") return ["aurora-console", "mobile-console"].map(name => ({ name, path: `/demo/${name}`, type: "directory" }));
        return entries(rootFor(path)).filter(entry => entry.path.slice(0, entry.path.lastIndexOf("/")) === path && (!params.directoriesOnly || entry.type === "directory") && (params.includeHidden || !entry.name.startsWith(".")));
      },
      stat: async ({ path }) => {
        const entry = entries(rootFor(path)).find(item => item.path === path);
        if (!entry && path !== rootFor(path)) throw new Error(`样例路径不存在：${path}`);
        return { path, type: entry?.type ?? "directory", size: entry?.type === "file" ? encoder.encode(text(path)).length : 0, mtimeMs: 1794297600000 };
      },
      checkFilesExist: async ({ paths }) => paths.map(path => ({ path, exists: path === rootFor(path) || entries(rootFor(path)).some(entry => entry.path === path) })),
      resolvePath: async ({ path }) => path.startsWith("/") ? path : `/demo/aurora-console/${path}`,
      ensureConversationWorkspace: async () => ({ path: "/demo/aurora-console", created: false, workspacePurpose: "conversation" }),
      createDefaultWorkspace: async () => ({ path: "/demo/aurora-console" }),
      createScratchWorkspace: async ({ name }) => ({ path: `/demo/${name.replace(/[^\p{L}\p{N}_-]/gu, "-")}` }),
      readTextFile: async ({ path, offset = 0, length }) => {
        const bytes = encoder.encode(text(path));
        const slice = bytes.slice(offset, length === undefined ? undefined : offset + length);
        return { path, content: new TextDecoder().decode(slice), offset, bytesRead: slice.length, totalBytes: bytes.length, truncated: offset + slice.length < bytes.length, isBinary: false };
      },
      readMediaPreview: async ({ path }) => { const bytes = encoder.encode(text(path)); return { path, mediaType: "text/plain", dataBase64: base64(bytes), totalBytes: bytes.length }; },
      readFileRange: async ({ path, offset, length }) => encoder.encode(text(path)).slice(offset, offset + length),
      readBinaryPreview: async ({ path }) => { const bytes = encoder.encode(text(path)); return { path, dataBase64: base64(bytes), totalBytes: bytes.length }; },
      listWorkspaceFilesLength: async ({ rootPath }) => packed(rootPath).length,
      listWorkspaceFilesRange: async ({ rootPath, offset, length }) => packed(rootPath).slice(offset, offset + length),
      readWorkspaceFileSearchIgnore: async () => ({ content: ignore, source: "file" }),
      applyWorkspaceFileSearchIgnoreTransform: async ({ transform }) => ({ content: transform === "reset-defaults" ? "node_modules/\ndist/\n.env\n" : ignore }),
      writeWorkspaceFileSearchIgnore: async ({ rootPath, content }) => { ignore = content; changes.fire({ dirPath: rootPath }); },
    },
    fileWatcherService: { watch: async ({ path }) => ({ id: path }), unwatch: async () => {}, disposeAll() {}, onDynamicChange: () => changes.event },
    gitService: {
      getRepositorySummary: async ({ workspacePath }) => summary(workspacePath),
      getWorkspaceRepositoryInfo: async ({ workspacePath }) => ({ workspacePath, kind: "main-tree", isGitAvailable: true }),
      getLocalBranches: async () => ({ headRefType: "branch", currentBranchName: branch, branches: [branch, "main"].map(name => ({ name, isCurrent: name === branch, upstreamName: null, commitHash: null, commitTimestampMs: null })) }),
      getCommitGraph: async () => ({ commits: [], hasMore: false }),
      switchBranch: async ({ workspacePath, targetBranchName }) => { branch = targetBranchName; return { ok: true, action: "switch", branchName: branch, didChange: true, created: false, summary: summary(workspacePath), issues: [] }; },
      createBranchAndSwitch: async ({ workspacePath, branchName }) => { branch = branchName; return { ok: true, action: "create-and-switch", branchName: branch, didChange: true, created: true, summary: summary(workspacePath), issues: [] }; },
      getChanges: async ({ workspacePath, sourceId }) => changeList(workspacePath).filter(change => sourceId === "staged" ? change.isStaged : !change.isStaged),
      getIgnoredPaths: async () => [],
      getDiff: async ({ path }) => ({ path, availability: "patch", patch: PROTOTYPE_REVIEW_PATCH, beforeContent: PROTOTYPE_REVIEW_BEFORE, afterContent: text(path), summary: "阶段性前端原型的预置差异；未执行 Git。" }),
      getBranchComparison: async ({ workspacePath }) => ({ baseRef: "main", headRef: branch, comparisonLabel: "样例差异（未执行 Git）", changes: changeList(workspacePath) }),
      stagePaths: async ({ paths, workspacePath }) => { paths.forEach(path => staged.add(path.startsWith("/") ? relative(path) : path)); changes.fire({ dirPath: workspacePath }); },
      unstagePaths: async ({ paths, workspacePath }) => { paths.forEach(path => staged.delete(path.startsWith("/") ? relative(path) : path)); changes.fire({ dirPath: workspacePath }); },
      discardPaths: async ({ paths, workspacePath }) => { if (paths.some(path => path.endsWith("src/auth/session.ts"))) files.set("src/auth/session.ts", PROTOTYPE_REVIEW_BEFORE); changes.fire({ dirPath: workspacePath }); },
      generateCommitMessage: async () => ({ message: "[原型样例] 展示会话过期检查差异", providerId: "prototype", model: "预置文本（未调用模型）" }),
      commit: unavailablePrototypeOperation,
      push: unavailablePrototypeOperation,
      getIdentity: async () => identity,
      refresh: async ({ workspacePath }) => ({ summary: summary(workspacePath), identity, unstagedChanges: changeList(workspacePath).filter(change => !change.isStaged), stagedChanges: changeList(workspacePath).filter(change => change.isStaged), branchComparison: { baseRef: "main", headRef: branch, comparisonLabel: "预置差异", changes: changeList(workspacePath) } }),
    },
    gitCheckpointService: { createCheckpoint: unavailablePrototypeOperation, diffCheckpoints: unavailablePrototypeOperation, restoreBetweenCheckpoints: unavailablePrototypeOperation, deleteCheckpoint: unavailablePrototypeOperation },
  };
}
