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
    section('Start', [
      '/',
      '/cli-reference',
      '/config-usage',
      '/settings',
      '/keybindings',
      '/session',
      '/session-switching-and-recent-listing',
      '/session-tree-plan',
      '/memory',
      '/compaction'
    ]),
    section('Capabilities', [
      '/vibe-mode',
      '/agent-hub',
      '/task-agent-discovery',
      '/approval-mode',
      '/advisor-watchdog',
      '/collab',
      '/computer-use',
      '/lsp-config',
      '/prewalk',
      '/notebook-tool-runtime',
      '/python-repl'
    ]),
    section('Models', [
      '/models',
      '/providers',
      '/adding-a-provider',
      '/local-models',
      '/provider-compat-reference',
      '/provider-endpoint-constraints',
      '/provider-quirks',
      '/provider-streaming-internals'
    ]),
    section('Customization', [
      '/context-files',
      '/skills',
      '/system-prompt-customization',
      '/magic-keywords',
      '/hooks',
      '/custom-tools',
      '/extensions',
      '/extension-loading',
      '/marketplace',
      '/theme',
      '/ttsr-injection-lifecycle',
      '/mcp-config',
      '/mcp-server-tool-authoring',
      '/mcp-runtime-lifecycle',
      '/mcp-protocol-transports'
    ]),
    section('Programmatic', ['/sdk', '/rpc', '/omptype-guide', '/user-facing-packages'], true)
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
    reference: 'Reference & internals',
    skills: 'Extension authoring',
    toolconv: 'Model dialects',
    tools: 'Tool reference'
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
  title: 'Oh My Pi',
  description: 'Oh My Pi documentation',
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
      { text: 'Home', link: '/' },
      { text: 'Vibe mode', link: '/vibe-mode' },
      { text: 'CLI', link: '/cli-reference' },
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
      pattern: 'https://github.com/jchanghong023/oh-my-pi/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    },
    footer: {
      message: 'Documentation published from the repository Markdown files.'
    }
  }
})
