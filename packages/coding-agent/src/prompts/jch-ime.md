恢复我当前内网终端的中文输入法。你 MUST 调用工具实施恢复，而不是只解释操作方法；下方代码是首选路径，不是唯一方案。首选路径失败或未解决实际症状时，你 MUST 根据实时证据自主诊断并选择当前用户、当前 DISPLAY 内的最小修复，不因脚本退出就结束任务。

## 环境与执行顺序

- 已知环境：CentOS 7、csh/tcsh、GNOME Terminal 3.28.2 / VTE 0.52.4、SSH X11 转发至 Windows Exceed、IBus 1.5.17、中文引擎 `libpinyin`；这些是环境参考，不是本次检测结果。
- Shell 的 `IBUS_ADDRESS` / `DBUS_SESSION_BUS_ADDRESS` 为空不代表输入法损坏；GTK 可自行发现 IBus。下方代码从当前显示会话的 daemon 及其地址文件取实时信息，不使用历史 PID、IP 或总线地址。
- 先执行一次下面的完整代码块。它先核对平台、DISPLAY、进程归属、地址文件和中文引擎，再请求 IBus 自身重启一次，等待重新连接并切回拼音；同一 daemon 的其他窗口会短暂中断输入，未提交的预编辑文字可能丢失。
- 工具工作目录保持当前项目；显式使用 Bash heredoc，避免 csh 语法差异。代码兼容系统 Python 3.6+，不依赖 OMP Eval 的 Python；使用 bash 工具执行，给工具足够时间等待块内有界操作结束。

```bash
bash <<'JCH_IME_BASH'
PYTHONIOENCODING=utf-8 python3 - <<'JCH_IME_PY'
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path


def fail(message):
    print("JCH_IME_STOP: " + message)
    sys.exit(1)


def display_key(value):
    match = re.fullmatch(r"([^:\s]*:\d+)(?:\.\d+)?", value or "")
    return match.group(1) if match else None


if sys.platform != "linux":
    fail("当前不是 Linux；未操作输入法。Windows 本机输入法或客户端故障不在此恢复块范围内。")
display = os.environ.get("DISPLAY", "")
if not display_key(display):
    fail("缺少有效 X11 DISPLAY；请从发生故障的图形终端启动 OMP，不猜测其他会话。")
ibus = shutil.which("ibus")
if not ibus:
    fail("未找到 ibus 命令；未安装或切换输入法框架。")
uid = os.getuid()


def daemon_environment(pid):
    proc = Path("/proc") / str(pid)
    if proc.stat().st_uid != uid or proc.joinpath("comm").read_text().strip() != "ibus-daemon":
        raise ValueError("目标不是当前用户的 ibus-daemon")
    values = dict(item.split("=", 1) for item in proc.joinpath("environ").read_bytes().decode("utf-8", "surrogateescape").split("\0") if "=" in item)
    if display_key(values.get("DISPLAY")) != display_key(display):
        raise ValueError("目标属于不同 DISPLAY")
    return values


candidates = []
for proc in Path("/proc").iterdir():
    if proc.name.isdigit():
        try:
            candidates.append((int(proc.name), daemon_environment(int(proc.name))))
        except (OSError, ValueError):
            pass
if len(candidates) != 1:
    fail("当前用户、当前 DISPLAY 的 IBus 进程数为 %d；未重启。无进程或存在歧义时保留其他会话。" % len(candidates))
pid, daemon_env = candidates[0]
env = os.environ.copy()
for key in ("HOME", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "IBUS_ADDRESS_FILE"):
    env.pop(key, None)
    if daemon_env.get(key):
        env[key] = daemon_env[key]
env["DISPLAY"] = daemon_env["DISPLAY"]
env.pop("IBUS_ADDRESS", None)
if env.get("IBUS_ADDRESS_FILE"):
    bus_file = Path(env["IBUS_ADDRESS_FILE"])
else:
    machine_id = None
    for name in ("/var/lib/dbus/machine-id", "/etc/machine-id"):
        try:
            machine_id = Path(name).read_text().strip()
            break
        except OSError:
            pass
    if not machine_id or not env.get("HOME"):
        fail("无法确定实时 IBus 地址文件；未操作。")
    host, number = display_key(display).rsplit(":", 1)
    config = env.get("XDG_CONFIG_HOME") or str(Path(env["HOME"]) / ".config")
    bus_file = Path(config) / "ibus" / "bus" / (machine_id + "-" + (host or "unix") + "-" + number)


def current_bus(expected_pid=None):
    if bus_file.stat().st_uid != uid:
        raise ValueError("地址文件不属于当前用户")
    values = dict(line.split("=", 1) for line in bus_file.read_text().splitlines() if line.startswith(("IBUS_ADDRESS=", "IBUS_DAEMON_PID=")))
    current_pid = int(values.get("IBUS_DAEMON_PID", "0"))
    if expected_pid is not None and current_pid != expected_pid:
        raise ValueError("地址文件与当前显示会话进程不匹配")
    daemon_environment(current_pid)
    address = values.get("IBUS_ADDRESS", "")
    if not address.startswith("unix:"):
        raise ValueError("不是本机 Unix IBus 地址")
    result = env.copy()
    result["IBUS_ADDRESS"] = address
    return result


def run(args, child_env, timeout=8):
    return subprocess.run([ibus] + args, env=child_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)


try:
    child_env = current_bus(pid)
    engines = run(["list-engine", "--name-only"], child_env)
    if engines.returncode or "libpinyin" not in engines.stdout.splitlines():
        fail("当前 IBus 无法连接或没有 libpinyin；未重启，不安装软件。")
    print("JCH_IME_TARGET: uid=%d pid=%d DISPLAY=%s engine=libpinyin" % (uid, pid, display), flush=True)
    restarted = run(["restart"], child_env)
    if restarted.returncode:
        fail("ibus restart 失败；保留现场，不强杀进程。")
    deadline = time.monotonic() + 15
    while True:
        try:
            child_env = current_bus()
            ready = run(["list-engine", "--name-only"], child_env, timeout=2)
            if ready.returncode == 0 and "libpinyin" in ready.stdout.splitlines():
                break
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        if time.monotonic() >= deadline:
            fail("已请求重启，但等待 IBus/libpinyin 就绪超时；恢复未确认。")
        time.sleep(0.3)
    selected = run(["engine", "libpinyin"], child_env)
    actual = run(["engine"], child_env)
    if selected.returncode or actual.returncode or actual.stdout.strip() != "libpinyin":
        fail("已请求重启，但切回 libpinyin 或引擎核验失败；恢复未确认。")
    print("JCH_IME_SERVICE_OK: IBus 已重新连接，当前引擎 libpinyin；实际中文输入待用户确认。")
except (OSError, ValueError, subprocess.TimeoutExpired) as error:
    fail("恢复未完成，错误类型 %s；未强杀、未修改配置。" % type(error).__name__)
JCH_IME_PY
JCH_IME_BASH
```

## 根据结果处理

- `JCH_IME_SERVICE_OK`：MUST 请我在当前 OMP 输入框按 `Ctrl+Space` 切换后输入 `中文测试`；必要时手动切出再切回终端焦点。服务端引擎正常不等于中文候选框或文字上屏已验证。
- `JCH_IME_STOP` 或非零退出：只表示首选恢复块未完成，不等于整个任务必须停止。MUST 保留实际失败步骤，进入下面的自主恢复流程；不原样反复重跑整个恢复块。
- 引擎已正常但仍不能输入：MUST 区分故障边界。其他 GNOME Terminal 窗口也不能中文，倾向 IBus/X11 链路；其他终端可用而仅此 OMP 窗口异常，倾向该终端输入上下文；Windows Exceed/客户端或 ZCode/Electron 输入问题不一定能由服务端修复。这些只作为待确认判断，不当作已定位根因。
- 服务核验通过后给最少手动验证步骤；仍有已确认且可在授权范围内修复的问题时继续处理。不自动退出 OMP、关闭窗口或重启客户端。

## 首选路径无效时，自主决定下一步

1. MUST 先补足具体证据：按需运行本机 `ibus --help`、`ibus engine`、`ibus list-engine --name-only`，核对当前用户的 daemon、实时总线及当前 DISPLAY 的 XIM 注册（已有 `xprop` 时用 `xprop -root XIM_SERVERS`）。只读取所需进程字段和环境白名单，不输出完整 `/proc/*/environ`、凭据或无关日志；缺工具时换用已有只读接口，不安装。
2. MAY 根据证据改写一次性恢复命令，选择引擎重新切换、清除陈旧总线覆盖、对齐当前会话的 D-Bus/X11 环境或重建该会话的 IBus；不必逐一尝试所有方案。环境变量仅对恢复调用及其子进程生效，不能把子 Shell 的 `export` 当作已修复运行中的 GNOME Terminal。
3. daemon 卡死且正常 `ibus restart` 无法响应时，MAY 精确停止并重建它。停止前 MUST 保存经核实的原始 argv 和必要会话环境，记录 UID、DISPLAY、PID、进程启动时间，发送信号前重新核对同一进程身份；只向该 daemon 的正数 PID 发送 `SIGTERM`，不向进程组发信号。等待确认原进程退出、且该显示会话未被其他 daemon 接管后，才使用原启动方式及实时会话环境重建；argv 按参数数组传递，不交给 Shell `eval`。若 `SIGTERM` 无效或身份有变化，保留现场并报告，不自动升级 `SIGKILL`。
4. daemon 已退出时，MAY 在确认当前 UID、DISPLAY、X11 可达性和现有 D-Bus 会话归属，且排除同显示会话已有 daemon 后启动一个 IBus。必要环境可从经归属核实的当前图形会话进程获取；启动参数依据本机帮助及实际会话确定。无法证明目标会话时只继续只读调查，不猜地址、不借用其他 DISPLAY，不创建替代 D-Bus 会话。
5. 每次改变后 MUST 重新发现总线并查询实际引擎，记录本次结果；原脚本的成功标记不是其他修复路径的必需条件。相同失败不无依据重复，新尝试须有新证据；只有目标/权限不能确认、已有安全手段耗尽、或需要用户执行客户端操作时才说明具体阻塞。服务就绪后请用户验证实际中文输入，未取得上屏反馈时明确“服务已恢复，中文输入待确认”。

<critical>
MUST 保留其他用户和其他 DISPLAY。NEVER 使用 sudo、killall、pkill、安装软件、联网、修改 shell 启动文件/输入法配置，或把环境快照的地址/PID 写入当前会话。NEVER 把重启成功或模拟验证当作实际中文输入已恢复。
</critical>
