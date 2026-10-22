import { createHash } from "node:crypto";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { toolCallCreateWorkflowDisplaySchema } from "../schema/vendor/zcode-protocol-v4/create-workflow-display.js";
import type { WorkflowLaunchMeta } from "../schema/vendor/zcode-protocol-v4/workflow-row-meta.js";
import { boundCausalityGraph } from "./vendor/workflow-display/create-workflow-graph-bounds.js";
import {
	analyzeWorkflowScript,
	buildAskSpecs,
	collectSites,
	collectPhaseNames,
	collectSitePhases,
	createWorkflowProgram,
	lowerWorkflow,
	synthesizeAskSchemas,
	MODEL_UNRESOLVED_CODE,
	type CompileDiagnostic,
	type AnalyzeResult,
	type AskSpec,
} from "./vendor/dynamic-workflow/index.js";

export interface CompiledWorkflow {
	ok: true;
	analysis: AnalyzeResult;
	lowered: string;
	askSpecs: Map<string, AskSpec>;
	sitePhases: ReadonlyMap<string, string>;
	phases: { phaseNames: string[]; holes: number[] };
	modelBindings: Map<string, Model<Api>>;
	scriptHash: string;
	display: NonNullable<WorkflowLaunchMeta["display"]>;
}
export type WorkflowCompilation = CompiledWorkflow | { ok: false; diagnostics: CompileDiagnostic[]; message: string };
export function compileWorkflow(script: string, catalog?: readonly Model<Api>[]): WorkflowCompilation {
	const analysis = analyzeWorkflowScript(script);
	const diagnostics: CompileDiagnostic[] = [...analysis.diagnostics];
	const modelBindings = new Map<string, Model<Api>>();
	for (const reference of analysis.modelReferences) {
		if (catalog === undefined) continue;
		if (modelBindings.has(reference.name)) continue;
		const name = reference.name.toLowerCase();
		const exact = catalog.filter(model => `${model.provider}/${model.id}`.toLowerCase() === name);
		const matches = exact.length ? exact : catalog.filter(model => model.id.toLowerCase() === name);
		if (matches.length === 1) modelBindings.set(reference.name, matches[0]!);
		else
			diagnostics.push({
				code: MODEL_UNRESOLVED_CODE,
				line: reference.line,
				column: reference.column,
				message: `The model "${reference.name}" named in the script cannot be used: ${matches.length ? "the name is ambiguous" : "no matching model in the native model catalog"}.`,
			});
	}
	if (!analysis.ok || diagnostics.length)
		return { ok: false as const, diagnostics, message: formatDiagnostics(diagnostics) };
	const workflow = createWorkflowProgram(script);
	const table = collectSites(workflow);
	const synthesized = synthesizeAskSchemas(workflow, table);
	if (synthesized.diagnostics.length)
		return {
			ok: false as const,
			diagnostics: synthesized.diagnostics,
			message: formatDiagnostics(synthesized.diagnostics),
		};
	const lowered = lowerWorkflow(workflow, table);
	return {
		ok: true as const,
		analysis,
		lowered: lowered.code,
		askSpecs: buildAskSpecs(table, synthesized.schemas),
		sitePhases: collectSitePhases(analysis.core!),
		phases: collectPhaseNames(analysis.flow!),
		modelBindings,
		scriptHash: createHash("sha256").update(script, "utf8").digest("hex"),
		// 启动轮过去丢弃分析图，真实 actor 虽完成却无法显示阶段；与模型工具共用同一编译投影。
		display: toolCallCreateWorkflowDisplaySchema.parse({
			kind: "create_workflow",
			ok: true,
			errorCount: 0,
			diagnostics: [],
			...(analysis.causality === undefined
				? {}
				: { causalityGraph: boundCausalityGraph(analysis.causality, analysis.flow, analysis.handoff) }),
		}),
	};
}
export function formatDiagnostics(diagnostics: readonly CompileDiagnostic[]): string {
	return diagnostics
		.map(diagnostic => `${diagnostic.code} L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
		.join("\n")
		.slice(0, 2000);
}
