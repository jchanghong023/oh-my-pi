# Java 单元测试修复规则

本文件是 Java 单元测试修复的导航索引。详细规则拆分到以下子文件，按需查阅。

## 测试框架

- **测试框架**：JUnit 5 (`org.junit.jupiter.api.Test`)
- **Mock 框架**：Mockito (`org.mockito.Mock` / `@Mock` / `MockitoAnnotations.openMocks`)
- **断言库**：JUnit 5 Assertions (`org.junit.jupiter.api.Assertions`) 或 AssertJ

## Maven 配置提取

**优先执行脚本提取配置**：

> **Windows 路径处理（重要）**：`{SKILL_DIR}` 替换为 skill 加载时提供的 "Base directory" 路径。在 Windows 上该路径含反斜杠（如 `C:\Users\...\skills\fix-ut`）。**在 Bash 命令中必须将反斜杠替换为正斜杠**（如 `C:/Users/.../skills/fix-ut/scripts/java/extract-maven-config.js`），否则反斜杠被 Bash 转义导致 `Cannot find module` 错误。

```bash
node {SKILL_DIR}/scripts/java/extract-maven-config.js <projectDir>
```

- **有配置时**：`mvn test -q -Dtest={ClassName} -s "{settingsPath}" {mavenProperties}`
- **无配置时**：`mvn test -q -Dtest={ClassName}`

脚本无输出时从目标项目的 `AGENTS.md` 或 `DT_AGENTS.md` 读取 Maven 配置段，都没有则使用默认 Maven 命令。

## 通用原则

- **仅修复测试代码**：不修改生产代码、构建配置、第三方库
- **渐进式修复**：一次修复一类错误，修复后重新验证，避免引入新问题
- **上下文驱动**：围绕被测函数所在文件展开上下文收集
- **循环验证**：修复后必须重新验证，直到无错误或遇到无法解决的问题

## 禁止的行为（硬性约束 — 违反即视为无效修复）

**禁止使用 `assertNotNull` / `assertNull` 作为断言**（无论单独或与精确断言组合）：
- 不能验证有意义的业务逻辑，属于虚假断言
- 若返回值为 null，后续调用 `.getXxx()` 会自然抛出 NPE，无需前置检查
- 修复时必须**删除** `assertNotNull`，用精确断言替换，不得保留
- 无法确定预期值时，应通过日志确认实际值，或标记该测试需要人工 Review

## 两阶段流程硬性约束（Java 专属 — 覆盖 SKILL.md 通用流程）

Java 修复流程由**阶段 1（编译/运行时错误修复）**和**阶段 2（Codecheck 告警检查与修复）**两个阶段组成。**两个阶段都必须执行，不允许跳过任何阶段**：

- **阶段 1 无错误时，必须继续执行阶段 2**，不得提前结束
- **阶段 1 修复完成（错误消除）后，必须继续执行阶段 2**，不得提前结束
- **仅当阶段 2 中 codecheck 执行失败（`success: false`）时**，才允许跳过阶段 2，结束流程
- SKILL.md 中"如不存在错误则结束"的通用判定在 Java 场景下**不适用**，以本文件的两阶段流程为准

## 执行流程

### 阶段 1: 编译/运行时错误修复

1. **获取错误**：执行 Maven 编译运行，捕获编译/运行输出，获取错误信息
2. **判定**：无错误 → **必须进入阶段 2**（不得结束）；有错误 → 继续
3. **路由**：读取 [route-runtime.md](route-runtime.md)，按优先级 0-4 匹配错误类型
4. **策略**：读取 [fix-strategies-runtime.md](fix-strategies-runtime.md) 对应章节
5. **修复循环**（最多 10 轮）：
   - 上下文信息收集：围绕被测函数所在文件展开
   - 生成修复：通过 Edit 工具修复测试代码，一次修复一类错误
   - 校验结果：重新执行 Maven 测试，确认错误是否消除
   - 错误消除 → **必须进入阶段 2**（不得结束）；未消除 → 继续循环
6. **循环限制**：达到 10 轮后，使用 `@Disabled` 禁用无法修复的用例，保留完整代码并注明原因

### 阶段 2: Codecheck 告警检查与修复

1. **安装检查**：读取 [codecheck-check.md](codecheck-check.md)，确保 codecheckcli 已安装
2. **执行检查**：
   ```bash
   node skills/fix-ut/scripts/java/run-codecheck.js <projectDir> <testFileRelativePath>
   ```
3. **读取结果**：从脚本 stdout JSON 读取结果
   - `success: false` → codecheck 执行失败，跳过，结束
   - `success: true, alarmCount: 0` → 无告警，结束
   - `success: true, alarmCount > 0` → 继续
4. **路由**：读取 [route-codecheck.md](route-codecheck.md)，按告警 `rule` 字段匹配
5. **策略**：读取 [fix-strategies-codecheck.md](fix-strategies-codecheck.md) 对应章节
6. **修复循环**（最多 3 轮，`currentRound = 1`）：
   - 按告警类型修复：通过 Edit 工具修复测试代码
   - 执行 Maven 测试确认无报错：
     - 有报错 → 读取 route-runtime.md → fix-strategies-runtime.md 对应章节修复（不计入 3 轮），继续验证 Maven 测试
     - 无报错 → 继续
   - 执行 codecheck 再次检查：`node skills/fix-ut/scripts/java/run-codecheck.js <projectDir> <testFileRelativePath>`
   - `success: false` → 输出 "Codecheck 执行失败，跳过验证"，结束
   - `alarmCount == 0` → 输出 "Codecheck 验证通过，告警已清零"，结束
   - `currentRound < 3` → `currentRound++`，继续循环
   - `currentRound >= 3` → 输出 "已达到最大修复轮次(3)，剩余 N 个告警未修复"及告警详情，结束

## 详细规则索引

| 主题 | 子文件 | 涵盖内容 |
|------|--------|----------|
| 编译/运行时路由 | [route-runtime.md](route-runtime.md) | 5 个优先级匹配规则：编译时异常、反射、运行时异常、Mock框架、参数匹配器 |
| Codecheck 告警路由 | [route-codecheck.md](route-codecheck.md) | 3 种告警规则：缺少断言、虚假断言、中途退出 |
| 编译/运行时修复策略 | [fix-strategies-runtime.md](fix-strategies-runtime.md) | 5 个修复策略章节：参数匹配器、Mock配置、反射、运行时异常、编译时异常 |
| Codecheck 告警修复策略 | [fix-strategies-codecheck.md](fix-strategies-codecheck.md) | 3 个修复策略章节：缺少断言、虚假断言、中途退出 |
| codecheckcli 检查 | [codecheck-check.md](codecheck-check.md) | codecheckcli 安装检查、版本对比、自动安装、华为内部 npm 仓库配置 |
| codecovcli 检查 | [codecovcli-check.md](codecovcli-check.md) | codecovcli 安装检查、版本对比、自动安装、华为内部 npm 仓库配置 |

## 工作语言

始终使用简体中文作为工作语言。
