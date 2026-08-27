<script setup lang="ts">
import { withBase } from 'vitepress'

interface DocumentationLink {
  label: string
  path: string
}

interface DocumentationSection {
  eyebrow: string
  title: string
  description: string
  links: DocumentationLink[]
}

const sections: DocumentationSection[] = [
  {
    eyebrow: '入门',
    title: '高效使用 omp',
    description: '搭建 CLI、配置工作区，并理解会话模型。',
    links: [
      { label: 'CLI 参考', path: '/cli-reference' },
      { label: '配置', path: '/config-usage' },
      { label: '会话', path: '/session' }
    ]
  },
  {
    eyebrow: '工作流',
    title: '运行复杂的编码任务',
    description: '协调 agent、保留上下文，并在交互式工作流之间切换。',
    links: [
      { label: 'Agent Hub', path: '/agent-hub' },
      { label: 'Vibe mode', path: '/vibe-mode' },
      { label: '记忆', path: '/memory' }
    ]
  },
  {
    eyebrow: '模型',
    title: '接入任意 provider',
    description: '选择模型、配置 provider，并理解兼容性行为。',
    links: [
      { label: '模型', path: '/models' },
      { label: 'Provider', path: '/providers' },
      { label: '添加 provider', path: '/adding-a-provider' }
    ]
  },
  {
    eyebrow: '扩展',
    title: '在平台之上构建',
    description: '添加可复用的 skills、extensions、tools，以及编程式集成。',
    links: [
      { label: 'Extensions', path: '/extensions' },
      { label: 'Skills', path: '/skills' },
      { label: 'SDK', path: '/sdk' }
    ]
  }
]
</script>

<template>
  <section class="docs-home-sections" aria-labelledby="browse-documentation">
    <div class="docs-home-heading">
      <p class="docs-home-kicker">文档导览</p>
      <h2 id="browse-documentation">找到合适的入口</h2>
      <p>从下方某个工作流开始，或使用完整的侧边栏与搜索直达任一文档。</p>
    </div>

    <div class="docs-home-grid">
      <article v-for="section in sections" :key="section.title" class="docs-home-card">
        <p class="docs-home-card-eyebrow">{{ section.eyebrow }}</p>
        <h3>{{ section.title }}</h3>
        <p class="docs-home-card-description">{{ section.description }}</p>
        <ul>
          <li v-for="link in section.links" :key="link.path">
            <a :href="withBase(link.path)">
              <span>{{ link.label }}</span>
              <span aria-hidden="true">→</span>
            </a>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>
