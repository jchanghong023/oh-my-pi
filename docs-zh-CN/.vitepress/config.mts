import * as fs from 'node:fs'
import * as path from 'node:path'
import { defineConfig } from 'vitepress'
import type { DefaultTheme } from 'vitepress'

interface DocEntry {
  route: string
  title: string
}

const docsDirectory = path.resolve(import.meta.dirname, '..')

// 只作同步对照稿源、不作为站点页面与搜索内容的文件（相对 docs 目录的路径）。
// 发现阶段与 VitePress `srcExclude` 共用此表，否则被排除的稿源会经兜底分组漏进侧栏。
const excludedSources = ['README.upstream.md']

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
    if (excludedSources.includes(relativePath)) continue

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
    section('开始', ['/', '/command-shortcut-tutorial']),
    section('参考', ['/settings-reference', '/research'], true),
    section('工具参考', ['/tools'], true)
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
    requirements: '需求文档'
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
  // 上游英文快照只作同步对照稿源，不作为站点页面与搜索内容。
  srcExclude: excludedSources,
  title: 'omp fork 文档',
  description: 'omp fork 的新增文档、工具参考与需求目录',
  base: '/oh-my-pi/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  markdown: {
    html: false,
    config(md) {
      const renderCodeInline = md.renderer.rules.code_inline
      if (renderCodeInline) {
        md.renderer.rules.code_inline = (...args) =>
          renderCodeInline(...args).replace('<code>', '<code v-pre>')
      }
      // 文档里 `../packages/`、`../crates/`、`../docs/` 开头的相对链接面向 GitHub 仓库浏览，
      // 发布到 GitHub Pages 后全部 404；渲染时改写为指向仓库源码的绝对链接。
      const renderLinkOpen = md.renderer.rules.link_open
      if (renderLinkOpen) {
        md.renderer.rules.link_open = (...args) => {
          const [tokens, idx] = args
          const href = tokens[idx].attrGet('href')
          if (
            href &&
            (href.startsWith('../packages/') || href.startsWith('../crates/') || href.startsWith('../docs/'))
          ) {
            const sourcePath = href.slice(3).replace(/\/+$/, '')
            const view = /\.[^/]+$/.test(sourcePath) ? 'blob' : 'tree'
            tokens[idx].attrSet('href', `https://github.com/jchanghong023/oh-my-pi/${view}/main/${sourcePath}`)
          }
          return renderLinkOpen(...args)
        }
      }
    }
  },
  themeConfig: {
    nav: [
      { text: '文档首页', link: '/' },
      { text: '快速开始', link: '/command-shortcut-tutorial' },
      { text: '设置参考', link: '/settings-reference' },
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
