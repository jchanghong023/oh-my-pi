# Codecheck 告警类型路由

根据 `run-codecheck.js` 脚本输出的 JSON 中 `alarms` 数组每条告警的 `rule` 字段，路由到对应的修复策略。

## 规则 1: Java是否存在断言检查
- **触发条件**: 告警的 `rule` 字段为 `Java是否存在断言检查`
- **特征**: 测试方法内无 Assert.*、assert*、verify*、expect、andExpect 调用
- **目标章节**: [fix-strategies-codecheck.md §1 缺少断言](fix-strategies-codecheck.md#1-缺少断言-missing-assertion)

## 规则 2: Java是否虚假断言
- **触发条件**: 告警的 `rule` 字段为 `Java是否虚假断言`
- **特征**: 仅使用 assertNotNull，缺少内容断言；assertTrue 参数为常量 true；assertEquals 两个参数为相同常量
- **目标章节**: [fix-strategies-codecheck.md §2 虚假断言](fix-strategies-codecheck.md#2-虚假断言-fake-assertion)

## 规则 3: Java中途退出检查
- **触发条件**: 告警的 `rule` 字段为 `Java中途退出检查`
- **特征**: for/while 循环体内包含 return；if/else 分支内包含 return
- **目标章节**: [fix-strategies-codecheck.md §3 中途退出](fix-strategies-codecheck.md#3-中途退出-early-exit-fix)
