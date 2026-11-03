# 依赖分析

本文件涵盖调用链提取工作流、传递依赖递归分析和依赖分类，是上下文获取的前置步骤。必须在完成依赖分析后，才能执行针对性上下文获取，确保上下文获取范围精准。

## 调用链提取工作流

### 处理流程

```
输入: 函数名
  │
  ▼
1. 查找函数定义位置 (文件:行号)
  │
  ▼
2. 调用 scripts/extract-function-callees.py 提取直接 callees
  │
  ▼
3. 对每个内部依赖函数:
   ├── 递归执行步骤 1-3
   └── 对外部依赖函数: 停止追踪
  │
  ▼
4. 将结果传递给传递依赖分析和针对性上下文获取
```

### 脚本提取（推荐）

如果环境中可用libclang，使用脚本自动提取函数调用链：

1. 使用grep/语义搜索定位被测函数定义位置（文件路径+行号）
2. 调用脚本：`python scripts/cpp/extract-function-callees.py <source_file> -l <line> -c <compile_commands.json>`
3. 解析输出，区分内部依赖和外部依赖
4. 对内部依赖递归调用脚本，直到所有外部依赖被识别

#### 脚本入参说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `source_file` | 位置参数 | 是 | 源文件路径 (.cpp 文件，不能用 .h 文件) |
| `-l` | int | 是 | 函数定义所在行号 |
| `-c` | string | 是 | compile_commands.json 文件路径，用于获取编译参数。**注意**：虽然标记为必填，但脚本代码中无该参数时会直接报错退出，实际为必填 |

**调用示例**:

```
bash tool:
- command: python {skill-path}/scripts/extract-function-callees.py /path/to/file.cpp -l 232 -c /path/to/compile_commands.json
- workdir: 当前工作目录
```

#### 脚本输出说明

**输出格式**:
```
function_name /path/to/file.cpp:123 (内部依赖)
function_name /path/to/file.h:456 (内部依赖) [需查找实现位置]
function_name /path/to/header.h:78 (外部依赖)
```

注意：当内部依赖显示 `[需查找实现位置]` 时，表示该函数实现在其他 .cpp 文件中，需要进一步查找。

#### 脚本输出递归处理

根据脚本输出的 `(内部依赖)` / `(外部依赖)` 标识处理:
- **(外部依赖)**: 停止递归，记录为Mock目标候选
- **(内部依赖)**: 
  - 位置在 .cpp 中定义的函数: 直接用该位置调用脚本递归
  - 位置在 .h 中且带 `[需查找实现位置]` 标记: 在同类其他 .cpp 文件中搜索实现位置后再递归

### 脚本关键约束

- **必须先查找函数位置再调用脚本** - 脚本需要文件路径和行号，不能直接用函数名, 不能用头文件作为文件路径，脚本会报错
- **内部依赖才递归** - 外部依赖直接标记停止
- **避免重复处理** - 用 set 记录已处理的函数，避免循环
- **关注 `[需查找实现位置]` 标记** - 有此标记的内部依赖需要查找函数实现，如果查找不到，停止递归处理

### 调用链输出格式

```
function_a() [file_a.cpp:10]
  └── function_b() [file_a.cpp:25] (内部依赖)
      ├── function_c() [file_a.cpp:40] (内部依赖)
      │   └── external_lib_a() [/path/to/file_b.cpp] (外部依赖)
      │   └── external_lib_b() [/path/to/file_b.cpp] (外部依赖)
      └── function_d() [file_b.h:18] (内部依赖)
      │   └── 【该函数的定义在头文件中，不展开分析】
```

### 手动推理（降级方案）

libclang不可用时，通过阅读源代码人工分析调用关系。标注：`[跳过: 调用链脚本提取，原因: libclang不可用，改用手动推理]`

### 上下文提取脚本

使用 `node {SKILL_DIR}/scripts/cpp/ut_code_analysis.js` 提取上下文到临时工作目录（Windows 下路径反斜杠须改为正斜杠）。脚本不可用时手动读取，但必须遵循探索范围约束。

## 传递依赖分析

当被测函数调用同类成员函数或同模块内部函数时，仅分析一层调用不足以识别所有外部依赖。必须对被调用的内部函数也进行依赖分析，确保Mock覆盖完整。

### 规则1：同类成员函数必须分析

如果被测函数调用了同类的其他成员函数，必须对这些成员函数进行与被测函数同等深度的依赖分析。

**示例**：

```cpp
class ServerManager {
public:
    RadiusServer* GetRadiusServer(const std::string& key) {
        // 调用了同类成员函数
        if (!IsInitialized()) return nullptr;  // ← 必须分析IsInitialized的依赖
        auto it = server_map_.find(key);
        return (it != server_map_.end()) ? it->second : nullptr;
    }

private:
    bool IsInitialized() {
        return config_loader_->IsLoaded();  // ← 依赖config_loader_
    }
    
    ConfigLoader* config_loader_;  // ← 外部依赖，需要Mock
    std::map<std::string, RadiusServer*> server_map_;
};
```

**分析要求**：
- 识别GetRadiusServer调用IsInitialized
- 分析IsInitialized依赖config_loader_
- 结论：GetRadiusServer的外部依赖包括config_loader_，需要Mock

### 规则2：构造函数依赖必须分析

如果被测类的构造函数中调用了外部依赖（如数据库查询、网络连接），必须识别并Mock这些依赖。

**示例**：

```cpp
class UserManager {
public:
    UserManager() {
        db_connection_ = Database::Connect();  // ← 构造函数中的外部依赖
        cache_ = CacheManager::GetInstance();  // ← 构造函数中的外部依赖
    }
    
    User GetUser(int id) {
        return db_connection_->Query(id);  // ← 直接依赖
    }
};
```

**分析要求**：
- 识别构造函数中的Database::Connect和CacheManager::GetInstance
- 在测试Fixture的SetUp中必须Mock或处理这些依赖
- 否则测试会在构造阶段卡住或崩溃

### 规则3：数据库/外部服务依赖识别

当代码中使用了数据库操作（SQL查询、连接池等），识别数据库依赖并确定Mock策略：

1. **如果有数据库接口类**：Mock该接口类
2. **如果直接使用SQL API**：Mock SQL API函数
3. **如果使用静态数据结构模拟数据库**：不需要Mock，直接操作数据结构

**关键判断**：不要对查询接口内部的数据结构进行Mock。如果增删改查是配套接口，优先使用增接口构造数据，再使用查询接口验证。

### 规则4：迭代器/集合遍历依赖

当代码使用迭代器遍历集合（如ClassIterator），分析迭代器是否依赖外部状态：

```cpp
void processDevices() {
    ClassIterator it(MITManager::Instance()->GetRoot(), "Device", NOT_LOCK, 1);
    while (it) {
        // 处理设备
        ++it;
    }
}
```

**分析要求**：
- 识别MITManager::Instance()是外部依赖
- 识别GetRoot()返回值影响遍历结果
- 需要Mock MITManager或设置测试数据

### 传递依赖分析流程

1. 列出被测函数的所有直接调用
2. 对每个内部调用（同类成员函数、同模块函数），递归分析其外部依赖
3. 合并所有传递依赖，形成完整的Mock需求清单
4. 记录传递依赖分析结果

### 传递依赖输出模板

```
被测函数：GetRadiusServer
直接调用：IsInitialized, server_map_.find
传递依赖：
  - IsInitialized → config_loader_->IsLoaded() → 需要Mock config_loader_
外部依赖汇总：
  - config_loader_ (ConfigLoader*) → 需要Mock
Mock策略：
  - 使用MockConfigLoader替代config_loader_
  - 测试IsInitialized返回true和false两种场景
```

## 依赖分类

- **内部依赖**（禁止Mock）：同类成员函数、同模块内部函数
- **外部依赖**（必须Mock）：实现不在本类或本文件的函数
- 严禁将内部依赖误判为外部依赖
