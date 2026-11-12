import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const modelModule = path.resolve(import.meta.dir, "../../src/openwiki/model.ts");

async function selection(options: { company?: boolean; plan?: string | null; selector?: string; planner?: string }) {
	using dir = TempDir.createSync("@omp-openwiki-model-selection-");
	const home = dir.join("home");
	const configRoot = dir.join("config");
	const agentDir = path.join(configRoot, "profiles", "fixture", "agent");
	const claudeDir = path.join(home, ".claude");
	await fs.mkdir(home, { recursive: true });
	if (options.company) {
		await Bun.write(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_AUTH_TOKEN: "fixture-token" } }),
		);
	}
	await Bun.write(
		path.join(agentDir, "config.yml"),
		Bun.YAML.stringify({
			modelRoles: {
				default: "deepseek/page-model",
				...(options.plan !== undefined ? { plan: options.plan } : {}),
			},
			startup: { setupWizard: false },
		}),
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		Bun.YAML.stringify({
			providers: {
				deepseek: {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					auth: "none",
					models: ["page-model", "planner-model"].map(id => ({
						id,
						name: id,
						supportsTools: true,
						input: ["text"],
						contextWindow: 100000,
						maxTokens: 4096,
					})),
				},
			},
		}),
	);
	const script = `
		import { createOpenWikiModel } from ${JSON.stringify(modelModule)};
		globalThis.fetch = async () => { throw new Error("Model selection must not make requests"); };
		const selected = await createOpenWikiModel(${JSON.stringify(options.selector)});
		let planner = selected;
		try {
			planner = await selected.createPlannerModel(${JSON.stringify(options.planner ?? options.selector)});
			console.log(JSON.stringify({ page: selected.modelId, planner: planner.modelId, shared: planner === selected }));
		} finally {
			if (planner !== selected) planner.dispose();
			selected.dispose();
		}
	`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		cwd: home,
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			HOME: home,
			USERPROFILE: home,
			CLAUDE_CONFIG_DIR: claudeDir,
			OMP_CONFIG_ROOT: configRoot,
			OMP_PROFILE: "fixture",
			OMP_OFFLINE: "1",
			AWS_EC2_METADATA_DISABLED: "true",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(code, stdout + stderr).toBe(0);
	return JSON.parse(stdout.trim());
}

describe("OpenWiki effective runtime planner selection", () => {
	it("reuses the page model without a configured plan or offline company defaults", async () => {
		expect(await selection({})).toEqual({
			page: "deepseek/page-model",
			planner: "deepseek/page-model",
			shared: true,
		});
	});

	it("uses the offline default plan even when the saved default is another provider", async () => {
		expect(await selection({ company: true })).toEqual({
			page: "deepseek/page-model",
			planner: "company/GLM-5.3-public",
			shared: false,
		});
	});

	it("keeps an explicitly configured plan ahead of offline defaults", async () => {
		expect(await selection({ company: true, plan: "deepseek/planner-model" })).toEqual({
			page: "deepseek/page-model",
			planner: "deepseek/planner-model",
			shared: false,
		});
	});

	it("preserves an explicitly cleared plan instead of applying an offline default", async () => {
		expect(await selection({ company: true, plan: null })).toEqual({
			page: "deepseek/page-model",
			planner: "deepseek/page-model",
			shared: true,
		});
	});

	it("keeps a public explicit selector ahead of the offline plan", async () => {
		expect(await selection({ company: true, selector: "deepseek/page-model" })).toEqual({
			page: "deepseek/page-model",
			planner: "deepseek/page-model",
			shared: true,
		});
	});

	it("keeps a separate planner selector ahead of the public selector", async () => {
		expect(
			await selection({ company: true, selector: "deepseek/page-model", planner: "deepseek/planner-model" }),
		).toEqual({
			page: "deepseek/page-model",
			planner: "deepseek/planner-model",
			shared: false,
		});
	});
});
