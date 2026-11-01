---
type: 运行配置指南
title: 启动、默认值与运行配置
description: 介绍 OMP 的安装启动、配置根与 profile、离线运行语义及 TUI 呈现。重点说明 fork 相对上游的运行默认值、覆盖优先级和网络安全取舍。
tags: [configuration, operations, offline, profiles, security]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-11-01T02:46:50.031Z
sources:
  - id: openwiki-source-b7b0974c2bebdc838627cf7c
    resource: repo://openspec/specs/fork-runtime-defaults/spec.md
  - id: openwiki-source-ba154f518e7ac4ceb4f38ab1
    resource: repo://openspec/specs/fork-runtime/spec.md
  - id: openwiki-source-b4cb68915e28abb4af4139f8
    resource: repo://openspec/specs/tui-presentation/spec.md
generated: { by: "openwiki/0.0.0-unknown", at: "2026-11-01T02:46:50.031Z" }
---

# 启动、默认值与运行配置

本文梳理 OMP 的安装入口、配置数据根与 profile 生命周期，以及 offline 模式怎样改变当前进程的网络行为、默认值和界面呈现。配置“零配置”只表示无需为这些行为额外写配置文件，不表示无需可用的模型服务、模型凭据或内部网络访问。

## 安装与启动

内网 Linux/tcsh 用户可先按[内网快速指南](../../docs-zh-CN/quick-start-intranet.md)准备环境：执行 `ma dmas_ide`、`ide agent` 启动 IDE 和模型代理，再运行 OMP。安装器安装 fork Release 的预编译二进制；当前提供 Linux glibc x64 和 Windows x64，macOS 安装器会在联网前拒绝安装，不能把上游支持平台等同于 fork 已提供安装资产。安装器先下载到唯一临时文件、验证可执行并核对 `omp --version`，再替换目标；验证失败保留旧安装。PATH 配置与 shell 配置文件由用户按安装器提示处理，安装器不擅自改写旧 settings.json 或用户 `config.yml`。具体命令和常见操作见快速指南。

`OMP_OFFLINE` 是进程级环境开关，不是命令行参数。仅 `1`、`true`、`yes`、`on`（忽略大小写及首尾空白）启用。由于由所有子进程继承，模型代理、OMP 主进程及 task 子代理对 offline 的认知一致，避免各进程数据根和状态分叉。

## 配置根、配置层级与 profile

`OMP_CONFIG_ROOT` 接受绝对路径（支持 `~` 展开）；相对值忽略。有效时统一承载 OMP 的 agent 数据、会话、日志、缓存、运行状态、Wiki/Repo 数据库及 profiles 等，沿用根下既有相对布局；项目级 `.omp/` 不随之改变。未设置有效值时沿用上游默认目录解析，不应假定固定目录名。与 `PI_CONFIG_DIR` 并存时，`OMP_CONFIG_ROOT` 决定根。Wiki 不再支持 `OMP_WIKI_DIR` 单独指定目录。

配置解析遵循既有优先级：默认值只补未设置项，显式配置、环境变量及本次 CLI 选择按各自原优先级生效。offline 有一组只作用于当前进程内存的启动覆盖，优先于保存配置但不写回；进程结束即消失。离线模型角色默认也仅补未配置角色，已有值（包括显式 `null`）和 CLI 模型参数优先。由此，默认值升级不会覆盖用户已有选择。

`-P <name>` 等价于 `--profile <name>`，用于选择隔离的运行配置。profile 与有效配置根共同决定数据布局；native addon 和 grammar 安装器也按相同根与 profile 解析，显式有效 `PI_NATIVES_DIR` 则优先于默认 native 目录。关于模型服务离线可用性，另见[离线模型运行](../integrations/models-offline.md)；ZCode 专属运行配置见[ZCode](../integrations/zcode.md)。

## Offline 模式的运行边界

offline 不等于断网运行：它关闭启动阶段不适合内网的联网功能，而保留公司内部模型 API、本地文件、bash/Eval、本地 Git、LSP、Computer Use 等能力。它关闭 web search、browser、AST edit、fetch 的当前进程设置；不检查 OMP 更新、插件市场或在线模型目录，不展示更新日志，模型选择只使用本地缓存。实际模型请求和 OAuth 请求仍可能发生，因而模型服务及相应认证仍须可用。

若 company provider 可用，offline 只为尚未配置的模型角色补充进程内默认模型；不锁定 provider、不阻止 `/model` 或角色切换。offline 下 `startup.setupWizard` 强制为 false，避免启动时自动弹出全屏向导；手动设置入口仍可用。Linux offline 对 Eval 解释器要求 Python ≥3.11，显式解释器不可用时明确失败而不回退；其他平台及非 offline 保持原有候选和门槛。

offline 的内网减负还包括诊断日志仅记录 ERROR、Linux TUI 后台普通重绘合并至最多 10 FPS、流式更新合并窗口由普通模式 50ms 调为 100ms（结束/取消等边界仍立即冲刷）。这些仅适用于相应 offline 平台/进程，不改变普通启动行为。离线文件补全目录扫描缓存默认 TTL 为 30000ms，显式 `FS_SCAN_CACHE_TTL_MS`（包括 `0`）优先。

## Fork 默认值与上游差异

下表是源码/规格中明确的 fork 默认值；默认只在没有用户选择时生效，不意味着更改已有配置文件。

| 设置 | OMP 默认行为 | 与上游基线的关系与覆盖 |
| --- | --- | --- |
| `lsp.enabled` | 默认 `false` | fork 有意区别于上游启用倾向；用户显式开启后才启用主会话及 task 子代理的 LSP、诊断与自动格式化。关闭可减少后台能力与文件变更副作用。 |
| `eval.js` | 默认 `false` | 所有平台及 offline 均关闭 JavaScript Eval；默认工具 schema 仅声明 Python。显式开启才恢复 JS 后端，关闭时执行请求被拒绝，降低意外执行任意 JS 的风险。 |
| `startup.setupWizard` | 默认 `false` | 不因 setupVersion 落后自动启动向导；用户仍可显式启用或手动进入设置。 |
| `composer.predictions` | 默认 `true` | 保留上游输入区预测：用当前模型生成建议，Tab/右方向键插入但不发送，额外模型用量计入 `/stats`。显式 `false` 可禁用；预测有模型调用成本。 |
| `theme.dark` | `titanium` | 与上游默认一致；仅未显式设置时采用，不迁移保存的主题。`theme.light=light` 保持不变。 |
| `terminal.programStatus` | 普通启动 `true`；offline `false` | offline 避免不兼容终端将 OSC 7501 序列显示成文本；显式设置仍优先。 |
| `ask.timeout` | 60 秒 | fork 默认值；其他 fork 设置见配置默认规格。 |
| `composer.shape` / 显示 | `box` / `compact` | 输入区使用 Rounded Box，TUI 默认紧凑显示。 |

其他值得注意的默认项包括 `recap.enabled=false`、`debug.enabled=false`、`ida.enabled=false`、`archive.enabled=false`、`statusLine.compactThinkingLevel=false`、`display.showTurnTime=true`、`mnemopi.embeddingVariant=multilingual`、`stt.language=zh-CN`。所有这些均服从显式配置。特别是 LSP 与 JavaScript Eval 默认关闭属于能力收缩，而非安装故障；排查相关能力时应先检查对应设置，不要通过修改全局默认或配置文件之外的方式绕过用户意图。

## TLS、代理与安全注意事项

个人 fork 的运行时网络引导采用宽松 TLS 默认：未显式设置时，主进程设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`（覆盖 Bun `fetch` 证书验证）及 `GIT_SSL_NO_VERIFY=true`（由主进程启动的 git 子进程继承），便于拦截代理或私有网关使用自有根证书时免配置工作。`agent` 目录 `.env` 的显式设置先于该默认；显式 `NODE_TLS_REJECT_UNAUTHORIZED=1`、`GIT_SSL_NO_VERIFY=false` 可分别恢复严格验证。worker 子进程入口不经过该默认。

这是重要的安全取舍，不应误称为安全的 TLS 配置：证书验证关闭后无法确认端点身份，在可劫持网络中凭据可能被截获。仅在个人受控网络确实接受该风险时使用；需要身份校验时显式恢复验证，并确保受信任证书链正确配置。

Windows 主进程出网请求的代理顺序为请求显式 `proxy`（`PI_PROXY_<PROVIDER>`/`PI_PROXY`）、标准代理环境变量、当前用户 Windows 静态系统代理、直连；`NO_PROXY` 与回环/内网绕行规则适用。系统代理不支持 PAC/WPAD，fork 的内网 bypass 清单只约束系统代理层，不覆盖显式或环境代理。故障排查时先区分代理链路与 TLS 校验，不要仅因请求失败就将凭据写入日志或配置。

## TUI 与状态表现

TUI 默认采用 `compact` 显示模式，输入区默认 box 形状。offline 可覆盖图表自动展示和标题状态，减少企业终端重绘；这些是进程内运行策略，不写入用户设置。欢迎界面的使用提示、字体提醒及提示/新功能标签采用简体中文。OSC 7501 程序状态通知在普通模式默认开启、offline 默认关闭；用户可显式改变。显示策略详见[TUI 呈现规格](../../openspec/specs/tui-presentation/spec.md)。

## 定位与验证

配置行为的主要依据是 `openspec/specs/fork-runtime-defaults/spec.md` 和 `openspec/specs/fork-runtime/spec.md`；安装与内网启动操作见[快速指南](../../docs-zh-CN/quick-start-intranet.md)。修改默认值时同时检查默认值解析、offline 环境覆盖与用户显式值优先级，尤其避免把启动覆盖写回磁盘。TUI 文案和显示模式应与呈现规格一致；offline 网络限制应验证实际模型请求仍按预期使用内网服务，而非把“禁止在线发现”误实现为“禁止所有模型请求”。
