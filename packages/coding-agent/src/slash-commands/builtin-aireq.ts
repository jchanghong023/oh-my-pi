import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandSpec } from "./types";

export interface AIReqLaunchContext {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	output(text: string): Promise<void> | void;
	registerHostShutdown?(dispose: () => Promise<void>): () => void;
	toggleAIReqWorkbench?(): Promise<void>;
}

export async function handleAIReqCommand(
	command: ParsedSlashCommand,
	context: AIReqLaunchContext,
): Promise<SlashCommandResult> {
	const args = /^\/aireq(?:[:\s]([\s\S]*))?$/.exec(command.text)?.[1] ?? command.args;
	if (args.trim()) {
		await context.output(
			"/aireq 不接受终端子命令或参数。请使用 /aireq 进入浏览器工作台，在网页中新建、配置或操作需求；输入不会交给模型。",
		);
		return { consumed: true, failed: true, errorCode: "invalid_params" };
	}
	if (!context.toggleAIReqWorkbench) {
		await context.output(
			"当前宿主不支持 AIReq 浏览器工作台互斥生命周期；请在原生 OMP 终端使用 /aireq，或运行 omp aireq。输入不会交给模型。",
		);
		return { consumed: true, failed: true, errorCode: "execution_failed" };
	}
	try {
		await context.toggleAIReqWorkbench();
		return { consumed: true };
	} catch (error) {
		await context.output(`AIReq 工作台切换失败：${error instanceof Error ? error.message : String(error)}`);
		return { consumed: true, failed: true, errorCode: "execution_failed" };
	}
}

// Keep these specs host-independent: the browser host consumes the registry.
// The registry attaches the native TUI lifecycle at the command-controller boundary.
export const BUILTIN_AIREQ_SLASH_COMMANDS: SlashCommandSpec[] = [
	{
		name: "aireq",
		description: "进入浏览器 AIReq 工作台；再次输入退出并恢复普通会话",
		// Retired verbs receive a consumed rejection, never a prompt fallback.
		allowArgs: true,
		handleWebGui: (command, runtime) =>
			handleAIReqCommand(command, {
				...runtime,
				toggleAIReqWorkbench: () => runtime.host.toggleMode("aireq"),
			}),
		handle: handleAIReqCommand,
	},
];
