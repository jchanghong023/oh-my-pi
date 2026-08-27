import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Oh My Pi',
  description: 'Oh My Pi documentation',
  base: '/oh-my-pi/',
  cleanUrls: true,
  lastUpdated: true,
  markdown: {
    html: false
  },
  vue: {
    template: {
      compilerOptions: {
        delimiters: ['[[[', ']]]']
      }
    }
  },
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Vibe mode', link: '/vibe-mode' },
      { text: 'CLI', link: '/cli-reference' },
      { text: 'GitHub', link: 'https://github.com/jchanghong023/oh-my-pi' }
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Home', link: '/' },
          { text: 'CLI reference', link: '/cli-reference' },
          { text: 'Configuration', link: '/config-usage' },
          { text: 'Adding a provider', link: '/adding-a-provider' }
        ]
      },
      {
        text: 'Agents and modes',
        items: [
          { text: 'Vibe mode', link: '/vibe-mode' },
          { text: 'Agent Hub', link: '/agent-hub' },
          { text: 'Approval mode', link: '/approval-mode' },
          { text: 'Advisor watchdog', link: '/advisor-watchdog' }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Compaction', link: '/compaction' },
          { text: 'Collaboration', link: '/collab' },
          { text: 'Computer use', link: '/computer-use' },
          { text: 'Blob artifact architecture', link: '/blob-artifact-architecture' },
          { text: 'Auth broker gateway', link: '/auth-broker-gateway' }
        ]
      }
    ],
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
