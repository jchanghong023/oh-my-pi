import { expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { isRecord } from "@oh-my-pi/pi-utils";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import type { DevWorkflowResult, DevWorkflowView } from "../../src/dev-workbench/workflow-types";
import { DevWorkflowStore } from "../../src/dev-workbench/workflow-store";
import { initializeRepository, eventually, registeredFixtureProject } from "./fixture";
import { contentText } from "../spec-driven/provider-fixture";
import { tuiTest, withTui } from "../spec-driven/tui-harness";
import { WorkflowConsumerFixture, WORKFLOW_ENTRY, workflowNativeContext } from "./workflow-fixture";

async function readWorkbenchReadyLink(tui: (...args: string[]) => Promise<string>) {
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

interface BrowserRequest {
	<T>(route: string, body?: unknown): Promise<T>;
}

async function browserClient(base: string): Promise<BrowserRequest> {
	const clientId = crypto.randomUUID();
	const bootstrap = await fetch(new URL("api/browser", base), { headers: { "X-Dev-Client": clientId } });
	const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
	if (!cookie) throw new Error("Native workbench browser identity was not allocated");
	return async <T>(route: string, body?: unknown): Promise<T> => {
		const response = await fetch(new URL(route, base), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				cookie,
				origin: new URL(base).origin,
				"X-Dev-Client": clientId,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`${route}: ${response.status}: ${await response.text()}`);
		return response.json() as Promise<T>;
	};
}

async function createDraft(request: BrowserRequest, cwd: string, type: "createLocalDraft" | "createBrowserDraft") {
	const available = await request<DevWorkflowView>("workflow");
	const projectId = (await registeredFixtureProject(available.projects, cwd)).id;
	await request("workflow/bind", { projectId });
	let view = await request<DevWorkflowView>(`workflow?${new URLSearchParams({ projectId })}`);
	await request("workflow/command", {
		type: "createRelease",
		projectId,
		title: "Native terminal isolation",
		expectedRevision: view.revision,
		operationId: crypto.randomUUID(),
	});
	view = await request<DevWorkflowView>(`workflow?projectId=${projectId}`);
	const releaseId = view.releases.at(-1)?.id;
	if (!releaseId) throw new Error("Release not persisted");
	const created = await request<DevWorkflowResult>("workflow/command", {
		type,
		projectId,
		releaseId,
		expectedRevision: view.revision,
		operationId: crypto.randomUUID(),
	});
	if (!created.irId) throw new Error("Draft identity missing");
	const ref = { projectId, irId: created.irId };
	await request("workflow/bind", ref);
	return ref;
}

test("ordinary TUI preserves its model, image input, queue, draft and session across exclusive Dev entry and exit", async () => {
	if (!tuiTest) throw new Error("tui-test is required for /dev public acceptance");
	const first = "ORDINARY_IMAGE_AFTER_DEV";
	const second = "ORDINARY_QUEUE_AFTER_DEV";
	const release = Promise.withResolvers<void>();
	let held = false;
	let ordinaryAborted = false;
	try {
		await withTui(
			{
				startupResponse: "Ordinary response",
				async setup(cwd) {
					await initializeRepository(cwd);
					await fs.writeFile(path.join(cwd, "baseline.txt"), "ordinary baseline\n");
					await requireGit(cwd).stageFiles(["baseline.txt"]);
					await requireGit(cwd).commitCreate("Ordinary baseline", {});
				},
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
					return {
						text: text.includes(second)
							? "ORDINARY_QUEUE_DONE"
							: text.includes(first)
								? "ORDINARY_IMAGE_DONE"
								: "Ordinary response",
					};
				},
			},
			[120, 36],
			async ({ cwd, provider, tui }) => {
				const count = provider.requests.length;
				await tui("submit", "/dev");
				const { screen, url, mouseMode } = await readWorkbenchReadyLink(tui);
				const base = url.endsWith("/") ? url : `${url}/`;
				await tui("expect", "text", url, "--link", url);
				expect(mouseMode).toBe("none");
				await tui("resize", "64", "36");
				const narrow = await eventually(
					() => tui("text"),
					value => value.replace(/\s+/gu, "").includes(url),
					5_000,
				);
				expect(narrow.replace(/\s+/gu, "")).toContain(url);
				await tui("resize", "120", "36");
				const request = await browserClient(base);
				const available = await request<DevWorkflowView>("workflow");
				expect(available.currentProjectId).toBeUndefined();
				const projectId = (await registeredFixtureProject(available.projects, cwd)).id;
				await request("workflow/bind", { projectId });
				const before = await request<DevWorkflowView>(`workflow?${new URLSearchParams({ projectId })}`);
				expect(before.groups).toEqual([]);
				expect(before.drafts).toEqual([]);
				expect(before.sessions).toEqual([]);
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
				const after = await request<DevWorkflowView>(`workflow?${new URLSearchParams({ projectId })}`);
				expect(after.revision).toBe(before.revision);
				expect(after.sessions).toEqual([]);
				expect(provider.requests).toHaveLength(count);
				for (const file of [sentinel, path.join(destination, "blocked-shell.txt")])
					expect(
						await fs.stat(file).then(
							() => true,
							() => false,
						),
					).toBe(false);
				await tui("key", "press", "End", "Ctrl+U");
				await tui("submit", "/dev");
				await waitForWorkbenchClose(base);
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
				expect(
					provider.requests.every(request => !workflowNativeContext(request) && request.model === "chat-a"),
				).toBe(true);
				await tui("type", "unsent ordinary draft");
				await tui("resize", "100", "28");
				await tui("expect", "text", "unsent ordinary draft", "--timeout", "30000");
			},
		);
	} finally {
		release.resolve();
	}
}, 180_000);

test("standalone workflow actors never replace ordinary continue history", async () => {
	await using fixture = await WorkflowConsumerFixture.create({ reply: () => ({ text: "Native isolated response" }) });
	const runOrdinary = async (args: string[]) => {
		const child = Bun.spawn([process.execPath, WORKFLOW_ENTRY, "--profile", "acceptance", ...args], {
			cwd: fixture.project,
			env: fixture.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
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
		}
	};
	const seed = "ORDINARY_RECENT_BEFORE_STANDALONE_DEV";
	const continuation = "ORDINARY_CONTINUE_AFTER_STANDALONE_DEV";
	await runOrdinary(["--print", "--model", "deepseek/deepseek-v4-flash", "--", seed]);
	const child = await fixture.start();
	const request = await browserClient(child.url);
	const ref = await createDraft(request, fixture.project, "createBrowserDraft");
	const view = await child.view(ref.projectId);
	const beforeNative = fixture.provider.requests.length;
	await request("workflow/input", {
		...ref,
		operationId: crypto.randomUUID(),
		expectedRevision: view.revision,
		text: "DEV_ISOLATED_REQUIREMENTS_TURN",
	});
	await eventually(
		async () => ({ view: await child.view(ref.projectId), calls: fixture.provider.requests.length }),
		value => value.calls > beforeNative && value.view.running.length === 0,
	);
	const persisted = await child.view(ref.projectId);
	expect(persisted.sessions.some(session => session.irId === ref.irId)).toBe(true);
	await child.stop();
	const afterDev = fixture.provider.requests.length;
	await runOrdinary(["--continue", "--print", "--model", "deepseek/deepseek-v4-flash", "--", continuation]);
	const resumed = fixture.provider.requests
		.slice(afterDev)
		.find(request =>
			contentText(request.messages.findLast(message => message.role === "user")?.content).includes(continuation),
		);
	if (!resumed) throw new Error("Ordinary --continue did not reach its native model");
	expect(workflowNativeContext(resumed)).toBeUndefined();
	expect(
		resumed.messages.some(message => message.role === "user" && contentText(message.content).includes(seed)),
	).toBe(true);
	expect(
		resumed.messages.some(message => contentText(message.content).includes("DEV_ISOLATED_REQUIREMENTS_TURN")),
	).toBe(false);
	const restarted = await fixture.start();
	expect((await restarted.view(ref.projectId)).drafts.find(item => item.id === ref.irId)).toEqual(
		persisted.drafts.find(item => item.id === ref.irId),
	);
	expect(fixture.provider.failures).toEqual([]);
}, 300_000);

test("second TUI dev settles native work, preserves worktree and user bytes, and restores the original root", async () => {
	if (!tuiTest) throw new Error("tui-test is required for exclusive Dev exit acceptance");
	const release = Promise.withResolvers<void>();
	let held = false;
	let aborted = false;
	try {
		await withTui(
			{
				startupResponse: "Native held turn ended",
				async setup(cwd) {
					await initializeRepository(cwd);
					await fs.writeFile(path.join(cwd, "baseline.txt"), "preserved before Dev\n");
					await requireGit(cwd).stageFiles(["baseline.txt"]);
					await requireGit(cwd).commitCreate("Exclusive Dev fixture baseline", {});
				},
				async delay(request, signal) {
					if (held || !workflowNativeContext(request)) return;
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
				reply: request => ({
					text: contentText(request.messages.findLast(message => message.role === "user")?.content).includes(
						"ORDINARY_AFTER_SETTLED_DEV",
					)
						? "ORDINARY_ROOT_RESTORED_AFTER_DEV"
						: "Native held turn ended",
				}),
			},
			[120, 36],
			async ({ cwd, agentDir, provider, tui }) => {
				const baseline = await requireGit(cwd).headSha();
				await tui("submit", "/dev");
				const { url: printed } = await readWorkbenchReadyLink(tui);
				const base = printed.endsWith("/") ? printed : `${printed}/`;
				const request = await browserClient(base);
				const ref = await createDraft(request, cwd, "createLocalDraft");
				const before = await request<DevWorkflowView>(`workflow?projectId=${ref.projectId}`);
				const draft = before.drafts.find(item => item.id === ref.irId);
				if (!draft?.worktree) throw new Error("Local draft did not create its persistent requirement worktree");
				await request("workflow/input", {
					...ref,
					operationId: crypto.randomUUID(),
					expectedRevision: before.revision,
					text: "Keep this native requirement conversation running until explicit Dev exit",
				});
				await eventually(async () => held, Boolean);
				await tui("submit", "/dev");
				await waitForWorkbenchClose(base);
				expect(aborted).toBe(true);
				const store = new DevWorkflowStore(path.join(agentDir, "dev-projects-v1"));
				const persisted = await store.view(ref.projectId);
				expect(persisted.drafts.find(item => item.id === ref.irId)?.worktree).toEqual(draft.worktree);
				expect(persisted.drafts.find(item => item.id === ref.irId)?.confirmation).toBeUndefined();
				expect(await fs.readFile(path.join(cwd, "baseline.txt"), "utf8")).toBe("preserved before Dev\n");
				expect(await requireGit(cwd).headSha()).toBe(baseline);
				expect(await fs.stat(draft.worktree.path).then(stat => stat.isDirectory())).toBe(true);
				await tui("submit", "ORDINARY_AFTER_SETTLED_DEV");
				await tui("expect", "text", "ORDINARY_ROOT_RESTORED_AFTER_DEV", "--timeout", "30000");
				const restored = provider.requests.findLast(request =>
					contentText(request.messages.findLast(message => message.role === "user")?.content).includes(
						"ORDINARY_AFTER_SETTLED_DEV",
					),
				);
				if (!restored) throw new Error("The original ordinary session did not resume");
				expect(workflowNativeContext(restored)).toBeUndefined();
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
