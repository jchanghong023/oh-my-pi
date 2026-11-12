import type { AIReqAnalysisFailure, AIReqAnalysisFilter, AIReqAnalysisHistoryFilter, AIReqAnalysisRun, AIReqAnalysisRunSummary, AIReqAnalysisSnapshot, AIReqAnalysisTask, AIReqProgressScheduler } from "../progress-scheduler.js";
import type { AIReqProgressAnalysis, AIReqSystemRequirement } from "../types.js";
import { requirePrototypeSettingsWrite } from "./backend.js";
import { withPrototypeProgress } from "./progress.js";
import { readPrototypeProjectSettings } from "./project-settings.js";
import { getPrototypeWorkflow, prototypeWorkflowChanges } from "./workflow.js";

interface Input { sr: AIReqSystemRequirement; fingerprint: string }
interface Pending { run: AIReqAnalysisRun; input: Input }
interface ScaleInput { input: Input; irTitle: string }

const failureSamples: AIReqAnalysisFailure[] = [
  { stage: "仓库读取", reason: "无法读取所选分支的代码。", nextStep: "请检查仓库地址、分支与读取权限后重试。", retryable: true },
  { stage: "模型调用", reason: "模型请求超时，尚未生成分析结论。", nextStep: "请检查需求分析 Agent 的模型配置与服务状态后重试。", retryable: true },
  { stage: "文档读取", reason: "当前 SR 的需求文档未能读取，分析依据不完整。", nextStep: "请检查 SR 文档路径、文件是否存在及读取权限后重试。", retryable: true },
];
function failureMessage(failure: AIReqAnalysisFailure): string {
  return `${failure.stage}失败：${failure.reason}`;
}

/** One source-lifetime memory scheduler. No timer, Git access, model call or formal-report write. */
export function createPrototypeProgressScheduler(options: { scaleDemo?: boolean } = {}): AIReqProgressScheduler {
  const scaleDemo = options.scaleDemo === true;
  let clock = Date.parse("2026-11-12T09:00:00.000Z");
  let enabled = true;
  let intervalMinutes = 60;
  let nextCheck = clock + intervalMinutes * 60_000;
  let lastCheckAt: string | undefined;
  let serial = 0;
  let disposed = false;
  const projects = new Map<string, boolean>();
  const tasks = new Map<string, AIReqAnalysisTask>();
  const inputs = new Map<string, Input>();
  // Scheduler-only additions: never inserted into the formal workflow or its requirements UI.
  const scaleInputs = new Map<string, ScaleInput>();
  const analysed = new Map<string, string>();
  const pending = new Map<string, Pending>();
  const failedSamples = new Set<string>();
  const runs: AIReqAnalysisRun[] = [];
  const listeners = new Set<() => void>();
  const at = () => new Date(clock).toISOString();
  const requireTime = (value: number) => {
    if (!Number.isFinite(new Date(value).getTime())) throw new Error("分析间隔过大，请使用更小的正整数分钟数。");
    return value;
  };
  const nextAt = () => new Date(clock + intervalMinutes * 60_000).toISOString();
  const active = (task: AIReqAnalysisTask) => projects.get(task.projectId) === true && inputs.has(task.id) && task.percent < 100;
  const emit = () => { for (const listener of listeners) listener(); };
  const requireWrite = () => {
    requirePrototypeSettingsWrite();
    if (disposed) throw new Error("需求分析服务已关闭，请刷新页面后重试。");
  };
  const matches = (row: { projectId: string; irId: string; srId: string; srTitle: string }, filter: AIReqAnalysisFilter) => {
    const search = filter.srSearch?.trim().toLowerCase();
    return (!filter.projectId || row.projectId === filter.projectId)
      && (!filter.irId || row.irId === filter.irId)
      && (!filter.srId || row.srId === filter.srId)
      && (!search || row.srId.toLowerCase().includes(search) || row.srTitle.toLowerCase().includes(search));
  };
  const pageBounds = (total: number, requestedPage: number, requestedSize: number) => {
    const pageSize = requestedSize === 50 ? 50 : 25;
    const page = Math.min(Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1), Math.max(1, Math.ceil(total / pageSize)));
    return { page, pageSize, start: (page - 1) * pageSize };
  };
  const newestFirst = (a: AIReqAnalysisRunSummary, b: AIReqAnalysisRunSummary) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);
  const summary = (run: AIReqAnalysisRun): AIReqAnalysisRunSummary => ({
    id: run.id, batchId: run.batchId, taskId: run.taskId, projectId: run.projectId, irId: run.irId,
    srId: run.srId, srTitle: run.srTitle, branch: run.branch, trigger: run.trigger, status: run.status,
    startedAt: run.startedAt, endedAt: run.endedAt, message: run.message, before: run.before, after: run.after,
  });

  function putInput(input: Input, irTitle: string): void {
    const sr = input.sr;
    const id = JSON.stringify([sr.projectId, sr.irId, sr.id]);
    inputs.set(id, input);
    let task = tasks.get(id);
    if (!task) {
      task = { id, projectId: sr.projectId, irId: sr.irId, irTitle, srId: sr.id, srTitle: sr.title,
        branch: sr.progress?.branch ?? sr.trackingBranch?.name ?? `sr/${sr.id}`, state: "waiting", percent: 0 };
      tasks.set(id, task);
    }
    Object.assign(task, { irTitle, srTitle: sr.title, percent: sr.progress?.percent ?? 0,
      branch: sr.progress?.branch ?? sr.trackingBranch?.name ?? `sr/${sr.id}` });
  }

  function reconcile(): void {
    inputs.clear();
    for (const project of readPrototypeProjectSettings().projects) {
      if (!projects.has(project.id)) projects.set(project.id, false);
      const view = withPrototypeProgress(getPrototypeWorkflow({ projectId: project.id }));
      for (const group of view.groups) {
        for (const sr of view.srs.filter(item => item.irId === group.id && group.srIds.includes(item.id))) {
          // Compare requirement and code evidence only, not analysis timestamps/manual progress edits.
          const fingerprint = JSON.stringify({ requirement: [group.snapshot?.digest, group.revision, group.files, sr.documentPath, sr.title],
            code: [sr.trackingBranch, sr.materialDigest, sr.materials, sr.codeMerge, sr.delivery?.candidate, sr.progress?.codeVersion, sr.progress?.defaultVersion] });
          putInput({ sr, fingerprint }, group.title);
        }
      }
    }
    for (const { input, irTitle } of scaleInputs.values()) putInput(input, irTitle);
    for (const task of tasks.values()) {
      if (pending.has(task.id)) { task.state = "running"; task.nextRunAt = undefined; continue; }
      if (inputs.has(task.id) && task.percent >= 100) {
        task.state = "completed"; task.nextRunAt = undefined; task.error = undefined;
      } else if (!enabled || !active(task)) {
        task.state = "paused"; task.nextRunAt = undefined;
      } else {
        task.state = task.error ? "failed" : "waiting";
        task.nextRunAt ??= nextAt();
      }
    }
  }

  function report(input: Input): AIReqProgressAnalysis {
    const existing = input.sr.progress;
    return { percent: Math.min(existing?.percent ?? 0, 99), merged: existing?.merged ?? false, certain: false,
      branch: existing?.branch ?? input.sr.trackingBranch?.name ?? `sr/${input.sr.id}`, analysedAt: at(),
      codeVersion: existing?.codeVersion ?? "未记录", defaultVersion: existing?.defaultVersion ?? "未记录",
      implemented: existing?.implemented ?? [],
      remaining: existing?.remaining ?? ["尚无可用代码依据，暂时保持当前进度。"],
      issues: existing?.issues ?? [], activity: existing?.activity ?? [] };
  }

  function admit(filter: AIReqAnalysisFilter, trigger: AIReqAnalysisRun["trigger"]): void {
    const batchId = `memory-demo-batch-${++serial}`;
    for (const task of tasks.values()) {
      if (!active(task) || pending.has(task.id) || !matches(task, filter)) continue;
      if (trigger === "schedule" && (!enabled || (task.nextRunAt && Date.parse(task.nextRunAt) > clock))) continue;
      const run: AIReqAnalysisRun = { id: `memory-demo-run-${++serial}`, batchId, taskId: task.id, projectId: task.projectId,
        irId: task.irId, srId: task.srId, srTitle: task.srTitle, branch: task.branch, trigger, status: "running", startedAt: at(),
        message: "正在分析代码与需求文档。", before: task.percent, after: task.percent };
      runs.push(run);
      pending.set(task.id, { run, input: structuredClone(inputs.get(task.id)!) });
      task.state = "running"; task.error = undefined; task.nextRunAt = undefined; task.lastRunAt = at(); task.lastRunId = run.id;
    }
  }

  reconcile();
  const initialProjects = readPrototypeProjectSettings().projects;
  if (scaleDemo) {
    // Pad each of the two initial projects to 150 records, retaining every real formal-SR record.
    for (const project of initialProjects.slice(0, 2)) {
      const existingCount = [...tasks.values()].filter(task => task.projectId === project.id).length;
      for (let index = 1; index <= 150 - existingCount; index++) {
        const suffix = String(index).padStart(3, "0");
        const irIndex = Math.floor((index - 1) / 50) + 1;
        const srId = `scale-${project.id}-sr-${suffix}`;
        const irId = `scale-${project.id}-ir-${irIndex}`;
        const percent = index % 10 === 0 ? 100 : index % 100;
        const sr: AIReqSystemRequirement = { id: srId, projectId: project.id, irId, title: `系统需求 ${suffix} · ${project.name}`,
          documentPath: `memory-scale/${srId}.md`, status: percent === 100 ? "completed" : "pending", round: 0,
          sessions: [], approvals: [], materials: [],
          trackingBranch: { name: `sr/${srId}`, baseCommit: "memory-scale-base", createdAt: at(), pushedAt: at() },
          progress: { percent, merged: percent === 100, certain: false, branch: `sr/${srId}`,
            analysedAt: at(), codeVersion: "未记录", defaultVersion: "未记录",
            implemented: [], remaining: [], issues: [], activity: [],
            ...(percent === 100 ? { manual: { employeeId: "j00808874", reason: "AI 分析到 99% 后人工确认完成（样例）。", at: at() } } : {}) } };
        const input = { sr, fingerprint: `memory-scale-input:${project.id}:${srId}:1` };
        scaleInputs.set(JSON.stringify([project.id, irId, srId]), { input, irTitle: `需求 ${irIndex} · ${project.name}` });
      }
    }
    if (initialProjects[0]) projects.set(initialProjects[0].id, true);
  } else if (projects.has("demo-aurora")) projects.set("demo-aurora", true);
  reconcile();

  if (scaleDemo) {
    const fixtureTasks = [...tasks.values()];
    for (let index = 0; index < 1000; index++) {
      const task = fixtureTasks[index % fixtureTasks.length]!;
      const input = inputs.get(task.id)!;
      const status = index < 300 ? "succeeded" : index < 600 || index >= 900 ? "failed" : "skipped";
      const timestamp = new Date(clock - Math.ceil((1000 - index) / 2) * 3_600_000).toISOString();
      const detail = report(input);
      detail.analysedAt = timestamp;
      const failure = status === "failed" ? failureSamples[index % failureSamples.length]! : undefined;
      const message = failure ? failureMessage(failure) : status === "skipped" ? "需求与代码未发生变化，已跳过重复分析。" : "分析完成，当前进度未发生变化。";
      runs.push({ id: `memory-scale-run-${String(index + 1).padStart(4, "0")}`, batchId: `memory-scale-batch-${Math.floor(index / 25) + 1}`,
        taskId: task.id, projectId: task.projectId, irId: task.irId, srId: task.srId, srTitle: task.srTitle, branch: task.branch,
        trigger: index % 2 ? "manual" : "schedule", status, startedAt: timestamp, endedAt: timestamp,
        message, before: task.percent, after: task.percent, report: status === "succeeded" ? detail : undefined, failure });
      task.lastRunAt = timestamp;
      task.lastRunId = `memory-scale-run-${String(index + 1).padStart(4, "0")}`;
      if (status === "failed") { task.error = message; analysed.delete(task.id); }
      else { task.error = undefined; analysed.set(task.id, input.fingerprint); }
    }
    reconcile();
  } else {
    // One compact fixture per outcome. Memory samples never update formal reports.
    for (const [srId, status] of [["sr-auth", "succeeded"], ["sr-session", "skipped"], ["sr-permissions", "failed"]] as const) {
      const task = [...tasks.values()].find(item => item.projectId === "demo-aurora" && item.srId === srId);
      if (!task || task.percent >= 100) continue;
      const input = inputs.get(task.id)!;
      const timestamp = new Date(clock - 60_000).toISOString();
      const message = status === "succeeded" ? "分析完成，当前进度未发生变化。"
        : status === "skipped" ? "需求与代码未发生变化，已跳过重复分析。"
        : failureMessage(failureSamples[2]!);
      runs.push({ id: `memory-demo-fixture-${srId}`, batchId: "memory-demo-fixtures", taskId: task.id, projectId: task.projectId,
        irId: task.irId, srId, srTitle: task.srTitle, branch: task.branch, trigger: "schedule", status, startedAt: timestamp, endedAt: timestamp,
        message, before: task.percent, after: task.percent, report: status === "succeeded" ? report(input) : undefined,
        failure: status === "failed" ? failureSamples[2] : undefined });
      task.lastRunAt = timestamp; task.lastRunId = `memory-demo-fixture-${srId}`;
      if (status !== "failed") analysed.set(task.id, input.fingerprint);
      else { task.error = message; task.state = "failed"; }
      if (status === "failed") {
        failedSamples.add(task.id);
        for (const [index, failure] of failureSamples.slice(0, 2).entries()) {
          const earlier = new Date(clock - (3 - index) * 60_000).toISOString();
          runs.push({ id: `memory-demo-fixture-${srId}-${index}`, batchId: "memory-demo-fixtures", taskId: task.id,
            projectId: task.projectId, irId: task.irId, srId, srTitle: task.srTitle, branch: task.branch,
            trigger: "schedule", status: "failed", startedAt: earlier, endedAt: earlier,
            message: failureMessage(failure), before: task.percent, after: task.percent, failure });
        }
      }
    }
  }
  const subscription = prototypeWorkflowChanges.event(() => { reconcile(); emit(); });

  return {
    read(): AIReqAnalysisSnapshot {
      const projectSummaries = readPrototypeProjectSettings().projects.map(project => ({
        id: project.id, name: project.name, enabled: projects.get(project.id) ?? false, pendingCount: 0, runningCount: 0,
        lastRunAt: undefined as string | undefined, lastStatus: undefined as AIReqAnalysisRunSummary["status"] | undefined,
      }));
      const byProject = new Map(projectSummaries.map(project => [project.id, project]));
      const irs = new Map<string, { projectId: string; id: string; title: string }>();
      for (const task of tasks.values()) {
        const project = byProject.get(task.projectId);
        if (project) {
          if (pending.has(task.id)) project.runningCount++;
          else if (active(task)) project.pendingCount++;
        }
        irs.set(JSON.stringify([task.projectId, task.irId]), { projectId: task.projectId, id: task.irId, title: task.irTitle });
      }
      const latest = new Map<string, AIReqAnalysisRun>();
      for (const run of runs) {
        const previous = latest.get(run.projectId);
        if (!previous || newestFirst(run, previous) < 0) latest.set(run.projectId, run);
      }
      for (const project of projectSummaries) {
        const run = latest.get(project.id);
        project.lastRunAt = run?.startedAt; project.lastStatus = run?.status;
      }
      return { enabled, intervalMinutes, currentTime: at(), lastCheckAt,
        nextCheckAt: enabled ? new Date(nextCheck).toISOString() : undefined,
        projects: projectSummaries, irs: [...irs.values()], tasksTotal: tasks.size, runsTotal: runs.length, scaleDemo };
    },
    queryTasks(filter, requestedPage, requestedSize) {
      const matching = [...tasks.values()].filter(task => matches(task, filter));
      const bounds = pageBounds(matching.length, requestedPage, requestedSize);
      return { items: structuredClone(matching.slice(bounds.start, bounds.start + bounds.pageSize)),
        total: matching.length, page: bounds.page, pageSize: bounds.pageSize,
        eligibleCount: matching.reduce((count, task) => count + Number(active(task) && !pending.has(task.id)), 0) };
    },
    queryRuns(filter: AIReqAnalysisHistoryFilter, requestedPage, requestedSize) {
      const matching = runs.filter(run => matches(run, filter) && (!filter.status || run.status === filter.status)
        && (!filter.since || run.startedAt >= filter.since) && (!filter.until || run.startedAt <= filter.until)).sort(newestFirst);
      const bounds = pageBounds(matching.length, requestedPage, requestedSize);
      return { items: matching.slice(bounds.start, bounds.start + bounds.pageSize).map(summary),
        total: matching.length, page: bounds.page, pageSize: bounds.pageSize };
    },
    readRun(id) { const run = runs.find(item => item.id === id); return run ? structuredClone(run) : undefined; },
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    setProjectEnabled(projectId, value) {
      requireWrite();
      if (!readPrototypeProjectSettings().projects.some(project => project.id === projectId)) throw new Error("请选择已有项目。");
      projects.set(projectId, value); reconcile(); emit();
    },
    configure(value, minutes) {
      requireWrite();
      if (!Number.isSafeInteger(minutes) || minutes < 1) throw new Error("全局检查间隔须为正整数分钟。");
      const next = requireTime(clock + minutes * 60_000);
      enabled = value; intervalMinutes = minutes; nextCheck = next;
      for (const task of tasks.values()) task.nextRunAt = undefined;
      reconcile(); emit();
    },
    runNow(filter) { requireWrite(); reconcile(); admit(filter, "manual"); emit(); },
    advance() {
      requireWrite();
      reconcile();
      // Finish only runs already admitted. A separate click can then simulate the next due check.
      const nextClock = requireTime(pending.size || !enabled ? clock + 1000 : Math.max(clock + 1000, nextCheck));
      requireTime(nextClock + intervalMinutes * 60_000);
      if (pending.size) {
        clock = nextClock;
        for (const [id, { run, input }] of pending) {
          const task = tasks.get(id)!;
          run.endedAt = at();
          run.report = report(input);
          if (analysed.get(id) === input.fingerprint) {
            run.status = "skipped"; run.message = "需求与代码未发生变化，已跳过重复分析。";
          } else if (task.projectId === "demo-aurora" && task.srId === "sr-permissions" && !failedSamples.has(id)) {
            failedSamples.add(id); run.status = "failed";
            run.failure = failureSamples[0]; run.report = undefined;
            run.message = failureMessage(failureSamples[0]!);
            task.error = run.message;
          } else {
            run.status = "succeeded"; run.message = "分析完成，当前进度未发生变化。";
            analysed.set(id, input.fingerprint);
          }
          task.nextRunAt = nextAt();
        }
        pending.clear();
      } else if (enabled) {
        clock = nextClock;
        lastCheckAt = at(); nextCheck = clock + intervalMinutes * 60_000;
        admit({}, "schedule");
      } else clock = nextClock;
      reconcile(); emit();
    },
    // Resource cleanup is not a settings write: read-only visitors must also be able to unmount.
    dispose() { if (disposed) return; disposed = true; subscription.dispose(); listeners.clear(); pending.clear(); },
  };
}
