# macOS 签名与公证

GitHub Releases 上发布的已编译 macOS `omp` 二进制文件可以使用 **Developer ID Application**
证书进行签名，并由 Apple 进行**公证**。这使得它们可以被 Gatekeeper 接受，也是提交到官方
Homebrew 的前提条件（参见 [#776](https://github.com/can1357/oh-my-pi/issues/776)）。

签名在 CI 中的 `release_binary_darwin` 矩阵任务（`.github/workflows/ci.yml`）里通过
`scripts/ci-macos-sign.sh` 完成。除非下面列出的全部五个 `APPLE_*` 仓库密钥都已配置，
否则该工作流步骤会**自动跳过**，因此在缺少凭据时发布的版本会保持临时（ad-hoc）签名状态。
脚本本身不会跳过：在缺少任何必需凭据的情况下调用它将会报错。

## 工作原理

1. `ci:release:build-binaries` 构建二进制文件并进行**临时（ad-hoc）**签名（以便它可以在
   构建运行器上运行）。
2. `scripts/ci-macos-sign.sh` 接着会：
   - 将 Developer ID 证书导入到一个一次性使用的钥匙串中；
   - 使用 `--options runtime --timestamp`（强化运行时 + 安全时间戳）以及
     `--entitlements scripts/macos-entitlements.plist` 重新签名；
   - 在新签名下运行 `--version` 和 `--smoke-test`，以便快速失败；
   - 通过 `notarytool submit --wait` 对二进制文件进行公证。
3. `release_github_verify` 重新下载已发布的 arm64 资源，运行 `codesign --verify --strict`
   以及两个启动检查；并且——在已配置签名密钥时——还会断言签名不是临时签名。

### 为什么这些授权项是必需的

该二进制文件是 Bun 的单文件可执行文件，因此强化运行时需要：

| 授权项                                                  | 原因                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.security.cs.allow-jit`                        | JavaScriptCore 在运行时执行 JIT 编译。                                                                                                                                                                                                                                                                                                                                          |
| `com.apple.security.cs.allow-unsigned-executable-memory` | JSC 的可执行内存页。                                                                                                                                                                                                                                                                                                                                                             |
| `com.apple.security.cs.disable-library-validation`       | omp 将其原生插件（`pi_natives.<triple>.node`）以及其他可选的 dylib 提取到运行时缓存中并通过 `dlopen()` 加载它们。它们与主二进制文件的 Team ID 不同，因此如果没有这项授权项，强化运行时会以_"mapping process and mapped file have different Team IDs"_ 错误中止——这实际上会破坏每一条命令。 |

如果没有 `disable-library-validation`，已签名并公证的二进制虽然可以顺利完成签名和公证，
但**在首次实际使用时就会失败**。`scripts/ci-macos-sign.sh` 在签名之后运行 `--smoke-test`，
目的就是在公证之前捕捉到这个问题。

### Stapling 限制（重要）

裸的 Mach-O 可执行文件**无法被打上公证票据**（`stapler` 仅支持 `.app`/`.pkg`/`.dmg`）。
该二进制实际上是经过公证的——`notarytool` 返回 `Accepted`，并且票据存在于 Apple 的服务器上，
以其 cdhash 为键——但该票据必须在线获取，而无法从可执行文件中读取。
`release_github_verify` 会输出 `spctl -a -t exec -vv` 供查看，但不会以此作为发布的门禁：
当在线票据不可用时，未打票据的裸二进制文件可能会产生非零的评估结果，而这种情况本身并不属于
签名或凭据失败。

实际意义如下：

- `curl https://omp.sh/install | sh` —— `curl` 不会设置隔离位（quarantine bit），因此
  Gatekeeper 不会被触发。
- Homebrew **formula** 安装 —— Homebrew 不会对 formula 文件设置隔离位，因此
  Gatekeeper 不会被触发。
- 任何会对二进制文件**设置隔离位**的场景（浏览器下载，或 Homebrew **cask**）都需要
  Apple 的在线票据查询。对于需要离线分发的产物，请将二进制文件打包到可打票据且经过公证的
  **`.pkg` 或 `.dmg`** 中（`xcrun stapler staple` 对这些格式有效）。对于 `curl`/formula
  路径，这一步不是必需的。

## 必需的 GitHub 密钥

请在 **Settings → Secrets and variables → Actions**（仓库密钥）下添加以下密钥。
所有五个密钥（证书、密码以及 API 密钥三件套）必须全部就位，签名才会生效。

| 密钥                         | 内容                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE_P12`      | 导出的 Developer ID Application `.p12`（证书 + 私钥）的 base64 编码。          |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码。                                                     |
| `APPLE_API_KEY_ID`           | App Store Connect API **Key ID**。                                            |
| `APPLE_API_ISSUER_ID`        | App Store Connect API **Issuer ID**（UUID）。                                 |
| `APPLE_API_KEY`              | App Store Connect `.p8` 私钥的 base64 编码。                                  |

### 生成凭据文件

将这些文件放到一个工作目录中（默认为 `~/omp-signing`）：

| 文件                 | 生成方法                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.p12`              | **钥匙串访问** → 右键单击你的_Developer ID Application: …_身份（即那条会展开为带私钥的证书的记录）→ **导出…** → 另存为 `.p12` 并设置密码。                                                                                                      |
| `p12-password.txt`   | 你刚才为 `.p12` 设置的密码。                                                                                                                                                                                                                      |
| `AuthKey_<KEYID>.p8` | App Store Connect → **Users and Access → Integrations → App Store Connect API** → 创建一个密钥（**Account Holder** 角色也允许创建 API 证书；**Developer** 角色对于公证已足够）→ **仅能下载一次**（无法恢复）。                                |
| `issuer-id.txt`      | 在密钥表格上方显示的 **Issuer ID**（UUID）。                                                                                                                                                                                                      |
| `key-id.txt`         | _可选_ —— Key ID；否则从 `.p8` 文件名中读取。                                                                                                                                                                                                     |

App Store Connect API 密钥是**无法**通过 CLI 创建的那一项凭据——它本身是 API 的引导凭据，
且 `.p8` 只能下载一次。其他都是本地操作。

### 上传时不在终端打印密钥值

`scripts/ci-macos-upload-secrets.sh` 会校验这些文件（使用你的密码打开 `.p12`，并对 `.p8`
进行健全性检查），然后将每个值通过 stdin 管道传给 `gh secret set`——任何密钥都不会被打印到
终端、argv 或 shell 历史记录中：

```sh
scripts/ci-macos-upload-secrets.sh ~/omp-signing --dry-run   # 先校验
scripts/ci-macos-upload-secrets.sh ~/omp-signing             # 上传全部五个
gh secret list --repo can1357/oh-my-pi                       # 确认
```

每当证书续期时，请重新运行此脚本。

### 查找你的签名身份 / Team ID（健全性检查）

```sh
security find-identity -v -p codesigning
# 例如："Developer ID Application: Your Name (TEAMID1234)"
```

脚本会自动选择第一个 `Developer ID Application` 身份；你无需将身份字符串或 Team ID
存储为密钥。

## 本地试运行

你可以通过导出五个环境变量，在本地（使用真实证书和 API 密钥）执行完整的签名+公证流程：

```sh
RELEASE_TARGETS=darwin-arm64 bun run ci:release:build-binaries
APPLE_CERTIFICATE_P12=… APPLE_CERTIFICATE_PASSWORD=… \
APPLE_API_KEY_ID=… APPLE_API_ISSUER_ID=… APPLE_API_KEY=… \
  bash scripts/ci-macos-sign.sh packages/coding-agent/binaries/omp-darwin-arm64
```
