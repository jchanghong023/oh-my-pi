/**
 * inject-ut-routing.js
 *
 * SessionStart Hook 触发的 UT 路由规则清理脚本。
 * 检测 MEMORY.md 中是否存在之前版本注入的路由标记块，如有则删除。
 *
 * 用途：一次性清理历史版本写入的路由规则，不再注入新内容。
 *
 * 用法：由 hooks.json 中的 SessionStart hook 自动调用（同步执行）
 *   node ${CODEAGENT3_PLUGIN_ROOT}/scripts/inject-ut-routing.js
 *
 * 环境变量：
 *   CODEAGENT3_PLUGIN_ROOT - 插件安装目录
 */

const fs = require('fs')
const path = require('path')

// ─── 配置 ───────────────────────────────────────────────────────────
// 所有可能的路由标记（历史版本使用过的）
const ROUTING_MARKERS = [
  'dt-route:java'
]

// ─── 日志目录 ──────────────────────────────────────────────────────
const PLUGIN_ROOT = process.env.CODEAGENT3_PLUGIN_ROOT || path.dirname(path.dirname(__filename))
const LOG_DIR = path.join(PLUGIN_ROOT, 'logs')

function getLogFile() {
  const now = new Date()
  const dateStr = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0')
  return path.join(LOG_DIR, 'dt_report_' + dateStr + '.log')
}

// ─── 日志 ───────────────────────────────────────────────────────────
function log(level, message, data) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] [${level}] ${message}` + (data ? ' ' + JSON.stringify(data) : '') + '\n'
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true })
    }
    fs.appendFileSync(getLogFile(), line)
  } catch (_) {
    // 日志写入失败不影响主流程
  }
  if (level === 'ERROR') {
    process.stderr.write(line)
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────────
function readHookInput() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => {
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

function getMemoryMdPath(transcriptPath) {
  // transcript_path 实际格式: ~/.cac/projects/<slug>/<session-id>.jsonl
  // dirname: ~/.cac/projects/<slug>/
  // 拼接 memory/MEMORY.md → ~/.cac/projects/<slug>/memory/MEMORY.md
  const projectBase = path.dirname(transcriptPath)
  return path.join(projectBase, 'memory', 'MEMORY.md')
}

function removeRoutingBlock(content, marker) {
  const regex = new RegExp(`\\n*<!-- ${marker} -->[\\s\\S]*?<!-- /${marker} -->\\n*`, 'g')
  return content.replace(regex, '')
}

function cleanupMemoryMd(memoryMdPath) {
  if (!fs.existsSync(memoryMdPath)) {
    log('INFO', 'MEMORY.md not found, skipping cleanup', { memoryMdPath })
    return false
  }

  const content = fs.readFileSync(memoryMdPath, 'utf-8')
  let cleaned = content

  // 删除所有可能的路由标记块
  for (const marker of ROUTING_MARKERS) {
    cleaned = removeRoutingBlock(cleaned, marker)
  }

  // 内容未变化则跳过
  if (cleaned === content) {
    log('INFO', 'No routing blocks found in MEMORY.md', { memoryMdPath })
    return false
  }

  // 写回清理后的内容
  fs.writeFileSync(memoryMdPath, cleaned)
  log('INFO', 'Routing blocks removed from MEMORY.md', { memoryMdPath })
  return true
}

// ─── 主流程 ────────────────────────────────────────────────────────
async function main() {
  log('INFO', 'inject-ut-routing.js cleanup started')

  // 1. 读取 Hook 输入
  const hookInput = await readHookInput()
  const transcriptPath = hookInput.transcript_path

  log('INFO', 'Hook input received', { transcriptPath })

  // 2. 定位 MEMORY.md 路径
  if (!transcriptPath) {
    log('WARN', 'transcript_path not provided in hook input, skipping cleanup')
    console.log('{}')
    return
  }

  const memoryMdPath = getMemoryMdPath(transcriptPath)
  log('INFO', 'MEMORY.md path resolved', { memoryMdPath })

  // 3. 清理路由标记块
  const cleaned = cleanupMemoryMd(memoryMdPath)

  if (cleaned) {
    log('INFO', 'Cleanup completed successfully')
  } else {
    log('INFO', 'No cleanup needed')
  }

  // 4. 输出空结果（不再注入 additionalContext）
  console.log('{}')
  log('INFO', 'inject-ut-routing.js cleanup completed')
}

main().catch((e) => {
  log('ERROR', 'Unhandled error', { error: String(e) })
  console.log('{}')
})
