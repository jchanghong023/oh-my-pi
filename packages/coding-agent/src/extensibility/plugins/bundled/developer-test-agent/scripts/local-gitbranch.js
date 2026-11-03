/**
 * local-gitbranch.js
 *
 * 检查本地 Git 分支状态，确保当前分支与源分支一致，并获取远端分支信息。
 * 直接输出 JSON 格式。
 *
 * 用法：
 *   node local-gitbranch.js <baseBranch> <targetBranch> <gitPath>
 *
 * 参数：
 *   baseBranch   - 源分支（期望当前本地分支与之一致）
 *   targetBranch - 目标分支
 *   gitPath      - 代码仓地址（如 https://codehub-g.huawei.com/xxx/yyy.git）
 *
 * 环境变量：
 *   CODEAGENT3_PLUGIN_ROOT - 插件安装目录（可选，不传时基于 __dirname 推算）
 *
 * 输出（JSON 到 stdout）：
 *   成功时：
 *     {"ok":true,"currentBranch":"feat/xxx","baseBranch":"feat/xxx","targetBranch":"master","branchMatched":true,"remoteTracking":"origin/master"}
 *
 *   分支不一致时：
 *     {"ok":false,"reason":"BRANCH_MISMATCH","message":"当前分支 master 与源分支 feat/xxx 不一致，请切换到源分支后再执行增量验证。","currentBranch":"master","baseBranch":"feat/xxx","targetBranch":"master"}
 *
 *   无远端配置时：
 *     {"ok":false,"reason":"NO_REMOTE","message":"未找到代码仓地址对应的远端配置，请先添加远端：git remote add <name> <gitPath>","currentBranch":"feat/xxx","baseBranch":"feat/xxx","targetBranch":"master"}
 *
 *   远端分支不存在时：
 *     {"ok":false,"reason":"NO_REMOTE_BRANCH","message":"远端分支 origin/master 不存在，请先执行 git fetch origin 拉取远端分支。","currentBranch":"feat/xxx","baseBranch":"feat/xxx","targetBranch":"master","remoteTracking":"origin/master"}
 *
 *   参数错误时：
 *     {"ok":false,"reason":"INVALID_ARGS","message":"用法：node local-gitbranch.js <baseBranch> <targetBranch> <gitPath>"}
 */

const { execSync } = require("child_process")
const path = require("path")

// ─── 插件根目录 ─────────────────────────────────────────────────────
const PLUGIN_ROOT = process.env.CODEAGENT3_PLUGIN_ROOT || path.dirname(path.dirname(__filename))

// ─── 工具函数 ────────────────────────────────────────────────────────

function execGit(args) {
  try {
    return execSync(`git ${args}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (_) {
    return null
  }
}

function normalizeGitUrl(url) {
  // 去掉末尾 .git，统一为小写比较
  return url.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase()
}

/**
 * 从 git URL 中提取项目路径（去掉域名部分），
 * 用于忽略域名差异（如 codehub-g.huawei.com vs codehub-dg-g.huawei.com）。
 *
 * 示例：
 *   https://codehub-g.huawei.com/GDDRDTools/LightIDE/CodeCovService.git
 *   → /gddrdtools/lightide/codecovservice
 */
function extractProjectPath(url) {
  const normalized = normalizeGitUrl(url)
  // 去掉协议和域名，只保留路径部分
  return normalized.replace(/^https?:\/\/[^/]+/, "")
}

// ─── 主流程 ────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)

  if (args.length < 3) {
    console.log(JSON.stringify({ ok: false, reason: "INVALID_ARGS", message: "用法：node local-gitbranch.js <baseBranch> <targetBranch> <gitPath>" }))
    return
  }

  const [baseBranch, targetBranch, gitPath] = args

  // 1. 获取当前本地分支
  const currentBranch = execGit("rev-parse --abbrev-ref HEAD")
  if (!currentBranch) {
    console.log(JSON.stringify({ ok: false, reason: "GIT_ERROR", message: "无法获取当前分支，请确认是否在 Git 仓库中执行。" }))
    return
  }

  // 2. 判断源分支与本地分支是否一致
  if (currentBranch !== baseBranch) {
    console.log(JSON.stringify({
      ok: false,
      reason: "BRANCH_MISMATCH",
      message: `当前分支 ${currentBranch} 与源分支 ${baseBranch} 不一致，请切换到源分支后再执行增量验证。`,
      currentBranch,
      baseBranch,
      targetBranch,
    }))
    return
  }

  // 3. 获取远端列表，找到与 gitPath 对应的 remote name
  const remoteLines = execGit("remote -v")
  if (!remoteLines) {
    console.log(JSON.stringify({
      ok: false,
      reason: "NO_REMOTE",
      message: `未找到代码仓地址对应的远端配置，请先添加远端：git remote add <name> ${gitPath}`,
      currentBranch,
      baseBranch,
      targetBranch,
    }))
    return
  }

  const normalizedGitPath = normalizeGitUrl(gitPath)
  const projectPathFromGitPath = extractProjectPath(gitPath)
  let remoteName = null

  for (const line of remoteLines.split("\n")) {
    // 格式：origin	https://codehub-g.huawei.com/xxx/yyy.git (fetch)
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/)
    if (match) {
      const name = match[1]
      const url = match[2]
      // 优先全量匹配，再按项目路径匹配（忽略域名差异）
      if (normalizeGitUrl(url) === normalizedGitPath || extractProjectPath(url) === projectPathFromGitPath) {
        remoteName = name
        break
      }
    }
  }

  if (!remoteName) {
    console.log(JSON.stringify({
      ok: false,
      reason: "NO_REMOTE",
      message: `未找到代码仓地址对应的远端配置，请先添加远端：git remote add <name> ${gitPath}`,
      currentBranch,
      baseBranch,
      targetBranch,
    }))
    return
  }

  // 4. 拼接远端跟踪分支
  const remoteTracking = `${remoteName}/${targetBranch}`

  // 5. 检查远端分支是否存在
  const remoteBranchExists = execGit(`branch --list -r "${remoteTracking}"`)
  if (!remoteBranchExists) {
    console.log(JSON.stringify({
      ok: false,
      reason: "NO_REMOTE_BRANCH",
      message: `远端分支 ${remoteTracking} 不存在，请先执行 git fetch ${remoteName} 拉取远端分支。`,
      currentBranch,
      baseBranch,
      targetBranch,
      remoteTracking,
    }))
    return
  }

  // 6. 一切正常
  console.log(JSON.stringify({
    ok: true,
    currentBranch,
    baseBranch,
    targetBranch,
    branchMatched: true,
    remoteTracking,
  }))
}

main()
