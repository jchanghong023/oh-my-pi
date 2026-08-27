<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import HomeSections from './HomeSections.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #home-features-after>
      <HomeSections />
    </template>
  </Layout>
</template>
