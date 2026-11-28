# Spec Delta

## Purpose

让可信隔离内网中的 Windows 和 CentOS 7 终端用户通过房号进行实时会话协作，来宾无需登录，且房间随主持会话结束而失效。

## ADDED Requirements

### Requirement: 编号房实时协作

在可信隔离内网中，Windows 和 CentOS 7 终端 MUST 提供 `/collab2 <房间号>` 和 `/collab2 join <房间号>`，允许多位来宾免登录加入主持会话。

#### Scenario: 多位来宾加入同一房间
- **WHEN** 主持人开房成功，至少两位来宾分别通过同一房号加入
- **THEN** 来宾可查看主持会话的实时对话并向主持人的 AI 发消息，不在各自的原会话执行该请求。

#### Scenario: 无效的开房或加入请求
- **WHEN** 房号已占用、房间不可用或参数有误
- **THEN** 说明占用、不可用或参数错误，不覆盖其他房间或进入错误会话。

### Requirement: 离开与房间失效

来宾 MUST 可用 `/leave` 返回原会话；主持人 MUST 可用 `/collab2 stop` 关房。主持人切换会话、退出或断线后，旧房号不得再进入旧房。

#### Scenario: 来宾离开
- **WHEN** 一位来宾使用 `/leave`
- **THEN** 该来宾回到原会话，其他来宾不因该来宾离开而掉线。

#### Scenario: 主持方导致房号失效
- **WHEN** 主持人使用 `/collab2 stop`、切换会话、退出或断线
- **THEN** 旧房号不可再用于加入旧房。
