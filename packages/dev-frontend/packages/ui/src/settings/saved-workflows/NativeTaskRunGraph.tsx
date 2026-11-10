import { useMemo, type ReactNode } from "react";
import type { NativeTaskActor, NativeTaskRun, NativeTaskStatus } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { WorkflowCardHeader } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const STATUS_LABELS: Record<NativeTaskStatus, [string, string]> = {
  pending: ["Pending", "待运行"],
  running: ["Running", "运行中"],
  waiting: ["Waiting", "等待中"],
  blocked: ["Blocked", "受阻"],
  idle: ["Idle", "空闲"],
  completed: ["Completed", "已完成"],
  failed: ["Failed", "失败"],
  cancelled: ["Cancelled", "已取消"],
  unknown: ["Unknown", "未知"],
};

export function NativeTaskStatusBadge({ status }: { status: NativeTaskStatus }) {
  const { locale } = useZCodeIntl();
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          status === "running" ? "wf-lamp bg-primary" :
            status === "failed" ? "bg-destructive" :
              status === "completed" ? "bg-success" :
                status === "blocked" || status === "waiting" ? "bg-warning" :
                  "border border-foreground-subtlest",
        )}
      />
      <span key={status} className="wf-swap">
        {STATUS_LABELS[status][locale.startsWith("zh") ? 1 : 0]}
      </span>
    </span>
  );
}

/** Only observed session ancestry: no workflow phases or dependency edges. */
export function NativeTaskRunGraph({
  run,
  onOpenActor,
}: {
  run: NativeTaskRun;
  onOpenActor: (actor: NativeTaskActor) => void;
}) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const forest = useMemo(() => {
    const ids = new Set(run.actors.map((actor) => actor.sessionId));
    const children = new Map<string, NativeTaskActor[]>();
    for (const actor of run.actors) {
      const siblings = children.get(actor.parentSessionId);
      if (siblings) siblings.push(actor);
      else children.set(actor.parentSessionId, [actor]);
    }
    const roots = [...children.keys()].filter((id) => !ids.has(id));
    const reached = new Set<string>();
    const visit = (parent: string) => {
      for (const actor of children.get(parent) ?? []) {
        if (reached.has(actor.sessionId)) continue;
        reached.add(actor.sessionId);
        visit(actor.sessionId);
      }
    };
    for (const root of roots) visit(root);
    return { children, roots, unlinked: run.actors.filter((actor) => !reached.has(actor.sessionId)) };
  }, [run.actors]);

  const actorNode = (actor: NativeTaskActor, ancestors: ReadonlySet<string>): ReactNode => (
    <li key={actor.sessionId} className="min-w-0 pl-4 pt-3">
      <button
        type="button"
        className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-lg border border-card-border px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        onClick={() => onOpenActor(actor)}
        title={`${actor.agentId} · ${actor.sessionId}`}
      >
        <span className="min-w-0 flex-1 break-words text-ui-base text-foreground">{actor.title}</span>
        <NativeTaskStatusBadge status={actor.status} />
        <span className="w-full break-all font-mono text-ui-xs text-foreground-subtlest">{actor.sessionId}</span>
      </button>
      {!ancestors.has(actor.sessionId) && (forest.children.get(actor.sessionId)?.length ?? 0) > 0 ? (
        <ul className="ml-3 border-l border-card-border">
          {forest.children.get(actor.sessionId)?.map((child) =>
            actorNode(child, new Set([...ancestors, actor.sessionId])),
          )}
        </ul>
      ) : null}
    </li>
  );

  return (
    <div className="min-w-0">
      <WorkflowCardHeader
        kind={zh ? "原生任务" : "Native task"}
        name={run.title}
        status={<NativeTaskStatusBadge status={run.status} />}
        detail={run.toolCallId}
        expanded
        live={run.status === "running"}
      />
      <div className="mt-3 space-y-3" aria-label={zh ? "父子会话关系" : "Parent-child sessions"}>
        {forest.roots.map((parentId) => (
          <div key={parentId}>
            <p className="break-all font-mono text-ui-xs text-foreground-subtlest">
              {zh ? "父会话" : "Parent session"}: {parentId}
            </p>
            <ul className="ml-2 border-l border-card-border">
              {forest.children.get(parentId)?.map((actor) => actorNode(actor, new Set()))}
            </ul>
          </div>
        ))}
        {forest.unlinked.length > 0 ? (
          <ul>
            {forest.unlinked.map((actor) => (
              <li key={actor.sessionId}>
                <p className="break-all text-ui-xs text-foreground-subtlest">
                  {zh ? "父会话" : "Parent session"}: {actor.parentSessionId}
                </p>
                <ul>{actorNode(actor, new Set([actor.sessionId]))}</ul>
              </li>
            ))}
          </ul>
        ) : null}
        {run.actors.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtlest">
            {zh ? "尚未观测到子代理会话。" : "No child agent sessions observed."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
