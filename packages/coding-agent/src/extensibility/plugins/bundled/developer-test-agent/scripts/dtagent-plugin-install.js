/**
 * dtagent-plugin-install.js
 *
 * SessionStart Hook 触发的插件安装注册脚本。
 * 检测 ~/.cac/extensions.json 是否存在，不存在则创建，已存在则确保包含 @baize/dtagent-plugin。
 * 同时配置 NPM Registry，确保 @baize scope 包可从华为内部源下载。
 *
 * 用法：由 hooks.json 中的 SessionStart hook 自动调用
 *   node ${CODEAGENT3_PLUGIN_ROOT}/scripts/dtagent-plugin-install.js
 *
 * 环境变量：
 *   CODEAGENT3_PLUGIN_ROOT - 插件安装目录
 */

const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")

// ─── 配置 ───────────────────────────────────────────────────────────
const PLUGIN_BASE_NAME = "@baize/dtagent-plugin"
const PLUGIN_NAME = "@baize/dtagent-plugin@1.0.8"  // 发版时手动更新版本号

// ─── 日志目录 ──────────────────────────────────────────────────────
const PLUGIN_ROOT = process.env.CODEAGENT3_PLUGIN_ROOT || path.dirname(path.dirname(__filename))
const LOG_DIR = path.join(PLUGIN_ROOT, "logs")

function getLogFile() {
  const now = new Date()
  const dateStr = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0")
  return path.join(LOG_DIR, "dt_report_" + dateStr + ".log")
}

// ─── 日志 ───────────────────────────────────────────────────────────
function log(level, message, data) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] [${level}] ${message}` + (data ? " " + JSON.stringify(data) : "") + "\n"
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true })
    }
    fs.appendFileSync(getLogFile(), line)
  } catch (_) {
    // 日志写入失败不影响主流程
  }
  if (level === "ERROR") {
    process.stderr.write(line)
  }
}

// ─── 获取 .cac 目录 ────────────────────────────────────────────────
function getCacDir() {
  const home = process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH
  if (!home) {
    // HOMEPATH 是相对路径（如 \Users\xxx），需要拼接 HOMEDRIVE
    const homeDrive = process.env.HOMEDRIVE || "C:"
    const homePath = process.env.HOMEPATH
    if (homePath) {
      return path.join(homeDrive + homePath, ".cac")
    }
    return null
  }
  return path.join(home, ".cac")
}

// ─── 从 stdin 读取 Hook 输入 ───────────────────────────────────────
function readHookInput() {
  return new Promise((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf-8")
    process.stdin.on("data", (chunk) => { data += chunk })
    process.stdin.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (_) {
        resolve({})
      }
    })
    // 超时保护：5 秒内没收到 stdin 则继续
    setTimeout(() => resolve({}), 5000)
  })
}
// ─── 主流程 ────────────────────────────────────────────────────────
async function main() {
  log("INFO", "dtagent-plugin-install.js started")

  // 1. 读取 Hook 输入
  const hookInput = await readHookInput()
  log("INFO", "Hook triggered", { source: hookInput.source, session_id: hookInput.session_id })

  // 2. 获取 .cac 目录
  const cacDir = getCacDir()
  if (!cacDir) {
    log("ERROR", "Cannot determine home directory")
    return
  }

  const extensionsPath = path.join(cacDir, "extensions.json")
  log("INFO", "Target path", { extensionsPath })

  // 3. 读取或创建 extensions.json
  let extensionsData
  let created = false

  if (fs.existsSync(extensionsPath)) {
    try {
      const content = fs.readFileSync(extensionsPath, "utf-8")
      extensionsData = JSON.parse(content)
      log("INFO", "Existing extensions.json read", { extensions: extensionsData.extensions })
    } catch (e) {
      log("WARN", "Failed to parse extensions.json, will overwrite", { error: String(e) })
      extensionsData = { extensions: [] }
    }
  } else {
    extensionsData = { extensions: [] }
    created = true
    log("INFO", "extensions.json not found, will create")
  }

  // 4. 确保 @baize/dtagent-plugin 在列表中
  if (!Array.isArray(extensionsData.extensions)) {
    extensionsData.extensions = []
  }

  let needWrite = created

  // 只处理 @baize/dtagent-plugin 相关条目（无版本或旧版本），其他插件配置一律保留
  const filteredExtensions = extensionsData.extensions.filter(
    ext => !(ext === PLUGIN_BASE_NAME || ext.startsWith(PLUGIN_BASE_NAME + "@"))
  )

  const removedCount = extensionsData.extensions.length - filteredExtensions.length
  if (removedCount > 0) {
    const removed = extensionsData.extensions.filter(
      ext => ext === PLUGIN_BASE_NAME || ext.startsWith(PLUGIN_BASE_NAME + "@")
    )
    log("INFO", "Old plugin entries removed", { removed, count: removedCount })
  }

  if (!filteredExtensions.includes(PLUGIN_NAME)) {
    filteredExtensions.push(PLUGIN_NAME)
    needWrite = true
    log("INFO", "Plugin updated", { plugin: PLUGIN_NAME, allExtensions: filteredExtensions })
  } else {
    log("INFO", "Plugin already in extensions, no change needed", { plugin: PLUGIN_NAME })
  }

  extensionsData.extensions = filteredExtensions

  // 5. 写入文件（仅在需要时）
  if (needWrite) {
    try {
      // 确保 .cac 目录存在
      if (!fs.existsSync(cacDir)) {
        fs.mkdirSync(cacDir, { recursive: true })
      }
      fs.writeFileSync(extensionsPath, JSON.stringify(extensionsData, null, 2) + "\n", "utf-8")
      log("INFO", created ? "extensions.json created" : "extensions.json updated", { extensions: extensionsData.extensions })
    } catch (e) {
      log("ERROR", "Failed to write extensions.json", { error: String(e) })
    }
  }

  log("INFO", "dtagent-plugin-install.js completed")
}

main().catch((e) => {
  log("ERROR", "Unhandled error", { error: String(e) })
})
