# Fork 工程笔记

本页是操作参考，不定义需求；验证入口和授权见[维护规格](specs/fork-maintenance/spec.md#requirement-使用上游验证入口)。

## 构建与发布

- 源码开发：初始化固定的 `vendor/openwiki` 子模块，再用 `bun setup` 准备依赖、native 和内置资源。
- Windows 本地构建：`bun run local` 默认替换 `%LOCALAPPDATA%\omp\omp.exe`，可用 `PI_INSTALL_DIR` 指定目标；见[替换规则](specs/fork-runtime/spec.md#requirement-安装与运行)。
- CNB：Windows 需要 Node.js、`@cnbcool/cnb-cli`、MSVC、`curl.exe`、系统 `tar.exe` 和目标发布读写权限（可用 `CNB_TOKEN`）；Ubuntu-24.04 WSL2 需要 `zip`、`readelf`、`cargo-zigbuild` 和 Zig。双端并行构建时 Bun 版本及 revision 必须相同，并使用仓库固定 Rust 工具链及同一 OpenWiki 子模块提交。入口 `bun run cnb`，见[交付规格](specs/fork-runtime/spec.md#requirement-cnb-精确输入缓存与四附件交付)。

## Windows 性能采集

`bun scripts/monitor-system.ts` 启动采集；`--report <监控目录>` 查看 CPU、内存、容量和 I/O，`--stop <监控目录>` 停止并保留数据。

## 上游问题线索

以下线索来自历史基线，未核对现行上游；不作为当前验收。提 PR 前复核并拆分最小补丁。

- [2026-11-15 基线](https://github.com/can1357/oh-my-pi/tree/7c49c11aa5bbaf3f418406583096168ad5b8c6dc)：Windows builtin stdin 阻塞后取消不返回（`cancelling_a_blocked_read_returns_130`）；JS subprocess 硬取消丢失已输出内容（`js-cancel-output.test.ts`）；vendored jaq-core doctest 缺 `jaq_json`／`jaq_std` 依赖。
- 当时 Windows Nextest／doctest 报告：`runs/test-timing/2026-11-15T09-08-50.519Z-41764-12232413/run.json`；JS 取消定向证据：`runs/test-timing/2026-11-15T09-25-19.657Z-36216-762b9182/run.json`，该轮其他测试有失败。
- [2026-11-21 基线](https://github.com/can1357/oh-my-pi/tree/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d)：Python RPC 测试夹具漏填 `cache_warming_end.method`；fork Windows 定向验证通过，未在干净上游单独运行，当时未提 PR。
