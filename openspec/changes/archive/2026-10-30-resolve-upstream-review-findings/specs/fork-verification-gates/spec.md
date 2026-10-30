# Spec Delta

## ADDED Requirements

### Requirement: Native 换入后尝试清理让位文件

OMP MUST 在 native 产物成功替换后立即尝试清理该次让位的旧文件，且清理失败不得使成功安装失败。

#### Scenario: 改名让位后成功换入
- **WHEN** 旧 addon 因占用而先改名为 `<目标>.old.<PID>`，新产物已成功换入目标
- **THEN** MUST 尝试删除该次让位文件；删除失败 MUST NOT 撤销成功换入或将安装判失败。
- **AND** 换入失败时继续按既有回滚及恢复文件保留要求处理，不能先删除恢复所需的文件。
