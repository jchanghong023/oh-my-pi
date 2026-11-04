import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadOpenWikiVendor } from "../../src/openwiki/vendor-loader";

const pages = ["/openwiki/alpha.md", "/openwiki/beta.md", "/openwiki/gamma.md", "/openwiki/quickstart.md"];
type Message = { role: string; content?: unknown; tool_call_id?: string };

async function repository(root: string) {
	await mkdir(root, { recursive: true });
	async function git(...args: string[]) {
		const child = Bun.spawn(["git", ...args], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
		});
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
	}
	await git("init", "--quiet");
	await git("config", "user.name", "Fixture");
	await git("config", "user.email", "fixture@example.invalid");
	await writeFile(path.join(root, "README.md"), "Stable source for pool tests.\n");
	await git("add", "README.md");
	await git("commit", "--quiet", "-m", "stable pool source");
	return git;
}

async function scenario(
	mode:
		| "rate"
		| "fatal"
		| "ownership"
		| "finalization"
		| "resume-drift"
		| "instructions"
		| "verification"
		| "partial-baseline",
) {
	using dir = TempDir.createSync("@omp-openwiki-native-pool-");
	const root = dir.join("repo");
	const git = await repository(root);
	const starts: string[] = [];
	const requests: string[] = [];
	const activeRateWorkers = new Set<string>();
	let peakRateWorkers = 0;
	const deniedWrites: string[] = [];
	let plans = 0;
	let interrupted = false;
	const interruption = new AbortController();
	const betaReady = Promise.withResolvers<void>();
	const alphaCommitted = Promise.withResolvers<void>();
	let betaBeforeAlpha: string | undefined;
	let betaAfterAlpha: string | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { messages: Message[] };
			const page = JSON.stringify(body.messages).match(/You own exactly (\/openwiki\/[^\s]+\.md)\./u)?.[1];
			const results = new Set(
				body.messages.filter(message => message.role === "tool").map(message => message.tool_call_id),
			);
			const call = (name: string, args: object, id = `call_${name}`) => ({
				role: "assistant",
				content: null,
				tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
			});
			let message: object = { role: "assistant", content: "Finished." };
			if (!page && !results.has("call_submit_plan")) {
				plans++;
				message = call("submit_plan", {
					pages: pages.map(page => ({
						path: page,
						title: path.basename(page, ".md"),
						purpose: "Document stable source",
						seedPaths: ["README.md"],
					})),
				});
			} else if (page) {
				requests.push(page);
				if (results.size === 0) starts.push(page);
				if (mode === "rate" && results.size === 0 && page !== pages[0]) {
					activeRateWorkers.add(page);
					peakRateWorkers = Math.max(peakRateWorkers, activeRateWorkers.size);
					// Keep work in flight past the native pool's staggered second start.
					await Bun.sleep(1_100);
				}
				if (mode === "rate" && results.has("call_submit_page")) activeRateWorkers.delete(page);
				if (mode === "verification" && plans === 2) {
					const betaSidecar = path.join(root, "openwiki", ".claims", "beta.json");
					if (page === pages[0] && results.size === 0) await betaReady.promise;
					if (page === pages[1] && results.has("call_edit_file") && !results.has("call_submit_page")) {
						betaBeforeAlpha = await readFile(betaSidecar, "utf8");
						betaReady.resolve();
						await alphaCommitted.promise;
					}
					if (page === pages[0] && results.has("call_submit_page")) {
						betaAfterAlpha = await readFile(betaSidecar, "utf8");
						alphaCommitted.resolve();
					}
				}
				if ((mode === "rate" || (mode === "partial-baseline" && plans === 2)) && page === pages[0]) {
					return Response.json(
						{ error: { message: "rate limit exceeded", code: "rate_limit_exceeded", type: "rate_limit_error" } },
						{ status: 429 },
					);
				}
				if (mode === "ownership" && !results.has("call_foreign_write")) {
					message = call(
						"write_file",
						{ file_path: "/openwiki/not-owned.md", content: "FORBIDDEN_CROSS_PAGE_WRITE" },
						"call_foreign_write",
					);
				} else if (!results.has("call_write_file") && !results.has("call_edit_file")) {
					if (mode === "ownership") {
						const denied = body.messages.find(message => message.tool_call_id === "call_foreign_write");
						deniedWrites.push(JSON.stringify(denied?.content));
					}
					const content = `---\ntype: Guide\ntitle: ${path.basename(page)}\n---\n# ${path.basename(page)}\n\nPOOL_CONTENT ${page}. Stable source for pool tests.\nRevision ${plans}.\n`;
					const existing = Bun.file(path.join(root, page.slice(1)));
					message = (await existing.exists())
						? call("edit_file", { file_path: page, old_string: await existing.text(), new_string: content })
						: call("write_file", { file_path: page, content });
				} else if (!results.has("call_submit_page")) {
					if (mode === "fatal" && page === pages[0]) {
						await writeFile(path.join(root, "openwiki", ".page-manifest.json"), "{ corrupt committed manifest");
					}
					const sidecar = Bun.file(path.join(root, "openwiki", ".claims", `${path.basename(page, ".md")}.json`));
					const id = (await sidecar.exists()) ? (await sidecar.json()).claims[0].id : undefined;
					message = call("submit_page", {
						claims: [
							{
								...(id && { id }),
								statement: "Stable source for pool tests.",
								evidence: [{ resource: "repo://README.md" }],
							},
						],
					});
				} else if (mode === "finalization" && page === pages.at(-1)) {
					await writeFile(path.join(root, "openwiki", ".page-manifest.json"), "{ corrupt committed manifest");
				}
			}
			// LangGraph uses completion IDs as message identities, so each turn
			// must append rather than overwrite the preceding tool-call message.
			return Response.json({
				id: `pool_${randomUUID()}`,
				object: "chat.completion",
				created: 0,
				model: "fixture",
				choices: [{ index: 0, message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			});
		},
	});
	try {
		const model = new ChatOpenAI({
			model: "fixture",
			apiKey: "fixture",
			configuration: { baseURL: `http://127.0.0.1:${server.port}/v1` },
			streaming: false,
			disableStreaming: true,
			maxRetries: 0,
		});
		const vendor = await loadOpenWikiVendor();
		const execute = (signal: AbortSignal, command: "init" | "update" = "init") =>
			vendor.runNativeRepositoryGeneration({
				root,
				mode: command,
				language: "en",
				force: false,
				planningContext: null,
				modelId: "fixture/pool",
				model,
				plannerModel: model,
				embedded: true,
				skillsDir: path.resolve(import.meta.dir, "../../../../vendor/openwiki/skills"),
				pageConcurrency: mode === "fatal" ? 1 : 2,
				signal,
				onEvent: event => {
					if (
						mode === "resume-drift" &&
						!interrupted &&
						event.type === "tool_end" &&
						event.name === "submit_plan"
					) {
						interrupted = true;
						interruption.abort(new Error("fixture interruption after durable plan"));
					}
				},
			});
		let execution = execute(mode === "resume-drift" ? interruption.signal : AbortSignal.timeout(20_000));
		if (mode === "resume-drift") {
			await expect(execution).rejects.toThrow(/fixture interruption|abort/i);
			expect(interrupted).toBe(true);
			expect(plans).toBe(1);
			expect(starts).toEqual([]);
			const checkpoint = JSON.parse(await readFile(path.join(root, "openwiki", ".run.json"), "utf8"));
			expect(checkpoint.plan.pages).toHaveLength(pages.length);
			await writeFile(path.join(root, "README.md"), "Stable source for pool tests.\nChanged before resume.\n");
			execution = execute(AbortSignal.timeout(20_000));
		}
		if (mode === "fatal" || mode === "finalization") {
			await expect(execution).rejects.toThrow(/manifest.*malformed/i);
			if (mode === "fatal") {
				expect([...new Set(requests)]).toEqual([pages[0]]);
				expect(starts).toEqual([pages[0]]);
			} else {
				expect(starts.slice().sort()).toEqual(pages.slice().sort());
				expect(starts.at(-1)).toBe(pages.at(-1));
				for (const page of pages) {
					expect(await readFile(path.join(root, page.slice(1)), "utf8")).toContain(`POOL_CONTENT ${page}`);
				}
			}
			expect(await readFile(path.join(root, "openwiki", ".page-manifest.json"), "utf8")).toBe(
				"{ corrupt committed manifest",
			);
			expect(JSON.parse(await readFile(path.join(root, "openwiki", ".last-update.json"), "utf8")).status).not.toBe(
				"complete",
			);
		} else {
			const result = await execution;
			expect(result.partialFailure === true).toBe(mode === "rate");
			expect(starts.slice().sort()).toEqual(pages.slice().sort());
			expect(starts.at(-1)).toBe(pages.at(-1));
			const completed = JSON.parse(await readFile(path.join(root, "openwiki", ".page-manifest.json"), "utf8"));
			if (mode === "rate") {
				expect(requests.filter(page => page === pages[0])).toHaveLength(1);
				expect(peakRateWorkers).toBe(1);
				expect(completed.pages[pages[0]]).toBeUndefined();
			} else if (mode === "ownership") {
				expect(deniedWrites).toHaveLength(pages.length);
				expect(await Bun.file(path.join(root, "openwiki", "not-owned.md")).exists()).toBe(false);
			}
			for (const page of mode === "rate" ? pages.slice(1) : pages) {
				expect(completed.pages[page].pageVersion).toMatch(/^sha256:/);
				expect(await readFile(path.join(root, page.slice(1)), "utf8")).toContain(`POOL_CONTENT ${page}`);
			}
		}
		if (mode === "resume-drift") expect(plans).toBe(2);
		if (mode === "instructions") {
			const instructions = path.join(root, "openwiki", "INSTRUCTIONS.md");
			const metadata = path.join(root, "openwiki", ".last-update.json");
			const update = () => execute(AbortSignal.timeout(20_000), "update");
			const commitWiki = async (message: string) => {
				await git("add", "openwiki");
				await git("commit", "--quiet", "-m", message);
			};
			// The native no-op gate requires a clean worktree apart from metadata
			// and covered instructions. Commit generated pages/Claims so they do
			// not independently force planning during these instruction checks.
			await commitWiki("record generated wiki baseline");
			await writeFile(instructions, "Prioritize useful source-grounded examples.\n");
			const changedInstructions = await update();
			expect(changedInstructions.skipped).toBe(false);
			expect(changedInstructions.partialFailure).toBeUndefined();
			expect(plans).toBe(2);
			expect(JSON.parse(await readFile(metadata, "utf8")).status).toBe("complete");
			await commitWiki("record covered wiki instructions");
			expect((await update()).skipped).toBe(true);
			expect(plans).toBe(2);
			await writeFile(instructions, "");
			expect((await update()).skipped).toBe(false);
			expect(plans).toBe(3);
			await commitWiki("record cleared wiki instructions");
			const removeBaseline = async () => {
				const saved = JSON.parse(await readFile(metadata, "utf8"));
				delete saved.instructionBaseline;
				await writeFile(metadata, JSON.stringify(saved));
			};
			await removeBaseline();
			await writeFile(instructions, "Legacy instruction changes must not be hidden.\n");
			expect((await update()).skipped).toBe(false);
			expect(plans).toBe(4);
			await commitWiki("record legacy wiki instruction update");
			await removeBaseline();
			await writeFile(instructions, "");
			await writeFile(path.join(root, "AGENTS.md"), "# Visible root instructions\nDocument the public API.\n");
			expect((await update()).skipped).toBe(false);
			expect(plans).toBe(5);
		}
		if (mode === "verification") {
			await writeFile(path.join(root, "README.md"), "Stable source for pool tests.\nAdditional source context.\n");
			const updated = await execute(AbortSignal.timeout(20_000), "update");
			expect(updated.partialFailure).toBeUndefined();
			expect(plans).toBe(2);
			expect(betaBeforeAlpha).toContain("Stable source for pool tests.");
			expect(betaAfterAlpha).toBe(betaBeforeAlpha);
			expect(starts.slice(pages.length).slice().sort()).toEqual(pages.slice().sort());
			expect(starts.at(-1)).toBe(pages.at(-1));
		}
		if (mode === "partial-baseline") {
			const metadataPath = path.join(root, "openwiki", ".last-update.json");
			const manifestPath = path.join(root, "openwiki", ".page-manifest.json");
			const baseline = JSON.parse(await readFile(metadataPath, "utf8"));
			const completedBefore = JSON.parse(await readFile(manifestPath, "utf8"));
			await writeFile(
				path.join(root, "README.md"),
				"Stable source for pool tests.\nNew committed source context.\n",
			);
			await git("add", "README.md");
			await git("commit", "--quiet", "-m", "change pool source");
			const partial = await execute(AbortSignal.timeout(20_000), "update");
			expect(partial.partialFailure).toBe(true);
			const incomplete = JSON.parse(await readFile(metadataPath, "utf8"));
			expect(incomplete.status).toBe("interrupted");
			expect(incomplete.gitHead).toBe(baseline.gitHead);
			const completedAfter = JSON.parse(await readFile(manifestPath, "utf8"));
			expect(completedAfter.pages[pages[0]]).toEqual(completedBefore.pages[pages[0]]);
			expect(completedAfter.pages[pages[1]].gitHead).not.toBe(baseline.gitHead);
			const recovered = await execute(AbortSignal.timeout(20_000), "update");
			expect(recovered.skipped).toBe(false);
			expect(recovered.partialFailure).toBeUndefined();
			expect(plans).toBe(3);
			const complete = JSON.parse(await readFile(metadataPath, "utf8"));
			expect(complete.status).toBe("complete");
			expect(complete.gitHead).not.toBe(baseline.gitHead);
		}
	} finally {
		betaReady.resolve();
		alphaCommitted.resolve();
		server.stop(true);
	}
}

describe("OpenWiki native pool through the OMP host boundary", () => {
	it(
		"does not retry a throttled page and lowers concurrency without losing other pages",
		async () => scenario("rate"),
		30_000,
	);
	it("stops claiming new pages after fatal committed-state rejection", async () => scenario("fatal"), 30_000);
	it(
		"denies every worker cross-page writes while committing its own page exactly once",
		async () => scenario("ownership"),
		30_000,
	);
	it(
		"rejects a failed finalization instead of treating committed-page narration as whole-run success",
		async () => scenario("finalization"),
		30_000,
	);
	it(
		"invalidates an interrupted durable plan when source changes before resuming",
		async () => scenario("resume-drift"),
		30_000,
	);
	it(
		"detects changed and emptied instructions and legacy nonempty or Git-visible root instruction changes",
		async () => scenario("instructions"),
		45_000,
	);
	it(
		"does not mutate an in-flight page or its verification when another page commits",
		async () => scenario("verification"),
		30_000,
	);
	it(
		"retains the previous success baseline after partial completion and retries failed coverage on clean source",
		async () => scenario("partial-baseline"),
		45_000,
	);
});
