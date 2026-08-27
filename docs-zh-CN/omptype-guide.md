# omptype 指南（本仓库的 schema 编写方式）

内部 schema 使用 **`@oh-my-pi/omptype`** —— 一个兼容 ArkType 的校验器，运行时采用懒编译 JIT（`packages/omptype`）。使用以下方式定义类型：

```ts
import { type } from "@oh-my-pi/omptype";
```


## 为什么选用 omptype（性能约定）

- `type()` 构造比 arktype 快约 100 倍（无急切代码生成，无需节点内部化）。
- 前两次调用走解释器；第三次调用通过 `new Function` JIT 编译出专用的校验器。热路径校验耗时仅几十纳秒；失败时分配一个带有懒消息构建的小错误对象。
- 没有 `jitless` 开关，也没有 `scope()` —— 懒编译 JIT 已经消除了它们原本试图回避的启动开销。直接导入 `type` 即可。

## 检测约定（请勿破坏）

`packages/ai/src/utils/schema/wire.ts` 区分两种 schema：

- **omptype** = 可调用函数，并带有 `.toJsonSchema` 和 `.assert` 方法（`isArkSchema`）。
- **JSON Schema** = 普通对象。

在 provider 边界，`toolWireSchema()` 会调用 `toJsonSchema()`，裁剪 `T | undefined` 分支，并使用 `additionalProperties: false` 闭合已声明的对象。谓词（`.narrow`）和变形（`.pipe`）在本地校验，但在传输时退化为其基础 schema。

## 定义语言（兼容 arktype 的子集）

| 构造 | 形式 |
| -------------------------- | ----------------------------------------------------------------- |
| 基本类型 | `"string"`、`"number"`、`"boolean"`、`"null"`、`"undefined"`、`"unknown"`、`"object"`、`"bigint"` |
| 整数 | `"number.integer"` |
| URL 字符串 | `"string.url"` |
| 字面量 | `"'x'"`、`"5"`、`"true"` |
| 联合 | `"'a' \| 'b'"`、`"string \| null"` |
| 数组 | `"string[]"`、`"(string \| number)[]"`、`[def, "[]"]` |
| 边界 | `"number >= 0"`、`"0 < number <= 3600"`、`"1 <= string <= 10"` |
| 可选键 | `{ "limit?": "number" }` 或值后缀形式 `{ limit: "number?" }` |
| 默认值 | `{ count: "number = 10" }`、`type("string[]").default(() => [])` |
| 未声明键 | `"+": "reject"`（失败）/ `"+": "delete"`（剥离）/ 默认保留 |
| 记录类型 | `{ "[string]": "number" }` —— 不是 `"Record<string, number>"` |
| 运行时枚举 | `type.enumerated(...RUNTIME_ARRAY)` |
| 运行时构建的对象定义 | `type.raw({...})`（返回 `BaseType`） |
| 关键字静态链 | `type.number.atLeast(5).atMost(300)`、`type.string` |

## 校验（与 arktype 相同）

```ts
import { type } from "@oh-my-pi/omptype";
const out = schema(value);
if (out instanceof type.errors) {
  // out.summary → 人类可读消息；条目包含 .path（数组）和 .problem
  throw new Error(out.summary);
}
// `out` 是经过校验/变形后的值（默认值已填充，多余字段已剥离）
```

- 失败时返回 `OmpErrors`（`OmpError` 数组）；`type.errors === OmpErrors`。
- 校验是快速失败的：每次失败对应一条错误条目。
- 变形永不会修改入参；当默认值/`"+": "delete"`/管道生效时，会返回一个新对象。
- 切勿在工具校验中使用 `.allows()` —— 它会跳过变形/默认值/管道。
- `.infer` / `.inferIn` 仅用于类型推断。
- 定义错误（DSL 不合法、组合非法）会在调用 `type()` 时抛出 `OmpTypeError`。

## 方法

`.describe(d)`、`.default(v | () => v)`、`.or(TypeOrStringDef)`、`.and(Type)`、`.array()`、`.atLeastLength(n)` / `.atMostLength(n)`（字符串/数组）、`.atLeast(n)` / `.atMost(n)`（数字）、`.pipe(fn)`、`.narrow(fn)`（配合 `ctx.mustBe("...")`）、`.allows(v)`、`.assert(v)`、`.toJsonSchema()`。

关于 `.or()` 的类型说明：schema 与字符串操作数可以精确推导；对象字面量操作数会降级 —— 请先用 `type({...})` 包装。

## 适配器

TypeBox 风格和 Zod 风格的写法底层均由 omptype 运行时支持：

```ts
import { Type, type Static } from "@oh-my-pi/omptype/typebox";
import { z } from "@oh-my-pi/omptype/zod";

const User = z.object({ name: z.string() });
type User = z.infer<typeof User>;
```

这些写法会生成真正的 omptype schema，具备 JIT 校验和 `toJsonSchema`。内部代码直接使用字符串 DSL 进行编写。
