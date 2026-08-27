import * as fs from 'node:fs'
import * as path from 'node:path'
import { defineConfig } from 'vitepress'
import type { DefaultTheme } from 'vitepress'

interface DocEntry {
  route: string
  title: string
}

const docsDirectory = path.resolve(import.meta.dirname, '..')

function discoverDocuments(directory = docsDirectory, relativeDirectory = ''): DocEntry[] {
  const documents: DocEntry[] = []
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        documents.push(...discoverDocuments(path.join(directory, entry.name), relativePath))
      }
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue

    const routePath = relativePath.slice(0, -3)
    const route = routePath === 'index' ? '/' : `/${routePath}`
    const markdown = fs.readFileSync(path.join(directory, entry.name), 'utf8')
    const heading = markdown.match(/^#\s+(.+)$/m)?.[1]
    const fallbackTitle = path.basename(routePath).replaceAll(/[-_]/g, ' ')
    const title = route === '/' ? 'Overview' : (heading?.replaceAll(/[`*_]/g, '').trim() ?? fallbackTitle)
    documents.push({ route, title })
  }

  return documents
}

function buildSidebar(): DefaultTheme.SidebarItem[] {
  const remaining = new Map(discoverDocuments().map((document) => [document.route, document]))
  const take = (routes: string[]): DefaultTheme.SidebarItem[] =>
    routes.flatMap((route) => {
      const document = remaining.get(route)
      if (!document) return []
      remaining.delete(route)
      return [{ text: document.title, link: document.route }]
    })
  const section = (text: string, routes: string[], collapsed = false): DefaultTheme.SidebarItem => ({
    text,
    collapsed,
    items: take(routes)
  })

  const sections: DefaultTheme.SidebarItem[] = [
    section('开始', [
      '/',
      '/command-shortcut-tutorial',
      '/config-usage',
      '/settings',
      '/keybindings',
      '/session',
      '/session-switching-and-recent-listing',
      '/session-tree-plan',
      '/memory',
      '/compaction',
      '/handoff-generation-pipeline'
    ]),
    section('能力', [
      '/lsp-config',
      '/task-agent-discovery',
      '/agent-hub',
      '/advisor-watchdog',
      '/vibe-mode',
      '/collab',
      '/computer-use',
      '/notebook-tool-runtime',
      '/python-repl'
    ]),
    section('模型', [
      '/providers',
      '/models',
      '/local-models',
      '/adding-a-provider',
      '/prewalk',
      '/provider-compat-reference',
      '/provider-endpoint-constraints',
      '/provider-quirks',
      '/provider-streaming-internals'
    ]),
    section('自定义', [
      '/context-files',
      '/skills',
      '/system-prompt-customization',
      '/magic-keywords',
      '/hooks',
      '/custom-tools',
      '/mcp-config',
      '/mcp-server-tool-authoring',
      '/theme',
      '/ttsr-injection-lifecycle',
      '/extensions',
      '/extension-loading',
      '/marketplace',
      '/mcp-runtime-lifecycle',
      '/mcp-protocol-transports'
    ]),
    section('编程接入', ['/sdk', '/rpc', '/omptype-guide', '/user-facing-packages'], true),
    section('参考', ['/cli-reference', '/environment-variables', '/secrets', '/approval-mode'], true)
  ]

  const grouped = new Map<string, DocEntry[]>()
  for (const document of remaining.values()) {
    const group = document.route.split('/')[1]
    const key = document.route.slice(1).includes('/') ? group : 'reference'
    const documents = grouped.get(key) ?? []
    documents.push(document)
    grouped.set(key, documents)
  }

  const groupLabels: Record<string, string> = {
    reference: '参考与内部实现',
    skills: '扩展开发',
    toolconv: '模型协议',
    tools: '工具参考'
  }
  for (const key of ['reference', ...[...grouped.keys()].filter((group) => group !== 'reference').sort()]) {
    const documents = grouped.get(key)
    if (!documents) continue
    sections.push({
      text: groupLabels[key] ?? key.replaceAll(/[-_]/g, ' '),
      collapsed: true,
      items: documents
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((document) => ({ text: document.title, link: document.route }))
    })
  }

  return sections
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'omp 中文文档',
  description: 'omp 终端编码 agent 中文文档',
  base: '/oh-my-pi/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  markdown: {
    html: false,
    config(md) {
      const renderCodeInline = md.renderer.rules.code_inline
      if (!renderCodeInline) return
      md.renderer.rules.code_inline = (...args) =>
        renderCodeInline(...args).replace('<code>', '<code v-pre>')
    }
  },
  themeConfig: {
    nav: [
      { text: '文档首页', link: '/' },
      { text: '快速开始', link: '/command-shortcut-tutorial' },
      { text: 'CLI 参考', link: '/cli-reference' },
      { text: '官方网站', link: 'https://omp.sh' },
      { text: 'GitHub', link: 'https://github.com/jchanghong023/oh-my-pi' }
    ],
    sidebar: buildSidebar(),
    search: {
      provider: 'local'
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/jchanghong023/oh-my-pi' }
    ],
    editLink: {
      pattern: 'https://github.com/jchanghong023/oh-my-pi/edit/main/docs-zh-CN/:path',
      text: '在 GitHub 上编辑此页'
    },
    footer: {
      message: '内容基于 oh-my-pi 仓库文档整理。'
    }
  }
})
