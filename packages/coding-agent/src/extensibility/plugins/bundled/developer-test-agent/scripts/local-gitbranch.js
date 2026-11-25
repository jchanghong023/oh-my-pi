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

const { spawnSync } = require("child_process")

// ─── 工具函数 ────────────────────────────────────────────────────────

function execGit(args) {
  return spawnSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
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
  const [baseBranch, targetBranch, gitPath] = process.argv.slice(2)
  const hasArgs = baseBranch?.trim() && targetBranch?.trim() && gitPath?.trim()
  const refStatus = hasArgs ? execGit(["check-ref-format", `refs/heads/${targetBranch}`]).status : 1
  if (refStatus === 1) {
    console.log(JSON.stringify({ ok: false, reason: "INVALID_ARGS", message: "用法：node local-gitbranch.js <baseBranch> <targetBranch> <gitPath>" }))
    return
  }

  // 1. 获取当前本地分支
  const head = refStatus === 0 ? execGit(["rev-parse", "--abbrev-ref", "HEAD"]) : null
  const currentBranch = head?.status === 0 ? head.stdout.trim() : null
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
  const remotes = execGit(["remote", "-v"])

  const normalizedGitPath = normalizeGitUrl(gitPath)
  const projectPathFromGitPath = extractProjectPath(gitPath)
  let fullMatch
  let pathMatch
  if (remotes.status === 0) {
    for (const line of remotes.stdout.split(/\r?\n/)) {
      // 格式：origin	https://codehub-g.huawei.com/xxx/yyy.git (fetch)
      const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/)
      if (!match) continue
      const [, name, url] = match
      if (url === gitPath) {
        fullMatch = name
        break
      }
      if (normalizeGitUrl(url) === normalizedGitPath) {
        fullMatch ??= name
      } else if (!pathMatch && extractProjectPath(url) === projectPathFromGitPath) {
        pathMatch = name
      }
    }
  }
  const remoteName = fullMatch ?? pathMatch

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
  const { status } = execGit(["show-ref", "--verify", "--quiet", `refs/remotes/${remoteTracking}`])
  if (status !== 0) {
    const missing = status === 1
    console.log(JSON.stringify({
      ok: false,
      reason: missing ? "NO_REMOTE_BRANCH" : "GIT_ERROR",
      message: missing
        ? `远端分支 ${remoteTracking} 不存在，请先执行 git fetch ${remoteName} 拉取远端分支。`
        : `无法检查远端分支 ${remoteTracking}，请确认当前 Git 仓库状态。`,
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
