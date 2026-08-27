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
    eyebrow: '开始',
    title: '先完成一次真实任务',
    description: '从安装、配置与交互开始，再理解会话如何保存和延续。',
    links: [
      { label: '命令与快捷键教程', path: '/command-shortcut-tutorial' },
      { label: '配置', path: '/config-usage' },
      { label: '设置', path: '/settings' },
      { label: '会话', path: '/session' },
      { label: '记忆', path: '/memory' }
    ]
  },
  {
    eyebrow: '能力',
    title: '把 IDE 能力接入 Agent',
    description: '使用代码智能、专业子 agent 与协作模式完成复杂工作。',
    links: [
      { label: '代码智能', path: '/lsp-config' },
      { label: '子 Agent', path: '/task-agent-discovery' },
      { label: 'Vibe mode', path: '/vibe-mode' },
      { label: 'Collab', path: '/collab' },
      { label: '计算机控制', path: '/computer-use' }
    ]
  },
  {
    eyebrow: '模型',
    title: '为每类工作选择模型',
    description: '连接 provider、本地模型与兼容端点，并配置模型路由。',
    links: [
      { label: 'Provider', path: '/providers' },
      { label: '模型', path: '/models' },
      { label: '本地模型', path: '/local-models' },
      { label: '添加 Provider', path: '/adding-a-provider' },
      { label: 'Prewalk', path: '/prewalk' }
    ]
  },
  {
    eyebrow: '自定义',
    title: '让 omp 适配你的项目',
    description: '通过上下文、skills、hooks、工具与 MCP 固化项目工作流。',
    links: [
      { label: '上下文文件', path: '/context-files' },
      { label: 'Skills', path: '/skills' },
      { label: 'Hooks', path: '/hooks' },
      { label: '自定义工具', path: '/custom-tools' },
      { label: 'MCP', path: '/mcp-config' }
    ]
  },
  {
    eyebrow: '编程接入',
    title: '嵌入应用与自动化系统',
    description: '通过 SDK、RPC 与类型系统接入非交互式工作流。',
    links: [
      { label: 'SDK', path: '/sdk' },
      { label: 'RPC', path: '/rpc' },
      { label: 'Omptype', path: '/omptype-guide' }
    ]
  },
  {
    eyebrow: '参考',
    title: '查找精确接口与约束',
    description: '按需查询 CLI、环境变量、认证与工具审批行为。',
    links: [
      { label: 'CLI 参考', path: '/cli-reference' },
      { label: '环境变量', path: '/environment-variables' },
      { label: '密钥与认证', path: '/secrets' },
      { label: '工具审批', path: '/approval-mode' }
    ]
  }
]
</script>

<template>
  <section class="docs-home-sections" aria-labelledby="browse-documentation">
    <div class="docs-home-heading">
      <p class="docs-home-kicker">官方文档结构</p>
      <h2 id="browse-documentation">按任务找到下一步</h2>
      <p>目录顺序与 omp.sh/docs 保持一致：先上手，再深入能力、模型、自定义、编程接入与参考。</p>
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
