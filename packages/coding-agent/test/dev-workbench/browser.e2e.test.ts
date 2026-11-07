import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HTTPResponse, Page } from "puppeteer-core";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import { isRecord } from "@oh-my-pi/pi-utils";
import { loadSessionFile } from "../../src/session/session-loader";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../../src/session/messages";
import type { DevActionPreview, DevActionResult, DevRequirementSnapshot, DevStage } from "../../src/spec-driven/types";
import {
	contentText,
	respond,
	rolePayload,
	IMPLEMENTATION,
	IMPLEMENTATION_PATH,
} from "../spec-driven/provider-fixture";
import { BUSINESS, closePublicWorkbenches, WorkbenchFixture, eventually, resolveInstalledDevChromium } from "./fixture";

const owned = new Set<WorkbenchFixture>();
afterEach(async () => {
	await closePublicWorkbenches();
	owned.clear();
});

async function reportBrowserFailure(
	fixture: WorkbenchFixture,
	page: Page,
	error: unknown,
	http: unknown[] = [],
): Promise<void> {
	const capture = (label: string, value: Promise<unknown>) =>
		value.then(
			result => ({ label, result }),
			failure => ({ label, error: String(failure) }),
		);
	const facts = await Promise.all([
		capture(
			"selected",
			page.$$eval('[data-requirement-id][aria-pressed="true"]', elements =>
				elements.map(element => element.getAttribute("data-requirement-id")),
			),
		),
		capture(
			"page-errors",
			page.$$eval('[role="alert"]', elements => elements.map(element => element.textContent)),
		),
		capture(
			"targets",
			fixture.list().then(items =>
				items.map(item => ({
					requirementId: item.record.requirementId,
					stage: item.record.stage,
					recordVersion: item.recordVersion,
					runtime: item.runtime,
				})),
			),
		),
		capture("pending-native-ui", fixture.request("native-ui")),
	]);
	console.error(
		"Browser workbench failure facts:",
		JSON.stringify({
			error: String(error),
			facts,
			http,
			forge: fixture.forgeRequests,
			native: fixture.nativeDiagnostics(),
		}),
	);
}

async function clickAction(
	fixture: WorkbenchFixture,
	page: Page,
	action: string,
	reply: string,
): Promise<DevActionResult> {
	const failures: Promise<{ url: string; status: number; body: string }>[] = [];
	const failed = Promise.withResolvers<Error>();
	const abort = new AbortController();
	const observe = (response: HTTPResponse): void => {
		const url = response.url();
		if (
			response.ok() ||
			response.request().method() !== "POST" ||
			(!url.endsWith("/api/action-preview") && !url.endsWith("/api/actions"))
		)
			return;
		const body = response.text().then(
			text => text.slice(0, 4_000),
			error => `Response body unavailable: ${String(error)}`,
		);
		const fact = body.then(body => ({ url: response.url(), status: response.status(), body }));
		failures.push(fact);
		void fact.then(value => failed.resolve(new Error(`Workbench HTTP ${value.status}: ${value.body}`)));
	};
	page.on("response", observe);
	try {
		const control =
			action === "cancel"
				? '.dw-requirement-row > [data-requirement-id][aria-pressed="true"] + .dw-request-delete[data-action="cancel"]'
				: `${CONVERSATION} ${action.startsWith("[") ? action : `[data-action="${action}"]`}`;
		await page.waitForSelector(`${control}:not([disabled])`, { signal: abort.signal });
		if (action === "cancel" && (await page.$eval(control, element => element.getBoundingClientRect().height === 0)))
			await page.click('[aria-label="打开需求列表"]');
		if (await page.$eval(control, element => Boolean(element.closest("#dw-secondary-operation-controls")))) {
			const toggle = `${CONVERSATION} [data-action="toggle-secondary-operations"]`;
			await page.waitForSelector(toggle, { visible: true, signal: abort.signal });
			if (!(await page.$eval(toggle, element => element.getAttribute("aria-expanded") === "true")))
				await page.click(toggle);
			await page.waitForSelector(
				`${toggle}[aria-expanded="true"] + #dw-secondary-operation-controls:not([hidden])`,
				{ visible: true, signal: abort.signal },
			);
		}
		if (action === "commit") {
			const disclosure = 'details:has([data-action="commit"])';
			await page.waitForSelector(disclosure, { signal: abort.signal });
			if (!(await page.$eval(disclosure, element => element.hasAttribute("open"))))
				await page.click(`${disclosure} > summary`);
		}
		const button = await page.waitForSelector(control, { signal: abort.signal });
		if (!button) throw new Error(`Actual workbench control missing: ${control}`);
		await page.waitForFunction(
			element => element.getAttribute("disabled") === null,
			{ signal: abort.signal },
			button,
		);
		await button.click();
		await Promise.race([
			page.waitForSelector('[data-testid="confirmation-reply"]', { signal: abort.signal }),
			failed.promise.then(error => {
				throw error;
			}),
		]);
		await page.type('[data-testid="confirmation-reply"]', reply);
		const actionResponse = page.waitForResponse(
			response => response.url().endsWith("/api/actions") && response.request().method() === "POST",
			{ signal: abort.signal },
		);
		await page.click('[data-testid="confirmation-submit"]');
		await Promise.race([
			page.waitForSelector('[data-testid="confirmation-submit"]', { hidden: true, signal: abort.signal }),
			failed.promise.then(error => {
				throw error;
			}),
		]);
		return (await (await actionResponse).json()) as DevActionResult;
	} catch (error) {
		await reportBrowserFailure(fixture, page, error, await Promise.all(failures));
		throw error;
	} finally {
		page.off("response", observe);
		abort.abort();
	}
}

async function openRequirement(page: Page, snapshot: DevRequirementSnapshot): Promise<void> {
	const selector = `[data-requirement-id="${snapshot.record.requirementId}"]`;
	await page.waitForSelector(selector);
	if (await page.$eval(selector, element => element.getBoundingClientRect().height === 0))
		await page.click('[aria-label="打开需求列表"]');
	await page.click(selector);
	await page.waitForSelector(`${selector}[aria-pressed="true"]`);
	await page.waitForSelector(
		`[data-testid="stages"] [data-stage="${snapshot.record.stage}"][aria-current="step"][aria-pressed="true"]`,
	);
	await page.waitForSelector('[data-testid="material-view"]');
}

const CONVERSATION = ".dw-conversation .dw-session:not([hidden])";
const COMPOSER = `${CONVERSATION} [data-testid="composer"] textarea`;
const SEND = `${CONVERSATION} [data-testid="composer"] button[title="send (Enter)"]`;

async function sendConversation(page: Page, text: string): Promise<void> {
	await page.waitForSelector(`${COMPOSER}:not([disabled])`);
	await page.type(COMPOSER, text);
	await page.click(SEND);
}

test("real Chromium imports Markdown without business dialogue, renders all stages and executes native handoffs", async () => {
	await resolveInstalledDevChromium();
	await using fixture = await WorkbenchFixture.create();
	owned.add(fixture);
	await fixture.start();
	const { page } = await fixture.browser();
	const errors: string[] = [];
	const external: string[] = [];
	page.on("pageerror", error => errors.push(String(error)));
	await page.setRequestInterception(true);
	await page.setCacheEnabled(false);
	page.on("request", request => {
		if (!["127.0.0.1", "localhost"].includes(new URL(request.url()).hostname)) {
			external.push(request.url());
			void request.abort();
		} else void request.continue();
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForSelector('[data-testid="workbench"]');
	if (await page.$eval('[aria-label="搜索需求"]', element => element.getBoundingClientRect().height === 0))
		await page.click('[aria-label="打开需求列表"]');
	await page.type('[aria-label="搜索需求"]', "no-existing-requirement-matches-this-search");
	await page.click('[aria-label="需求筛选"] button:last-child');
	await page.click('[data-action="new"]');
	await page.waitForFunction(
		`document.querySelector('[role="dialog"][aria-label="新建需求"]')?.contains(document.activeElement)`,
	);
	await page.keyboard.press("Tab");
	expect(
		await page.evaluate(
			`document.querySelector('[role="dialog"][aria-label="新建需求"]')?.contains(document.activeElement)`,
		),
	).toBe(true);
	await page.select('[data-testid="new-source"]', "import");
	await page.click('[data-testid="new-submit"]');
	await page.waitForSelector('[data-testid="new-submit"]', { hidden: true });
	const snapshot = await eventually(
		() => fixture.list(),
		values => values.length === 1,
	).then(values => values[0]!);
	const id = snapshot.record.requirementId;
	expect(await page.evaluate(`document.querySelector('[aria-label="搜索需求"]')?.value`)).toBe("");
	expect(
		await page.$eval('[aria-label="需求筛选"] button:first-child', element => element.getAttribute("aria-pressed")),
	).toBe("true");
	expect(await page.$(`[data-requirement-id="${id}"]`)).not.toBeNull();
	await page.waitForSelector('[data-testid="material-view"]');
	const upload = fixture.root.join("uploaded-business.md");
	await fs.writeFile(upload, BUSINESS);
	const input = await page.waitForSelector('input[data-action="import"]');
	if (!input) throw new Error("Markdown upload control missing");
	await input.uploadFile(upload);
	await eventually(
		() => fixture.get(id),
		value => value.record.materials.some(material => material.kind === "business"),
	);
	await page.waitForSelector('[role="dialog"][aria-label="导入业务文档"]', { hidden: true });
	await openRequirement(page, snapshot);
	expect(fixture.provider.requests).toEqual([]);
	expect((await fixture.get(id)).runtime?.recipient ?? null).toBeNull();
	const stages: DevStage[] = ["business", "requirements", "solution", "planning", "executing", "st", "pr", "testing"];
	expect(
		await page.$$eval('[data-testid="stages"] [data-stage]', elements =>
			elements.map(element => element.getAttribute("data-stage")),
		),
	).toEqual(stages);
	const beforeNavigation = await fixture.get(id);
	for (const stage of stages) await page.click(`[data-testid="stages"] [data-stage="${stage}"]`);
	expect((await fixture.get(id)).recordVersion).toBe(beforeNavigation.recordVersion);
	expect(fixture.provider.requests).toEqual([]);
	expect(
		await page.$('[data-testid="material-view"] textarea, [data-testid="material-view"] [contenteditable="true"]'),
	).toBeNull();
	await page.click('[data-stage="business"]');
	await fs.writeFile(path.join(fixture.cwd, "unrelated-staged.txt"), "Preserve this unrelated staged user change\n");
	await requireGit(fixture.cwd).stageFiles(["unrelated-staged.txt"]);
	for (const [index, stage] of ["business", "requirements", "solution", "planning", "executing"].entries()) {
		await page.click(`[data-testid="stages"] [data-stage="${stage}"]`);
		if (stage === "business" || stage === "executing") {
			const beforeCommit = await fixture.get(id);
			const beforeHead = await requireGit(fixture.cwd).headSha();
			if (!beforeHead) throw new Error("Scoped commit fixture is missing its initial real HEAD");
			const modelCalls = fixture.provider.requests.length;
			await clickAction(
				fixture,
				page,
				"commit",
				stage === "business"
					? "Commit and push only this displayed early business document and requirement record; do not approve or advance."
					: "Commit and push this displayed execution batch; do not accept the report or advance to ST.",
			);
			const committed = await fixture.get(id);
			expect(committed.record.stage).toBe(stage);
			const operation = committed.record.gitOperations.at(-1);
			if (!operation) throw new Error("Confirmed commit is missing its actual operation audit");
			expect(
				committed.record.decisions.find(decision => decision.operationId === operation.operationId),
			).toMatchObject({
				stage,
				files: [],
			});
			expect(committed.record.decisions.filter(decision => decision.operationId !== operation.operationId)).toEqual(
				beforeCommit.record.decisions,
			);
			expect(committed.record.report.development).toEqual(beforeCommit.record.report.development);
			expect(committed.record.marks).toEqual(beforeCommit.record.marks);
			expect(committed.record.gitOperations.at(-1)?.kind).toBe("commit");
			expect(fixture.provider.requests).toHaveLength(modelCalls);
			const head = await requireGit(fixture.cwd).headSha();
			if (!head) throw new Error("Confirmed scoped commit did not produce a real HEAD");
			expect(head).not.toBe(beforeHead);
			expect((await requireGit(fixture.cwd).remoteRef("origin", "refs/heads/development")).sha).toBe(head);
			expect(await requireGit(fixture.cwd).statusPorcelain({})).toContain("A  unrelated-staged.txt");
			await expect(requireGit(fixture.cwd).showBlob(`${head}:unrelated-staged.txt`)).rejects.toThrow();
			if (stage === "business") {
				const previousViewport = page.viewport();
				const more = `${CONVERSATION} [data-action="toggle-secondary-operations"]`;
				if ((await page.$eval(more, element => element.getAttribute("aria-expanded"))) !== "true")
					await page.click(more);
				await page.setViewport({ width: 320, height: 480 });
				await page.click('[aria-label="工作区面板"] button:last-child');
				const scrollTop = await page.$eval(CONVERSATION, element => {
					const session = element as Element & { scrollTop: number; scrollHeight: number };
					session.scrollTop = session.scrollHeight;
					return session.scrollTop;
				});
				expect(scrollTop).toBeGreaterThan(0);
				const composer = await page.$eval(COMPOSER, element => {
					const bounds = element.getBoundingClientRect();
					return { top: bounds.top, bottom: bounds.bottom };
				});
				expect(composer.top).toBeGreaterThan(56);
				expect(composer.bottom).toBeLessThanOrEqual(480);
				const composerWrapBottom = await page.$eval(
					`${CONVERSATION} .dw-composer-wrap`,
					element => element.getBoundingClientRect().bottom,
				);
				const sessionBottom = await page.$eval(CONVERSATION, element => element.getBoundingClientRect().bottom);
				expect(sessionBottom - composerWrapBottom).toBeLessThanOrEqual(2);
				await page.click('[aria-label="工作区面板"] button:first-child');
				await page.setViewport(previousViewport ?? { width: 1440, height: 900 });
			}
		}
		if (stage === "solution") {
			await page.waitForSelector('[data-candidate-id="pure"]');
			expect(await page.$eval('[data-candidate-id="pure"]', element => element.textContent)).toContain("纯函数");
			expect(await page.$eval('[data-candidate-id="normalizer"]', element => element.textContent)).toContain(
				"规范化",
			);
			await page.click('[data-candidate-id="pure"] button');
			await page.waitForFunction(
				`document.querySelector('[data-candidate-id="pure"] h3')?.textContent?.includes("已选") === true`,
			);
			await fixture.stage(id, "solution");
		}
		await clickAction(fixture, page, "next", `Approve exact ${stage} material bytes`);
		await fixture.stage(id, stages[index + 1]!);
	}
	const st = await fixture.get(id);
	expect(st.record.stage).toBe("st");
	const commitAudits = new Set(
		st.record.gitOperations.filter(operation => operation.kind === "commit").map(operation => operation.operationId),
	);
	expect(
		st.record.decisions.filter(decision => !commitAudits.has(decision.operationId)).map(decision => decision.stage),
	).toEqual(stages.slice(0, 5));
	expect(st.record.syncRevisions).toEqual([]);
	expect(st.record.marks).toEqual({});
	expect(await fs.readFile(path.join(fixture.cwd, IMPLEMENTATION_PATH), "utf8")).toBe(IMPLEMENTATION);
	expect(await fs.readFile(upload, "utf8")).toBe(BUSINESS);
	expect(fixture.provider.requests.map(rolePayload).filter(payload => payload?.specDrivenRole === "business")).toEqual(
		[],
	);
	expect(fixture.provider.failures).toEqual([]);
	if (await page.$eval('[data-action="new"]', element => element.getBoundingClientRect().height === 0))
		await page.click('[aria-label="打开需求列表"]');
	await page.click('[data-action="new"]');
	await page.select('[data-testid="new-source"]', "local");
	await page.type('[data-testid="new-request"]', "Draft a local business document without starting development.");
	const localPosts: string[] = [];
	page.on("request", request => {
		if (request.url().endsWith("/api/local-business") && request.method() === "POST") localPosts.push(request.url());
	});
	const localResponse = page.waitForResponse(
		response => response.url().endsWith("/api/local-business") && response.request().method() === "POST",
	);
	await page.click('[data-testid="new-submit"]');
	expect((await localResponse).ok()).toBe(true);
	await page.waitForSelector('[data-testid="new-submit"]', { hidden: true });
	await page.waitForSelector('[aria-label="本地业务文档操作"]', { visible: true });
	expect(localPosts).toHaveLength(1);
	expect(await page.$('[data-testid="stages"]')).toBeNull();
	expect(await page.$('[data-requirement-id][aria-pressed="true"]')).toBeNull();
	expect(await page.$eval(".dw-request-heading", element => element.textContent)).toContain("本地业务需求文档");
	expect((await fixture.list()).map(value => value.record.requirementId)).toEqual([id]);
	expect(external).toEqual([]);
	expect(errors).toEqual([]);
}, 180_000);

test("refresh and page close do not repeat confirmed actions or stop native execution", async () => {
	await resolveInstalledDevChromium();
	const release = Promise.withResolvers<void>();
	let entered = false;
	await using fixture = await WorkbenchFixture.create({
		delay: async (request, signal) => {
			if (entered || rolePayload(request)?.specDrivenRole !== "requirements") return;
			entered = true;
			await Promise.race([
				release.promise,
				new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })),
			]);
		},
	});
	owned.add(fixture);
	try {
		const process = await fixture.start();
		const snapshot = await fixture.imported();
		const { browser, page } = await fixture.browser();
		await openRequirement(page, snapshot);
		await clickAction(fixture, page, "next", "Approve imported business exactly once");
		await eventually(async () => entered, Boolean);
		await page.close();
		expect(process.child.exitCode).toBeNull();
		const waiting = await fixture.get(snapshot.record.requirementId);
		expect(waiting.record.decisions.filter(decision => decision.stage === "business")).toHaveLength(1);
		expect(waiting.runtime?.execution).toBe("running");
		release.resolve();
		await fixture.stage(snapshot.record.requirementId, "requirements");
		const count = fixture.provider.requests.length;
		const record = await fixture.get(snapshot.record.requirementId);
		const reopened = await browser.newPage();
		await reopened.goto(fixture.url, { waitUntil: "domcontentloaded" });
		await openRequirement(reopened, record);
		await reopened.reload({ waitUntil: "domcontentloaded" });
		await reopened.waitForSelector('[data-testid="workbench"]');
		expect((await fixture.get(snapshot.record.requirementId)).recordVersion).toBe(record.recordVersion);
		expect(fixture.provider.requests).toHaveLength(count);
		expect(await requireGit(fixture.cwd).currentBranch()).toBe("development");
	} finally {
		release.resolve();
	}
}, 180_000);

test("browser native ask, raw multi-answer images and denied tools use the actual session", async () => {
	await resolveInstalledDevChromium();
	const marker = "BROWSER_NATIVE_ASK_AND_DENIED_WRITE";
	await using fixture = await WorkbenchFixture.create({
		model: { provider: "deepseek", id: "deepseek-flash" },
		reply(request) {
			const index = request.messages.findLastIndex(
				message => message.role === "user" && contentText(message.content).includes(marker),
			);
			if (index < 0) return respond(request);
			const calls = request.messages
				.slice(index)
				.flatMap(message => message.tool_calls ?? [])
				.filter(isRecord)
				.map(call => (isRecord(call.function) ? String(call.function.name).replace(/^_/u, "") : ""));
			const tool = (name: string, args: Record<string, unknown>) => {
				const advertised = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === name)?.function
					?.name;
				if (!advertised) throw new Error(`Native browser fixture requires actual ${name}`);
				return { tool: { name: advertised, args } };
			};
			if (!calls.includes("ask"))
				return tool("ask", {
					questions: [
						{
							id: "whitespace",
							question: "Which whitespace rules are confirmed?",
							multi: true,
							options: [{ label: "trim outer" }, { label: "preserve inner" }],
						},
					],
				});
			if (!calls.includes("write"))
				return tool("write", {
					i: "Probing stage permission",
					path: "baseline.txt",
					content: "unauthorized write\n",
				});
			if (!calls.includes("read")) return tool("read", { i: "Checking denied file bytes", path: "baseline.txt" });
			return { text: "Native ask and denied tool result settled." };
		},
	});
	owned.add(fixture);
	await fixture.start();
	const snapshot = await fixture.developUntil("requirements");
	const { page } = await fixture.browser();
	await openRequirement(page, snapshot);
	await page.waitForSelector(`${COMPOSER}:not([disabled])`);
	const image = fixture.root.join("native-answer.png");
	await fs.writeFile(
		image,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
			"base64",
		),
	);
	const attach = await page.$(`${CONVERSATION} [data-testid="composer"] input[type="file"]`);
	if (!attach) throw new Error("Native composer attachment input missing");
	await attach.uploadFile(image);
	await sendConversation(page, marker);
	await page.waitForSelector('[data-native-request] input[type="checkbox"]').catch(async error => {
		await reportBrowserFailure(fixture, page, error);
		throw error;
	});
	for (const checkbox of await page.$$('[data-native-request] input[type="checkbox"]')) await checkbox.click();
	await page.type("[data-native-request] textarea", "Raw human answer 中文; not stage approval");
	const answerAttachment = await page.$('[data-native-request] fieldset input[type="file"]');
	if (!answerAttachment) throw new Error("Native raw-answer attachment input missing");
	await answerAttachment.uploadFile(image);
	await page.waitForSelector("[data-native-request] fieldset span button");
	await page.click("[data-native-request] > button:first-of-type");
	await page.waitForSelector("[data-native-request]", { hidden: true });
	await fixture.stage(snapshot.record.requirementId, "requirements");
	const native = fixture.provider.requests.findLast(request =>
		request.messages.some(
			message => message.role === "tool" && contentText(message.content).includes("Raw human answer"),
		),
	);
	if (!native) throw new Error("Actual native ask results never reached the model");
	const results = native.messages
		.filter(message => message.role === "tool")
		.map(message => contentText(message.content))
		.join("\n");
	expect(results).toContain("trim outer");
	expect(results).toContain("preserve inner");
	expect(results).toContain("Raw human answer 中文; not stage approval");
	expect(JSON.stringify(native.messages)).toMatch(/image_url|image\/png/u);
	expect(await fs.readFile(path.join(fixture.cwd, "baseline.txt"), "utf8")).toBe("Original user bytes\n");
	expect((await fixture.get(snapshot.record.requirementId)).record.decisions).toEqual(snapshot.record.decisions);
	expect(fixture.provider.failures).toEqual([]);
}, 180_000);

test("human ST marking commits once, reports a real push failure and resumes only that push", async () => {
	await resolveInstalledDevChromium();
	await using fixture = await WorkbenchFixture.create();
	owned.add(fixture);
	await fixture.start();
	const snapshot = await fixture.developUntil("st");
	const id = snapshot.record.requirementId;
	const repo = requireGit(fixture.cwd);
	await fs.writeFile(path.join(fixture.cwd, "unrelated-staged.txt"), "Preserve this unrelated staged user change\n");
	await repo.stageFiles(["unrelated-staged.txt"]);
	const { page } = await fixture.browser();
	await openRequirement(page, snapshot);
	const mark = `${CONVERSATION} [data-mark="st-complete"]:not([disabled])`;
	// Selecting a requirement reconnects its session; a rendered control can still be disabled.
	await page.waitForSelector(mark, { visible: true });
	const previousViewport = page.viewport();
	await page.setViewport({ width: 320, height: 480 });
	await page.click('[aria-label="工作区面板"] button:last-child');
	const previewResponse = page.waitForResponse(
		response => response.url().endsWith("/api/action-preview") && response.request().method() === "POST",
	);
	await page.click(mark);
	const preview = (await (await previewResponse).json()) as DevActionPreview;
	await page.waitForSelector('[data-testid="confirmation-reply"]');
	const dialog = '[role="dialog"][aria-label="确认需求操作"]';
	await page.waitForFunction(`document.querySelector(${JSON.stringify(dialog)}) === document.activeElement`);
	const initialScope = await page.$eval(dialog, element => {
		const bounds = element.getBoundingClientRect();
		const scroller = element as Element & { scrollTop: number; scrollHeight: number; clientHeight: number };
		const heading = element.querySelector("h2");
		const firstPath = element.querySelector("ul > li");
		if (!heading || !firstPath) throw new Error("Git confirmation heading or exact file scope missing");
		const headingBounds = heading.getBoundingClientRect();
		const pathBounds = firstPath.getBoundingClientRect();
		return {
			scrollTop: scroller.scrollTop,
			scrollHeight: scroller.scrollHeight,
			clientHeight: scroller.clientHeight,
			top: bounds.top,
			bottom: bounds.bottom,
			heading: heading.textContent,
			headingTop: headingBounds.top,
			headingBottom: headingBounds.bottom,
			firstPathTop: pathBounds.top,
			firstPathBottom: pathBounds.bottom,
			paths: Array.from(element.querySelectorAll("ul > li"), item => item.textContent),
		};
	});
	expect(preview.git).toBeDefined();
	expect(initialScope.scrollHeight).toBeGreaterThan(initialScope.clientHeight);
	expect(initialScope.scrollTop).toBe(0);
	expect(initialScope.top).toBeGreaterThanOrEqual(0);
	expect(initialScope.bottom).toBeLessThanOrEqual(480);
	expect(initialScope.headingTop).toBeGreaterThanOrEqual(initialScope.top);
	expect(initialScope.headingBottom).toBeLessThanOrEqual(initialScope.bottom);
	expect(initialScope.firstPathTop).toBeGreaterThanOrEqual(initialScope.headingBottom);
	expect(initialScope.firstPathBottom).toBeLessThanOrEqual(initialScope.bottom);
	expect(initialScope.paths).toEqual([
		...new Set([
			...(preview.git?.paths ?? preview.git?.files.map(file => file.path) ?? []),
			...preview.action.binding.files.map(file => file.path),
		]),
	]);
	await page.keyboard.press("Tab");
	expect(
		await page.evaluate(`document.querySelector('[data-testid="confirmation-reply"]') === document.activeElement`),
	).toBe(true);
	expect(await page.$eval(dialog, element => (element as Element & { scrollTop: number }).scrollTop)).toBeGreaterThan(
		0,
	);
	await page.keyboard.down("Shift");
	await page.keyboard.press("Tab");
	await page.keyboard.up("Shift");
	expect(
		await page.evaluate(`document.querySelector('[data-testid="confirmation-submit"]') === document.activeElement`),
	).toBe(true);
	await page.keyboard.press("Tab");
	expect(
		await page.evaluate(`document.querySelector('[data-testid="confirmation-reply"]') === document.activeElement`),
	).toBe(true);
	expect(await page.$eval('[role="dialog"]', element => element.textContent)).toContain("refs/heads/development");
	expect(await page.$eval('[role="dialog"]', element => element.textContent)).toContain("refs/heads/main");
	const lock = fixture.root.join("remote.git/refs/heads/development.lock");
	await fs.writeFile(lock, "Owned deterministic rejection of receive-pack\n");
	try {
		await page.type(
			'[data-testid="confirmation-reply"]',
			"Mark ST complete; failed or unrun ST facts remain disclosed. Commit and push only this displayed requirement scope.",
		);
		await page.waitForSelector('[data-testid="confirmation-submit"]:not([disabled])', { visible: true });
		const actionResponse = page.waitForResponse(
			response => response.url().endsWith("/api/actions") && response.request().method() === "POST",
		);
		await page.click('[data-testid="confirmation-submit"]');
		const submitted = await actionResponse;
		expect(submitted.ok()).toBe(true);
		const failed = (await submitted.json()) as DevActionResult;
		// The HTTP result precedes the client's refresh and React's release of the busy controls.
		await page.waitForSelector('[data-testid="confirmation-submit"]', { hidden: true });
		await page.setViewport(previousViewport ?? { width: 1440, height: 900 });
		const resume = `${CONVERSATION} [data-action="resume"]:not([disabled])`;
		await page.waitForSelector(resume, { visible: true });
		expect(await page.$eval(`${CONVERSATION} [data-result="push"]`, element => element.textContent)).toBe("失败");
		expect(failed.snapshot.record.marks["st-complete"]?.operationId).toBe(preview.action.binding.operationId);
		expect(failed.snapshot.record.stage).toBe("pr");
		expect(failed.persistence.commit.status).toBe("succeeded");
		expect(failed.persistence.push.status).toBe("failed");
		const commit = failed.persistence.commit.sha;
		expect(commit).toMatch(/^[a-f0-9]{40,64}$/u);
		expect(await repo.headSha()).toBe(commit);
		expect(await repo.statusPorcelain({})).toContain("A  unrelated-staged.txt");
		await expect(repo.showBlob(`${commit}:unrelated-staged.txt`)).rejects.toThrow();
		expect(
			failed.snapshot.record.gitOperations.filter(
				operation => operation.operationId === preview.action.binding.operationId,
			),
		).toHaveLength(1);
		await fs.rm(lock);
		const resumeResponse = page.waitForResponse(
			response => response.url().endsWith("/api/actions") && response.request().method() === "POST",
		);
		await page.click(resume);
		const retried = await resumeResponse;
		expect(retried.ok()).toBe(true);
		expect(retried.request().postData()).toBe(submitted.request().postData());
		const resumed = (await retried.json()) as DevActionResult;
		await page.waitForSelector(`${CONVERSATION} [data-action="resume"]`, { hidden: true });
		expect(resumed.persistence.push.status).toBe("succeeded");
		expect(resumed.persistence.commit.sha).toBe(commit);
		expect(await repo.headSha()).toBe(commit);
		expect(await repo.statusPorcelain({})).toContain("A  unrelated-staged.txt");
		expect(resumed.snapshot.record.marks["st-complete"]?.operationId).toBe(preview.action.binding.operationId);
		expect(resumed.snapshot.record.gitOperations).toEqual(failed.snapshot.record.gitOperations);
		expect(resumed.snapshot.record.decisions).toEqual(failed.snapshot.record.decisions);
		expect((await repo.remoteRef("origin", "refs/heads/development")).sha).toBe(commit);
		expect(resumed.snapshot.record.syncRevisions).toEqual([]);
	} catch (error) {
		await reportBrowserFailure(fixture, page, error);
		throw error;
	} finally {
		await fs.rm(lock, { force: true });
	}
}, 180_000);

test("browser cancellation displays unknown later file ownership as a conflict and does not release development", async () => {
	await resolveInstalledDevChromium();
	await using fixture = await WorkbenchFixture.create();
	owned.add(fixture);
	await fixture.start();
	const snapshot = await fixture.developUntil("executing");
	await fs.writeFile(path.join(fixture.cwd, IMPLEMENTATION_PATH), "later unrelated edit; must not be overwritten\n");
	const { page } = await fixture.browser();
	await openRequirement(page, snapshot);
	await page.click('[data-action="cancel"]');
	await page.waitForSelector('[data-testid="cancellation-scope"]');
	expect(await page.$eval('[data-testid="cancellation-scope"]', element => element.textContent)).toContain(
		IMPLEMENTATION_PATH,
	);
	expect(
		await page.$eval('[data-testid="cancellation-scope"] [role="alert"]', element => element.textContent),
	).toMatch(/冲突|conflict|changed|ownership/iu);
	expect(
		await page.$eval('[data-testid="confirmation-submit"]', element => element.getAttribute("disabled") !== null),
	).toBe(true);
	expect(await fs.readFile(path.join(fixture.cwd, IMPLEMENTATION_PATH), "utf8")).toBe(
		"later unrelated edit; must not be overwritten\n",
	);
	const newRequirement = await fixture.response("requirements", { source: "import" });
	expect(newRequirement.ok).toBe(false);
	expect((await fixture.get(snapshot.record.requirementId)).record.lifecycle).not.toBe("cancelled");
}, 180_000);

test("two plain-HTTP Chromium peers explicitly join one native Relay session without browser crypto", async () => {
	await resolveInstalledDevChromium();
	const marker = "COLLAB_NATIVE_READ_PROBE";
	await using fixture = await WorkbenchFixture.create({
		reply(request) {
			const index = request.messages.findLastIndex(
				message => message.role === "user" && contentText(message.content).includes(marker),
			);
			if (index < 0) return respond(request);
			const read = request.messages.slice(index).some(message => message.role === "tool");
			if (read) return { text: "COLLAB_SHARED_TOOL_DONE" };
			const advertised = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "read")?.function
				?.name;
			if (!advertised) throw new Error("Shared native session did not advertise read");
			return { tool: { name: advertised, args: { i: "Reading shared native bytes", path: "baseline.txt" } } };
		},
	});
	owned.add(fixture);
	await fixture.start();
	const snapshot = await fixture.developUntil("requirements");
	const { browser, page } = await fixture.browser();
	await openRequirement(page, snapshot);
	let link = "";
	const network = await page.createCDPSession();
	await network.send("Network.enable");
	network.on("Network.webSocketFrameReceived", event => {
		try {
			const value: unknown = JSON.parse(event.response.payloadData);
			if (isRecord(value) && value.t === "native-status" && typeof value.message === "string") link = value.message;
		} catch {
			/* Binary native frames are not status notices. */
		}
	});
	await sendConversation(page, "/collab");
	await eventually(
		async () => link,
		value => value.length > 0,
	);
	const peers: Page[] = [];
	for (const name of ["browser-one", "browser-two"]) {
		const context = await browser.createBrowserContext();
		const peer = await context.newPage();
		await peer.setViewport({ width: 1440, height: 900 });
		await peer.evaluateOnNewDocument(() => {
			Object.defineProperty(globalThis.crypto, "subtle", { value: undefined });
			Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined });
		});
		await peer.goto(fixture.url, { waitUntil: "domcontentloaded" });
		await peer.waitForSelector('[data-action="join-session"]:not([disabled])', { visible: true });
		await peer.click('[data-action="join-session"]');
		await peer.waitForSelector('input[aria-label="用户名或邀请链接"]:not([disabled])', { visible: true });
		await peer.type('input[aria-label="用户名或邀请链接"]', link);
		await peer.type('input[aria-label="加入时显示的姓名"]', name);
		await peer.waitForSelector('[data-action="collab-join"]:not([disabled])', { visible: true });
		await peer.click('[data-action="collab-join"]');
		await peer.waitForSelector('[data-action="collab-join"]', { hidden: true });
		await peer.waitForSelector(`${COMPOSER}:not([disabled])`);
		peers.push(peer);
	}
	const before = fixture.provider.requests.length;
	await sendConversation(peers[0]!, marker);
	for (const peer of peers)
		await peer.waitForFunction(`document.body.textContent?.includes("COLLAB_SHARED_TOOL_DONE") === true`);
	const completed = fixture.provider.requests.findLast(request =>
		request.messages.some(
			message => message.role === "tool" && contentText(message.content).includes("Original user bytes"),
		),
	);
	if (!completed) throw new Error("Shared browser input did not execute a real host read");
	expect(fixture.provider.requests.length).toBeGreaterThan(before);
	expect(
		fixture.provider.requests.filter(
			request =>
				request.messages.filter(message => message.role === "user" && contentText(message.content) === marker)
					.length > 1,
		),
	).toEqual([]);
	const joinedParticipants = await peers[1]!.$$eval(`${CONVERSATION} .dw-participants`, elements =>
		elements.map(element => element.textContent),
	);
	expect(joinedParticipants.join("\n")).toContain("browser-one");
	expect(joinedParticipants.join("\n")).toContain("browser-two");
	await fixture.stage(snapshot.record.requirementId, "requirements");
	await fixture.act(await fixture.get(snapshot.record.requirementId), { kind: "next" });
	const next = await fixture.stage(snapshot.record.requirementId, "solution");
	expect(next.runtime?.recipient?.sessionId).not.toBe(snapshot.runtime?.recipient?.sessionId);
	expect(
		await peers[1]!.$$eval(`${CONVERSATION} .dw-participants`, elements =>
			elements.map(element => element.textContent),
		),
	).toEqual(joinedParticipants);
	await network.detach();
	expect(fixture.provider.failures).toEqual([]);
}, 180_000);

test("eight-stage PR merge, independent failed testing, related fix, retest and final read-only record are real browser actions", async () => {
	await resolveInstalledDevChromium();
	const probe = "POSTMERGE_BROWSER_WRITE_PROBE";
	await using fixture = await WorkbenchFixture.create({
		reply(request) {
			const index = request.messages.findLastIndex(
				message => message.role === "user" && contentText(message.content).includes(probe),
			);
			if (index < 0) return respond(request);
			if (request.messages.slice(index).some(message => message.role === "tool"))
				return { text: "POSTMERGE_NATIVE_PROBE_SETTLED" };
			const write = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "write")?.function?.name;
			if (!write)
				return {
					text: "POSTMERGE_NATIVE_PROBE_SETTLED: write tool is unavailable in this read-only test session.",
				};
			return {
				tool: {
					name: write,
					args: {
						i: "Probing postmerge write boundary",
						path: "baseline.txt",
						content: "must not mutate while another requirement develops\n",
					},
				},
			};
		},
	});
	owned.add(fixture);
	await fixture.installLocalForge();
	await fixture.start();
	const original = await fixture.developUntil("st");
	const id = original.record.requirementId;
	const { page } = await fixture.browser();
	await openRequirement(page, original);
	await page.click('[data-testid="stages"] [data-stage="requirements"]');
	const materialTabs = '[data-testid="material-view"] [aria-label="阶段材料"] button';
	await page.waitForFunction(`document.querySelectorAll(${JSON.stringify(materialTabs)}).length > 1`);
	const firstMaterialTab = `${materialTabs}:nth-child(1)`;
	const secondMaterialTab = `${materialTabs}:nth-child(2)`;
	const readableMaterial = '[data-testid="material-view"] .dw-material';
	await page.waitForFunction(`(() => {
		const article = document.querySelector(${JSON.stringify(readableMaterial)});
		return Boolean(article?.textContent?.trim()) && !article?.querySelector('[role="status"], [role="alert"]');
	})()`);
	const firstMaterialText = await page.$eval(readableMaterial, element => element.textContent);
	await page.click(secondMaterialTab);
	await page.waitForFunction(`(() => {
		const article = document.querySelector(${JSON.stringify(readableMaterial)});
		return Boolean(article?.textContent?.trim()) &&
			article?.textContent !== ${JSON.stringify(firstMaterialText)} &&
			!article?.querySelector('[role="status"], [role="alert"]');
	})()`);
	const selectedMaterialText = await page.$eval(readableMaterial, element => element.textContent);
	const selectedMaterialPath = await page.$eval('[data-testid="material-view"] .dw-document-footer [title]', element =>
		element.getAttribute("title"),
	);
	const refreshResponse = page.waitForResponse(
		response => response.url().endsWith("/api/requirements") && response.request().method() === "GET",
	);
	await page.click('[aria-label="刷新需求"]');
	expect((await refreshResponse).ok()).toBe(true);
	await page.waitForNetworkIdle();
	expect(await page.$eval(secondMaterialTab, element => element.getAttribute("aria-pressed"))).toBe("true");
	expect(await page.$eval(firstMaterialTab, element => element.getAttribute("aria-pressed"))).toBe("false");
	expect(await page.$eval(readableMaterial, element => element.textContent)).toBe(selectedMaterialText);
	expect(
		await page.$eval('[data-testid="material-view"] .dw-document-footer [title]', element =>
			element.getAttribute("title"),
		),
	).toBe(selectedMaterialPath);
	await page.click(`[data-testid="stages"] [data-stage="${original.record.stage}"]`);
	const publishAndMerge = async (snapshot: DevRequirementSnapshot): Promise<DevRequirementSnapshot> => {
		await openRequirement(page, snapshot);
		await clickAction(
			fixture,
			page,
			'[data-mark="st-complete"]',
			"Human ST completion; preserve actual failures and limitations. Commit and push only this requirement.",
		);
		await fixture.stage(snapshot.record.requirementId, "pr");
		await clickAction(
			fixture,
			page,
			"sync",
			"Explicitly synchronize the accepted actual materials and archive this change.",
		);
		const archived = await fixture.get(snapshot.record.requirementId);
		expect(archived.record.syncRevisions.at(-1)?.archivedChangePath).toBeTruthy();
		expect(archived.record.lifecycle).toBe("active");
		const submission = await clickAction(
			fixture,
			page,
			'[data-mark="pr-submitted"]',
			"Submit the actual PR and persist this human mark with the exact displayed commit and push.",
		);
		const submitted = submission.snapshot;
		try {
			expect(submission.persistence.error).toBeUndefined();
			expect(submission.persistence.save).toBe("succeeded");
			expect(submission.persistence.commit.status).toBe("succeeded");
			expect(submission.persistence.push.status).toBe("succeeded");
			expect(submitted.record.stage).toBe("pr");
			expect(submitted.record.pr?.state).toBe("open");
		} catch (error) {
			await reportBrowserFailure(fixture, page, error, [{ action: "pr-submitted", result: submission }]);
			throw error;
		}
		expect((await fixture.response("requirements", { source: "import" })).ok).toBe(false);
		await fixture.mergeLocalPr();
		expect((await fixture.get(snapshot.record.requirementId)).record.stage).toBe("pr");
		await clickAction(
			fixture,
			page,
			'[data-mark="pr-merged"]',
			"I verified this exact PR really merged. Record the human merge mark and commit/push only this scope.",
		);
		return fixture.stage(snapshot.record.requirementId, "testing");
	};
	const testing = await publishAndMerge(original);
	expect(testing.record.testing).toBe("not-started");
	await page.click('[data-stage="testing"]');
	await clickAction(
		fixture,
		page,
		'[data-test-state="failed"]',
		"Actual tester failure; this is not ST and is not software acceptance. Commit and push only this test record.",
	);
	expect((await fixture.get(id)).record.testing).toBe("failed");
	const fix = await fixture.request<DevRequirementSnapshot>("requirements", {
		source: "import",
		relatedRequirementIds: [id],
	});
	expect(fix.record.relatedRequirementIds).toEqual([id]);
	expect((await fixture.get(id)).record.testing).toBe("failed");
	expect((await fixture.upload(fix.record.requirementId)).ok).toBe(true);
	await sendConversation(page, probe);
	await page.waitForFunction(`document.body.textContent?.includes("POSTMERGE_NATIVE_PROBE_SETTLED") === true`);
	expect(await fs.readFile(path.join(fixture.cwd, "baseline.txt"), "utf8")).toBe("Original user bytes\n");
	const fixBeforeExecution = await fixture.get(fix.record.requirementId);
	expect(fixBeforeExecution.record.stage).toBe("business");
	expect(fixBeforeExecution.record.decisions).toEqual([]);
	expect((await fixture.get(id)).record.testing).toBe("failed");
	const fixSt = await fixture.developUntil("st", await fixture.get(fix.record.requirementId));
	await publishAndMerge(fixSt);
	expect((await fixture.get(id)).record.testing).toBe("failed");
	await openRequirement(page, await fixture.get(id));
	await clickAction(
		fixture,
		page,
		'[data-test-state="retest-pending"]',
		"The linked fix is merged; retain the original failure until a human retest. Commit and push only this record.",
	);
	expect((await fixture.get(id)).record.testing).toBe("retest-pending");
	await clickAction(
		fixture,
		page,
		'[data-mark="tested"]',
		"I have actually retested the linked fix and mark this original requirement tested. Include the final read-only state in this exact commit and push.",
	);
	const completed = await fixture.get(id);
	expect(completed.record.lifecycle).toBe("completed");
	expect(completed.record.testing).toBe("tested");
	const head = await requireGit(fixture.cwd).headSha();
	if (!head) throw new Error("Final tested commit missing");
	const committed = await requireGit(fixture.cwd).showBlob(`${head}:docs/dev-requirements/${id}.json`);
	expect(committed.truncated).toBe(false);
	expect(JSON.parse(committed.data.toString("utf8")).lifecycle).toBe("completed");
	expect((await requireGit(fixture.cwd).remoteRef("origin", "refs/heads/development")).sha).toBe(head);
	expect(await page.$eval(COMPOSER, element => element.hasAttribute("disabled"))).toBe(true);
	const count = fixture.provider.requests.length;
	await page.reload({ waitUntil: "domcontentloaded" });
	await openRequirement(page, completed);
	expect((await fixture.get(id)).recordVersion).toBe(completed.recordVersion);
	expect(fixture.provider.requests).toHaveLength(count);
	const denied = await fixture.response("action-preview", {
		requirementId: id,
		expectedRecordVersion: completed.recordVersion,
		expectedStage: "testing",
		intent: { kind: "set-test-state", state: "failed" },
		gitTarget: null,
	});
	expect(denied.ok).toBe(false);
	const adjustment = await fixture.request<DevRequirementSnapshot>("requirements", {
		source: "import",
		relatedRequirementIds: [id],
	});
	expect(adjustment.record.relatedRequirementIds).toEqual([id]);
	expect((await fixture.get(id)).recordVersion).toBe(completed.recordVersion);
	expect(fixture.provider.requests).toHaveLength(count);
	expect(fixture.forgeRequests.some(args => args.includes("POST"))).toBe(true);
	expect(fixture.provider.failures).toEqual([]);
}, 300_000);

test("browser deletion compensates committed development, archived materials and main-spec sync while retaining user bytes", async () => {
	await resolveInstalledDevChromium();
	await using fixture = await WorkbenchFixture.create();
	owned.add(fixture);
	await fixture.start();
	await fs.writeFile(path.join(fixture.cwd, "unrelated-user.txt"), "Unrelated user work remains\n");
	const snapshot = await fixture.developUntil("st");
	const id = snapshot.record.requirementId;
	const { page } = await fixture.browser();
	await openRequirement(page, snapshot);
	await clickAction(
		fixture,
		page,
		'[data-mark="st-complete"]',
		"ST is human-complete with actual recorded validation. Commit and push this exact requirement scope.",
	);
	await fixture.stage(id, "pr");
	const developedHead = await requireGit(fixture.cwd).headSha();
	await clickAction(
		fixture,
		page,
		"sync",
		"Explicitly sync and archive this requirement, without marking a PR submitted.",
	);
	const synced = await fixture.get(id);
	const archive = synced.record.syncRevisions.at(-1)?.archivedChangePath;
	if (!archive) throw new Error("Actual native archive location was not persisted");
	expect((await fs.stat(path.join(fixture.cwd, archive))).isDirectory()).toBe(true);
	await clickAction(
		fixture,
		page,
		"cancel",
		"Delete this unmerged requirement and reverse only every displayed owned committed, staged, unstaged, archive and main-spec change. Preserve unrelated user bytes and history.",
	);
	const cancelled = await fixture.get(id);
	expect(cancelled.record.lifecycle).toBe("cancelled");
	expect(cancelled.record.materials).toEqual([]);
	for (const file of [IMPLEMENTATION_PATH, archive, "openspec/specs/greeting/spec.md"])
		expect(
			await fs.stat(path.join(fixture.cwd, file)).then(
				() => true,
				() => false,
			),
		).toBe(false);
	expect(await fs.readFile(path.join(fixture.cwd, "baseline.txt"), "utf8")).toBe("Original user bytes\n");
	expect(await fs.readFile(path.join(fixture.cwd, "unrelated-user.txt"), "utf8")).toBe(
		"Unrelated user work remains\n",
	);
	if (!developedHead) throw new Error("Original development commit disappeared");
	expect(await requireGit(fixture.cwd).refExists(developedHead)).toBe(true);
	const next = await fixture.create();
	expect(next.record.stage).toBe("business");
}, 300_000);

test("native always-ask approval displays real scope and a human denial never becomes write authority", async () => {
	await resolveInstalledDevChromium();
	await using fixture = await WorkbenchFixture.create();
	owned.add(fixture);
	await fixture.start(undefined, ["--approval-mode", "always-ask"]);
	const business = await fixture.imported();
	await fixture.act(business, { kind: "next" });
	const id = business.record.requirementId;
	const requirements = await fixture.get(id);
	const { page } = await fixture.browser();
	await openRequirement(page, requirements);
	const requests = `${CONVERSATION} [data-native-request]`;
	await page.waitForSelector(requests);
	const firstRequest = await page.$eval(requests, element => element.getAttribute("data-native-request"));
	if (!firstRequest) throw new Error("Actual native approval request identity missing");
	expect(await page.$eval(requests, element => element.textContent)).toContain("proposal.md");
	const proposal = path.join(fixture.cwd, `openspec/changes/${id}/proposal.md`);
	expect(
		await fs.stat(proposal).then(
			() => true,
			() => false,
		),
	).toBe(false);
	const nativeButton = async (requestId: string, label: string) => {
		const request = `${CONVERSATION} [data-native-request="${requestId}"]`;
		await page.waitForSelector(request, { visible: true });
		for (const button of await page.$$(`${request} button`)) {
			if ((await button.evaluate(element => element.textContent?.trim())) !== label) continue;
			await page.waitForFunction(element => element.getAttribute("disabled") === null, {}, button);
			if (!(await button.isVisible())) throw new Error(`Actual native ${label} button is not visible`);
			return button;
		}
		throw new Error(`Actual native ${label} button missing from request ${requestId}`);
	};
	const denialButton = await nativeButton(firstRequest, "拒绝");
	await denialButton.focus();
	const denialControl = await denialButton.evaluate(element => {
		const control = element as unknown as {
			tagName: string;
			textContent: string | null;
			outerHTML: string;
			ownerDocument: { activeElement: { tagName: string; textContent: string | null; outerHTML: string } | null };
		};
		const focused = control.ownerDocument.activeElement;
		return {
			tag: control.tagName,
			text: control.textContent,
			outerHTML: control.outerHTML,
			focused: focused === control,
			activeElement: focused && { tag: focused.tagName, text: focused.textContent, outerHTML: focused.outerHTML },
		};
	});
	try {
		expect(denialControl.tag).toBe("BUTTON");
		expect(denialControl.text?.trim()).toBe("拒绝");
		expect(denialControl.focused).toBe(true);
	} catch (error) {
		await reportBrowserFailure(fixture, page, error, [{ requestId: firstRequest, control: denialControl }]);
		throw error;
	}
	const denialResponse = page.waitForResponse(
		response => response.url().endsWith("/api/native-ui-response") && response.request().method() === "POST",
	);
	await denialButton.click();
	const denied = await denialResponse;
	const denialFact = {
		status: denied.status(),
		body: await denied.text(),
		input: denied.request().postData(),
		control: denialControl,
	};
	try {
		expect(JSON.parse(denialFact.input ?? "null")).toMatchObject({ requestId: firstRequest, value: "deny" });
		expect(denied.ok()).toBe(true);
	} catch (error) {
		await reportBrowserFailure(fixture, page, error, [denialFact]);
		throw error;
	}
	await page
		.waitForFunction(
			`document.querySelector(${JSON.stringify(requests)})?.getAttribute("data-native-request") !== ${JSON.stringify(firstRequest)}`,
		)
		.catch(async error => {
			await reportBrowserFailure(fixture, page, error, [denialFact]);
			throw error;
		});
	await page.waitForSelector(requests);
	const secondRequest = await page.$eval(requests, element => element.getAttribute("data-native-request"));
	if (!secondRequest) throw new Error("Actual native once-only approval request identity missing");
	expect(await page.$eval(requests, element => element.textContent)).toContain("spec.md");
	const approvalButton = await nativeButton(secondRequest, "仅本次批准");
	await approvalButton.click();
	await page.waitForSelector(requests, { hidden: true });
	const settled = await fixture.stage(id, "requirements");
	try {
		expect(
			await fs.stat(proposal).then(
				() => true,
				() => false,
			),
		).toBe(false);
	} catch (error) {
		await reportBrowserFailure(fixture, page, error, [denialFact]);
		throw error;
	}
	const delta = path.join(fixture.cwd, "openspec/changes", settled.record.changeId, "specs/greeting/spec.md");
	expect(await fs.readFile(delta, "utf8")).toContain("Requirement: Greeting");
	const count = fixture.provider.requests.length;
	const next = await fixture.response("action-preview", {
		requirementId: id,
		expectedRecordVersion: settled.recordVersion,
		expectedStage: "requirements",
		intent: { kind: "next" },
		gitTarget: null,
	});
	expect(next.ok).toBe(false);
	expect((await fixture.get(id)).record.stage).toBe("requirements");
	expect(fixture.provider.requests).toHaveLength(count);
	expect(settled.record.decisions.map(decision => decision.stage)).toEqual(["business"]);
}, 180_000);

test("right composer executes a native builtin and expands an existing skill without approving the stage", async () => {
	await resolveInstalledDevChromium();
	const skillMarker = "BROWSER_NATIVE_SKILL_SLASH_PROBE";
	await using fixture = await WorkbenchFixture.create({
		reply(request) {
			const latest = contentText(request.messages.findLast(message => message.role === "user")?.content);
			return latest.includes(skillMarker) ? { text: "BROWSER_NATIVE_SKILL_SLASH_DONE" } : respond(request);
		},
	});
	owned.add(fixture);
	await fixture.start();
	const requirement = await fixture.developUntil("requirements");
	const { page } = await fixture.browser();
	await openRequirement(page, requirement);
	const count = fixture.provider.requests.length;
	await sendConversation(page, "/queue list");
	await page.waitForSelector(`${CONVERSATION} [data-native-status="command"]`, { visible: true });
	await page.waitForFunction(`document.querySelector(${JSON.stringify(COMPOSER)})?.value === ""`);
	expect(fixture.provider.requests).toHaveLength(count);
	const beforeSkill = await fixture.get(requirement.record.requirementId);
	await sendConversation(page, `/skill:jch-grill-me ${skillMarker}`);
	await page.waitForFunction(
		`document.querySelector(".dw-conversation")?.textContent?.includes("BROWSER_NATIVE_SKILL_SLASH_DONE") === true`,
	);
	const skillRequest = fixture.provider.requests
		.slice(count)
		.find(request =>
			request.messages.some(
				message => message.role === "user" && contentText(message.content).includes(skillMarker),
			),
		);
	if (!skillRequest) throw new Error("Actual composer skill invocation never reached its native model");
	const expanded = contentText(
		skillRequest.messages.findLast(
			message => message.role === "user" && contentText(message.content).includes(skillMarker),
		)?.content,
	);
	expect(expanded).not.toContain("/skill:jch-grill-me");
	const afterSkill = await fixture.stage(requirement.record.requirementId, "requirements");
	const sessionFile = afterSkill.runtime?.recipient?.sessionFile;
	if (!sessionFile) throw new Error("Actual native skill session history missing");
	const history = await loadSessionFile(sessionFile, undefined, { throwIfMissing: true });
	const activation = history.entries.findLast(
		entry =>
			entry.type === "custom_message" &&
			entry.customType === SKILL_PROMPT_MESSAGE_TYPE &&
			isRecord(entry.details) &&
			entry.details.prompt === `/skill:jch-grill-me ${skillMarker}`,
	);
	if (
		!activation ||
		activation.type !== "custom_message" ||
		!isRecord(activation.details) ||
		typeof activation.details.path !== "string"
	)
		throw new Error("Native history did not persist the actual user-invoked skill activation");
	expect(activation.attribution).toBe("user");
	expect(activation.details).toMatchObject({
		name: "jch-grill-me",
		args: skillMarker,
		prompt: `/skill:jch-grill-me ${skillMarker}`,
	});
	const skillSource = await fs.readFile(activation.details.path, "utf8");
	const skillBody = skillSource.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").trim();
	expect(skillBody.length).toBeGreaterThan(0);
	expect(expanded).toContain(skillBody);
	expect(afterSkill.record.decisions).toEqual(beforeSkill.record.decisions);
	expect(afterSkill.record.stage).toBe("requirements");
	expect(fixture.provider.failures).toEqual([]);
}, 180_000);
