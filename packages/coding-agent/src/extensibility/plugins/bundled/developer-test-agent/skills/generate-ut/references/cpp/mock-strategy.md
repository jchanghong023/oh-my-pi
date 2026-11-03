# Mock策略

## Mock禁令

1. **禁止循环Mock**：禁止创建wrapper函数然后Mock它们
2. **禁止Mock被测类/被测函数本身**
3. **禁止Mock标准库函数**：C标准库（string.h/stdlib.h/stdio.h/math.h）和C++标准库（string/vector/map/optional/chrono/memory等）
4. **禁止Mock私有成员函数**
5. **禁止Mock libc核心函数（Windows/MinGW）**：禁止Mock malloc/free/printf——gtest内部也调用它们会导致无限递归
6. **禁止static函数打桩**：将其逻辑作为被测函数一部分
7. **禁止Mock遍历函数**：禁止Mock HasNext/FetchNext/GetNext/Next等，应该Mock数据提供函数
8. **禁止Mock单例获取**：禁止Mock GetInstance/sInstance/GetSingleton等，应该直接Mock实例方法

## Mock策略设计原则

### 风险适配原则

| 风险等级 | Mock策略 | 说明 |
|----------|----------|------|
| 高风险依赖 | 深度Mock（正常+异常+边界） | 覆盖所有关键路径 |
| 中风险依赖 | 选择性Mock | 仅Mock必要的异常分支 |
| 低风险依赖 | 最小化Mock | 仅在必要时Mock |

### 其他原则

- **场景匹配**：异常场景不Mock正常响应，边界场景不Mock普通响应
- **最小化Mock**：仅Mock必要的依赖/方法，保留内部业务逻辑的真实实现
- **契约一致性**：Mock的返回值/异常/调用行为必须严格符合依赖的真实业务契约

## Mock配置验证点

| 验证点 | 说明 | 实现方式 |
|--------|------|----------|
| 调用验证 | Mock对象是否被正确调用 | `.expects()` + `.will()` |
| 参数验证 | 调用参数是否符合预期 | `.with(参数约束)` |
| 次数验证 | 调用次数是否正确 | `once()` / `never()` / `exactly(n)` |
| 时序验证 | 调用顺序是否正确 | `.then()` 链式调用 |

## Mock限制场景处理

当因框架限制无法Mock某个外部依赖时，必须通过替代方案触发目标分支：
- 优先方案：调整输入参数或设置内部状态来触发目标分支
- 次选方案：Mock被测函数实际调用的分配函数
- 降级方案：手动构造状态验证后续行为
