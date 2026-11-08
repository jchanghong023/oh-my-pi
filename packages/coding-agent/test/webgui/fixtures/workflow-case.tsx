import { useMemo, useState } from "react";
import type { AssistantTextRow, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { workflowActorStartState, type WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";
import { WorkflowArtifactBody } from "@/app-shell/workflow-artifacts/WorkflowArtifactBody.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { buildWorkflowTimeline, type TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import {
	openWorkflowActorSessionSidePane,
	openWorkflowArtifactSidePane,
	openWorkflowRunSidePane,
	type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import { buildWorkflowRunByRunId } from "@/v4/workflowRunCardJoin.js";

const RUN_ID = "core-workflow-run";
const PARENT_ID = "core-workflow-parent";
const TOOL_ID = "core-workflow-create";
const SCOPE = { workspaceKey: "core-workflow-workspace", workspacePath: "/core-workflow" };
const GRAPH: WorkflowCausalityGraphData = {
	steps: [
		{
			id: "ask#plan",
			kind: "ask",
			label: "Plan release",
			line: 2,
			column: 1,
			lane: "actor#planner",
			phase: "phase#plan",
		},
		{
			id: "ask#review",
			kind: "ask",
			label: "Review release",
			line: 4,
			column: 1,
			lane: "actor#reviewer",
			phase: "phase#review",
		},
	],
	lanes: [
		{ id: "actor#planner", name: "Planner", line: 1, column: 1 },
		{ id: "actor#reviewer", name: "Reviewer", line: 3, column: 1 },
	],
	participants: [
		{ id: "phase#plan:actor#planner", phase: "phase#plan", lane: "actor#planner", steps: ["ask#plan"] },
		{ id: "phase#review:actor#reviewer", phase: "phase#review", lane: "actor#reviewer", steps: ["ask#review"] },
	],
	handoffs: [],
	phases: [
		{ id: "phase#plan", name: "Planning", line: 1 },
		{ id: "phase#review", name: "Review", line: 3 },
	],
	phaseEdges: [{ from: "phase#plan", to: "phase#review" }],
	exits: ["phase#review"],
};
const MARKDOWN = new TextEncoder().encode(
	"# Release evidence\n\nDelivered by **Reviewer** for core-workflow-run.\n\n- Verified release notes\n",
);
const ARTIFACT: WorkflowRunArtifactView = {
	id: "release-evidence",
	kind: "markdown",
	title: "Release evidence",
	contentType: "text/markdown",
	version: 1,
	bytes: MARKDOWN.length,
	itemCount: 0,
	primary: true,
};
const TRANSCRIPTS: ReadonlyMap<string, AssistantTextRow> = new Map([
	[
		"core-workflow-planner",
		{
			kind: "assistantText",
			rowId: 1,
			turnId: "planner-turn",
			createdAt: 1,
			createdAtSeq: 1,
			state: "complete",
			text: "Planner private evidence: assemble the release plan.",
		},
	],
	[
		"core-workflow-reviewer",
		{
			kind: "assistantText",
			rowId: 2,
			turnId: "reviewer-turn",
			createdAt: 2,
			createdAtSeq: 2,
			state: "complete",
			text: "Reviewer private evidence: independently checked the release.",
		},
	],
]);
type Stage = "pending" | "running" | "completed";

function runAt(stage: Stage): WorkflowRunState {
	const completed = stage === "completed";
	return {
		runId: RUN_ID,
		toolCallId: TOOL_ID,
		status: stage,
		usage: { spentTokens: 0, nodesUsed: 2 },
		lastEventSequence: completed ? 3 : stage === "running" ? 2 : 1,
		actors: [
			{
				siteId: "actor#planner",
				ordinal: 1,
				name: "Planner",
				sessionId: "core-workflow-planner",
				status: completed ? "completed" : stage === "running" ? "running" : "waiting",
			},
			{
				siteId: "actor#reviewer",
				ordinal: 1,
				name: "Reviewer",
				sessionId: "core-workflow-reviewer",
				status: completed ? "completed" : "waiting",
			},
		],
		nodes: [
			{
				siteId: "ask#plan",
				ordinal: 1,
				actorSiteId: "actor#planner",
				actorOrdinal: 1,
				phase: completed ? "settled" : stage === "running" ? "executing" : "queued",
				...(completed ? { outcome: "ok" as const } : {}),
			},
			{
				siteId: "ask#review",
				ordinal: 1,
				actorSiteId: "actor#reviewer",
				actorOrdinal: 1,
				phase: completed ? "settled" : "queued",
				...(completed ? { outcome: "ok" as const } : {}),
			},
		],
		...(completed ? { artifacts: [ARTIFACT] } : {}),
	};
}

/** UI/presentation integration only: no Workflow engine, CLI producer or native execution bridge. */
export function WorkflowCase() {
	const [stage, setStage] = useState<Stage>("pending");
	const [panes, setPanes] = useState<WorkspaceSidePaneState | null>(null);
	const run = useMemo(() => runAt(stage), [stage]);
	const model = useMemo(() => buildWorkflowTimeline(GRAPH, run), [run]);
	const summary = useMemo(() => buildWorkflowRunByRunId([run]).get(RUN_ID), [run]);
	const active = panes?.tabs.find(tab => tab.id === panes.activeTabId);
	const openActor = (actor: WorkflowActorInstance) =>
		setPanes(current =>
			openWorkflowActorSessionSidePane(current, {
				...SCOPE,
				parentSessionId: PARENT_ID,
				runId: RUN_ID,
				siteId: actor.siteId,
				ordinal: actor.ordinal,
				...(actor.sessionId === undefined ? {} : { actorSessionId: actor.sessionId }),
				...(actor.name === undefined ? {} : { actorName: actor.name }),
			}),
		);
	const openPill = (pill: TimelinePill) => {
		if (!pill.slot) throw new Error("Workflow agent pill did not provide its actor slot");
		openActor({
			...pill.slot,
			status: "waiting",
			...(pill.runtimeName === undefined ? {} : { name: pill.runtimeName }),
			...(pill.instance?.sessionId === undefined ? {} : { sessionId: pill.instance.sessionId }),
		});
	};
	const openArtifact = (artifactId: string) =>
		setPanes(current =>
			openWorkflowArtifactSidePane(current, {
				...SCOPE,
				parentSessionId: PARENT_ID,
				runId: RUN_ID,
				artifactId,
			}),
		);
	const gate = active?.type === "workflow-actor-session" ? workflowActorStartState([run], active) : undefined;
	const row = gate?.state === "started" && gate.sessionId ? TRANSCRIPTS.get(gate.sessionId) : undefined;
	return (
		<ZCodeIntlProvider>
			<TooltipProvider>
				<main
					data-testid="core-workflow-case"
					data-coverage="ui-presentation-integration"
					className="mx-auto max-w-4xl space-y-4 p-6"
				>
					<nav aria-label="Workflow fixture projection controls" className="flex gap-3">
						{(["pending", "running", "completed"] as const).map(value => (
							<button
								key={value}
								type="button"
								data-testid={`core-workflow-${value}`}
								aria-pressed={stage === value}
								onClick={() => setStage(value)}
							>
								{value}
							</button>
						))}
					</nav>
					<WorkflowRunDigest
						name="Release workflow"
						runId={RUN_ID}
						graph={GRAPH}
						summary={summary}
						testIdKey="core-workflow"
						onOpenPill={openPill}
						onOpenArtifact={openArtifact}
						onOpenRun={() =>
							setPanes(current =>
								openWorkflowRunSidePane(current, {
									...SCOPE,
									parentSessionId: PARENT_ID,
									runId: RUN_ID,
									toolCallId: TOOL_ID,
									workflowName: "Release workflow",
								}),
							)
						}
					/>
					{active && (
						<section
							data-testid="core-workflow-content"
							data-pane-type={active.type}
							data-workflow-run-id={"runId" in active ? active.runId : undefined}
							data-parent-session-id={"parentSessionId" in active ? active.parentSessionId : undefined}
						>
							{active.type === "workflow-run" && (
								<WorkflowRunPhaseList
									graph={GRAPH}
									model={model}
									run={run}
									pendingQuestions={[]}
									onOpenActor={openActor}
								/>
							)}
							{active.type === "workflow-actor-session" && (
								<div
									data-testid="core-workflow-actor-content"
									data-actor-site-id={active.siteId}
									data-actor-ordinal={active.ordinal}
									data-actor-session-id={gate?.sessionId}
									data-actor-gate={gate?.state}
								>
									{row && (
										<ConversationRowView
											key={gate?.sessionId}
											row={row}
											context={{
												workspacePath: SCOPE.workspacePath,
												sessionId: gate?.sessionId,
												theme: "light",
												codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
											}}
											hideAssistantActions
										/>
									)}
								</div>
							)}
							{active.type === "workflow-artifact" &&
								active.runId === RUN_ID &&
								active.artifactId === ARTIFACT.id && (
									<div data-testid="core-workflow-artifact-content" data-artifact-id={active.artifactId}>
										<WorkflowArtifactBody
											artifact={ARTIFACT}
											version={1}
											bytes={MARKDOWN}
											blob={null}
											objectUrl={null}
											loading={false}
											error={null}
											items={[]}
											theme="light"
											resolvedTheme="light"
											isLatestVersion
											metadataLoading={false}
										/>
									</div>
								)}
						</section>
					)}
				</main>
			</TooltipProvider>
		</ZCodeIntlProvider>
	);
}
