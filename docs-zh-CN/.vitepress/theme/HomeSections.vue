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
    eyebrow: '上手',
    title: '使用这个 fork',
    description: '安装入口见仓库 README；在这里查询命令、快捷键和当前配置。',
    links: [
      { label: '命令与快捷键教程', path: '/command-shortcut-tutorial' },
      { label: '全部设置参考', path: '/settings-reference' },
      { label: 'Fork 功能与默认值', path: '/requirements/fork' }
    ]
  },
  {
    eyebrow: '检索',
    title: '定位代码与知识',
    description: '了解仓库索引、外部 Markdown 知识库和只读查询工具的边界。',
    links: [
      { label: '代码定位索引需求', path: '/requirements/repo-index' },
      { label: '工具参考', path: '/tools' }
    ]
  },
  {
    eyebrow: '协作',
    title: '协作与多模型讨论',
    description: '查询浏览器协作、子代理通信与多模型方案讨论的行为契约。',
    links: [
      { label: '协作功能', path: '/requirements/fork#collab-长期链接与网页端命令' },
      { label: '多模型方案讨论', path: '/requirements/team' },
      { label: '进程与代理协调', path: '/tools#进程与代理协调' }
    ]
  },
  {
    eyebrow: '集成',
    title: '接入桌面客户端',
    description: '区分 OMP 项目运行服务的接口、待接入的 GUI 和真实验收条件。',
    links: [
      { label: 'rpc-ui 协议与项目运行服务', path: '/requirements/rpc-ui-protocol' },
      { label: '需求目录', path: '/requirements/README' }
    ]
  },
  {
    eyebrow: '依据',
    title: '查询设计与上游基线',
    description: '研究资料用于取证；需求目录才是 fork 行为的权威来源。',
    links: [
      { label: '研究资料', path: '/research' },
      { label: '上游 README 对照快照', path: 'https://github.com/jchanghong023/oh-my-pi/blob/main/docs-zh-CN/README.upstream.md' },
      { label: '需求目录', path: '/requirements/README' }
    ]
  }
]
</script>

<template>
  <section class="docs-home-sections" aria-labelledby="browse-documentation">
    <div class="docs-home-heading">
      <p class="docs-home-kicker">Fork 自有文档</p>
      <h2 id="browse-documentation">按任务找到下一步</h2>
      <p>这里维护 fork 的教程、参考与需求，不重复翻译上游 docs；上游通用能力请查看仓库中的原始文档。</p>
    </div>

    <div class="docs-home-grid">
      <article v-for="section in sections" :key="section.title" class="docs-home-card">
        <p class="docs-home-card-eyebrow">{{ section.eyebrow }}</p>
        <h3>{{ section.title }}</h3>
        <p class="docs-home-card-description">{{ section.description }}</p>
        <ul>
          <li v-for="link in section.links" :key="link.path">
            <a :href="link.path.startsWith('https://') ? link.path : withBase(link.path)">
              <span>{{ link.label }}</span>
              <span aria-hidden="true">→</span>
            </a>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>
