import { mock } from "bun:test";
import * as path from "node:path";
import * as vendor from "#openwiki-vendor";

// Run only in a child process: module mocks must never poison other consumer tests.
const root = process.cwd();
const mode = process.env.OPENWIKI_PROBE_MODE;
const events: Array<{ type: string; selector?: string; instance?: number }> = [];
let nextInstance = 0;
let options: Record<string, unknown> | undefined;
let visualization: Record<string, unknown> | undefined;
let closedVisualizers = 0;
mock.module("../../src/openwiki/model", () => ({
	previewOpenWikiModel: async () => {
		throw new Error("Generation unexpectedly previewed a model");
	},
	resolveOpenWikiPlannerSelector: async (selector?: string) => selector ?? process.env.OPENWIKI_PROBE_PLAN,
	createOpenWikiModel: createFixtureModel,
}));
type FixtureModel = {
	modelId: string;
	model: { instance: number };
	createPlannerModel(selector?: string): Promise<FixtureModel>;
	dispose(): void;
};
async function createFixtureModel(selector?: string): Promise<FixtureModel> {
	events.push({ type: "create", selector });
	if (mode === "planner-error" && selector === "fixture/planner") throw new Error("planner unavailable");
	const instance = ++nextInstance;
	return {
		modelId: selector ?? "fixture/default",
		model: { instance },
		async createPlannerModel(plannerSelector?: string) {
			const effectiveSelector = plannerSelector ?? process.env.OPENWIKI_PROBE_PLAN;
			if (effectiveSelector === undefined || effectiveSelector === selector) return this;
			return createFixtureModel(effectiveSelector);
		},
		dispose: () => events.push({ type: "dispose", instance }),
	};
}
mock.module("../../src/openwiki/resources", () => ({
	materializeOpenWikiSkills: async () => path.join(root, "bundled-skills"),
}));
mock.module("../../src/openwiki/visual-assets", () => ({
	getOpenWikiVisualAssets: async () => ({ clientJs: "client", clientLibJs: "library", stylesCss: "styles" }),
}));
mock.module("../../src/openwiki/vendor-loader", () => ({
	loadOpenWikiVendor: async () => ({
		...vendor,
		resolveRepositoryRoot: async () => root,
		runNativeRepositoryGeneration: async (input: Record<string, unknown>) => {
			options = { ...input, signal: undefined, onEvent: undefined };
			if (mode === "generation-error") throw new Error("finalization refused");
			if (mode === "cancel") process.emit("SIGINT");
			return { skipped: false, partialFailure: mode === "partial", sourceChanged: mode === "drift" };
		},
		startEmbeddedVisualizeServer: async (input: Record<string, unknown>) => {
			visualization = { wikiRoot: input.wikiRoot, port: input.port, open: input.open };
			process.emit("SIGINT");
			return {
				url: "http://127.0.0.1:8765",
				close: async () => {
					closedVisualizers++;
				},
			};
		},
	}),
}));
const { runOpenWikiCommand } = await import("../../src/cli/openwiki-cli");
const before = { interrupt: process.listenerCount("SIGINT"), terminate: process.listenerCount("SIGTERM") };
const standalone = () => [
	vendor.parseCommand(["personal", "--init"]),
	vendor.parseCommand(["mcp"]),
	vendor.parseCommand(["integrations", "list"]),
	vendor.parseCommand(["ingest", "all"]),
];
const standaloneBefore = standalone();
const code = await runOpenWikiCommand(JSON.parse(process.env.OPENWIKI_PROBE_ARGS ?? "[]"));
const after = { interrupt: process.listenerCount("SIGINT"), terminate: process.listenerCount("SIGTERM") };
process.stdout.write(
	`\nHOST_RESULT=${JSON.stringify({ code, events, options, before, after, visualization, closedVisualizers, standaloneBefore, standaloneAfter: standalone() })}\n`,
);
