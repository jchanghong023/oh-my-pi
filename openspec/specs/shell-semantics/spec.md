# shell-semantics

## Purpose

规定交互 Shell 与内建命令在参数字节保真、派发、路径边界、超时退出码、进程树信号投递和取消等待上的可观察语义。目标是与外部进程和 POSIX 行为一致：参数原样到达、拒绝条件明确、信号不溢出到宿主或无关进程，取消不跳过清理宽限。

## Requirements

### Requirement: 非 UTF-8 参数保真与派发

Shell MUST 将非 UTF-8 的原生字节参数原样交给被启动的程序，并 MUST 在命令名本身非 UTF-8 时跳过内建命令与函数派发、直接按 `PATH` 查找可执行文件。

#### Scenario: 非 UTF-8 参数到达外部进程

- **WHEN** 执行的命令包含无法解码为 UTF-8 的参数，且实际运行的是外部可执行文件
- **THEN** 该参数的原始字节以操作系统字符串形式进入子进程 `argv`，MUST NOT 被替换字符、截断或重新编码；经延迟 FIFO 重定向而由 `/bin/sh` 中介转发的命令，其 `argv` 同样保留原始字节序列。

#### Scenario: 原生命令名的派发绕过内建与函数

- **WHEN** 命令名自身包含非 UTF-8 字节
- **THEN** MUST NOT 派发到同名内建命令或 Shell 函数，MUST 直接按 `PATH`（含当前目录等相对条目）查找并执行可执行文件；MUST NOT 仅因命令名无法解码就报“未找到”或复用按 UTF-8 名称缓存的解析结果。

#### Scenario: 可解码命令名下的内建接收

- **WHEN** 命令名可解码为 UTF-8，但某个参数无法解码
- **THEN** 只有声明为接受原始参数值的内建命令才继续执行并自行处理该参数；其他内建命令 MUST 放弃派发，交由外部可执行文件处理，以保住参数的原始字节。

### Requirement: 内建命令无法接受非 UTF-8 参数时的失败契约

内建命令无法消费非 UTF-8 参数时 MUST 明确失败，MUST NOT 静默丢弃该参数后继续执行。

#### Scenario: 通用内建拒绝非 UTF-8 参数

- **WHEN** 会接收普通字符串参数的内建命令收到非 UTF-8 参数
- **THEN** 该调用 MUST 以内部错误失败，错误信息为 `builtin cannot accept non-UTF-8 argument`，且 MUST NOT 以去掉该参数后的剩余参数继续执行产生副作用。

#### Scenario: 声明与导出内建的诊断

- **WHEN** `declare` 系列命令（含 `local`、`readonly`）收到非 UTF-8 或赋值形式的操作数
- **THEN** MUST 在 stderr 输出 `<命令名>: <操作数>: not found`（显示模式下）或 `<命令名>: <操作数>: not a valid variable name`（定义模式下），并以通用错误（非零）退出。

#### Scenario: 导出内建的诊断

- **WHEN** `export` 收到非 UTF-8 操作数
- **THEN** MUST 在 stderr 输出 `export: <操作数>: invalid variable name`，并以用法错误码 `2` 退出。

### Requirement: Windows 上 `rmdir` 的路径分量边界

Windows 的 Win32 路径会静默折叠尾随点与空格、以及 `.`／`..` 分量；`rmdir` MUST 在解析前拒绝会因此删除另一个目录或删除操作数所指目录之外的调用。

#### Scenario: 尾随点或空格的分量

- **WHEN** 在 Windows 上执行 `rmdir`，且操作数或解析后的路径中任一非 `.`／`..` 分量以 `.` 或空格结尾
- **THEN** MUST 以无效参数（InvalidInput）拒绝，MUST NOT 执行删除；显式 verbatim 操作数（`\\?\`、`\??\` 前缀）与虚拟路径不受该拒绝约束。

#### Scenario: 末尾 `.` 与 `..` 分量

- **WHEN** 操作数的最后一个非分隔符分量恰为 `.` 或 `..`
- **THEN** `.` MUST 以无效参数拒绝，`..` MUST 以“目录非空”错误拒绝，MUST NOT 折叠该分量后删除目录自身或其父目录；当其父路径不是目录时 MUST 报“不是目录”。

### Requirement: `timeout` 的保留状态退出码

`timeout` 在 `--preserve-status` 下 MUST 以被信号终止的等价方式报告退出码，判定口径跨平台一致。

#### Scenario: 信号致死与取消回退

- **WHEN** 超时后 `timeout` 以 `--preserve-status` 报告被限制命令的退出码
- **THEN** POSIX 上 MUST 返回 `128 + N`（N 为所投递信号的编号）；Windows 无法投递信号、只能以取消回退终止进程内操作数时 MUST 返回 `128`，MUST NOT 叠加信号编号。

#### Scenario: KILL 判定

- **WHEN** 判断操作数是否死于 KILL
- **THEN** 判定条件 MUST 为“非 Windows 且所投递信号为 KILL”，命中时 MUST 返回 `137`；Windows 上 MUST NOT 因取消回退而返回 `137`。

#### Scenario: 未保留状态的默认退出码

- **WHEN** 未使用 `--preserve-status`
- **THEN** 死于 KILL 时 MUST 返回 `137`，其余超时终止 MUST 返回 `124`。

### Requirement: 进程树信号的快照式投递

向进程树投递信号 MUST 先对目标集合取快照再一次性投递，作用域限定为该命令实际启动的外部成员及其进程组，并 MUST 保护宿主进程。

#### Scenario: 信号处理中新建的子进程不受本波影响

- **WHEN** 向进程树投递 TERM，而某个成员的信号处理逻辑立即创建了清理子进程
- **THEN** 该新子进程 MUST NOT 被同一波信号命中，因为本波目标已在投递前枚举完毕。

#### Scenario: 已投递成员不重复投递

- **WHEN** 某一成员已通过进程组信号成功覆盖
- **THEN** MUST NOT 再对其投递一次，避免重新进入其 TERM 陷阱或杀死它刚创建的清理子进程；仅当进程组投递失败时 MUST 回退为按成员句柄投递。

#### Scenario: 取消作用域与宿主保护

- **WHEN** 为多进程管道或单进程命令执行取消清理
- **THEN** 多进程管道的作用域 MUST 覆盖实际启动的全部外部成员（脱离子进程组的管道输入阶段仍须覆盖），单进程 MUST 只覆盖自身；宿主自身 PID 及其子树 MUST NOT 收到信号，宿主被误列为后代时 MUST 整棵子树剪除。

### Requirement: 取消后的管道等待宽限

管道已在取消到达前启动子进程时，等待 MUST 让它们完成 TERM 清理宽限，MUST NOT 因取消而提前返回并立即硬杀。

#### Scenario: 取消不缩短清理宽限

- **WHEN** 取消信号在管道成员已成功启动之后到达
- **THEN** 等待 MUST 继续到这些成员按 TERM 清理规则结束，MUST NOT 立即销毁进程句柄或跳过宽限；已停止的成员 MUST 以轮询方式回收，剩余成员继续按取消语义等待。

### Requirement: 终止进程树时执行快照式信号投递

进程树终止路径 MUST 遵守进程树信号快照与去重合同，每一波投递前确定目标；不得因组投递后重新枚举而向本波中新建的清理子进程发信号。

#### Scenario: 组内成员处理 TERM

- **WHEN** 终止进程树时进程组成功收到 TERM，成员的处理程序启动清理子进程
- **THEN** 已由组信号覆盖的成员不再收到本波逐成员信号，新建的清理子进程不被本波命中；组投递失败时回退逐成员投递。
