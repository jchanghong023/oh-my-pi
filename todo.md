# 清理内置 OpenSpec 的非业务文件

## 目标与范围

只清理此前整仓复制时带入的上游研发、测试、文档、网站和发布管理材料。保留完整上游业务代码、运行资源、许可证及必要构建输入，不修改业务实现，不做 OMP 适配。

- 唯一清理目录：`F:\code2026\oh-my-pi\packages\coding-agent\src\spec-driven\vendor\resources\openspec`。
- 上游参考目录：`C:\Users\jiang\Documents\OpenSpec`，只读，不删除或修改。
- 此文件是执行计划，以下任务均未由本次编写操作执行。
- 之前“目标必须与上游整个仓库文件集合完全一致”的标准作废；现在仅要求保留文件与固定来源一致，删除项符合明确清单。

## 1. 保留清单

下列目录整树保留，不根据文件名称继续裁剪其内部模块：

| 路径 | 用途 |
|---|---|
| `src/` | 完整业务实现，含 CLI、工作流、提示词、工具适配、校验、迁移和历史指纹数据 |
| `bin/` | 原生 CLI 启动入口 |
| `schemas/` | 内置 schema 和模板，运行时按相对路径读取 |
| `skills/` | 全部原版 Skill 资源，不仅是默认 core 五／六项 |

下列根文件原样保留：

| 路径 | 用途 |
|---|---|
| `package.json` | ESM、依赖、版本、入口及构建声明；CLI 实际读取其版本 |
| `pnpm-lock.yaml` | 上游锁定依赖输入 |
| `pnpm-workspace.yaml` | 单包工作区及依赖 overrides；不能误当多仓管理材料删除 |
| `tsconfig.json` | src → dist 的上游构建配置 |
| `build.js` | 上游 build／prepare 使用的构建入口 |
| `LICENSE` | 上游许可声明 |
| `.gitattributes` | 保留原文件属性及换行约定 |
| `.gitignore` | 避免后续生成的依赖／构建文件被意外纳入版本管理 |

注意：

- `src/core/templates/`、`src/prompts/`、`src/core/command-generation/` 和历史迁移／指纹模块都是业务源码，不是待删除的文档或旧测试。
- 上游源码中提到用户项目的 `.agents/skills/`、`openspec/` 或在线安装器 URL，不代表依赖 vendor 根下同名研发目录；不因此保留上游自己的需求档案，也不删掉对应业务实现。
- 当前 package.json 包含测试、发布和资源维护脚本。此次保持其原文，不连带裁剪 devDependencies 或重写锁文件；这些独立仓库维护命令不再属于本副本的可执行承诺。保留的 build／prepare 入口使用 build.js，不依赖下列 scripts/ 维护目录。

## 2. 明确删除清单

只删除目标根下列出的项，不使用全仓名称匹配或“凡不在白名单就删”的命令。

### 目录

- [ ] `test/`：上游测试及 fixtures，不是 OMP 宿主测试。
- [ ] `docs/`、`docs-lab/`：文档及文档站材料。
- [ ] `website/`：上游网站工程及其依赖配置。
- [ ] `assets/`：上游 README／网站展示图片；此次已检查的业务源码、bin 和 build.js 未发现对该目录的本地资源依赖。
- [ ] `openspec/`：上游自身的需求、变更、探索及计划档案。
- [ ] `.agents/`：用于开发上游仓库的项目级技能副本，不是根 `skills/` 的业务资源。
- [ ] `.github/`：上游 CI、Issue／PR 模板和维护配置。
- [ ] `.changeset/`：上游发布版本管理材料。
- [ ] `.devcontainer/`：上游开发容器配置。
- [ ] `scripts/`：上游独立二进制发行、安装验证、技能文档生成和维护脚本。本轮不运行这些维护命令，也不删除 src 内的安装／更新业务实现。

### 根文件

- [ ] `README.md`、`README_OLD.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`MAINTAINERS.md`、`SECURITY.md`、`install.md`：上游展示与维护说明；许可证单独保留。
- [ ] `openspec-parallel-merge-plan.md`：上游研发计划。
- [ ] `AGENTS.md`：复制进来的上游仓库开发规则文件，不是 OMP 根规则。
- [ ] `vitest.config.ts`、`vitest.setup.ts`、`eslint.config.js`：上游专用测试／lint 配置。
- [ ] `.actrc`、`.coderabbit.yaml`：上游 CI 本地模拟和评审配置。
- [ ] `flake.nix`、`flake.lock`：上游独立 Nix 环境配置，不参与当前 package.json 的 Node 构建入口。

## 3. PowerShell 执行步骤

### 3.1 固定路径、备份并预览

- [ ] 在 PowerShell 执行以下整段。若目录不符或保留项缺失，停止，不扩大清理范围。
- [ ] 备份完成后检查打印的删除列表。备份放在仓库外，便于恢复，不写入 vendor 资源树。

```powershell
$repo = 'F:\code2026\oh-my-pi'
$relative = 'packages\coding-agent\src\spec-driven\vendor\resources\openspec'
$root = (Resolve-Path -LiteralPath (Join-Path $repo $relative) -ErrorAction Stop).Path
$expected = [IO.Path]::GetFullPath((Join-Path $repo $relative)).TrimEnd('\')
if ($root.TrimEnd('\') -ne $expected) { throw "目标路径不符：$root" }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw '目标是链接或 junction，停止清理'
}

$keepDirs = @('src', 'bin', 'schemas', 'skills')
$keepFiles = @(
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'tsconfig.json', 'build.js', 'LICENSE', '.gitattributes', '.gitignore'
)
foreach ($name in ($keepDirs + $keepFiles)) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $name))) {
        throw "保留项缺失：$name"
    }
}

$removeDirs = @(
    'test', 'docs', 'docs-lab', 'website', 'assets', 'openspec',
    '.agents', '.github', '.changeset', '.devcontainer', 'scripts'
)
$removeFiles = @(
    'README.md', 'README_OLD.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
    'MAINTAINERS.md', 'SECURITY.md', 'install.md', 'openspec-parallel-merge-plan.md',
    'AGENTS.md', 'vitest.config.ts', 'vitest.setup.ts', 'eslint.config.js',
    '.actrc', '.coderabbit.yaml', 'flake.nix', 'flake.lock'
)
$deleteNames = $removeDirs + $removeFiles
$knownNames = $keepDirs + $keepFiles + $deleteNames
$unexpected = @(Get-ChildItem -LiteralPath $root -Force |
    Where-Object { $_.Name -notin $knownNames })
if ($unexpected.Count -gt 0) {
    $unexpected | Select-Object Name, FullName
    throw '发现清单外项目，先核对用途，不自动删除'
}

# 本次已知快照无符号链接。若执行时出现链接，停止并核对，避免递归越界。
$links = @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
if ($links.Count -gt 0) { throw '目录内存在链接，先核对链接范围再清理' }

$backup = Join-Path ([IO.Path]::GetTempPath()) ('omp-openspec-prune-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $root -Destination (Join-Path $backup 'openspec') -Recurse -Force -ErrorAction Stop

# 记录清理前全目录文件内容，清理后对保留文件逐项核对。
$prefix = $root.TrimEnd('\') + '\'
$before = @(Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction Stop |
    ForEach-Object {
        [PSCustomObject]@{
            Path = $_.FullName.Substring($prefix.Length)
            Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
    })
$before | Export-Csv -LiteralPath (Join-Path $backup 'before.csv') -NoTypeInformation -Encoding UTF8
$deleteNames | ForEach-Object {
    $p = Join-Path $root $_
    if (Test-Path -LiteralPath $p) { Get-Item -LiteralPath $p -Force }
} | Select-Object Name, FullName
Write-Host "备份位置：$backup"
```

### 3.2 执行清理

- [ ] 确认上述预览只涉及 vendor 中的 OpenSpec 副本后，在同一个 PowerShell 会话执行：

```powershell
foreach ($name in $deleteNames) {
    $target = Join-Path $root $name
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    }
}
```

### 3.3 一次性文件校验

- [ ] 在同一个 PowerShell 会话执行以下检查：删除项不存在，保留项齐全，保留文件内容未变化，没有新文件混入。

```powershell
foreach ($name in $deleteNames) {
    if (Test-Path -LiteralPath (Join-Path $root $name)) { throw "删除项仍存在：$name" }
}
foreach ($name in ($keepDirs + $keepFiles)) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $name))) { throw "保留项丢失：$name" }
}
$expectedFiles = @($before | Where-Object {
    $top = ($_.Path -split '\\', 2)[0]
    $top -in ($keepDirs + $keepFiles)
})
$actualFiles = @(Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction Stop |
    ForEach-Object {
        [PSCustomObject]@{
            Path = $_.FullName.Substring($prefix.Length)
            Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
    })
$diff = @(Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $actualFiles -Property Path, Hash)
if ($diff.Count -gt 0) { $diff | Format-Table; throw '保留文件集合或内容发生非预期变化' }
$extra = @(Get-ChildItem -LiteralPath $root -Force |
    Where-Object { $_.Name -notin ($keepDirs + $keepFiles) })
if ($extra.Count -gt 0) { throw '存在清单外项目' }
Write-Host "PASS：清理完成，保留文件内容未变；备份：$backup"
```

## 4. 边界与交付

- [ ] 不修改 `C:\Users\jiang\Documents\OpenSpec`；不清理 OMP 根目录的 `openspec/`、`test/` 或其他目录。
- [ ] 不修改 OMP 自有 `packages/coding-agent/test/spec-driven/`；其中旧定制测试和对应宿主代码的处置不属于本次第三方文件裁剪。
- [ ] 不裁剪 `src/` 的业务模块，不修改 Skill、schema、package.json 或锁文件，不恢复任何 OMP 魔改。
- [ ] 不安装依赖、不运行构建或测试、不执行上游发布／资源维护脚本、不提交、不推送。
- [ ] 将完成项勾选并记录实际备份路径和文件校验结果。已有完整还原记录属于前一阶段，不能作为本次清理已完成的证明。

## 完成标准

目标顶层仅保留第 1 节的 4 个目录和 8 个文件；内部业务文件集合及内容与清理前相同。文件校验通过后结束，不追加宿主适配。

本计划中的 PowerShell 为按当前目录与源码编写的待执行步骤，编写时未运行。校验只证明本次删除没有改动保留代码，不证明 OMP 已能加载或运行 OpenSpec；当前副本没有 dist／运行依赖时，本次也不补建。
