# mini-marketplace

一个最小的 `oh-my-pi` marketplace 目录，演示 `marketplace.json` 格式。它通过相对路径源列出一个插件（`my-plugin`）。

## 安装命令

```
/marketplace add ./docs/skills/examples/mini-marketplace
/marketplace install my-plugin@example-marketplace
```

或者从 CLI：

```
omp plugin marketplace add ./docs/skills/examples/mini-marketplace
omp plugin install my-plugin@example-marketplace
```

## 演示内容

- 必需的最小 `marketplace.json` 字段：`name`、`owner.name`、`plugins`
- 使用 `./` 前缀的相对路径插件源（`"source": "./my-plugin"`）
- 插件与 marketplace 目录打包在同一个目录树中
- 额外的目录元数据：本示例包含顶层 `description`；当前 marketplace 解析会保留额外的顶层字段，而运行时行为仅使用必需字段和插件条目。

## 结构

```
mini-marketplace/
  .claude-plugin/
    marketplace.json      ← catalog
  README.md
  my-plugin/
    package.json          ← omp.extensions manifest
    index.ts              ← extension entry point
```

已发布和本地的 marketplace 使用相同的目录位置。omp 优先加载 `.omp-plugin/marketplace.json`，回退到 `.claude-plugin/marketplace.json`（本示例提供的与 Claude Code 兼容的路径），它们都位于 marketplace 根目录中。将 `/marketplace add` 指向此文件夹即可加载该示例。
