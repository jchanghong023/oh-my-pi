import { expect, test } from "bun:test";
import * as path from "node:path";
import { respond, rolePayload } from "./provider-fixture";
import { entry, tuiTest, withTui } from "./tui-harness";

const businessDocument = `# 业务需求：核对订单

## 基本信息
订单业务；版本待确认。
## 业务背景与目标
减少人工核对。
## 实际使用场景与现状
业务人员逐条核对订单。
## 期望结果
展示差异。
## 业务规则与边界
只比较已确认订单。
## 典型例子
数量不一致时显示两边数量。
## 业务验收预期
业务人员能定位差异订单。
## 待确认事项
无。
## 资料来源
本次用户陈述。
## 业务确认与交接
用户通过原生动作确认；后续接收人待定。
`;

test.skipIf(!tuiTest)(
	"business-only delivery preserves history and optional next hands off complete document",
	async () => {
		await withTui(
			{
				reply(request) {
					const payload = rolePayload(request);
					if (!payload) return respond(request);
					if (payload?.specDrivenRole !== "business") return { text: "需求会话已接收完整业务文档" };
					if (request.messages.some(message => message.role === "tool"))
						return { text: "业务文档已保存，等待用户选择出口" };
					const write = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === "write")?.function;
					if (!write) throw new Error("Business document write unavailable");
					return {
						tool: {
							name: write.name,
							args: {
								i: "Saving business requirements",
								path: (payload.input.outputPaths as string[])[0],
								content: businessDocument,
							},
						},
					};
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state, idle, stage }) => {
				await tui("submit", "/dev");
				await tui("expect", "text", "Dev ·");
				await tui("submit", "/dev business 停止访谈，保存已确认业务需求");
				await stage("business");
				await idle();
				await tui("expect", "text", "业务 Agent");
				const initial = (await state()).run!;
				expect(await Bun.file(path.join(cwd, initial.paths!.business!)).text()).toBe(businessDocument);
				expect(
					await Bun.file(path.join(cwd, "openspec/changes", initial.changeId!, ".openspec.yaml")).exists(),
				).toBe(false);
				await tui("submit", "/dev finish-business");
				await stage("idle");
				expect((await state()).run?.businessCompleted).toBe(true);
				expect((await state()).run?.sessions.requirements).toBeUndefined();
				await tui("expect", "text", "业务需求已交付");
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await tui("submit", "/dev");
				await stage("idle");
				await tui("expect", "text", "业务需求已交付");
				expect((await state()).run?.runId).toBe(initial.runId);
				await tui("submit", "/dev business 停止访谈，保存已确认业务需求并等待确认");
				await stage("business");
				await idle();
				const second = (await state()).run!;
				expect(second.paths!.business).not.toBe(initial.paths!.business);
				expect(await Bun.file(path.join(cwd, initial.paths!.business!)).text()).toBe(businessDocument);
				await tui("submit", "/dev next");
				await stage("requirements");
				await idle();
				const input = entry(provider, "requirements");
				expect(input.files).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ path: second.paths!.business, content: businessDocument }),
					]),
				);
				await tui("submit", "/dev back");
				await stage("business");
				expect((await state()).run?.approvals.business).toBeUndefined();
			},
		);
	},
	180_000,
);
