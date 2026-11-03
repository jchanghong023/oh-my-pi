---
name: codecovcli-check
description: 检查 codecovcli 是否已安装，未安装则自动安装，已安装则对比版本并更新
---

# codecovcli 安装检查与版本更新

本参考文档描述如何在执行覆盖率分析前检查 codecovcli 的安装状态，并在必要时进行安装或更新。

---

## Step 0: 检查 codecovcli 是否已安装

先检查 `codecovcli` 是否已安装：

```bash
codecovcli --version
```

### 如果未安装

执行以下安装步骤：

#### Step 0.1: 配置华为内部 npm 仓库

```bash
npm config set @baize:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/
```

#### Step 0.2: 安装 codecovcli 插件

```bash
npm install -g @baize/codecovcli@latest
```

安装完成后验证：

```bash
codecovcli --version
```
