# Spec Delta

## ADDED Requirements

### Requirement: 声明命令显示诊断使用实际命令名

OMP MUST 在声明系列显示模式拒绝非 UTF-8 或赋值形式操作数时，按现有声明诊断契约使用实际调用的命令名。

#### Scenario: local 显示无效操作数
- **WHEN** 函数内执行 `local -p` 并提供非 UTF-8 或赋值形式操作数
- **THEN** MUST 在 stderr 输出以 `local:` 开头的 `<命令名>: <操作数>: not found`，并以非零状态退出；不得误报为 `declare:`。

### Requirement: Windows timeout 升级取消回退状态

OMP MUST 将 Windows `timeout -k` 的取消回退与可投递的 POSIX KILL 区分，不得因取消回退返回 137。

#### Scenario: 进程内操作数超时后达到升级期限
- **WHEN** Windows 上进程内操作数不响应初次取消，随后 `-k` 升级期限到达
- **THEN** 未使用 `--preserve-status` MUST 返回 124；使用 `--preserve-status` 的取消回退 MUST 返回 128；不得仅因升级期限到达而返回 137。
- **AND** POSIX 实际 KILL 的现有 137 契约保持不变。
