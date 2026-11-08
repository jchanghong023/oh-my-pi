import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandSpec } from "./types";

export interface DevLaunchContext {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	output(text: string): Promise<void> | void;
	registerHostShutdown?(dispose: () => Promise<void>): () => void;
	toggleDevWorkbench?(): Promise<void>;
}

export async function handleDevCommand(
	command: ParsedSlashCommand,
	context: DevLaunchContext,
): Promise<SlashCommandResult> {
	const args = /^\/dev(?:[:\s]([\s\S]*))?$/.exec(command.text)?.[1] ?? command.args;
	if (args.trim()) {
		await context.output(
			"/dev 不接受终端子命令或参数。请使用 /dev 进入浏览器工作台，在网页中新建、配置或操作需求；输入不会交给模型。",
		);
		return { consumed: true, failed: true, errorCode: "invalid_params" };
	}
	if (!context.toggleDevWorkbench) {
		await context.output(
			"当前宿主不支持 Dev 浏览器工作台互斥生命周期；请在原生 OMP 终端使用 /dev，或运行 omp dev。输入不会交给模型。",
		);
		return { consumed: true, failed: true, errorCode: "execution_failed" };
	}
	try {
		await context.toggleDevWorkbench();
		return { consumed: true };
	} catch (error) {
		await context.output(`Dev 工作台切换失败：${error instanceof Error ? error.message : String(error)}`);
		return { consumed: true, failed: true, errorCode: "execution_failed" };
	}
}

// Keep these specs host-independent: the browser host consumes the registry.
// The registry attaches the native TUI lifecycle at the command-controller boundary.
export const BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS: SlashCommandSpec[] = [
	{
		name: "dev",
		description: "进入浏览器 Dev 工作台；再次输入退出并恢复普通会话",
		// Retired verbs receive a consumed rejection, never a prompt fallback.
		allowArgs: true,
		handleWebGui: (command, runtime) =>
			handleDevCommand(command, {
				...runtime,
				toggleDevWorkbench: () => runtime.host.toggleMode("dev"),
			}),
		handle: handleDevCommand,
	},
];
