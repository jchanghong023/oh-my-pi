import { readPrototypeAgentModelBinding } from "../packages/ui/src/aireq/mock/agent-models.js";
import { ISSUE_TYPES, type AIReqIssue, type AIReqIssueInput, type AIReqIssueScope, type AIReqIssueServices, type AIReqIssueSnapshot } from "../packages/ui/src/aireq/issues.js";
import { getPrototypeWorkflow } from "../packages/ui/src/aireq/mock/workflow.js";
import { getEmployeeId, isEmployeeId } from "../packages/ui/src/aireq/identity.js";
import { requirePrototypeSettingsWrite } from "../packages/ui/src/aireq/mock/backend.js";

/** Shared backend memory, never a browser business store. No real Git/model calls. */
export function createPrototypeIssues(): AIReqIssueServices {
  const states = new Map<string, AIReqIssueSnapshot>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const state = (scope: AIReqIssueScope) => {
    const view = getPrototypeWorkflow({ projectId: scope.projectId });
    if (!view.projects.some(project => project.id === scope.projectId)) throw new Error("请选择有效的项目。");
    const key = scope.projectId;
    let value = states.get(key);
    if (!value) {
      const now = new Date().toISOString();
      const samples: { title: string; type: AIReqIssue["type"]; status: AIReqIssue["status"]; percent: number; merged: boolean }[] = [
        { title: "侧栏收起后内容区域未重新居中", description: "收起左侧导航后，内容区仍保留展开时的左偏移，大屏窗口下两侧留白不一致。", acceptance: "展开、收起导航或拖动右侧面板后，内容均在剩余区域居中，保留两侧最小间距。", type: "bug", status: "developing", percent: 65, merged: false },
        { title: "整理重复的状态转换逻辑", description: "多个入口重复维护相同的状态转换，新增状态时容易遗漏校验或产生不一致结果。", acceptance: "统一状态转换入口和校验，现有合法操作保持一致，非法转换有明确提示。", type: "refactor", status: "merging", percent: 99, merged: false },
        { title: "优化列表首次加载速度", description: "首次进入列表需要等待全部详情返回，条目增加后首屏加载明显变慢。", acceptance: "列表首屏按页加载，详情按需读取；搜索和切换筛选时保留清晰的反馈。", type: "performance", status: "confirming", percent: 99, merged: true },
      ];
      value = { issues: samples.map<AIReqIssue>(sample => {
        const id = `ISSUE-${String(++sequence).padStart(4, "0")}`;
        return {
          projectId: scope.projectId, ...sample, id, requestId: `sample:${id}`, priority: "normal", developerEmployeeId: "j00808874",
          branch: `issue/${id.toLowerCase()}`, description: sample.description,
          acceptance: "问题得到修复，相关改动合入默认分支后人工确认。",
          report: sample.merged ? "开发分支已合入默认分支。请核对完成标准，确认后结束跟踪。" : sample.status === "merging" ? "状态转换入口已统一，开发分支待合入默认分支。" : "已完成主要布局调整，仍需核对导航开合及右侧面板拖动时的边界情况。",
          remaining: sample.merged ? ["等待人工核对完成标准并确认"] : ["核对代码与完成标准", "等待开发分支合入默认分支"],
          createdAt: now, updatedAt: now,
        };
      }), runs: [], enabled: false, intervalMinutes: 30 };
      states.set(key, value);
    }
    return value;
  };
  const signedIn = () => { if (!isEmployeeId(getEmployeeId())) throw new Error("请先登录工号。"); };
  const issueFor = (scope: AIReqIssueScope, id: string) => {
    const issue = state(scope).issues.find(item => item.id === id);
    if (!issue) throw new Error("Issue 不存在。");
    return issue;
  };
  const analyze = (value: AIReqIssueSnapshot) => {
    const startedAt = new Date().toISOString();
    for (const issue of value.issues.filter(item => item.status !== "completed")) {
      // 样例没有 Git 证据，不能随点击次数虚增进度或伪造合入事实。
      issue.percent = Math.min(issue.percent, 99);
      issue.report = issue.merged ? "开发分支已合入默认分支，等待人工核对完成标准。" : "本轮未获得足以确认新进展的证据，保留当前进度；请查看遗留问题后继续处理。";
      issue.remaining = issue.merged ? ["开发分支已合入，等待人工确认"] : ["等待开发分支的代码证据", "等待合入默认分支后人工确认"];
      issue.updatedAt = startedAt;
      value.runs.unshift({ modelConfig: readPrototypeAgentModelBinding("issue-analysis"), id: crypto.randomUUID(), issueId: issue.id, title: issue.title, startedAt, status: "succeeded", summary: issue.report });
    }
    value.runs = value.runs.slice(0, 200);
    value.nextRunAt = value.enabled ? new Date(Date.now() + value.intervalMinutes * 60_000).toISOString() : undefined;
    emit();
  };
  const timer = setInterval(() => {
    for (const value of states.values()) if (value.enabled && value.nextRunAt && Date.parse(value.nextRunAt) <= Date.now()) analyze(value);
  }, 5000);
  let sequence = 0;
  return {
    async read(scope) { return structuredClone(state(scope)); },
    async create(input: AIReqIssueInput) {
      signedIn();
      const value = state(input);
      const duplicate = value.issues.find(issue => issue.requestId === input.requestId);
      if (duplicate) return structuredClone(duplicate);
      if (typeof input.requestId !== "string" || !input.requestId || typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || typeof input.description !== "string" || !input.description.trim() || typeof input.acceptance !== "string" || !input.acceptance.trim() || !Object.hasOwn(ISSUE_TYPES, input.type) || !["low", "normal", "high"].includes(input.priority) || !isEmployeeId(input.developerEmployeeId)) throw new Error("请填写标题、问题说明、完成标准及一位有效开发人员。");
      if (!["j00808874", "j00808875", "j00808876", "j00808877"].includes(input.developerEmployeeId)) throw new Error("开发人员不在当前工号目录中。");
      if (input.requirement) {
        const view = getPrototypeWorkflow({ projectId: input.projectId });
        const group = view.groups.find(item => item.id === input.requirement?.irId && item.projectId === input.projectId);
        if (!group || (input.requirement.srId && !view.srs.some(sr => sr.id === input.requirement?.srId && sr.irId === group.id))) throw new Error("关联需求不属于当前项目。");
      }
      const id = `ISSUE-${String(++sequence).padStart(4, "0")}`;
      const now = new Date().toISOString();
      const issue: AIReqIssue = {
        requestId: input.requestId, projectId: input.projectId,
        title: input.title.trim(), type: input.type, priority: input.priority,
        description: input.description.trim(), acceptance: input.acceptance.trim(),
        developerEmployeeId: input.developerEmployeeId, requirement: input.requirement,
        id, branch: `issue/${id.toLowerCase()}`, status: "pending", percent: 0,
        remaining: ["等待开发与代码证据"], report: "尚未分析。", merged: false, createdAt: now, updatedAt: now,
      };
      value.issues.unshift(issue); emit(); return structuredClone(issue);
    },
    async configure(scope, enabled, intervalMinutes) {
      requirePrototypeSettingsWrite();
      if (typeof enabled !== "boolean" || !Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 1440) throw new Error("分析间隔须为 15 至 1440 分钟。");
      const value = state(scope);
      value.enabled = enabled; value.intervalMinutes = intervalMinutes;
      value.nextRunAt = enabled ? new Date(Date.now() + intervalMinutes * 60_000).toISOString() : undefined;
      emit();
    },
    async runNow(scope) { requirePrototypeSettingsWrite(); analyze(state(scope)); },
    async confirm(scope, id) {
      signedIn();
      const issue = issueFor(scope, id);
      if (!issue.merged) throw new Error("尚未确认开发分支合入默认分支，不能完成 Issue。");
      issue.status = "completed"; issue.percent = 100; issue.remaining = []; issue.confirmedBy = getEmployeeId(); issue.updatedAt = new Date().toISOString(); emit();
    },
    async reopen(scope, id, reason) {
      signedIn();
      const issue = issueFor(scope, id);
      if (issue.status !== "completed" || typeof reason !== "string" || !reason.trim()) throw new Error("仅已完成的 Issue 可填写原因重新打开。");
      issue.status = "developing"; issue.percent = Math.min(issue.percent, 99); issue.merged = false;
      issue.confirmedBy = undefined; issue.remaining = [reason.trim()]; issue.updatedAt = new Date().toISOString(); emit();
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { clearInterval(timer); listeners.clear(); },
  };
}
