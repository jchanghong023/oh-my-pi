---
name: codecovcli-check
description: 检查本机 codecovcli 是否可用
---

# 检查 codecovcli

运行 `codecovcli --version`。可用则使用本机版本；不可用且有本地覆盖率路径则改用本地路径，必须使用云门禁时报告缺少 `codecovcli` 并停止。NEVER 自动联网安装、升级或修改 npm 配置。
