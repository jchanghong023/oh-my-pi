import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";
import { AUTOMATION_CREATE_LIMIT, AUTOMATION_CREATE_LIMIT_ERROR_CODE } from "@zcode/shared";
import { readPrototypeProjectSettings } from "./project-settings.js";
import reviewPrompt from "./prompts/automation-review.md?raw";
import summaryPrompt from "./prompts/automation-summary.md?raw";
import output from "./automation-output.md?raw";

/** 只维护后端场景内存样例，不创建真实调度、模型请求或业务文件。 */
export function createPrototypeAutomationServices(): Pick<IServiceAccessor["zcodeAgentService"],
	"listAutomations" | "listAllAutomations" | "createAutomation" | "updateAutomation" | "deleteAutomation" |
	"setAutomationEnabled" | "restartAutomation" | "runAutomationNow" | "listAutomationRuns" | "deleteAutomationRun" |
	"listNativeTaskRuns" | "readNativeTaskOutput"> {
	const now = Date.now();
	let nextId = 10;
	const definitions = new Map<string, ZCodeAutomation>();
	const histories = new Map<string, ZCodeAutomationRun[]>();
	const projects = readPrototypeProjectSettings().projects;
	const samples: { title: string; status: ZCodeAutomation["lifecycleStatus"]; prompt: string; projectIndex: number }[] = [
		{ title: "每日变更巡检（样例）", status: "active", prompt: reviewPrompt, projectIndex: 0 },
		{ title: "每周项目摘要（样例）", status: "paused", prompt: summaryPrompt, projectIndex: 0 },
		{ title: "交付材料检查（样例）", status: "completed", prompt: reviewPrompt, projectIndex: 1 },
		{ title: "待补齐资料的检查（样例）", status: "failed", prompt: summaryPrompt, projectIndex: 0 },
	];
	for (const [index, sample] of samples.entries()) {
		const project = projects[sample.projectIndex];
		if (!project) continue;
		const automationId = `prototype-automation-${index + 1}`;
		const value: ZCodeAutomation = {
			automationId, title: sample.title, prompt: sample.prompt, cronExpr: index === 1 ? "0 9 * * 1" : "0 9 * * *",
			projectId: project.id, hostId: "local", workspacePath: project.root, workspaceKey: project.root,
			locationKind: "local", recurring: sample.status !== "completed", maxRuns: sample.status === "completed" ? 1 : undefined,
			runCount: 1, enabled: sample.status === "active", lifecycleStatus: sample.status,
			nextRunAt: sample.status === "active" ? now + 3600000 : undefined, lastRunAt: now - 3600000,
			dispatchStatus: "idle", dispatchAttempts: 0, lastError: sample.status === "failed" ? "样例：资料不足，等待人员补充；未执行真实任务。" : undefined,
			createdAt: now - 86400000, updatedAt: now - 3600000,
		};
		definitions.set(automationId, value);
		histories.set(automationId, [{ runId: `${automationId}:${now - 3600000}`, automationId, workspaceKey: project.root,
			scheduledAt: now - 3600000, trigger: "schedule", dispatchStatus: "dispatched",
			outcome: sample.status === "failed" ? "failed" : "succeeded", attempts: 1,
			sessionId: `prototype-automation-session:${automationId}`, error: value.lastError,
			createdAt: now - 3600000, updatedAt: now - 3540000 }]);
	}
	const lookup = (automationId: string, workspacePath: string): ZCodeAutomation => {
		const value = definitions.get(automationId);
		if (!value || value.workspacePath !== workspacePath) throw new Error("所选项目没有这条自动化样例。");
		return value;
	};
	return {
		listAutomations: async params => structuredClone([...definitions.values()].filter(item => item.workspacePath === params.workspacePath)),
		listAllAutomations: async () => structuredClone([...definitions.values()]),
		createAutomation: async params => {
			if (definitions.size >= AUTOMATION_CREATE_LIMIT) throw new Error(AUTOMATION_CREATE_LIMIT_ERROR_CODE);
			const value: ZCodeAutomation = { automationId: `prototype-automation-${++nextId}`, title: params.title,
				prompt: params.prompt, cronExpr: params.cronExpr, projectId: params.projectId, hostId: "local",
				workspacePath: params.workspacePath, workspaceIdentity: params.workspaceIdentity, workspaceKey: params.workspaceIdentity ?? params.workspacePath,
				modelSelection: params.modelSelection, mode: params.mode as ZCodeAutomation["mode"], recurring: params.recurring ?? true, maxRuns: params.maxRuns,
				endAt: params.endAt, scheduleRule: params.scheduleRule, locationKind: "local", enabled: true,
				lifecycleStatus: "active", runCount: 0, dispatchStatus: "idle", dispatchAttempts: 0, createdAt: Date.now(), updatedAt: Date.now() };
			definitions.set(value.automationId, value); histories.set(value.automationId, []);
			return structuredClone(value);
		},
		updateAutomation: async params => {
			const value = lookup(params.automationId, params.workspacePath);
			Object.assign(value, { title: params.title ?? value.title, prompt: params.prompt ?? value.prompt,
				cronExpr: params.cronExpr ?? value.cronExpr, recurring: params.recurring ?? value.recurring,
				modelSelection: params.modelSelection === null ? undefined : params.modelSelection ?? value.modelSelection,
				mode: params.mode === null ? undefined : params.mode ?? value.mode,
				maxRuns: params.maxRuns === null ? undefined : params.maxRuns ?? value.maxRuns,
				endAt: params.endAt === null ? undefined : params.endAt ?? value.endAt,
				scheduleRule: params.scheduleRule === null ? undefined : params.scheduleRule ?? value.scheduleRule,
				scheduleEditedByUser: params.scheduleEditedByUser ?? value.scheduleEditedByUser, updatedAt: Date.now() });
			return structuredClone(value);
		},
		deleteAutomation: async params => { lookup(params.automationId, params.workspacePath); definitions.delete(params.automationId); histories.delete(params.automationId); },
		setAutomationEnabled: async params => { const value = lookup(params.automationId, params.workspacePath); value.enabled = params.enabled; value.lifecycleStatus = params.enabled ? "active" : "paused"; value.updatedAt = Date.now(); },
		restartAutomation: async params => { const value = lookup(params.automationId, params.workspacePath); value.enabled = true; value.lifecycleStatus = "active"; value.lastError = undefined; value.updatedAt = Date.now(); },
		runAutomationNow: async params => {
			const value = lookup(params.automationId, params.workspacePath);
			const time = Date.now();
			// 仅登记已停止的演示条目，不伪造一次真实成功，也不在后台继续运行。
			const run: ZCodeAutomationRun = { runId: `${value.automationId}:manual:${++nextId}`, automationId: value.automationId,
				workspaceKey: value.workspaceKey, trigger: "manual", dispatchStatus: "dispatched", outcome: "stopped",
				error: "前端演示：未执行模型或调度，此条为内存交互记录。", attempts: 0,
				sessionId: `prototype-automation-session:${value.automationId}`, createdAt: time, updatedAt: time };
			histories.set(value.automationId, [run, ...(histories.get(value.automationId) ?? [])]);
			value.lastRunAt = time; value.updatedAt = time;
			return { status: "queued" };
		},
		listAutomationRuns: async params => { lookup(params.automationId, params.workspacePath); return structuredClone(histories.get(params.automationId) ?? []); },
		deleteAutomationRun: async params => { for (const [key, runs] of histories) histories.set(key, runs.filter(run => !(run.runId === params.runId && definitions.get(key)?.workspacePath === params.workspacePath))); },
		listNativeTaskRuns: async params => ({ source: "omp-native-task", sessionId: params.sessionId, revision: 1,
			runs: [{ runId: `prototype-run:${params.sessionId}`, sessionId: params.sessionId, toolCallId: "prototype-tool-call", title: "检查与独立审查（样例）", status: "completed", startedAt: now - 600000, endedAt: now - 540000,
				actors: [{ agentId: "prototype-review", sessionId: `prototype-automation-session:review:${params.sessionId}`, parentSessionId: params.sessionId, title: "检查 Agent（样例）", status: "completed" },
					{ agentId: "prototype-audit", sessionId: `prototype-automation-session:audit:${params.sessionId}`, parentSessionId: params.sessionId, title: "独立审查 Agent（样例）", status: "completed" }],
				outputs: [{ id: "prototype-report", sessionId: params.sessionId, title: "检查报告（样例）", kind: "file" }] }] }),
		readNativeTaskOutput: async params => ({ outputId: params.outputId, title: "检查报告（样例）", content: output, format: "markdown" }),
	};
}
