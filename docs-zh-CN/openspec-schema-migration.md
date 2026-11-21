# 本仓库 OpenSpec 2.0 schema 迁移记录

本次仅迁移 OMP 仓库作为普通 OpenSpec 项目的配置，不迁移用户项目。

## 变更与恢复

- 根 `openspec/config.yaml` 及当时活动 change 的 `.openspec.yaml` 从 `omp-spec` 改为上游 `spec-driven`，创建日期及换行格式保持。
- 现存的旧 YAML 配置与材料摘要保存在 `openspec/.migration-backup/openspec-2.0/`。需要撤回时，仅恢复对应配置／元数据；回滚名称不会恢复已撤销的包内私有 schema。
- schema 迁移本身没有生成、删除或改写 proposal、specs、design、tasks；迁移时逐文件摘要验证原有材料保持不变。
- 不批量改写历史 `changes/archive/`；其中旧 schema 名称保留为历史记录。没有恢复 `mini`／`omp-spec` 兼容 schema 或别名。

## 活动材料核对

下表列出仍保留的活动 change，并记录 schema 迁移时的材料。`specs` 列为 `specs/<capability>/spec.md` 的 capability 名称。文件存在不代表内容完整、实现完成、任务完成或业务获批；迁移不自动生成缺失设计／任务，也不关闭校验。

|活动 change|现有材料|specs|仍缺的原生产物|
|---|---|---|---|
|add-todoloop-command|proposal、tasks|personal-commands|design|
|refine-compact-output-preview|proposal|tui-presentation|design、tasks|
|revamp-compact-activity-dock|proposal|tui-presentation|design、tasks|

## 使用影响

普通项目默认 `spec-driven`，原生依赖图为 proposal → specs／design → tasks。已有 proposal／specs 不会因改名自动满足 design／tasks；`omp openspec status --change <name>` 如实展示缺失产物，补齐实际材料后才能达到完整状态。

其他用户项目不会自动迁移。显式引用旧私有 schema 的项目须先备份并核对材料，再自行改用 `spec-driven` 或维护自己的自定义 schema；旧名称缺失时报错，不静默改写、下载或回退。历史归档不需要为了显示新默认值而重写。
