import { getSpecDrivenController } from "../spec-driven/controller";
import type { SlashCommandSpec } from "./types";

const usages = [
	["start", "<change-id> <request>", "澄清需求并起草规格"],
	["status", "", "查看当前阶段、材料和准确的下一步命令"],
	["answer", "<text>", "回答当前澄清问题"],
	["confirm-spec", "<version>", "明确确认当前规格版本"],
	["choose", "<run-id> <candidate-id> <candidate-version>", "选择当前已审查候选，仅授权编写计划"],
	["confirm-plan", "<version> [--goal]", "批准计划并启动自主执行；可选 Goal，仅授权本任务本地 commit"],
	["accept", "<acceptance-version>", "最终验收当前交付版本"],
	["amend", "<text>", "修改需求，撤销受影响下游批准"],
	["change-solution", "<reason>", "重新讨论核心方案"],
	["pause", "", "暂停并停止后续派发"],
	["resume", "", "继续本进程内的暂停流程"],
	["cancel", "", "取消本流程，不影响其他后台工作"],
] as const;

export const BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS: SlashCommandSpec[] = [
	{
		name: "spec",
		description: "规格驱动四职责编排（显式版本批准，仅运行期状态）",
		allowArgs: true,
		subcommandOptional: true,
		subcommands: usages.map(([name, usage, description]) => ({ name, usage, description })),
		handle: async (parsed, host) => {
			// 仅切分命令头和固定 ID；需求/回答保留完整内部空白及换行。
			const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(parsed.args);
			const action = match?.[1] ?? "status";
			const text = match?.[2]?.trim() ?? "";
			const usage = usages.find(item => item[0] === action);
			if (!usage) {
				await host.output(
					`未知 /spec 子命令。\n${usages.map(([name, args]) => `/spec ${name}${args ? ` ${args}` : ""}`).join("\n")}`,
				);
				return { consumed: true, failed: true };
			}
			let phase = "unavailable";
			try {
				const controller = getSpecDrivenController(host, { restart: action === "start" });
				phase = controller.status().phase;
				const exact = (count: number): string[] => {
					const values = text ? text.split(/\s+/) : [];
					if (values.length !== count) throw new Error(`用法：/spec ${action}${usage[1] ? ` ${usage[1]}` : ""}`);
					return values;
				};
				const requiredText = (): string => {
					if (!text) exact(1);
					return text;
				};
				let jobId: string | undefined;
				switch (action) {
					case "status":
						exact(0);
						await controller.report();
						return { consumed: true };
					case "pause":
						exact(0);
						controller.pause();
						await controller.report();
						return { consumed: true };
					case "cancel":
						exact(0);
						await controller.cancel();
						return { consumed: true };
					case "resume":
						exact(0);
						jobId = controller.resume();
						break;
					case "start": {
						const start = /^(\S+)\s+([\s\S]+)$/.exec(text);
						if (!start) throw new Error("用法：/spec start <change-id> <request>");
						const changeId = start[1]!;
						const request = start[2]!;
						jobId = controller.schedule(core => core.start(request, changeId));
						break;
					}
					case "answer": {
						const answer = requiredText();
						jobId = controller.schedule(core => core.answer(answer));
						break;
					}
					case "confirm-spec": {
						const [version] = exact(1);
						jobId = controller.schedule(core => core.confirmSpecification(version!));
						break;
					}
					case "choose": {
						const [run, candidate, version] = exact(3);
						jobId = controller.schedule(core => core.chooseCandidate(run!, candidate!, version!));
						break;
					}
					case "confirm-plan": {
						const values = text ? text.split(/\s+/) : [];
						if (
							values.length < 1 ||
							values.length > 2 ||
							values[0]!.startsWith("-") ||
							(values.length === 2 && values[1] !== "--goal")
						)
							throw new Error("用法：/spec confirm-plan <version> [--goal]");
						const mode = values.length === 2 ? "goal" : "normal";
						jobId = controller.schedule(core => core.confirmPlan(values[0]!, { mode }));
						break;
					}
					case "accept": {
						const [version] = exact(1);
						jobId = controller.schedule(core => core.accept(version!));
						break;
					}
					case "amend": {
						const amendment = requiredText();
						jobId = controller.schedule(core => core.amendRequirements(amendment), true);
						break;
					}
					case "change-solution": {
						const reason = requiredText();
						jobId = controller.schedule(core => core.changeSolution(reason), true);
						break;
					}
				}
				await host.output(
					`已提交后台任务 ${JSON.stringify({ jobId, command: action, phase: controller.status().phase })}。\n/spec status\n/spec pause\n/spec cancel`,
				);
				return { consumed: true };
			} catch (error) {
				await host.output(
					`规格流程操作失败：${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ phase })}\n/spec status`,
				);
				return { consumed: true, failed: true };
			}
		},
	},
];
