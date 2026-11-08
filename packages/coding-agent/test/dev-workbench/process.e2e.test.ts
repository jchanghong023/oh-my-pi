import { afterEach, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { isRecord } from "@oh-my-pi/pi-utils";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import {
	BUSINESS,
	closePublicWorkbenches,
	initializeRepository,
	SOURCE_ENTRY,
	WorkbenchFixture,
	eventually,
} from "./fixture";
import { contentText, respond, rolePayload } from "../spec-driven/provider-fixture";
import { tuiTest, withTui } from "../spec-driven/tui-harness";
import type { DevActionPreview, DevRequirementSnapshot } from "../../src/spec-driven/types";
import { readDevRequirement } from "../../src/spec-driven/records";
import { loadSessionFile } from "../../src/session/session-loader";

const owned = new Set<WorkbenchFixture>();
const ordinaryChildren = new Set<Subprocess<"ignore", "pipe", "pipe">>();
afterEach(async () => {
	for (const child of ordinaryChildren) if (child.exitCode === null) child.kill("SIGTERM");
	await Promise.all([...ordinaryChildren].map(child => child.exited));
	ordinaryChildren.clear();
	await closePublicWorkbenches();
	owned.clear();
});

async function readWorkbenchReadyLink(
	tui: (...args: string[]) => Promise<string>,
): Promise<{ screen: string; url: string; mouseMode: unknown }> {
	const screen = await eventually(
		() => tui("text", "--full"),
		value => /http:\/\/(?:127\.0\.0\.1|localhost):\d+\//u.test(value),
	);
	const terminalState: unknown = JSON.parse(await tui("state", "--json"));
	if (
		!isRecord(terminalState) ||
		!isRecord(terminalState.data) ||
		typeof terminalState.data.cols !== "number" ||
		typeof terminalState.data.rows !== "number"
	)
		throw new Error("Terminal state is unavailable");
	// Painted URLs wrap across rows; OSC 8 cell destinations retain the full capability path.
	const cells: unknown = JSON.parse(
		await tui("cells", "0", "0", String(terminalState.data.cols), String(terminalState.data.rows), "--json"),
	);
	if (!isRecord(cells) || !isRecord(cells.data) || !Array.isArray(cells.data.cells))
		throw new Error("Terminal hyperlink cells are unavailable");
	const linkedCell: unknown = cells.data.cells.find(
		(cell: unknown) =>
			isRecord(cell) &&
			typeof cell.link === "string" &&
			/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//u.test(cell.link),
	);
	if (!isRecord(linkedCell) || typeof linkedCell.link !== "string")
		throw new Error("/dev did not print a complete ready URL");
	return { screen, url: linkedCell.link, mouseMode: terminalState.data.mouse_mode };
}

async function waitForWorkbenchClose(base: string): Promise<void> {
	// 等待真实监听器关闭，不把状态提示的空格或措辞当作退出协议。
	await eventually(
		() =>
			fetch(new URL("api/browser", base)).then(
				() => false,
				() => true,
			),
		Boolean,
		30_000,
	);
}

test("source omp dev serves a durable empty workbench without model or Git side effects", async () => {
	await using fixture = await WorkbenchFixture.create();
	owned.add(fixture);
	const repo = requireGit(fixture.cwd);
	const initialHead = await repo.headSha();
	const process = await fixture.start();
	expect(new URL(fixture.url).hostname).toBe("127.0.0.1");
	expect(await fixture.list()).toEqual([]);
	expect(fixture.provider.requests).toEqual([]);
	expect(await repo.headSha()).toBe(initialHead);
	expect(await repo.statusPorcelain({})).toBe("");
	const response = await fetch(fixture.url);
	expect(response.headers.get("content-type")).toContain("text/html");
	expect(await response.text()).toContain("<html");
	const snapshot = await fixture.imported();
	expect(snapshot.record.stage).toBe("business");
	expect(snapshot.runtime?.recipient ?? null).toBeNull();
	expect(fixture.provider.requests).toEqual([]);
	const firstVersion = snapshot.recordVersion;
	await fetch(fixture.url);
	expect((await fixture.get(snapshot.record.requirementId)).recordVersion).toBe(firstVersion);
	expect(process.child.exitCode).toBeNull();
}, 180_000);

test("ordinary TUI remains unchanged before Dev and restores original model, image input and queue only after Dev exit", async () => {
	if (!tuiTest) throw new Error("tui-test is required for /dev public acceptance");
	const first = "ORDINARY_IMAGE_AFTER_DEV";
	const second = "ORDINARY_QUEUE_AFTER_DEV";
	const release = Promise.withResolvers<void>();
	let held = false;
	let ordinaryAborted = false;
	try {
		await withTui(
			{
				async delay(request, signal) {
					if (
						held ||
						!contentText(request.messages.findLast(message => message.role === "user")?.content).includes(first)
					)
						return;
					held = true;
					await Promise.race([
						release.promise,
						new Promise<void>(resolve =>
							signal.addEventListener(
								"abort",
								() => {
									ordinaryAborted = true;
									resolve();
								},
								{ once: true },
							),
						),
					]);
				},
				reply(request) {
					const text = contentText(request.messages.findLast(message => message.role === "user")?.content);
					return text.includes(second)
						? { text: "ORDINARY_QUEUE_DONE" }
						: text.includes(first)
							? { text: "ORDINARY_IMAGE_DONE" }
							: respond(request);
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state }) => {
				for (const relative of [".omp/dev-workbench", ".omp/dev", "docs/dev-requirements"])
					expect(
						await fs.stat(path.join(cwd, relative)).then(
							() => true,
							() => false,
						),
					).toBe(false);
				expect((await state()).requirements).toEqual([]);
				expect(provider.requests.every(request => !rolePayload(request))).toBe(true);
				const count = provider.requests.length;
				await tui("submit", "/dev");
				const { screen, url, mouseMode } = await readWorkbenchReadyLink(tui);
				const base = url.endsWith("/") ? url : `${url}/`;
				await tui("expect", "text", url, "--link", url);
				expect(mouseMode).toBe("none");
				await tui("resize", "64", "36");
				const narrow = await tui("text");
				expect(narrow.replace(/\s+/gu, "")).toContain(url);
				await tui("resize", "120", "36");
				const bootstrap = await fetch(new URL("api/browser", base));
				const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
				if (!cookie) throw new Error("Native workbench browser identity was not allocated");
				expect(
					await fetch(new URL("api/requirements", base), { headers: { cookie } }).then(response =>
						response.json(),
					),
				).toEqual([]);
				expect(screen).not.toContain("Dev ·");
				const destination = path.join(cwd, "blocked-destination");
				await fs.mkdir(destination);
				const sentinel = path.join(cwd, "blocked-shell.txt");
				for (const input of [
					"ORDINARY_BLOCKED_IN_DEV",
					"/new",
					"/move blocked-destination",
					"/model",
					"/queue ORDINARY_BLOCKED_QUEUE",
					"!echo blocked > blocked-shell.txt",
				]) {
					await tui("submit", input);
					await tui("expect", "text", input, "--timeout", "30000");
					await tui("expect", "text", "普通聊天、命令和快捷操作已暂停", "--timeout", "30000");
					await tui("key", "press", "End", "Ctrl+U");
				}
				for (const shortcut of ["Escape", "Ctrl+C", "Ctrl+Enter", "Alt+P"]) {
					await tui("key", "press", shortcut);
					if (shortcut === "Escape" || shortcut === "Ctrl+C")
						await tui("expect", "text", "请明确输入 /dev 退出", "--timeout", "30000");
				}
				expect(
					await fetch(new URL("api/requirements", base), { headers: { cookie } }).then(response =>
						response.json(),
					),
				).toEqual([]);
				expect(provider.requests).toHaveLength(count);
				expect(
					await fs.stat(sentinel).then(
						() => true,
						() => false,
					),
				).toBe(false);
				expect(
					await fs.stat(path.join(destination, "blocked-shell.txt")).then(
						() => true,
						() => false,
					),
				).toBe(false);
				await tui("key", "press", "End", "Ctrl+U");
				await tui("submit", "/dev");
				await waitForWorkbenchClose(base);
				expect(provider.requests).toHaveLength(count);
				const image = path.join(cwd, "ordinary-input.png");
				await fs.writeFile(
					image,
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
						"base64",
					),
				);
				await tui("type", `${first} `);
				await tui("write", `\x1b[200~${image}\x1b[201~`);
				await tui("key", "press", "Enter");
				await eventually(async () => held, Boolean);
				await tui("submit", "/dev");
				await eventually(
					() => tui("text", "--full"),
					value => /ordinary[\s\S]*settle|请先停止或等待/u.test(value),
				);
				expect(ordinaryAborted).toBe(false);
				await tui("key", "press", "End", "Ctrl+U");
				await tui("submit", `/queue ${second}`);
				expect(
					provider.requests.some(request =>
						contentText(request.messages.findLast(message => message.role === "user")?.content).includes(second),
					),
				).toBe(false);
				release.resolve();
				await tui("expect", "text", "ORDINARY_QUEUE_DONE", "--timeout", "30000");
				const firstRequest = provider.requests.find(request =>
					contentText(request.messages.findLast(message => message.role === "user")?.content).includes(first),
				);
				if (!firstRequest) throw new Error("Ordinary image prompt never reached its original native model");
				expect(JSON.stringify(firstRequest.messages.findLast(message => message.role === "user")?.content)).toMatch(
					/image_url|image\/png/u,
				);
				expect(
					firstRequest.messages.some(
						message => message.role === "user" && contentText(message.content).includes("ordinary-root-beacon"),
					),
				).toBe(true);
				expect(
					firstRequest.messages.some(message => contentText(message.content).includes("blocked-destination")),
				).toBe(false);
				expect(ordinaryAborted).toBe(false);
				expect(
					provider.requests.filter(request =>
						contentText(request.messages.findLast(message => message.role === "user")?.content).includes(second),
					),
				).toHaveLength(1);
				expect(provider.requests.every(request => !rolePayload(request) && request.model === "chat-a")).toBe(true);
				expect((await state()).requirements).toEqual([]);
				await tui("type", "unsent ordinary draft");
				await tui("resize", "100", "28");
				await tui("expect", "text", "unsent ordinary draft", "--timeout", "30000");
			},
		);
	} finally {
		release.resolve();
	}
}, 180_000);

test("manual native Goal is persisted and report acceptance stops autonomous work without signing human marks", async () => {
	const release = Promise.withResolvers<void>();
	const objective =
		"Complete the currently approved greeting implementation and completion report; do not approve any stage.";
	let held = false;
	await using fixture = await WorkbenchFixture.create({
		delay: async (request, signal) => {
			if (held || rolePayload(request)?.specDrivenRole !== "executor") return;
			held = true;
			await Promise.race([
				release.promise,
				new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })),
			]);
		},
		reply(request) {
			if (rolePayload(request)?.specDrivenRole !== "executor") return respond(request);
			// This deterministic model treats the explicit Goal objective as continued approved work.
			// Native requests/history stay intact; all returned tool calls still execute through real guards.
			return respond({
				...request,
				messages: request.messages.filter(
					message => message.role !== "user" || !contentText(message.content).includes(objective),
				),
			});
		},
	});
	owned.add(fixture);
	try {
		await fixture.start();
		const planning = await fixture.developUntil("planning");
		await fixture.act(planning, { kind: "next" });
		await eventually(async () => held, Boolean);
		const running = await fixture.get(planning.record.requirementId);
		const runtime = running.runtime;
		if (!runtime?.recipient?.sessionFile) throw new Error("Actual native executor session file missing");
		const target = {
			requirementId: running.record.requirementId,
			sessionId: runtime.recipient.sessionId,
			generation: runtime.generation,
		};
		const result = await fixture.request("native-command", {
			target,
			command: "goal",
			args: ["start", objective],
		});
		expect(result).toMatchObject({ kind: "accepted" });
		release.resolve();
		let complete: DevRequirementSnapshot;
		try {
			complete = await fixture.stage(running.record.requirementId, "executing");
		} catch (error) {
			let goalHistory: unknown;
			let latestRuntime: unknown;
			try {
				const latest = await fixture.get(running.record.requirementId);
				latestRuntime = latest.runtime;
				const file = latest.runtime?.recipient?.sessionFile;
				if (!file) throw new Error("No actual native history reference");
				const history = await loadSessionFile(file, undefined, { throwIfMissing: true });
				goalHistory = history.entries.filter(entry => entry.type === "mode_change").slice(-3);
			} catch (historyError) {
				goalHistory = { unavailable: String(historyError) };
			}
			console.error(
				"Native Goal fixture failure facts:",
				JSON.stringify({
					runtime: latestRuntime,
					persistedGoalState: goalHistory,
					native: fixture.nativeDiagnostics("executor"),
				}),
			);
			throw error;
		}
		const sessionFile = complete.runtime?.recipient?.sessionFile;
		if (!sessionFile) throw new Error("Settled native executor lost its durable history reference");
		const history = await loadSessionFile(sessionFile, undefined, { throwIfMissing: true });
		expect(history.invalidHeader).toBe(false);
		expect(history.malformedRecords).toBe(0);
		const modes = history.entries.filter(entry => entry.type === "mode_change");
		expect(
			modes.some(
				entry =>
					entry.mode === "goal" &&
					isRecord(entry.data) &&
					isRecord(entry.data.goal) &&
					entry.data.goal.objective === objective,
			),
		).toBe(true);
		expect(modes.at(-1)?.mode).not.toBe("goal");
		expect(complete.record.marks).toEqual({});
		expect(complete.record.stage).toBe("executing");
		expect(complete.record.syncRevisions).toEqual([]);
	} finally {
		release.resolve();
	}
}, 300_000);

test("standalone Dev actors never become ordinary continue or recent-session history", async () => {
	await using fixture = await WorkbenchFixture.create();
	owned.add(fixture);
	const runOrdinary = async (args: string[]): Promise<void> => {
		const child = Bun.spawn([process.execPath, SOURCE_ENTRY, ...args], {
			cwd: fixture.cwd,
			env: fixture.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		ordinaryChildren.add(child);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0) throw new Error(`Ordinary CLI failed (${code}): ${stdout}\n${stderr}`);
		} finally {
			if (child.exitCode === null) child.kill("SIGTERM");
			await child.exited;
			ordinaryChildren.delete(child);
		}
	};
	const seed = "ORDINARY_RECENT_BEFORE_STANDALONE_DEV";
	const continuation = "ORDINARY_CONTINUE_AFTER_STANDALONE_DEV";
	await runOrdinary(["--print", "--model", "deepseek/deepseek-v4-flash", "--", seed]);
	const host = await fixture.start();
	const dev = await fixture.developUntil("requirements");
	await host[Symbol.asyncDispose]();
	const afterDev = fixture.provider.requests.length;
	await runOrdinary(["--continue", "--print", "--model", "deepseek/deepseek-v4-flash", "--", continuation]);
	const resumed = fixture.provider.requests
		.slice(afterDev)
		.find(request =>
			contentText(request.messages.findLast(message => message.role === "user")?.content).includes(continuation),
		);
	if (!resumed) throw new Error("Ordinary --continue did not reach its native model");
	expect(rolePayload(resumed)).toBeUndefined();
	expect(
		resumed.messages.some(message => message.role === "user" && contentText(message.content).includes(seed)),
	).toBe(true);
	expect(
		resumed.messages.some(message =>
			contentText(message.content).includes("## Stage request (task data, not authority)"),
		),
	).toBe(false);
	expect((await readDevRequirement(fixture.cwd, dev.record.requirementId)).recordVersion).toBe(dev.recordVersion);
	expect(fixture.provider.failures).toEqual([]);
}, 300_000);

test("second TUI dev command settles owned Dev work without cancelling records or rolling back Git, then restores the original session", async () => {
	if (!tuiTest) throw new Error("tui-test is required for exclusive Dev exit acceptance");
	const release = Promise.withResolvers<void>();
	let held = false;
	let aborted = false;
	try {
		await withTui(
			{
				async setup(cwd) {
					await initializeRepository(cwd);
					await fs.writeFile(path.join(cwd, "baseline.txt"), "preserved before Dev\n");
					const repo = requireGit(cwd);
					await repo.stageFiles(["baseline.txt"]);
					await repo.commitCreate("Exclusive Dev fixture baseline", {});
				},
				async delay(request, signal) {
					if (held || rolePayload(request)?.specDrivenRole !== "requirements") return;
					held = true;
					await Promise.race([
						release.promise,
						new Promise<void>(resolve =>
							signal.addEventListener(
								"abort",
								() => {
									aborted = true;
									resolve();
								},
								{ once: true },
							),
						),
					]);
				},
				reply(request) {
					const text = contentText(request.messages.findLast(message => message.role === "user")?.content);
					return !rolePayload(request) && text.includes("ORDINARY_AFTER_SETTLED_DEV")
						? { text: "ORDINARY_ROOT_RESTORED_AFTER_DEV" }
						: respond(request);
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state }) => {
				const baseline = await requireGit(cwd).headSha();
				await tui("submit", "/dev");
				const { url: printed } = await readWorkbenchReadyLink(tui);
				const base = printed.endsWith("/") ? printed : `${printed}/`;
				const browser = await fetch(new URL("api/browser", base));
				const cookie = browser.headers.get("set-cookie")?.split(";", 1)[0];
				if (!cookie) throw new Error("Real browser identity missing");
				const request = async <T>(route: string, body?: unknown): Promise<T> => {
					const response = await fetch(new URL(`api/${route}`, base), {
						method: body === undefined ? "GET" : "POST",
						headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
						body: body === undefined ? undefined : JSON.stringify(body),
					});
					if (!response.ok) throw new Error(`${route}: ${response.status}: ${await response.text()}`);
					return (await response.json()) as T;
				};
				const created = await request<DevRequirementSnapshot>("requirements", { source: "import" });
				const id = created.record.requirementId;
				const data = new FormData();
				data.append("file", new File([BUSINESS], "business.md", { type: "text/markdown" }));
				expect(
					(await fetch(new URL(`api/business/${id}`, base), { method: "POST", headers: { cookie }, body: data }))
						.ok,
				).toBe(true);
				const imported = await request<DevRequirementSnapshot>(`requirements/${id}`);
				const preview = await request<DevActionPreview>("action-preview", {
					requirementId: id,
					expectedRecordVersion: imported.recordVersion,
					expectedStage: "business",
					intent: { kind: "next" },
					gitTarget: null,
				});
				await request("actions", {
					operationId: preview.action.binding.operationId,
					confirmationToken: preview.confirmationToken,
					userReply: "Approve only this document and start the Dev requirements actor",
				});
				await eventually(async () => held, Boolean);
				await tui("submit", "/dev");
				await waitForWorkbenchClose(base);
				expect(aborted).toBe(true);
				const persisted = (await state()).requirements.find(item => item.record.requirementId === id);
				if (!persisted) throw new Error("Exiting Dev removed the requirement record");
				expect(persisted.record.lifecycle).toBe("active");
				expect(persisted.record.stage).toBe("requirements");
				expect(persisted.record.decisions.map(decision => decision.stage)).toEqual(["business"]);
				expect(await fs.readFile(path.join(cwd, `docs/business-requirements/${id}.md`), "utf8")).toBe(BUSINESS);
				expect(await fs.readFile(path.join(cwd, "baseline.txt"), "utf8")).toBe("preserved before Dev\n");
				expect(await requireGit(cwd).headSha()).toBe(baseline);
				await tui("submit", "ORDINARY_AFTER_SETTLED_DEV");
				await tui("expect", "text", "ORDINARY_ROOT_RESTORED_AFTER_DEV", "--timeout", "30000");
				const restored = provider.requests.findLast(request =>
					contentText(request.messages.findLast(message => message.role === "user")?.content).includes(
						"ORDINARY_AFTER_SETTLED_DEV",
					),
				);
				if (!restored) throw new Error("The original ordinary session did not resume");
				expect(rolePayload(restored)).toBeUndefined();
				expect(
					restored.messages.some(
						message => message.role === "user" && contentText(message.content).includes("ordinary-root-beacon"),
					),
				).toBe(true);
			},
		);
	} finally {
		release.resolve();
	}
}, 300_000);
