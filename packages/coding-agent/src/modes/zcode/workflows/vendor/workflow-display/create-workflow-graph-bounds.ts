// Adapted from pinned ZCode core/src/tool/handlers/create-workflow-graph-bounds.ts.
// The contracts are the already-vendored wire schema; only imports/types are adapted.
import type { ToolCallCreateWorkflowCausalityGraph } from "../../../schema/vendor/zcode-protocol-v4/create-workflow-display.js";
import {
	FLOW_ABORT,
	FLOW_ENTRY,
	FLOW_SINK,
	UNPHASED,
	type CausalityGraph,
	type ControlFlowGraph,
	type FlowHole,
	type HandoffGraph,
} from "../dynamic-workflow/projections.js";
import { foldPhaseEdges, type RawEdge } from "./create-workflow-graph-fold.js";

type CreateWorkflowCausalityGraph = ToolCallCreateWorkflowCausalityGraph;
type CreateWorkflowParticipant = CreateWorkflowCausalityGraph["participants"][number];
type CreateWorkflowHandoff = CreateWorkflowCausalityGraph["handoffs"][number];
type CreateWorkflowPhase = NonNullable<CreateWorkflowCausalityGraph["phases"]>[number];
type CreateWorkflowLane = CreateWorkflowCausalityGraph["lanes"][number];
type CreateWorkflowStep = CreateWorkflowCausalityGraph["steps"][number];
type CreateWorkflowHole = NonNullable<CreateWorkflowCausalityGraph["holes"]>[number];
type CreateWorkflowStream = NonNullable<CreateWorkflowCausalityGraph["phaseStreams"]>[number];
type CreateWorkflowNamePattern = NonNullable<CreateWorkflowLane["namePattern"]>;

// Same bounds as pinned contracts/tools/create-workflow.ts and the wire schema.
const CREATE_WORKFLOW_GRAPH_MAX_STEPS = 64;
const CREATE_WORKFLOW_GRAPH_MAX_LANES = 32;
const CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS = 64;
const CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS = 256;
const CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES = 8;
const CREATE_WORKFLOW_GRAPH_MAX_PHASES = 32;
const CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES = 128;
const CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS = 64;
const CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS = 128;
const CREATE_WORKFLOW_GRAPH_MAX_HOLES = CREATE_WORKFLOW_GRAPH_MAX_PHASES;

/** 三份原生分析投影一起裁剪：因果站点、控制阶段、真实 actor 参与者不能丢掉任一层。 */
export function boundCausalityGraph(
	graph: CausalityGraph,
	flow?: ControlFlowGraph,
	handoff?: HandoffGraph,
): CreateWorkflowCausalityGraph {
	let truncated = graph.steps.length > CREATE_WORKFLOW_GRAPH_MAX_STEPS;
	const headSteps = graph.steps.slice(0, CREATE_WORKFLOW_GRAPH_MAX_STEPS);
	const wantedLanes = new Set<string>();
	for (const step of headSteps) {
		wantedLanes.add(step.lane);
		for (const lane of step.lanes ?? []) wantedLanes.add(lane);
	}
	const laneList = graph.lanes.filter(lane => wantedLanes.has(lane.id));
	truncated = truncated || laneList.length > CREATE_WORKFLOW_GRAPH_MAX_LANES;
	const keptLanes = laneList.slice(0, CREATE_WORKFLOW_GRAPH_MAX_LANES);
	const laneIds = new Set(keptLanes.map(lane => lane.id));
	const steps = headSteps.filter(step => laneIds.has(step.lane));
	truncated = truncated || steps.length < headSteps.length;
	const stepIds = new Set(steps.map(step => step.id));

	const participantList: CreateWorkflowParticipant[] = [];
	for (const participant of handoff?.participants ?? []) {
		if (!laneIds.has(participant.lane)) continue;
		const memberSteps = participant.steps.filter(id => stepIds.has(id));
		if (memberSteps.length === 0) continue;
		participantList.push({
			id: boundGraphText(participant.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
			phase: boundGraphText(participant.phase, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
			lane: boundGraphText(participant.lane, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
			steps: memberSteps.slice(0, CREATE_WORKFLOW_GRAPH_MAX_STEPS).map(id => boundGraphText(id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS)),
			...(participant.member === undefined ? {} : { member: { ...participant.member } }),
			...(participant.many === true ? { many: true as const } : {}),
		});
	}
	truncated = truncated || participantList.length < (handoff?.participants.length ?? 0);
	truncated = truncated || participantList.length > CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS;
	const participants = participantList.slice(0, CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS);
	const participantIds = new Set(participants.map(participant => participant.id));
	const handoffList: CreateWorkflowHandoff[] = (handoff?.handoffs ?? [])
		.filter(edge => participantIds.has(edge.from) && participantIds.has(edge.to))
		.map(edge => {
			const types = (edge.types ?? []).slice(0, CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES)
				.map(type => boundGraphText(type, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS)).filter(type => type.length > 0);
			return {
				from: boundGraphText(edge.from, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
				to: boundGraphText(edge.to, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
				...(edge.back === true ? { back: true as const } : {}),
				...(types.length > 0 ? { types } : {}),
			};
		});
	truncated = truncated || handoffList.length < (handoff?.handoffs.length ?? 0);
	truncated = truncated || handoffList.length > CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS;
	const handoffs = handoffList.slice(0, CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS);
	const sink = (graph.sink?.fedBy ?? []).filter(id => stepIds.has(id))
		.slice(0, CREATE_WORKFLOW_GRAPH_MAX_STEPS).map(id => boundGraphText(id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS));

	const declaredPhases = flow?.phases;
	const phaseIds = new Set((declaredPhases ?? []).map(phase => phase.id));
	const rawPhaseEdges: RawEdge[] = [];
	const exitSet = new Set<string>();
	for (const edge of flow?.phaseEdges ?? []) {
		if (edge.from === FLOW_ENTRY || edge.from === FLOW_ABORT || edge.to === FLOW_ABORT) continue;
		if (!phaseIds.has(edge.from)) continue;
		if (edge.to === FLOW_SINK) {
			exitSet.add(edge.from);
			continue;
		}
		if (!phaseIds.has(edge.to)) continue;
		rawPhaseEdges.push({ back: edge.kind === "loop", from: edge.from, to: edge.to });
	}
	const phaseEdges = foldPhaseEdges(rawPhaseEdges).map(edge => ({
		from: boundGraphText(edge.from, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
		to: boundGraphText(edge.to, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
		...(edge.back ? { back: true as const } : {}),
	}));
	const phaseStreams = boundPhaseStreams(graph, declaredPhases, phaseIds);
	const phaseVocabularyDropped = declaredPhases !== undefined &&
		(declaredPhases.length > CREATE_WORKFLOW_GRAPH_MAX_PHASES ||
			phaseEdges.length > CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES ||
			phaseStreams.length > CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES);
	truncated = truncated || phaseVocabularyDropped;
	const emitPhases = declaredPhases !== undefined && !phaseVocabularyDropped;
	const boundPhases: CreateWorkflowPhase[] = (declaredPhases ?? []).map(phase => {
		const name = phase.name ? boundGraphText(phase.name, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : undefined;
		const alongside: string[] = [];
		const alongsideSeen = new Set<string>();
		for (const id of phase.alongside ?? []) {
			if (id === phase.id || !phaseIds.has(id) || alongsideSeen.has(id)) continue;
			if (alongside.length >= CREATE_WORKFLOW_GRAPH_MAX_PHASES) break;
			alongsideSeen.add(id);
			alongside.push(boundGraphText(id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS));
		}
		return {
			id: boundGraphText(phase.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
			...(name === undefined ? {} : { name }),
			...(phase.loc === undefined ? {} : { line: phase.loc.line, column: phase.loc.column }),
			...(alongside.length === 0 ? {} : { alongside }),
			...fillMark(phase, graph.phases?.find(candidate => candidate.id === phase.id)),
		};
	});
	const exits = (declaredPhases ?? []).filter(phase => exitSet.has(phase.id))
		.map(phase => boundGraphText(phase.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS));
	const boundLanes: CreateWorkflowLane[] = keptLanes.map(lane => {
		const name = lane.name ? boundGraphText(lane.name, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : undefined;
		const namePattern = boundNamePattern(lane.namePattern);
		return {
			id: boundGraphText(lane.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
			...(name === undefined ? {} : { name }),
			...(namePattern === undefined ? {} : { namePattern }),
			...(lane.loc === undefined ? {} : { line: lane.loc.line, column: lane.loc.column }),
		};
	});
	const boundSteps: CreateWorkflowStep[] = steps.map(step => {
		const lanes = (step.lanes ?? []).filter(lane => laneIds.has(lane));
		const label = step.label ? boundGraphText(step.label, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : step.id;
		const labelPattern = boundNamePattern(step.labelPattern);
		return {
			id: boundGraphText(step.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
			kind: step.kind,
			label,
			...(labelPattern === undefined ? {} : { labelPattern }),
			line: step.loc.line,
			column: step.loc.column,
			lane: boundGraphText(step.lane, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
			...(lanes.length > 1 ? { lanes } : {}),
			...(step.source === undefined ? {} : { source: boundGraphText(step.source, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) }),
			...(emitPhases && step.phase !== undefined && phaseIds.has(step.phase)
				? { phase: boundGraphText(step.phase, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) } : {}),
			...(step.repeat === undefined ? {} : { repeat: step.repeat }),
			...fillMark(step),
		};
	});
	const boundParticipants: CreateWorkflowParticipant[] = participants.map(participant =>
		emitPhases && phaseIds.has(participant.phase) ? participant : { ...participant, phase: UNPHASED });
	const openHoles: readonly FlowHole[] = flow?.holes ?? [];
	truncated = truncated || openHoles.length > CREATE_WORKFLOW_GRAPH_MAX_HOLES;
	const holes: CreateWorkflowHole[] = openHoles.slice(0, CREATE_WORKFLOW_GRAPH_MAX_HOLES).map(hole => ({
		siteId: boundGraphText(hole.siteId, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
		name: hole.name ? boundGraphText(hole.name, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : hole.siteId,
		type: hole.type ? boundGraphText(hole.type, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : "unknown",
		...(emitPhases && hole.phase !== undefined && phaseIds.has(hole.phase)
			? { phase: boundGraphText(hole.phase, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) } : {}),
		...(hole.tail === true ? { tail: true as const } : {}),
	}));
	return {
		steps: boundSteps,
		lanes: boundLanes,
		participants: boundParticipants,
		handoffs,
		...(emitPhases ? { phases: boundPhases, phaseEdges, exits } : {}),
		...(emitPhases && phaseStreams.length > 0 ? { phaseStreams } : {}),
		...(sink.length > 0 ? { sink } : {}),
		...(holes.length > 0 ? { holes } : {}),
		...(truncated ? { truncated: true } : {}),
	};
}

function boundPhaseStreams(
	graph: CausalityGraph,
	declaredPhases: ControlFlowGraph["phases"] | undefined,
	phaseIds: ReadonlySet<string>,
): CreateWorkflowStream[] {
	const alongside = new Set<string>();
	for (const phase of declaredPhases ?? []) {
		for (const id of phase.alongside ?? []) {
			alongside.add(`${phase.id}>${id}`);
			alongside.add(`${id}>${phase.id}`);
		}
	}
	const streams: CreateWorkflowStream[] = [];
	const seen = new Set<string>();
	for (const edge of graph.phaseEdges ?? []) {
		if (edge.kind !== "data" || edge.from === edge.to) continue;
		if (!phaseIds.has(edge.from) || !phaseIds.has(edge.to)) continue;
		const key = `${edge.from}>${edge.to}`;
		if (!alongside.has(key) || seen.has(key)) continue;
		seen.add(key);
		streams.push({
			from: boundGraphText(edge.from, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
			to: boundGraphText(edge.to, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
		});
	}
	return streams;
}

function fillMark(...nodes: ({ fill?: string } | undefined)[]): { fill?: string } {
	for (const node of nodes) {
		const fill = node?.fill;
		if (fill !== undefined && fill.length > 0) return { fill: boundGraphText(fill, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) };
	}
	return {};
}

function boundGraphText(value: string, maxChars: number): string {
	const bounded = value.slice(0, maxChars);
	const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
	return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

function boundNamePattern(pattern: { head?: string; tail?: string } | undefined): CreateWorkflowNamePattern | undefined {
	if (pattern === undefined) return undefined;
	const head = pattern.head ? boundGraphText(pattern.head, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : "";
	const tail = pattern.tail ? boundGraphText(pattern.tail, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : "";
	if (head === "" && tail === "") return undefined;
	return { ...(head === "" ? {} : { head }), ...(tail === "" ? {} : { tail }) };
}
