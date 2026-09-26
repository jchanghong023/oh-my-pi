// Runs the public /repo interface and real agent tools through the dev TUI in a
// native PTY. Only the Anthropic model is simulated; SQLite, Python parsing,
// tools, source mutations, and terminal interaction are real.
import * as fs from "node:fs/promises";
import { rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { PtySession } from "@oh-my-pi/pi-natives";
import { RepoService } from "../packages/coding-agent/src/repo/service";

interface Tui {
	session: PtySession;
	output: string;
	exitPromise: Promise<{ exitCode?: number }>;
}
interface Harness {
	startTui(argv: string[], env: Record<string, string>, projectCwd?: string): Tui;
	waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean>;
	normalizePtyOutput(text: string): string;
	sleep(ms: number): Promise<void>;
}

interface ToolCall {
	id: string;
	name: "repo" | "write";
	input: Record<string, unknown>;
}

interface ToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	is_error?: boolean;
	content?: unknown;
}

function toolResults(messages: unknown[]): Map<string, ToolResultBlock> {
	const results = new Map<string, ToolResultBlock>();
	for (const message of messages) {
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") continue;
		const content = "content" in message ? message.content : undefined;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
			if (typeof block.tool_use_id !== "string") continue;
			results.set(block.tool_use_id, block as ToolResultBlock);
		}
	}
	return results;
}

function resultText(block: ToolResultBlock): string {
	if (typeof block.content === "string") return block.content;
	if (!Array.isArray(block.content)) return "";
	return block.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part && typeof part === "object" && part.type === "text" && typeof part.text === "string",
		)
		.map(part => part.text)
		.join("\n");
}

function sse(model: string, call?: ToolCall, text = "REPO_SMOKE_DONE"): string {
	const id = call ? `msg_${call.id}` : `msg_${crypto.randomUUID()}`;
	const frames = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id,
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					usage: { input_tokens: 16, output_tokens: 8 },
				},
			},
		],
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 0,
				content_block: call
					? { type: "tool_use", id: call.id, name: call.name, input: {} }
					: { type: "text", text: "" },
			},
		],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 0,
				delta: call
					? { type: "input_json_delta", partial_json: JSON.stringify(call.input) }
					: { type: "text_delta", text },
			},
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: call ? "tool_use" : "end_turn" },
				usage: { output_tokens: 32 },
			},
		],
		["message_stop", { type: "message_stop" }],
	] as const;
	return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

export async function runRepoSmoke({ startTui, waitFor, normalizePtyOutput, sleep }: Harness): Promise<void> {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-ui-smoke-"));
	const project = path.join(temp, "project");
	const configName = `.omp-repo-ui-smoke-${process.pid}`;
	const configRoot = path.join(os.homedir(), configName);
	const agentDir = path.join(configRoot, "profiles", "localci-ui-repo", "agent");
	const source = path.join(project, "src", "engine.py");
	let tui: Tui | undefined;
	let server: { port: number; stop(closeActiveConnections?: boolean): void } | undefined;
	const issued = new Map<string, ToolCall[]>();
	const results = new Map<string, Map<string, string>>();
	const closings = new Set<string>();
	const marker = "REPO_SYMBOL_MARKER";
	const original = `def target_definition():\n    return '${marker}'\n`;
	const edited = `def target_definition():\n    return 'REPO_EDITED_MARKER'\n`;
	const actions: Record<string, { name: ToolCall["name"]; input: Record<string, unknown> }[]> = {
		SEARCH: [{ name: "repo", input: { action: "search", query: marker } }],
		SYMBOL: [{ name: "repo", input: { action: "symbol", query: "target_definition" } }],
		EDIT: [
			{ name: "write", input: { path: source, content: edited } },
			{ name: "repo", input: { action: "search", query: "REPO_EDITED_MARKER" } },
		],
		AUTO: [{ name: "repo", input: { action: "search", query: "REPO_EDITED_MARKER" } }],
		EXTERNAL: [{ name: "repo", input: { action: "search", query: "REPO_EXTERNAL_MARKER" } }],
		STALE_SYMBOL: [{ name: "repo", input: { action: "symbol", query: "target_definition" } }],
		MISSING: [{ name: "repo", input: { action: "status" } }],
	};
	let serverError: string | undefined;
	try {
		await fs.mkdir(path.dirname(source), { recursive: true });
		await fs.writeFile(source, original);
		await $`git init -q`.cwd(project).quiet();
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			[
				"tools:",
				"  approval:",
				"    write: allow",
				"marketplace:",
				'  autoUpdate: "off"',
				"startup:",
				"  setupWizard: false",
				"  checkUpdate: false",
				"",
			].join("\n"),
		);
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method !== "POST" || !new URL(request.url).pathname.includes("/v1/messages")) {
					return new Response("not found", { status: 404 });
				}
				const body = (await request.json()) as { model?: string; messages?: unknown[] };
				const messages = body.messages ?? [];
				const step = [...messages]
					.reverse()
					.filter(
						message => message && typeof message === "object" && "role" in message && message.role === "user",
					)
					.flatMap(message => {
						const content = "content" in message ? message.content : undefined;
						if (typeof content === "string") return [content];
						if (!Array.isArray(content)) return [];
						return content
							.filter(block => block && typeof block === "object" && block.type === "text")
							.map(block => block.text)
							.filter((text): text is string => typeof text === "string");
					})
					.map(text => /REPO_SMOKE_(SEARCH|SYMBOL|EDIT|AUTO|EXTERNAL|STALE_SYMBOL|MISSING)/.exec(text))
					.find(Boolean)?.[1];
				let call: ToolCall | undefined;
				if (step) {
					const calls = issued.get(step) ?? [];
					const matched = results.get(step) ?? new Map<string, string>();
					const available = toolResults(messages);
					for (const issuedCall of calls) {
						const block = available.get(issuedCall.id);
						if (!block) continue;
						if (block.is_error !== false) {
							serverError = `${step}: ${issuedCall.name} ${issuedCall.id} returned is_error=${String(block.is_error)}`;
							break;
						}
						matched.set(issuedCall.id, resultText(block));
						if (
							step === "EDIT" &&
							issuedCall.name === "write" &&
							(await fs.readFile(source, "utf8")) !== edited
						) {
							serverError = "EDIT: write tool returned but source was not changed";
							break;
						}
					}
					results.set(step, matched);
					if (serverError) return new Response(serverError, { status: 500 });
					// Provider retries/prefill can replay the same user turn before
					// execution. Replay its outstanding call; only matching results
					// advance the scripted scenario.
					const outstanding = calls.find(value => !matched.has(value.id));
					if (outstanding)
						return new Response(sse(body.model ?? "glm-5.2", outstanding), {
							headers: { "content-type": "text/event-stream" },
						});
					const next = actions[step]?.[calls.length];
					if (next) {
						call = { ...next, id: `repo_smoke_${step.toLowerCase()}_${calls.length + 1}` };
						calls.push(call);
						issued.set(step, calls);
					} else {
						closings.add(step);
					}
				}
				return new Response(sse(body.model ?? "glm-5.2", call), {
					status: 200,
					headers: { "content-type": "text/event-stream", "request-id": `repo_${crypto.randomUUID()}` },
				});
			},
		});
		tui = startTui(
			["--profile", "localci-ui-repo", "--model", "zcode-api/glm-5.2"],
			{
				ZCODE_API_BASE_URL: `http://127.0.0.1:${server.port}`,
				PI_CONFIG_DIR: configName,
			},
			project,
		);
		const current = tui;
		async function visible(label: string, condition: (text: string) => boolean, timeout = 20_000, offset = 0) {
			if (!(await waitFor(() => condition(normalizePtyOutput(current.output.slice(offset))), timeout))) {
				throw new Error(
					`${label}: expected rendered state not observed; PTY tail: ${normalizePtyOutput(current.output).slice(-3200)}`,
				);
			}
		}
		async function panel() {
			const offset = current.output.length;
			current.session.write("/repo\r");
			await visible(
				"/repo panel",
				text => text.includes("Repository index") && text.includes(`Root: ${project}`),
				20_000,
				offset,
			);
		}
		async function closePanel() {
			const offset = current.output.length;
			current.session.write("\x1b[27u");
			// Diff rendering may leave the unchanged status line untouched. Await
			// the close repaint; the following real tool turn proves editor focus.
			if (!(await waitFor(() => current.output.length > offset, 20_000)))
				throw new Error("Closing /repo did not repaint the terminal");
		}
		async function prompt(step: string, required: RegExp[][]) {
			const offset = current.output.length;
			current.session.write(`REPO_SMOKE_${step}\r`);
			if (
				!(await waitFor(
					() => !!serverError || ((results.get(step)?.size ?? 0) === actions[step].length && closings.has(step)),
					20_000,
				))
			) {
				throw new Error(
					`${step}: real tool result never returned; PTY tail: ${normalizePtyOutput(current.output).slice(-2800)}`,
				);
			}
			if (serverError) throw new Error(serverError);
			const calls = issued.get(step) ?? [];
			if (required.length !== actions[step].length)
				throw new Error(`${step}: assertions do not cover every issued tool call`);
			for (const [index, patterns] of required.entries()) {
				const call = calls[index];
				if (!call) throw new Error(`${step}: expected tool call #${index + 1} was never issued`);
				const text = results.get(step)?.get(call.id) ?? "";
				for (const expected of patterns)
					if (!expected.test(text))
						throw new Error(`${step}: ${call.name} result ${call.id} missing ${expected}: ${text.slice(-1800)}`);
			}
			await visible(`${step} agent response`, text => text.includes("REPO_SMOKE_DONE"), 20_000, offset);
			await sleep(200);
		}
		await visible("initial render", text => text.includes("π"), 120_000);
		await panel();
		await visible("missing index", text => text.includes("No repository index. Press b to build."));
		current.session.write("b");
		await visible("build confirmation", text => text.includes("Build repository index for"));
		const buildOffset = current.output.length;
		current.session.write("y");
		await visible("built index", text => text.includes("Files: 1") && text.includes("Symbols:"), 45_000, buildOffset);
		await closePanel();
		await prompt("SEARCH", [[/\[\d+\] src\/engine\.py:2-2 \[[^\]]+\] [^\n]*REPO_SYMBOL_MARKER/]]);
		await prompt("SYMBOL", [[/\[\d+\] src\/engine\.py:1-\d+ \[[^\]]+\] function target_definition/]]);
		await prompt("EDIT", [
			[
				new RegExp(
					`Successfully wrote ${Buffer.byteLength(edited, "utf8")} bytes to (?:.*/)?src/engine\\.py(?:\\n|$)`,
				),
			],
			[/\[\d+\] src\/engine\.py:2-2 \[[^\]]+\] [^\n]*REPO_EDITED_MARKER/],
		]);
		await prompt("AUTO", [[/\[\d+\] src\/engine\.py:2-2 \[[^\]]+\] [^\n]*REPO_EDITED_MARKER/]]);
		const generationBefore = new RepoService({ cwd: project, agentDir });
		let stable: string | null;
		try {
			stable = (await generationBefore.status()).generation;
		} finally {
			generationBefore.close();
		}
		await fs.mkdir(path.join(project, "bulk"));
		await Promise.all(
			Array.from({ length: 320 }, (_, index) =>
				fs.writeFile(
					path.join(project, "bulk", `${String(index).padStart(3, "0")}.py`),
					`def pending_${index}(): return 'bulk'\n`,
				),
			),
		);
		await panel();
		current.session.write("r");
		await visible("rebuild confirmation", text => text.includes("Rebuild repository index for"));
		const cancelProgressOffset = current.output.length;
		current.session.write("y");
		await visible("rebuild progress", text => text.includes("Progress:"), 45_000, cancelProgressOffset);
		const cancelledOffset = current.output.length;
		current.session.write("c");
		await visible(
			"cancelled rebuild returned to status",
			text => text.includes("Files: 1") && text.includes("Generation:"),
			45_000,
			cancelledOffset,
		);
		await sleep(1_000);
		const generationAfter = new RepoService({ cwd: project, agentDir });
		try {
			if ((await generationAfter.status()).generation !== stable)
				throw new Error("cancelled rebuild replaced the usable generation");
		} finally {
			generationAfter.close();
		}
		await fs.rm(path.join(project, "bulk"), { recursive: true });
		await fs.writeFile(source, "def external_definition():\n    return 'REPO_EXTERNAL_MARKER'\n");
		await fs.writeFile(path.join(project, "new.py"), "def external_added(): return 'REPO_EXTERNAL_MARKER'\n");
		await fs.writeFile(path.join(project, "removed.py"), "def obsolete(): return 'REMOVEDONLYBEACON'\n");
		const addedOffset = current.output.length;
		current.session.write("u");
		await visible("reconciled index", text => text.includes("Files: 3"), 45_000, addedOffset);
		await fs.rm(path.join(project, "removed.py"));
		const deletedSourceOffset = current.output.length;
		current.session.write("u");
		await visible("external delete reconciled", text => text.includes("Files: 2"), 45_000, deletedSourceOffset);
		const reconciled = new RepoService({ cwd: project, agentDir });
		try {
			if ((await reconciled.search("REMOVEDONLYBEACON")).hits.some(hit => hit.path === "removed.py"))
				throw new Error("full reconcile retained a deleted source");
			if (!(await reconciled.symbol("external_added")).hits.some(hit => hit.path === "new.py"))
				throw new Error("full reconcile did not index the externally added definition");
			if ((await reconciled.symbol("target_definition")).hits.some(hit => hit.path === "src/engine.py"))
				throw new Error("full reconcile retained the replaced symbol");
		} finally {
			reconciled.close();
		}
		await closePanel();
		await prompt("EXTERNAL", [
			[
				/\[\d+\] src\/engine\.py:2-2 \[[^\]]+\] [^\n]*REPO_EXTERNAL_MARKER/,
				/\[\d+\] new\.py:1-1 \[[^\]]+\] [^\n]*REPO_EXTERNAL_MARKER/,
			],
		]);
		await prompt("STALE_SYMBOL", [
			[/Python symbols for "target_definition": 0 hit\(s\) on this page/, /No indexed matches\./],
		]);
		await panel();
		current.session.write("d");
		await visible("delete confirmation", text => text.includes("Delete repository index for"));
		const deleteOffset = current.output.length;
		current.session.write("y");
		await visible(
			"deleted index",
			text => text.includes("No repository index. Press b to build."),
			45_000,
			deleteOffset,
		);
		if (!(await fs.readFile(source, "utf8")).includes("REPO_EXTERNAL_MARKER"))
			throw new Error("delete changed source");
		await closePanel();
		await prompt("MISSING", [[/Index: missing \(open \/repo to build it\); 0 files; 0 symbols/]]);
		current.session.write("\x04");
		const outcome = await Promise.race([current.exitPromise, sleep(20_000).then(() => undefined)]);
		if (!outcome || outcome.exitCode !== 0)
			throw new Error(`repo TUI did not exit cleanly: ${JSON.stringify(outcome)}`);
		console.log(
			"ui-smoke: /repo PASS — real panel build/status/reconcile/cancel/delete, native-backed tool results, and source edit",
		);
	} finally {
		if (tui) {
			try {
				tui.session.kill();
			} catch {}
		}
		server?.stop(true);
		rmSync(configRoot, { recursive: true, force: true });
		await fs.rm(temp, { recursive: true, force: true });
	}
}
