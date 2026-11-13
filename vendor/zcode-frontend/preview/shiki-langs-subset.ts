/**
 * WebGUI 只允许聊天/工具卡片实际使用的语言进入产物。
 * @pierre/diffs 会动态 import("shiki/langs") 取全量语言表；Vite alias 把该说明符
 * 指向本文件，避免为 diff 预览打包数百个无关语法。
 */
export const bundledLanguages = {
  bash: () => import("shiki/langs/bash.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
} as const;

export const bundledLanguagesInfo: readonly { id: string; aliases?: readonly string[] }[] = [];
export const bundledLanguagesBase = bundledLanguages;
export default bundledLanguages;
