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
    eyebrow: 'Start',
    title: 'Use omp effectively',
    description: 'Set up the CLI, configure a workspace, and understand the session model.',
    links: [
      { label: 'CLI reference', path: '/cli-reference' },
      { label: 'Configuration', path: '/config-usage' },
      { label: 'Sessions', path: '/session' }
    ]
  },
  {
    eyebrow: 'Workflows',
    title: 'Run complex coding tasks',
    description: 'Coordinate agents, preserve context, and move between interactive workflows.',
    links: [
      { label: 'Agent Hub', path: '/agent-hub' },
      { label: 'Vibe mode', path: '/vibe-mode' },
      { label: 'Memory', path: '/memory' }
    ]
  },
  {
    eyebrow: 'Models',
    title: 'Connect any provider',
    description: 'Choose models, configure providers, and understand compatibility behavior.',
    links: [
      { label: 'Models', path: '/models' },
      { label: 'Providers', path: '/providers' },
      { label: 'Add a provider', path: '/adding-a-provider' }
    ]
  },
  {
    eyebrow: 'Extend',
    title: 'Build on the platform',
    description: 'Add reusable skills, extensions, tools, and programmatic integrations.',
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
      <p class="docs-home-kicker">Documentation map</p>
      <h2 id="browse-documentation">Find the right entry point</h2>
      <p>Start with a workflow below, or use the complete sidebar and search to reach every document.</p>
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
