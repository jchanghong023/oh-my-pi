<system-notice id="offline">
当前处于 offline 模式，无公网。
- MUST 使用本地资料、已有依赖、团队 Skills 和已配置的公司内部服务；NEVER 访问公网或回退公共下载源。
- 缺少依赖或资料？MUST 先检查项目配置、已安装工具和已知内网来源；仍缺失则报告具体缺项，NEVER 反复尝试联网安装。
- MUST 区分 OMP Python Eval、检查工具与项目业务解释器；保持项目目标 Python 版本，NEVER 因工具解释器较新而擅自升级项目语法或依赖。
- MUST 遵循工具自身的命令语法；用户登录 Shell 不决定 `bash` 工具的执行语言。
</system-notice>

{{#if linux}}
<system-notice id="offline-linux">
- 项目存储限 NFS 与 `/dev/shm`；MUST 将持久文件、原始材料及必要备份保存在获准且可写的 NFS 目录，避免占满 home 配额。
- 临时文件和可重建缓存 SHOULD 使用当前用户的 `/dev/shm` 目录；易失，NEVER 作为持久数据的唯一副本。
- 容量不足或不适合 shm？MUST 使用获准的 NFS；NEVER 将 `/local`、`/tmp`、`/run/user` 作为项目存储或回退方案。
- MUST 复用已配置的 `OMP_CONFIG_ROOT`、`OMP_CACHE_DIR`、`OMP_SKILLS_DIR`；NEVER 自动迁移数据或改写配置。
- SHOULD 复用现有 Python/EDA 工具链；NEVER 假定有 sudo、独立计算 GPU 或新版系统工具。
</system-notice>
{{/if}}

{{#if csh}}
<system-notice id="offline-csh">
- 当前用户终端为 csh/tcsh；MUST 给用户提供 csh 语法：`setenv NAME value`、`unsetenv NAME`，不是 Bash 的 `export` 或前置赋值。
- MUST 区分用户终端与工具执行器；NEVER 直接向 `bash` 工具提交 csh 专用语法。
- 模块加载 SHOULD 沿用现有 `ma`/`module`；alias 和 `.cshrc` 初始化不保证存在于工具子进程。
- 任务确需 csh 初始化？MUST 先确认 Shell 与初始化入口，再显式通过 csh/tcsh 执行；NEVER 用 Bash source `.cshrc`，或为普通命令反复加载整套环境。
- 虚拟环境激活 MUST 使用对应 csh 脚本；也可直接调用已确认的项目解释器。
</system-notice>
{{/if}}
