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
 *     自定义 fetch refspec 的 remoteTracking 使用完整引用名。
 *
 *   分支不一致时：
 *     {"ok":false,"reason":"BRANCH_MISMATCH","message":"当前分支 master 与源分支 feat/xxx 不一致，请切换到源分支后再执行增量验证。","currentBranch":"master","baseBranch":"feat/xxx","targetBranch":"master"}
 *
 *   无远端配置时：
 *     {"ok":false,"reason":"NO_REMOTE","message":"未找到代码仓地址对应的远端配置，请先添加远端：git remote add <name> <gitPath>","currentBranch":"feat/xxx","baseBranch":"feat/xxx","targetBranch":"master"}
 *
 *   目标分支未映射或映射引用未抓取时返回 NO_REMOTE_BRANCH，并提示检查 fetch refspec。
 *
 *   参数错误时：
 *     {"ok":false,"reason":"INVALID_ARGS","message":"用法：node local-gitbranch.js <baseBranch> <targetBranch> <gitPath>"}
 */

const { spawnSync } = require("child_process")

// ─── 工具函数 ────────────────────────────────────────────────────────

function execGit(args) {
  return spawnSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
}

function repository(url) {
  let host
  let pathname
  if (/^(https?|ssh|git):\/\//i.test(url)) {
    try {
      ({ hostname: host, pathname } = new URL(url))
    } catch {
      return null
    }
  } else {
    const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^@/:]+):(.+)$/.exec(url)
    if (!scp) return null
    host = scp[1]
    pathname = scp[2]
  }
  return {
    host: host.toLowerCase(),
    project: pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase(),
  }
}

function canonicalHost(host) {
  return host === "codehub-dg-g.huawei.com" ? "codehub-g.huawei.com" : host
}

function matchRefPattern(pattern, ref) {
  const wildcard = pattern.indexOf("*")
  if (wildcard === -1) return pattern === ref ? "" : null
  const prefix = pattern.slice(0, wildcard)
  const suffix = pattern.slice(wildcard + 1)
  return ref.length >= prefix.length + suffix.length && ref.startsWith(prefix) && ref.endsWith(suffix)
    ? ref.slice(prefix.length, ref.length - suffix.length)
    : null
}

function trackingRefs(refspecs, branch) {
  if (refspecs.some(spec => spec.startsWith("^") && matchRefPattern(spec.slice(1), branch) !== null)) return []
  const refs = []
  for (const spec of refspecs) {
    const [source, destination] = spec.replace(/^\+/, "").split(":")
    if (!destination) continue
    const capture = matchRefPattern(source, branch)
    if (capture !== null) refs.push(destination.replace("*", () => capture))
  }
  return refs
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

  const rewritten = execGit(["ls-remote", "--get-url", "--", gitPath])
  const rewrittenUrl = rewritten.status === 0 ? rewritten.stdout.trim() : gitPath
  const expected = [gitPath, rewrittenUrl].map(repository).filter(Boolean)
  let remoteName
  let bestRank = 0
  if (remotes.status === 0) {
    for (const line of remotes.stdout.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\t(.+) \(fetch\)$/)
      if (!match) continue
      const [, name, url] = match
      const configured = execGit(["config", "--get-all", `remote.${name}.url`])
      const configuredUrl = configured.status === 0 ? configured.stdout.split(/\r?\n/, 1)[0] : url
      let rank = 0
      for (const candidate of [url, configuredUrl]) {
        const actual = repository(candidate)
        if (!actual?.project) continue
        if (candidate === gitPath) {
          rank = 4
        } else if (candidate === rewrittenUrl) {
          rank = Math.max(rank, 3)
        } else {
          for (const wanted of expected) {
            if (actual.project !== wanted.project) continue
            if (actual.host === wanted.host) rank = Math.max(rank, 2)
            else if (canonicalHost(actual.host) === canonicalHost(wanted.host)) rank = Math.max(rank, 1)
          }
        }
      }
      if (rank <= bestRank) continue
      remoteName = name
      bestRank = rank
      if (rank === 4) break
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

  // 4. 检查 fetch refspec 实际映射到的远端跟踪引用。
  const config = execGit(["config", "--get-all", `remote.${remoteName}.fetch`])
  const refs = config.status === 0 ? trackingRefs(config.stdout.trim().split(/\r?\n/), `refs/heads/${targetBranch}`) : []
  const conventionalName = `${remoteName}/${targetBranch}`
  let remoteTracking
  let gitError = config.status !== 0 && config.status !== 1
  for (const ref of refs) {
    const { status } = execGit(["show-ref", "--verify", "--quiet", ref])
    if (status === 0) {
      remoteTracking = ref === `refs/remotes/${conventionalName}` ? conventionalName : ref
      break
    }
    if (status !== 1) gitError = true
  }
  if (!remoteTracking) {
    const missing = !gitError
    console.log(JSON.stringify({
      ok: false,
      reason: missing ? "NO_REMOTE_BRANCH" : "GIT_ERROR",
      message: missing
        ? `未找到目标分支 ${targetBranch} 的跟踪引用，请检查 ${remoteName} 的 fetch refspec 并执行 git fetch ${remoteName}。`
        : `无法检查 ${remoteName} 的目标分支 ${targetBranch}，请确认当前 Git 仓库状态。`,
      currentBranch,
      baseBranch,
      targetBranch,
      remoteTracking: refs[0] ?? conventionalName,
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
