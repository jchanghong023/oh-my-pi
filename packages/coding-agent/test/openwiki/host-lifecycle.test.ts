import { describe, expect, it } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

type Probe = {
	code: number;
	events: Array<{ type: string; selector?: string; instance?: number }>;
	options?: {
		root: string;
		mode: string;
		language: string;
		force: boolean;
		planningContext: string | null;
		modelId: string;
		model: { instance: number };
		plannerModel: { instance: number };
		pageConcurrency: number;
		embedded: boolean;
		skillsDir: string;
	};
	before: { interrupt: number; terminate: number };
	after: { interrupt: number; terminate: number };
	standaloneBefore: Array<{ kind: string; mode?: string; command?: string }>;
	standaloneAfter: Array<{ kind: string; mode?: string; command?: string }>;
	visualization?: { wikiRoot: string; port: number; open: boolean };
	closedVisualizers: number;
};

async function probe(root: string, args: string[], mode = "complete", plan?: string, concurrency?: string) {
	const home = path.join(root, "home");
	await mkdir(home, { recursive: true });
	const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../helpers/openwiki-host-probe.ts")], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			HOME: home,
			USERPROFILE: home,
			OMP_CONFIG_ROOT: path.join(home, "config"),
			OMP_OFFLINE: "1",
			OPENWIKI_PROBE_MODE: mode,
			OPENWIKI_PROBE_ARGS: JSON.stringify(args),
			...(plan === undefined ? {} : { OPENWIKI_PROBE_PLAN: plan }),
			...(concurrency === undefined ? {} : { OPENWIKI_PAGE_CONCURRENCY: concurrency }),
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exit, stdout + stderr).toBe(0);
	const payload = stdout.match(/^HOST_RESULT=(.*)$/m)?.[1];
	if (!payload) throw new Error(`Missing host result: ${stdout}\n${stderr}`);
	return { result: JSON.parse(payload) as Probe, stderr };
}

describe("OpenWiki host lifecycle contract", () => {
	// These narrow boundary tests complement the real-model/native-engine CLI suites.
	it.each(["--modelId", "--model-id"])(
		"reuses the explicit %s model and preserves native run inputs",
		async flag => {
			using dir = TempDir.createSync("@omp-openwiki-host-");
			const { result } = await probe(dir.path(), ["--init", "Document the retry flow", flag, "fixture/page:high"]);
			expect(result.code).toBe(0);
			expect(result.events).toEqual([
				{ type: "create", selector: "fixture/page:high" },
				{ type: "dispose", instance: 1 },
			]);
			expect(result.options).toEqual({
				root: dir.path(),
				mode: "init",
				language: "zh-CN",
				force: true,
				planningContext: "Document the retry flow",
				modelId: "fixture/page:high",
				model: { instance: 1 },
				plannerModel: { instance: 1 },
				pageConcurrency: 1,
				embedded: true,
				skillsDir: dir.join("bundled-skills"),
			});
			expect(result.after).toEqual(result.before);
			expect(await readFile(dir.join("openwiki", "INSTRUCTIONS.md"), "utf8")).toBe("");
		},
		30_000,
	);

	// Creation failure must release the page model even before native generation starts.
	it.each(["planner-error", "generation-error", "cancel", "partial", "drift", "complete"])(
		"releases both phase models and signal handlers after %s",
		async mode => {
			using dir = TempDir.createSync("@omp-openwiki-lifetime-");
			const { result, stderr } = await probe(
				dir.path(),
				["code", "--update", "--language", "en", "--model-id=fixture/page", "--planner-model=fixture/planner"],
				mode,
				"fixture/ignored-plan",
				"8",
			);
			expect(result.code).toBe(
				mode === "cancel" ? 130 : ["planner-error", "generation-error", "partial"].includes(mode) ? 1 : 0,
			);
			expect(result.events.filter(event => event.type === "create")).toEqual([
				{ type: "create", selector: "fixture/page" },
				{ type: "create", selector: "fixture/planner" },
			]);
			expect(result.events.filter(event => event.type === "dispose")).toEqual(
				mode === "planner-error"
					? [{ type: "dispose", instance: 1 }]
					: [
							{ type: "dispose", instance: 2 },
							{ type: "dispose", instance: 1 },
						],
			);
			expect(result.after).toEqual(result.before);
			if (mode === "planner-error") {
				expect(result.options).toBeUndefined();
				expect(stderr).toContain("planner unavailable");
			} else {
				expect(result.options).toMatchObject({
					mode: "update",
					language: "en",
					force: false,
					planningContext: null,
					modelId: "fixture/page",
					model: { instance: 1 },
					plannerModel: { instance: 2 },
					pageConcurrency: 8,
				});
			}
			if (mode === "generation-error") expect(stderr).toContain("finalization refused");
			if (mode === "partial") expect(stderr).toContain("did not complete all pages");
			if (mode === "drift") expect(stderr).toMatch(/source changed[\s\S]*--update/);
		},
		30_000,
	);

	// Invalid pool bounds fail before creating a model or touching Wiki state.
	it.each(["0", "9", "1.5", "many"])(
		"rejects invalid page concurrency %s before generation",
		async concurrency => {
			using dir = TempDir.createSync("@omp-openwiki-concurrency-");
			const { result, stderr } = await probe(dir.path(), ["--init"], "complete", undefined, concurrency);
			expect(result.code).toBe(1);
			expect(result.events).toEqual([]);
			expect(result.options).toBeUndefined();
			expect(stderr).toContain("OPENWIKI_PAGE_CONCURRENCY");
			expect(await Bun.file(dir.join("openwiki", "INSTRUCTIONS.md")).exists()).toBe(false);
			expect(result.after).toEqual(result.before);
		},
		30_000,
	);

	// Host exclusions must not mutate the fork's separate public parser capability.
	it("rejects embedded personal mode without disabling standalone personal, MCP, integration or ingest entry points", async () => {
		using dir = TempDir.createSync("@omp-openwiki-standalone-boundary-");
		const { result, stderr } = await probe(dir.path(), ["personal", "--init"]);
		expect(result.code).toBe(1);
		expect(stderr).toContain("not supported by OMP");
		expect(result.events).toEqual([]);
		expect(result.standaloneBefore[0]).toMatchObject({ kind: "run", mode: "personal", command: "init" });
		expect(result.standaloneBefore.slice(1).map(command => command.kind)).toEqual(["mcp", "integrations", "ingest"]);
		expect(result.standaloneAfter).toEqual(result.standaloneBefore);
		expect(await Bun.file(dir.join("openwiki", "INSTRUCTIONS.md")).exists()).toBe(false);
	}, 30_000);

	it("defaults an omitted-code update to Chinese without forcing generation or a task role", async () => {
		using dir = TempDir.createSync("@omp-openwiki-update-defaults-");
		const { result } = await probe(dir.path(), ["--update"]);
		expect(result.code).toBe(0);
		expect(result.options).toMatchObject({
			mode: "update",
			language: "zh-CN",
			force: false,
			planningContext: null,
			model: { instance: 1 },
			plannerModel: { instance: 1 },
			pageConcurrency: 1,
		});
		expect(result.events).toEqual([{ type: "create" }, { type: "dispose", instance: 1 }]);
	}, 30_000);

	it.each([true, false])(
		"preserves visualizer path, port and browser-open=%s and closes on command interruption",
		async open => {
			using dir = TempDir.createSync("@omp-openwiki-visual-host-");
			const { result } = await probe(dir.path(), [
				"visualize",
				"custom/wiki",
				"--port",
				"8765",
				...(open ? [] : ["--no-open"]),
			]);
			expect(result.code).toBe(0);
			expect(result.visualization).toEqual({ wikiRoot: dir.join("custom", "wiki"), port: 8765, open });
			expect(result.closedVisualizers).toBe(1);
			expect(result.events).toEqual([]);
			expect(result.after).toEqual(result.before);
		},
		30_000,
	);
});
