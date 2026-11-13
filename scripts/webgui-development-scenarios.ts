import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { WEBGUI_PROJECTS_PATH } from "../vendor/zcode-frontend/preview/session-info";
import { encodeCustomModelValue } from "../vendor/zcode-frontend/packages/shared/src/custom-model-value";
import type { DevelopmentBrowser, DevelopmentPage } from "./webgui-platform-smoke";
import { PlatformPrerequisiteError, readEditableText } from "./webgui-platform-smoke";

/** Real browser acceptance, deliberately not imported by default test gates. */
export const DEVELOPMENT_MATRIX = [
	"standalone-projects",
	"native-development-history",
	"independent-cancel",
	"native-questions",
	"attachments",
	"file-context",
	"follow-up-queue",
	"guide-immediate",
	"branch-edit",
	"failed-retry",
	"parallel-isolation",
	"owned-settlement",
] as const;
export type DevelopmentScenarioId = (typeof DEVELOPMENT_MATRIX)[number];
export type Evidence = Record<string, unknown>;
export interface NativeRecord extends Record<string, unknown> {
	type: string;
	id?: string;
	parentId?: string | null;
	cwd?: string;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		stopReason?: string;
		errorMessage?: string;
		content?: unknown;
	};
}
export interface NativeTranscript {
	file: string;
	header: NativeRecord;
	entries: NativeRecord[];
}
export interface ScenarioResult {
	id: string;
	status: "passed" | "failed" | "blocked" | "unverified";
	startedAt: string;
	durationMs: number;
	evidence: Evidence[];
	error?: string;
}
export interface DevelopmentContext {
	browser: DevelopmentBrowser;
	url: string;
	root: string;
	agentDir: string;
	projectA: string;
	projectB: string;
	createdProject: string;
	fixtureDir: string;
	evidenceDir: string;
	model: { provider: string; id: string; input: readonly string[] };
	selectableModel?: { provider: string; id: string };
	timeoutMs: number;
	redact(text: string): string;
	transcripts(): Promise<NativeTranscript[]>;
	artifactFiles(): Promise<string[]>;
	captureResources?(): Promise<void>;
	/** Only the separately owned negative-transport fixture context exposes this. */
	providerFault?: { arm(sessionId: string): void; evidence(): Evidence };
	/** Starts another real CLI with its own profile and port, not a substitute executor. */
	isolated<T>(name: string, run: (context: DevelopmentContext) => Promise<T>): Promise<T>;
	waitForRestart(): Promise<{
		url: string;
		previousUrl: string;
		observedProcesses: Array<{ pid: number; ppid: number | null }>;
	}>;
	stop(): Promise<Evidence>;
	/** Public listener availability; no business RPC is issued by the harness. */
	isListening(): Promise<boolean>;
}
const tid = (name: string) => `[data-testid=${JSON.stringify(name)}]`;
const INPUT = tid("v4-composer-input");
const SEND = tid("v4-composer-send");
const STOP = tid("v4-stop");
const ASK = tid("v4-native-question");
const QUESTION = `${ASK},${tid("v4-user-input-dialog")}`;
const QUEUE = tid("v4-queue");
const QUEUE_PAUSED = tid("v4-queue-paused-banner");
const QUEUE_RESUME = tid("v4-queue-resume");
const nativeAdmissions = new WeakMap<DevelopmentContext, Map<string, Evidence & { cwd: string }>>();
const body = async (page: DevelopmentPage) => {
	await assertUiHealthy(page);
	return page.evaluate<string>("document.body.innerText");
};
const content = (record: NativeRecord) => JSON.stringify(record.message?.content ?? record);
const samePath = (left: string, right: string) => {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
};
function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
// Closed <details> hide React's component stack from innerText and screenshots.
// Capture bounded, read-only DOM evidence without opening or replacing the UI.
const UI_DIAGNOSTIC_EXPRESSION = `(function(){function take(selector,count,limit){return Array.prototype.slice.call(document.querySelectorAll(selector),0,count).map(function(e){return (e.textContent||'').slice(0,limit);});}var input=document.querySelector(${JSON.stringify(INPUT)});return {url:location.href,title:document.title,visibleBody:(document.body.innerText||'').slice(-12000),alerts:take('[role="alert"]',6,8000),hiddenComponentStacks:take('[role="alert"] details pre',6,8000),composer:input?{text:(input.textContent||'').slice(0,8000),html:input.innerHTML.slice(0,4000)}:null};})()`;
async function assertUiHealthy(page: DevelopmentPage): Promise<void> {
	const failure = await page.evaluate<string | null>(
		`(function(){var alerts=document.querySelectorAll('[role="alert"]');for(var i=0;i<alerts.length;i++){var e=alerts[i],r=e.getBoundingClientRect();if(!r.width||!r.height||getComputedStyle(e).visibility==='hidden')continue;if(e.querySelector('details pre')||(e.closest('main')&&e.querySelector('h1')))return (e.textContent||'').slice(0,10000);}return null;})()`,
	);
	check(!failure, `Actual browser React error boundary: ${failure}`);
}
async function uiDiagnostic(page: DevelopmentPage): Promise<Evidence> {
	return withTimeout(page.evaluate<Evidence>(UI_DIAGNOSTIC_EXPRESSION), 5000, "Browser UI diagnostic capture");
}
export async function observe<T>(
	read: () => Promise<T>,
	ready: (value: T) => boolean,
	name: string,
	timeoutMs = 90_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	do {
		last = await read();
		if (ready(last)) return last;
		await Bun.sleep(150);
	} while (Date.now() < deadline);
	throw new Error(`Timed out observing ${name}; last=${JSON.stringify(last)?.slice(0, 2000)}`);
}
async function visible(page: DevelopmentPage, selector: string): Promise<boolean> {
	await assertUiHealthy(page);
	return page.evaluate<boolean>(
		`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';})()`,
	);
}
async function click(page: DevelopmentPage, selector: string): Promise<void> {
	await observe(() => visible(page, selector), Boolean, `visible control ${selector}`);
	await page.click(selector);
}
async function clickNamed(page: DevelopmentPage, scope: string, name: RegExp): Promise<void> {
	const selector = await observe(
		() =>
			page.evaluate<string | null>(
				`(function(){var root=document.querySelector(${JSON.stringify(scope)});if(!root)return null;var buttons=root.querySelectorAll('button');var pattern=new RegExp(${JSON.stringify(name.source)},${JSON.stringify(name.flags)});for(var i=0;i<buttons.length;i++){var e=buttons[i];if(!pattern.test(e.textContent.trim()))continue;var parts=[];while(e!==root){var parent=e.parentElement;var index=Array.prototype.indexOf.call(parent.children,e)+1;parts.unshift(':nth-child('+index+')');e=parent;}return ${JSON.stringify(scope)}+' > '+parts.join(' > ');}return null;})()`,
			),
		value => value !== null,
		`native action ${name.source}`,
	);
	check(selector, `Native action ${name.source} is absent`);
	await click(page, selector);
}
async function fill(page: DevelopmentPage, selector: string, text: string): Promise<void> {
	await observe(() => visible(page, selector), Boolean, `editable control ${selector}`);
	await page.clear(selector);
	if (text) await page.type(selector, text);
	const expected = text.replace(/\r\n?/g, "\n");
	await observe(
		() => readEditableText(page, selector),
		actual => actual === expected,
		`exact native editable text for ${selector}; expected=${JSON.stringify(expected)}`,
		5000,
	);
}
async function send(page: DevelopmentPage, text: string, delivery?: "queue" | "guide" | "startNow"): Promise<string> {
	const input = text.trimStart().startsWith("/")
		? text
		: `Work only in this isolated project or this session's local:// artifacts. Never read credentials, install/download tools, or modify personal files.\n${text}`;
	await fill(page, INPUT, input);
	if (delivery) await click(page, tid(`v4-composer-delivery-${delivery}`));
	else if (await visible(page, SEND)) await click(page, SEND);
	else await page.press(INPUT, "Enter"); // Busy default submission, not an explicit guide/immediate override.
	return input;
}
function classifyModelPrerequisite(context: DevelopmentContext, message: string): void {
	if (
		/\b401\b|api_key_expired|authentication_error|invalid[_ -]api[_ -]key|No API key|credential.*expired|API key.*expired/i.test(
			message,
		)
	)
		throw new PlatformPrerequisiteError("model-authentication", context.redact(message));
	if (
		/\b(?:429|503)\b|model_not_found|model.*(?:not found|not available)|provider.*temporarily unavailable/i.test(
			message,
		)
	)
		throw new PlatformPrerequisiteError("beam-free-availability", context.redact(message));
}
async function assertModelPrerequisites(context: DevelopmentContext): Promise<void> {
	await assertUiHealthy(context.browser.page);
	for (const source of await context.transcripts()) {
		for (const entry of source.entries) {
			if (entry.message?.role === "assistant" && entry.message.stopReason === "error")
				classifyModelPrerequisite(context, entry.message.errorMessage ?? content(entry));
		}
	}
}
async function waitIdle(context: DevelopmentContext, page: DevelopmentPage): Promise<void> {
	await observe(
		async () => {
			await assertModelPrerequisites(context);
			const error = await page.evaluate<string>(
				`(function(){var e=document.querySelector(${JSON.stringify(tid("chat-error-banner"))});return e?e.innerText:'';})()`,
			);
			classifyModelPrerequisite(context, error);
			return !(await visible(page, STOP));
		},
		Boolean,
		"native run to settle",
		context.timeoutMs,
	);
}
async function selectedSession(page: DevelopmentPage, id?: string): Promise<string> {
	const selected = await observe(
		() =>
			page.evaluate<string | null>(
				`(function(){var input=document.querySelector(${JSON.stringify(INPUT)});var pane=input&&input.closest('[data-testid^="v4-session-pane"]');return pane&&pane.getAttribute('data-session-id');})()`,
			),
		value => Boolean(value && (!id || value === id)),
		`actual selected native session${id ? ` ${id}` : ""}`,
	);
	check(selected, "The editable native pane has no selected session");
	return selected;
}
async function newSession(context: DevelopmentContext, page: DevelopmentPage, project: string): Promise<string> {
	let admitted = nativeAdmissions.get(context);
	if (!admitted) nativeAdmissions.set(context, (admitted = new Map()));
	const before = new Set([...admitted.keys(), ...(await context.transcripts()).map(value => value.header.id)]);
	const selected = await openProject(context, page, project);
	const previousId = await page.evaluate<string | null>(
		`(function(){var input=document.querySelector(${JSON.stringify(INPUT)});var pane=input&&input.closest('[data-testid^="v4-session-pane"]');return pane&&pane.getAttribute('data-session-id');})()`,
	);
	if (previousId) before.add(previousId);
	await click(page, tid("task-new-button"));
	// SDK-created roots are admitted and editable before their first assistant
	// message materializes JSONL. Observe the actual selected native UI, not disk.
	const admission = await observe(
		() =>
			page.evaluate<{
				url: string;
				projectId: string | null;
				sessionId: string | null;
				lifecycle: string | null;
				generation: string | null;
				projectionSeq: string | null;
				editable: boolean;
				provider: string | null;
				model: string | null;
				error: string;
			}>(
				`(function(){var input=document.querySelector(${JSON.stringify(INPUT)});var pane=input&&input.closest('[data-testid^="v4-session-pane"]');var config=pane&&pane.querySelector(${JSON.stringify(tid("v4-model-config"))});var rect=input&&input.getBoundingClientRect();var error=document.querySelector(${JSON.stringify(`${tid("chat-error-banner")},${tid("v4-session-initialization")}`)});return {url:location.href,projectId:new URL(location.href).searchParams.get('project'),sessionId:pane&&pane.getAttribute('data-session-id'),lifecycle:pane&&pane.getAttribute('data-session-lifecycle'),generation:pane&&pane.getAttribute('data-session-generation'),projectionSeq:pane&&pane.getAttribute('data-projection-seq'),editable:!!(input&&rect.width>0&&rect.height>0&&getComputedStyle(input).visibility!=='hidden'&&!input.disabled&&!input.readOnly&&(input.isContentEditable||input.tagName==='TEXTAREA'||input.tagName==='INPUT')),provider:config&&config.getAttribute('data-provider'),model:config&&config.getAttribute('data-model'),error:error?error.innerText:''};})()`,
			),
		value =>
			typeof value.sessionId === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.sessionId) &&
			!before.has(value.sessionId) &&
			value.projectId === selected.projectId &&
			(value.lifecycle === null || value.lifecycle === "ready") &&
			value.projectionSeq !== null &&
			value.projectionSeq !== "" &&
			value.editable &&
			value.provider === context.model.provider &&
			value.model === context.model.id &&
			!value.error,
		"new selected, editable native session admission",
	);
	const binding = (await publicProjects(context)).find(value => value.projectId === admission.projectId);
	check(binding && samePath(binding.root, project), "New native session belongs to a different project");
	check(admission.sessionId, "Selected native admission has no session UUID");
	admitted.set(admission.sessionId, { ...admission, cwd: binding.root });
	return admission.sessionId;
}
async function publicProjects(
	context: DevelopmentContext,
): Promise<Array<{ projectId: string; root: string; mode: string }>> {
	// Read-only observation of the published HTTP catalogue, never a business mutation.
	const response = await fetch(new URL(WEBGUI_PROJECTS_PATH, context.url), { signal: AbortSignal.timeout(5000) });
	check(response.ok, `Public project metadata failed: ${response.status}`);
	return ((await response.json()) as { projects: Array<{ projectId: string; root: string; mode: string }> }).projects;
}
async function openProject(
	context: DevelopmentContext,
	page: DevelopmentPage,
	project: string,
	create = false,
): Promise<Evidence> {
	await page.navigate(context.url);
	await observe(
		async () =>
			(await visible(page, tid("directory-browser-path"))) || (await visible(page, tid("virtual-project-add"))),
		Boolean,
		"retained project chooser",
	);
	if (!(await visible(page, tid("directory-browser-path")))) await click(page, tid("virtual-project-add"));
	await fill(page, tid("directory-browser-path"), project);
	await click(page, tid(create ? "directory-browser-create" : "directory-browser-confirm"));
	const selected = await observe(
		async () => {
			const url = await page.evaluate<string>("location.href");
			const projectId = new URL(url).searchParams.get("project");
			const record = (await publicProjects(context)).find(value => value.projectId === projectId);
			return { url, projectId, record };
		},
		value => Boolean(value.record && samePath(value.record.root, project)),
		`actual selected project binding ${project}`,
	);
	return { projectId: selected.projectId, cwd: selected.record!.root, publicUrl: selected.url, create };
}
async function transcript(context: DevelopmentContext, id: string): Promise<NativeTranscript> {
	const value = (await context.transcripts()).find(item => item.header.id === id);
	check(value, `Native session ${id} is absent from isolated persistence`);
	return value;
}
async function written(
	context: DevelopmentContext,
	relative: string,
	expected: string,
	project = context.projectA,
): Promise<Evidence> {
	const file = path.join(project, relative);
	const value = await observe(
		async () => {
			await assertModelPrerequisites(context);
			return fs.readFile(file, "utf8").catch(() => "");
		},
		text => text.trim() === expected,
		`native tool output ${file}`,
		context.timeoutMs,
	);
	return { file, content: value, sha256: new Bun.CryptoHasher("sha256").update(value).digest("hex") };
}
async function toolEvidence(context: DevelopmentContext, id: string, marker: string): Promise<Evidence> {
	const source = await transcript(context, id);
	const admission = nativeAdmissions.get(context)?.get(id);
	if (admission)
		check(samePath(String(source.header.cwd), admission.cwd), "Native journal differs from its admitted project");
	const assistants = source.entries.filter(entry => entry.message?.role === "assistant");
	check(
		assistants.every(
			entry => entry.message?.provider === context.model.provider && entry.message.model === context.model.id,
		),
		"Persisted inference used a model other than the requested opencode-go/beam-free",
	);
	const calls = assistants.filter(entry => content(entry).includes('"toolCall"'));
	const results = source.entries.filter(entry => entry.message?.role === "toolResult");
	check(calls.length && results.length, "Real native tool call and result are both required, not a user-message echo");
	check(
		source.entries.some(entry => entry.message?.role === "toolResult" && content(entry).includes(marker)) ||
			calls.some(entry => content(entry).includes(marker)),
		`Native tools did not reference ${marker}`,
	);
	return {
		sessionId: id,
		cwd: source.header.cwd,
		transcript: source.file,
		nativeHeader: source.header,
		provider: context.model.provider,
		model: context.model.id,
		toolCallEntryIds: calls.map(entry => entry.id),
		toolResultEntryIds: results.map(entry => entry.id),
		admission,
	};
}
async function development(
	context: DevelopmentContext,
	page: DevelopmentPage,
	id: string,
	file: string,
	marker: string,
	extra = "",
): Promise<Evidence[]> {
	const cwd = nativeAdmissions.get(context)?.get(id)?.cwd ?? String((await transcript(context, id)).header.cwd);
	const beforeUsers =
		(await context.transcripts())
			.find(source => source.header.id === id)
			?.entries.filter(entry => entry.message?.role === "user").length ?? 0;
	const requestedInput = await send(
		page,
		`Use your native write/edit tool to create ${file} containing exactly ${marker}. Do not merely describe the change. ${extra}`,
	);
	// The real tool write crosses the journal's lazy assistant-output boundary.
	const evidence = await written(context, file, marker, cwd);
	await waitIdle(context, page);
	const source = await transcript(context, id);
	const admittedUsers = source.entries.filter(entry => entry.message?.role === "user").slice(beforeUsers);
	check(admittedUsers.length === 1, "One explicit Send must admit exactly one complete native user input");
	const blocks = admittedUsers[0]!.message?.content;
	const admittedText =
		typeof blocks === "string"
			? blocks
			: Array.isArray(blocks)
				? blocks.map(block => (block?.type === "text" ? block.text : "")).join("")
				: "";
	check(
		admittedText.includes(requestedInput.trim()),
		"Native journal lost or changed the complete security prefix and requested development task",
	);
	return [
		evidence,
		await toolEvidence(context, id, file),
		{ userEntryId: admittedUsers[0]!.id, admittedText, explicitSendCount: 1 },
	];
}
async function nativeQuestion(
	context: DevelopmentContext,
	page: DevelopmentPage,
	id: string,
	file: string,
): Promise<Evidence[]> {
	const marker = `answer-${crypto.randomUUID()}`;
	await send(
		page,
		`Call the native ask tool now. Ask me for a marker using free text and wait for my answer. Do not guess. After my answer use the native write tool to write it exactly to ${file}.`,
	);
	await observe(() => visible(page, QUESTION), Boolean, "real native supplementary question", context.timeoutMs);
	const interaction = await page.evaluate<string>(
		`document.querySelector(${JSON.stringify(QUESTION)}).getAttribute('data-interaction-id')`,
	);
	check(interaction, "Rendered question lacks real interaction identity");
	await fill(page, `${ASK} textarea`, marker);
	await clickNamed(page, ASK, /^提交$/);
	const fileEvidence = await written(context, file, marker);
	await waitIdle(context, page);
	return [
		{ interactionId: interaction, answer: marker, sessionId: id },
		fileEvidence,
		await toolEvidence(context, id, "ask"),
	];
}
async function pendingRun(context: DevelopmentContext, page: DevelopmentPage, id: string, file: string): Promise<void> {
	// A newly admitted sibling legitimately has no journal until its first reply.
	const previous = new Set(
		(await context.transcripts()).find(source => source.header.id === id)?.entries.map(entry => entry.id) ?? [],
	);
	await send(
		page,
		`Use your native bash tool to wait 25 seconds, then write ${file} with exactly ${id}. Keep the tool synchronous and wait for completion. Do not use background jobs.`,
	);
	await observe(() => visible(page, STOP), Boolean, "real active native run", context.timeoutMs);
	await observe(
		async () => {
			await assertModelPrerequisites(context);
			return (await context.transcripts()).find(source => source.header.id === id)?.entries ?? [];
		},
		values =>
			values.some(
				value =>
					!previous.has(value.id) &&
					value.message?.role === "assistant" &&
					content(value).includes('"toolCall"') &&
					/bash|sleep|timeout/.test(content(value)),
			),
		"native running bash call",
		context.timeoutMs,
	);
}
async function assertNoModel(context: DevelopmentContext, evidence: Evidence[], unregistered = false): Promise<void> {
	const snapshots = await context.transcripts();
	const projects = await publicProjects(context);
	check(snapshots.length === 0, "Standalone browsing created a native session before explicit work");
	if (unregistered) {
		check(projects.length === 0, "Lazy startup/refresh registered an unrequested project");
		check(
			!(await fs.stat(path.join(context.root, ".omp", "aireq-workbench", "browser-mode")).then(
				() => true,
				() => false,
			)),
			"Lazy startup created a project-mode lock",
		);
	}
	evidence.push({
		lazyAgents: true,
		persistedNativeSessions: 0,
		registeredProjects: projects,
		observedAt: new Date().toISOString(),
	});
}

/** Each callback performs real controls and checks native persistence/files, not internal business endpoints. */
export function developmentScenarios(
	context: DevelopmentContext,
): Array<{ id: DevelopmentScenarioId; run(evidence: Evidence[]): Promise<void> }> {
	const page = context.browser.page;
	let sessionA: string | undefined;
	const a = () => {
		check(sessionA, "Native-development-history prerequisite did not create session A");
		return sessionA;
	};
	return [
		{
			id: "standalone-projects",
			async run(evidence) {
				await page.navigate(context.url);
				await assertNoModel(context, evidence, true);
				await page.reload();
				await assertNoModel(context, evidence, true);
				evidence.push(await openProject(context, page, context.projectA));
				await assertNoModel(context, evidence);
				evidence.push(await openProject(context, page, context.createdProject, true));
				check(
					(await fs.stat(context.createdProject)).isDirectory(),
					"Create project control did not create the requested real directory",
				);
				await assertNoModel(context, evidence);
				evidence.push(await openProject(context, page, context.projectB));
				await assertNoModel(context, evidence);
				evidence.push({
					opened: [context.projectA, context.projectB],
					created: context.createdProject,
					port: new URL(context.url).port,
				});
			},
		},
		{
			id: "native-development-history",
			async run(evidence) {
				sessionA = await newSession(context, page, context.projectA);
				const marker = `developed-${crypto.randomUUID()}`;
				evidence.push(...(await development(context, page, a(), "native-development.txt", marker)));
				const other = await context.browser.newPage();
				const sessionB = await newSession(context, other, context.projectB);
				evidence.push(
					...(await development(
						context,
						other,
						sessionB,
						"history-b.txt",
						"history-b",
						"Work only in the selected project.",
					)),
				);
				await openProject(context, page, context.projectA);
				await click(page, tid(`task-item-${sessionB}`));
				await observe(
					() => body(page),
					text => text.includes("history-b"),
					"cross-directory read-only history",
				);
				const before = (await context.transcripts()).length;
				await click(page, `${tid("v4-native-history-resume")} button`);
				await observe(
					() => body(page),
					text => text.includes(context.projectB) || text.includes(path.basename(context.projectB)),
					"continued historical cwd",
				);
				check(
					(await context.transcripts()).length === before,
					"Continuing an already resident history created a duplicate native executor",
				);
				evidence.push(...(await development(context, page, sessionB, "history-continued.txt", "continued-in-b")));
				check(
					(await fs.readFile(path.join(context.projectA, "native-development.txt"), "utf8")) === marker,
					"History continuation changed A's workspace",
				);
				evidence.push({
					readOnlyHistorySessionId: sessionB,
					resumedSessionId: sessionB,
					cwd: context.projectB,
					unaffectedSessionId: a(),
				});
				await openProject(context, page, context.projectA);
				await click(page, tid(`task-item-${a()}`));
			},
		},
		{
			id: "independent-cancel",
			async run(evidence) {
				const sibling = await context.browser.newPage();
				const siblingId = await newSession(context, sibling, context.projectB);
				await pendingRun(context, page, a(), "cancelled-a.txt");
				await pendingRun(context, sibling, siblingId, "survived-b.txt");
				await click(page, STOP);
				await waitIdle(context, page);
				evidence.push(await written(context, "survived-b.txt", siblingId, context.projectB));
				await waitIdle(context, sibling);
				const cancelled = await transcript(context, a());
				check(
					cancelled.entries.some(
						entry =>
							entry.message?.stopReason === "aborted" ||
							(/abort|cancel/i.test(content(entry)) && entry.message?.role === "toolResult"),
					),
					"Native cancellation has no persisted aborted/tool cancellation result",
				);
				check(
					await fs.stat(path.join(context.projectA, "native-development.txt")).then(
						() => true,
						() => false,
					),
					"Cancellation removed previously developed file",
				);
				evidence.push({
					cancelledSessionId: a(),
					continuingSibling: siblingId,
					cancellationEntryIds: cancelled.entries
						.filter(entry => /abort|cancel/i.test(content(entry)))
						.map(entry => entry.id),
				});
			},
		},
		{
			id: "native-questions",
			async run(evidence) {
				const sibling = await context.browser.newPage();
				const siblingId = await newSession(context, sibling, context.projectB);
				await send(
					sibling,
					"Call the native ask tool with exactly one question and two options labelled approved and rejected. Wait for my answer. If approved is selected use the native write tool to create option-answer.txt containing exactly approved.",
				);
				await observe(() => visible(sibling, ASK), Boolean, "sibling native option question", context.timeoutMs);
				const siblingInteraction = await sibling.evaluate<string>(
					`document.querySelector(${JSON.stringify(ASK)}).getAttribute('data-interaction-id')`,
				);
				evidence.push(...(await nativeQuestion(context, page, a(), "answered.txt")));
				check(await visible(sibling, ASK), "Answering A consumed B's pending question");
				check(
					(await sibling.evaluate<string>(
						`document.querySelector(${JSON.stringify(ASK)}).getAttribute('data-interaction-id')`,
					)) === siblingInteraction,
					"A answer replaced B's waiting point",
				);
				const pendingQuestion = `${ASK}[data-interaction-id=${JSON.stringify(siblingInteraction)}]`;
				const approved = await observe(
					() =>
						sibling.evaluate<{ selector: string | null; options: string[] }>(
							`(function(){var root=document.querySelector(${JSON.stringify(pendingQuestion)});var result={selector:null,options:[]};if(!root)return result;var options=root.querySelectorAll('button[role="option"]');for(var i=0;i<options.length;i++){var e=options[i];result.options.push(e.textContent.trim());var label=Array.prototype.some.call(e.querySelectorAll('span'),function(s){return !s.children.length&&s.textContent.trim()==='approved';});var r=e.getBoundingClientRect();if(!label||!r.width||!r.height||getComputedStyle(e).visibility==='hidden'||e.matches(':disabled'))continue;var parts=[];while(e!==root){var parent=e.parentElement;parts.unshift(':nth-child('+(Array.prototype.indexOf.call(parent.children,e)+1)+')');e=parent;}result.selector=${JSON.stringify(pendingQuestion)}+' > '+parts.join(' > ');}return result;})()`,
						),
					value => value.selector !== null,
					`visible enabled approved native option for ${siblingInteraction}`,
				);
				check(approved.selector, "Native approved option is absent");
				await click(sibling, approved.selector);
				// A single-select final answer submits itself. The fieldset can remain
				// visible but disabled until the pending-interaction projection catches
				// up; clicking its old Submit in that interval races its removal.
				await observe(
					() => visible(sibling, pendingQuestion),
					present => !present,
					`native option interaction ${siblingInteraction} resolved after auto-submit`,
					context.timeoutMs,
				);
				evidence.push(await written(context, "option-answer.txt", "approved", context.projectB));
				await waitIdle(context, sibling);
				evidence.push(await toolEvidence(context, siblingId, "option-answer.txt"));
				evidence.push({
					siblingSessionId: siblingId,
					siblingInteraction,
					answerMode: "native-option",
					isolation: true,
					approvedOptions: approved.options,
					approvedSelector: approved.selector,
					resolvedInteractionId: siblingInteraction,
				});
			},
		},
		{
			id: "attachments",
			async run(evidence) {
				const marker = `uploaded-${crypto.randomUUID()}`;
				const upload = path.join(context.fixtureDir, "upload.txt");
				await fs.writeFile(upload, marker);
				await page.upload(tid("v4-composer-upload-input"), [upload]);
				await send(
					page,
					"Read the attached text file bytes, then use the native write tool to put its exact text into uploaded-result.txt. Do not copy the filename as content.",
				);
				evidence.push(await written(context, "uploaded-result.txt", marker));
				await waitIdle(context, page);
				const source = await transcript(context, a());
				check(
					source.entries.some(
						entry =>
							entry.message?.role === "user" &&
							/upload\.txt/.test(content(entry)) &&
							(content(entry).includes(marker) || /attachment|file|mime/i.test(content(entry))),
					),
					"Accepted native message lacks uploaded file ownership/metadata",
				);
				const png = path.join(context.fixtureDir, "pixel.png");
				await fs.writeFile(
					png,
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=",
						"base64",
					),
				);
				await page.upload(tid("v4-composer-upload-input"), [png]);
				await send(page, "Describe the attached image.");
				await observe(() => visible(page, tid("chat-error-banner")), Boolean, "native image capability result");
				const details = tid("chat-error-details-button");
				const expanded = await visible(page, details);
				if (expanded) await click(page, details);
				await observe(
					() => body(page),
					text =>
						/不支持.*图|图.*不支持|image.*not.support|does not (?:support|accept).*image|text.only/i.test(text),
					"Beam Free meaningful image capability rejection",
				);
				check(
					!context.model.input.includes("image"),
					"This rejection case is specifically for authoritative text-only Beam Free",
				);
				check(
					(await page.evaluate<string>(`document.querySelector(${JSON.stringify(INPUT)}).textContent`)).includes(
						"Describe",
					),
					"Rejected image lost recoverable draft",
				);
				evidence.push({
					sessionId: a(),
					filename: "upload.txt",
					mime: "text/plain",
					bytes: Buffer.byteLength(marker),
					image: { filename: "pixel.png", mime: "image/png", capability: context.model.input, result: "rejected" },
				});
				if (expanded) await page.press('[role="dialog"]', "Escape");
				await page.clearDraft();
				const remove = "[data-composer-attachment-remove]";
				while (await visible(page, remove)) await page.click(remove);
			},
		},
		{
			id: "file-context",
			async run(evidence) {
				const marker = `context-${crypto.randomUUID()}`;
				await fs.writeFile(path.join(context.projectA, "context-secret.txt"), marker);
				await send(
					page,
					"@context-secret.txt Use the referenced file context supplied with this message, without reading any file with a tool. Write its exact content to context-result.txt with the native write tool.",
				);
				evidence.push(await written(context, "context-result.txt", marker));
				await waitIdle(context, page);
				const source = await transcript(context, a());
				check(
					source.entries.some(entry => entry.message?.role === "user" && content(entry).includes(marker)),
					"@ context was not actually resolved into the native input",
				);
				await send(page, "@../project-b/outside-context.txt Do not run if the reference is unauthorized.");
				await observe(
					() => body(page),
					text => /越权|授权|outside|escape|not.allowed|not.found|不存在|拒绝/i.test(text),
					"unauthorized context reference rejection",
				);
				check(
					(await page.evaluate<string>(`document.querySelector(${JSON.stringify(INPUT)}).textContent`)).includes(
						"outside-context",
					),
					"Rejected reference discarded draft",
				);
				await page.clearDraft();
				evidence.push({
					sessionId: a(),
					referenced: "context-secret.txt",
					rejected: "../project-b/outside-context.txt",
				});
			},
		},
		{
			id: "follow-up-queue",
			async run(evidence) {
				await selectedSession(page, a());
				await waitIdle(context, page);
				await pendingRun(context, page, a(), "queue-first.txt");
				await send(
					page,
					"Use the native write tool to create queued-second.txt containing exactly queued-after-first.",
				);
				const queueState = () =>
					page.evaluate<{ autoDrain: string | null; text: string; paused: boolean; count: number }>(
						`(function(){var queue=document.querySelector(${JSON.stringify(QUEUE)});return {autoDrain:queue&&queue.getAttribute('data-queue-auto-drain'),text:queue?queue.innerText:'',paused:!!document.querySelector(${JSON.stringify(QUEUE_PAUSED)}),count:queue?Number(queue.getAttribute('data-queue-count')):0};})()`,
					);
				const admittedQueue = await observe(
					queueState,
					value => value.count > 0 && value.text.includes("queued-second.txt"),
					"native busy follow-up admission, whether held or auto-draining",
				);
				check(await visible(page, STOP), "Follow-up admission was not observed during the active native run");
				check(
					!(await fs.stat(path.join(context.projectA, "queued-second.txt")).then(
						() => true,
						() => false,
					)),
					"Follow-up executed before the active synchronous call completed",
				);
				await send(
					page,
					"Use the native read tool to read queued-second.txt, then use the native write tool to create queued-third.txt containing exactly queued-after-second. Do not create it before queued-second.txt exists.",
				);
				const fifoQueue = await observe(
					() =>
						page.evaluate<
							Array<{ id: string | null; text: string; index: string | null; delivery: string | null }>
						>(
							`(function(){var queue=document.querySelector(${JSON.stringify(QUEUE)});return queue?Array.prototype.map.call(queue.querySelectorAll('li[data-queue-item-id]'),function(e){return {id:e.getAttribute('data-queue-item-id'),text:e.innerText,index:e.getAttribute('data-index'),delivery:e.getAttribute('data-delivery-admitted')};}):[];})()`,
						),
					items => {
						const second = items.findIndex(item => item.text.includes("create queued-second.txt"));
						const third = items.findIndex(item => item.text.includes("create queued-third.txt"));
						return second >= 0 && third > second;
					},
					"two native queued follow-ups admitted in FIFO order while busy",
				);
				const drainState = await queueState();
				evidence.push({ sessionId: a(), admittedQueue, fifoQueue, drainState });
				if (drainState.autoDrain === "false") {
					check(drainState.paused, "Held native queue has no paused banner");
					await click(page, QUEUE_RESUME);
					await observe(
						queueState,
						value => value.autoDrain === "true" || value.count === 0,
						"native queue resumed or drained after explicit Continue",
					);
					evidence.push({ manualResumeControl: QUEUE_RESUME });
				} else check(drainState.autoDrain === "true", "Native queue has no authoritative drain mode");
				evidence.push(await written(context, "queue-first.txt", a()));
				evidence.push(await written(context, "queued-second.txt", "queued-after-first"));
				evidence.push(await written(context, "queued-third.txt", "queued-after-second"));
				await waitIdle(context, page);
				evidence.push(await toolEvidence(context, a(), "queued-second.txt"));
				evidence.push(await toolEvidence(context, a(), "queued-third.txt"));
				const queuedSource = await transcript(context, a());
				const secondInput = queuedSource.entries.findIndex(
					entry => entry.message?.role === "user" && content(entry).includes("create queued-second.txt"),
				);
				const secondWrite = queuedSource.entries.findIndex(
					entry =>
						entry.message?.role === "assistant" &&
						content(entry).includes('"toolCall"') &&
						content(entry).includes("queued-second.txt"),
				);
				const thirdInput = queuedSource.entries.findIndex(
					entry => entry.message?.role === "user" && content(entry).includes("create queued-third.txt"),
				);
				check(
					secondInput >= 0 && secondWrite > secondInput && thirdInput > secondWrite,
					"Native journal did not execute the second follow-up before admitting the third",
				);
				evidence.push({
					sessionId: a(),
					fifoEntryIds: [secondInput, secondWrite, thirdInput].map(index => queuedSource.entries[index]!.id),
				});
			},
		},
		{
			id: "guide-immediate",
			async run(evidence) {
				// Delivery owns a fresh native session, rather than inheriting the
				// cancellation/queue state intentionally exercised by earlier cases.
				const deliveryPage = await context.browser.newPage();
				const deliveryId = await newSession(context, deliveryPage, context.projectA);
				await pendingRun(context, deliveryPage, deliveryId, "guide-base.txt");
				await send(
					deliveryPage,
					"After the current tool finishes, use the native write tool to create guided.txt containing exactly native-steer-applied.",
					"guide",
				);
				await observe(
					() => body(deliveryPage),
					text => /guide|steer|引导|接纳|待应用/i.test(text),
					"native steer acceptance",
				);
				evidence.push(await written(context, "guided.txt", "native-steer-applied"));
				evidence.push(await written(context, "guide-base.txt", deliveryId));
				await waitIdle(context, deliveryPage);
				await pendingRun(context, deliveryPage, deliveryId, "immediate-old.txt");
				await send(
					deliveryPage,
					"Use the native write tool to create immediate-result.txt containing exactly explicit-immediate.",
					"startNow",
				);
				evidence.push(await written(context, "immediate-result.txt", "explicit-immediate"));
				await waitIdle(context, deliveryPage);
				evidence.push({
					sessionId: deliveryId,
					delivery: ["steer", "explicit-startNow"],
					native: await toolEvidence(context, deliveryId, "guided.txt"),
					nativeImmediate: await toolEvidence(context, deliveryId, "immediate-result.txt"),
				});
			},
		},
		{
			id: "branch-edit",
			async run(evidence) {
				await waitIdle(context, page);
				await selectedSession(page, a());
				const originalId = a();
				const original = await transcript(context, originalId);
				const userTexts = original.entries
					.filter(entry => entry.message?.role === "user")
					.map(entry => entry.message!.content)
					.map(value =>
						typeof value === "string"
							? value
							: Array.isArray(value)
								? value
										.filter(part => part?.type === "text")
										.map(part => part.text)
										.join("")
								: "",
					)
					.map(text => text.replace(/\s+/g, " ").trim())
					.filter(Boolean);
				const row = await observe(
					() =>
						page.evaluate<Array<{ id: string; text: string; editable: boolean }>>(
							`Array.prototype.map.call(document.querySelectorAll('[data-session-id=${JSON.stringify(originalId)}] [data-row-id]'),function(e){return {id:e.getAttribute('data-row-id'),text:e.textContent,editable:!!e.querySelector('[data-testid^="v4-edit-"]')};})`,
						),
					rows =>
						rows.some(
							value => value.editable && userTexts.some(text => value.text.replace(/\s+/g, " ").includes(text)),
						),
					"existing editable user question in the selected native session",
				).then(rows =>
					rows.findLast(
						value => value.editable && userTexts.some(text => value.text.replace(/\s+/g, " ").includes(text)),
					),
				);
				check(row, "Selected native session has no persisted editable user question");
				const preserved = new Map<string, string>();
				const snapshot = async (directory: string): Promise<void> => {
					for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
						if (entry.name === ".git") continue;
						const file = path.join(directory, entry.name);
						if (entry.isDirectory()) await snapshot(file);
						else if (entry.isFile())
							preserved.set(file, new Bun.CryptoHasher("sha256").update(await fs.readFile(file)).digest("hex"));
					}
				};
				await snapshot(context.projectA);
				await click(page, tid(`v4-edit-${row.id}`));
				await fill(
					page,
					tid(`v4-edit-input-${row.id}`),
					"Use the native write tool to create branch-result.txt containing exactly native-branch. Do not remove any existing files.",
				);
				await click(page, tid(`v4-edit-submit-${row.id}`));
				evidence.push(await written(context, "branch-result.txt", "native-branch"));
				await waitIdle(context, page);
				for (const [file, digest] of preserved)
					check(
						new Bun.CryptoHasher("sha256").update(await fs.readFile(file)).digest("hex") === digest,
						`Editing a question rolled back or changed existing workspace file ${file}`,
					);
				const branchId = await selectedSession(page);
				check(branchId !== originalId, "Edited resend did not select a distinct native branch session");
				const branch = await transcript(context, branchId);
				check(
					branch.header.parentSession === original.file || branch.header.parentSession === originalId,
					"Selected edited session has no exact native parent identity",
				);
				check(
					branch.entries.some(
						entry => entry.message?.role === "user" && content(entry).includes("branch-result.txt"),
					),
					"Selected native branch did not persist the edited user input",
				);
				evidence.push({
					originalSessionId: originalId,
					originalMessageRow: row.id,
					originalPrompt: row.text,
					branchSessionId: branchId,
					branchParent: branch.header.parentSession,
					originalTranscript: original.file,
					preservedWorkspaceFiles: [...preserved.keys()],
					workspaceRollback: false,
					native: await toolEvidence(context, branchId, "branch-result.txt"),
				});
				sessionA = branchId;
			},
		},
		{
			id: "failed-retry",
			async run(evidence) {
				// A separately owned real CLI receives one explicit HTTP 400 at its
				// provider boundary. Retrying forwards unchanged to real Beam Free;
				// no failed journal message or successful model output is fabricated.
				await context.isolated("failed-retry-transport", async isolated => {
					const retryPage = isolated.browser.page;
					const fixture = isolated.providerFault;
					check(fixture, "Failed-reply acceptance requires its owned one-request negative transport fixture");
					const id = await newSession(isolated, retryPage, isolated.projectA);
					await selectedSession(retryPage, id);
					fixture.arm(id);
					try {
						await send(
							retryPage,
							`Use the native write tool to create retry-finished.txt containing exactly ${id}. Then state the answer to 197 + 326 as a single number.`,
						);
						const before = await observe(
							async () => (await isolated.transcripts()).find(value => value.header.id === id),
							source =>
								Boolean(
									source?.entries.some(
										entry =>
											entry.message?.role === "assistant" &&
											entry.message.stopReason === "error" &&
											String(entry.message.errorMessage).includes(String(fixture.evidence().marker)),
									),
								),
							"native failed assistant reply from the explicit one-request HTTP fault",
							isolated.timeoutMs,
						);
						check(before, "Native failed-reply journal is absent");
						await waitIdle(isolated, retryPage);
						check(
							fixture.evidence().injectedRequests === 1,
							"Negative transport fixture did not fail exactly one request",
						);
						check(
							!(await fs.stat(path.join(isolated.projectA, "retry-finished.txt")).then(
								() => true,
								() => false,
							)),
							"The explicitly failed provider reply unexpectedly executed the tool write",
						);
						const failed = before.entries.findLast(
							entry => entry.message?.role === "assistant" && entry.message.stopReason === "error",
						);
						check(failed, "No actual failed native assistant reply exists for row retry");
						await fill(retryPage, INPUT, "draft-survives-native-retry");
						const retry = await observe(
							() =>
								retryPage.evaluate<string | null>(
									`(function(){var pane=document.querySelector('[data-session-id=${JSON.stringify(id)}]');var buttons=pane&&pane.querySelectorAll('[data-testid^="v4-retry-"]:not([data-testid="v4-retry-subscribe"])');return buttons&&buttons.length?buttons[buttons.length-1].getAttribute('data-testid'):null;})()`,
								),
							value => value !== null,
							"real failed assistant row retry button",
						);
						check(retry, "Actual failed native reply has no retry control");
						const failedScreenshot = path.join(context.evidenceDir, "native-failed-row-before-retry.png");
						await withTimeout(
							retryPage.screenshot(failedScreenshot),
							5000,
							"Actual failed reply and native retry control",
						);
						evidence.push({
							failedScreenshot,
							failedEntryId: failed.id,
							failedError: failed.message?.errorMessage,
							nativeJournal: before.file,
						});
						await click(retryPage, tid(retry));
						evidence.push(await written(isolated, "retry-finished.txt", id));
						await waitIdle(isolated, retryPage);
						const after = await transcript(isolated, id);
						check(
							after.entries.length > before.entries.length,
							"Native row retry appended no new real provider result",
						);
						check(
							after.entries.some(entry => entry.message?.role === "assistant" && /\b523\b/.test(content(entry))),
							"Retried real assistant did not produce the exact arithmetic result",
						);
						check(
							(await readEditableText(retryPage, INPUT)) === "draft-survives-native-retry",
							"Native row retry discarded an unrelated unsent draft",
						);
						const transport = fixture.evidence();
						check(
							Array.isArray(transport.requests) &&
								transport.requests.some(
									request =>
										request.outcome === "real-provider-forwarded" &&
										request.model === isolated.model.id &&
										request.nativeSessionIdFromInput === id &&
										request.status >= 200 &&
										request.status < 300,
								),
							"Retried positive inference did not cross the actual authorized Beam Free provider boundary",
						);
						evidence.push(await toolEvidence(isolated, id, "retry-finished.txt"));
						evidence.push({
							sessionId: id,
							failedEntryId: failed.id,
							retryControl: retry,
							beforeEntryCount: before.entries.length,
							afterEntryCount: after.entries.length,
							transport,
							draftPreserved: true,
							negativeFixture: "one-real-HTTP-400; no synthetic native messages",
						});
						await retryPage.screenshot(path.join(context.evidenceDir, "native-failed-row-retry.png"));
					} catch (cause) {
						const diagnostic = await uiDiagnostic(retryPage).catch(error => ({ captureError: String(error) }));
						evidence.push({ retryFailureUi: diagnostic, transport: fixture.evidence() });
						throw cause;
					}
				});
			},
		},
		{
			id: "parallel-isolation",
			async run(evidence) {
				const first = await context.browser.newPage();
				const second = await context.browser.newPage();
				const third = await context.browser.newPage();
				const firstId = await newSession(context, first, context.projectA);
				const secondId = await newSession(context, second, context.projectB);
				const thirdId = await newSession(context, third, context.projectA);
				check(thirdId !== firstId && thirdId !== secondId, "Same-project sessions share a native executor");
				const attachment = path.join(context.fixtureDir, "parallel-attachment.txt");
				await fs.writeFile(attachment, "attachment-owned-only-by-first");
				await first.upload(tid("v4-composer-upload-input"), [attachment]);
				check(firstId !== secondId, "Concurrent pages share one native executor");
				await fill(first, INPUT, "isolated-draft-A");
				await fill(second, INPUT, "isolated-draft-B");
				await first.reload();
				await observe(
					() =>
						first.evaluate<string>(
							`document.querySelector(${JSON.stringify(INPUT)})&&document.querySelector(${JSON.stringify(INPUT)}).textContent`,
						),
					text => text === "isolated-draft-A",
					"session A isolated persisted draft",
				);
				check(
					(await second.evaluate<string>(`document.querySelector(${JSON.stringify(INPUT)}).textContent`)) ===
						"isolated-draft-B",
					"A reload changed B's draft",
				);
				check(
					!(await body(second)).includes("parallel-attachment.txt") &&
						!(await body(third)).includes("parallel-attachment.txt"),
					"Draft attachment crossed native session boundaries",
				);
				await first.clearDraft();
				await second.clearDraft();
				const alternative = context.selectableModel;
				check(
					alternative,
					"Temporary-model isolation requires a second authoritative OpenCode Go catalogue model (no inference is sent to it)",
				);
				const configBefore = await fs.readFile(path.join(context.agentDir, "config.yml"), "utf8");
				const selectModel = async (model: { provider: string; id: string }) => {
					await observe(
						() =>
							first.evaluate<boolean>(
								`(function(){var e=document.querySelector(${JSON.stringify(tid("chat-model-select-trigger"))});return !!e&&!e.disabled&&e.getAttribute('aria-disabled')!=='true';})()`,
							),
						Boolean,
						"enabled native model picker for its selected session",
					);
					await click(first, tid("chat-model-select-trigger"));
					// Native model menus expose provider submenus even for one provider.
					// A model item is not mounted until its real provider trigger opens.
					const item = tid(`chat-model-select-item-${encodeCustomModelValue(model.provider, model.id)}`);
					if (!(await visible(first, item))) {
						const provider = `[data-model-provider-key=${JSON.stringify(`native-provider:${model.provider}`)}]`;
						await observe(() => visible(first, provider), Boolean, "native provider submenu trigger");
						await first.hover(provider);
					}
					await observe(() => visible(first, item), Boolean, "real native provider model submenu item");
					const visibleItem = await first.evaluate<Evidence>(
						`(function(){var e=document.querySelector(${JSON.stringify(item)});return {testId:e.getAttribute('data-testid'),text:e.textContent,locked:e.getAttribute('data-model-option-locked')};})()`,
					);
					await click(first, item);
					await observe(
						() =>
							first.evaluate<{ provider: string | null; model: string | null; value: string | null }>(
								`(function(){var e=document.querySelector(${JSON.stringify(tid("v4-model-config"))});var trigger=document.querySelector(${JSON.stringify(tid("chat-model-select-trigger"))});return {provider:e&&e.getAttribute('data-provider'),model:e&&e.getAttribute('data-model'),value:trigger&&trigger.getAttribute('data-model-current-value')};})()`,
							),
						value =>
							value.provider === model.provider &&
							value.model === model.id &&
							value.value === encodeCustomModelValue(model.provider, model.id),
						"actual selected native temporary provider/model",
					);
					evidence.push({ selectedNativeModel: model, actualNativeModelItem: visibleItem });
				};
				await selectModel(alternative);
				check(
					(await second.evaluate<string>(
						`document.querySelector(${JSON.stringify(tid("v4-model-config"))}).getAttribute('data-model')`,
					)) === context.model.id,
					"Temporary selection changed sibling model",
				);
				check(
					(await third.evaluate<string>(
						`document.querySelector(${JSON.stringify(tid("v4-model-config"))}).getAttribute('data-model')`,
					)) === context.model.id,
					"Temporary selection changed a same-project sibling model",
				);
				check(
					(await fs.readFile(path.join(context.agentDir, "config.yml"), "utf8")) === configBefore,
					"Temporary selection mutated global profile model defaults",
				);
				await selectModel(context.model);
				evidence.push({
					temporarilySelected: alternative,
					inferenceSentToAlternative: false,
					restored: context.model.id,
				});
				await pendingRun(context, first, firstId, "parallel-a.txt");
				await pendingRun(context, second, secondId, "parallel-b.txt");
				await pendingRun(context, third, thirdId, "parallel-a2.txt");
				check(
					(await visible(first, STOP)) && (await visible(second, STOP)) && (await visible(third, STOP)),
					"Same-project and cross-project native sessions were not simultaneously running",
				);
				await send(
					first,
					"Use the native write tool to create parallel-queue-a.txt containing exactly queued-only-for-first.",
				);
				await send(
					third,
					"After the current tool completes use the native write tool to create parallel-guide-a2.txt containing exactly guided-only-for-third.",
					"guide",
				);
				await first.reload();
				await observe(() => visible(first, STOP), Boolean, "refresh reconnect sees same running native session");
				evidence.push(await written(context, "parallel-a.txt", firstId));
				evidence.push(await written(context, "parallel-b.txt", secondId, context.projectB));
				evidence.push(await written(context, "parallel-a2.txt", thirdId));
				evidence.push(await written(context, "parallel-queue-a.txt", "queued-only-for-first"));
				evidence.push(await written(context, "parallel-guide-a2.txt", "guided-only-for-third"));
				evidence.push(
					await toolEvidence(context, firstId, "parallel-a.txt"),
					await toolEvidence(context, secondId, "parallel-b.txt"),
					await toolEvidence(context, thirdId, "parallel-a2.txt"),
				);
				const firstSource = await transcript(context, firstId);
				check(
					firstSource.entries.filter(
						entry => entry.message?.role === "user" && content(entry).includes("parallel-a.txt"),
					).length === 1,
					"Reconnect replayed an already accepted native input",
				);
				check(
					!(await transcript(context, secondId)).entries.some(
						entry => entry.message?.role === "user" && content(entry).includes("parallel-attachment.txt"),
					),
					"Accepted attachment reached a sibling native session",
				);
				evidence.push({
					sessions: [firstId, secondId, thirdId],
					drafts: "isolated",
					attachments: "isolated",
					concurrent: true,
					sameProjectConcurrent: true,
					reconnectedWithoutReplay: true,
				});
			},
		},
		{
			id: "owned-settlement",
			async run(evidence) {
				await context.isolated("unrelated-owner", async unrelated => {
					await unrelated.browser.page.navigate(unrelated.url);
					check(await unrelated.isListening(), "Unrelated OMP instance was not live before settlement");
					const first = await context.browser.newPage();
					const second = await context.browser.newPage();
					const firstId = await newSession(context, first, context.projectA);
					const secondId = await newSession(context, second, context.projectB);
					await send(
						first,
						"Use the native task tool to spawn a child that itself spawns another child. The deepest child must run a synchronous bash wait for 90 seconds. Wait for all descendants. Do not produce mock events.",
					);
					await observe(
						context.transcripts,
						values =>
							values.some(
								value =>
									value.header.parentSession &&
									values.some(
										parent =>
											parent.header.parentSession &&
											(value.header.parentSession === parent.file ||
												value.header.parentSession === parent.header.id),
									),
							),
						"real recursive native descendants",
						context.timeoutMs,
					);
					await send(
						second,
						"Call the native ask tool and wait for my free-text answer before doing anything else.",
					);
					await observe(
						() => visible(second, QUESTION),
						Boolean,
						"second root waiting on native question",
						context.timeoutMs,
					);
					await send(first, "Write shutdown-queued.txt only after descendants finish.", "queue");
					const owned = await context.transcripts();
					evidence.push({
						rootSessionIds: [firstId, secondId],
						recursiveSessions: owned.map(value => ({
							id: value.header.id,
							parent: value.header.parentSession,
							cwd: value.header.cwd,
							file: value.file,
						})),
						pendingQuestion: await second.evaluate<string>(
							`document.querySelector(${JSON.stringify(QUESTION)}).getAttribute('data-interaction-id')`,
						),
						queuedWork: "shutdown-queued.txt",
					});
					const unrelatedId = await newSession(unrelated, unrelated.browser.page, unrelated.projectA);
					await pendingRun(unrelated, unrelated.browser.page, unrelatedId, "unrelated-survived.txt");
					await first.screenshot(path.join(context.evidenceDir, "settlement-root-descendants.png"));
					await second.screenshot(path.join(context.evidenceDir, "settlement-root-question.png"));
					evidence.push(await context.stop());
					check(!(await context.isListening()), "Owned listener remains accessible after successful exit");
					check(await unrelated.isListening(), "Own settlement terminated another OMP process/listener");
					evidence.push(await written(unrelated, "unrelated-survived.txt", unrelatedId));
					await waitIdle(unrelated, unrelated.browser.page);
					// A second real owner acquiring the same root proves OS lease release, not file deletion.
					evidence.push(await openProject(unrelated, unrelated.browser.page, context.projectA));
					evidence.push({
						ownListenerReleased: true,
						unrelatedListenerSurvived: unrelated.url,
						unrelatedSessionId: unrelatedId,
						originalProjectLeaseReacquired: context.projectA,
					});
				});
			},
		},
	];
}

export async function runDevelopmentScenarios(context: DevelopmentContext): Promise<ScenarioResult[]> {
	const results: ScenarioResult[] = [];
	for (const scenario of developmentScenarios(context)) {
		const started = Date.now();
		const evidence: Evidence[] = [];
		let status: ScenarioResult["status"] = "passed";
		let error: string | undefined;
		try {
			await scenario.run(evidence);
		} catch (cause) {
			status = cause instanceof PlatformPrerequisiteError ? "blocked" : "failed";
			error = context.redact(cause instanceof Error ? cause.message : String(cause));
			try {
				const pages = await withTimeout(context.browser.pages(), 5000, "Failure evidence page discovery");
				const targets = [...new Set([context.browser.page, ...pages.slice(-3)])];
				await Promise.all(
					targets.map(async (target, index) => {
						try {
							const diagnostic = await uiDiagnostic(target);
							const diagnosticFile = path.join(
								context.evidenceDir,
								`${scenario.id}-failure-ui${index ? `-${index}` : ""}.json`,
							);
							await fs.writeFile(diagnosticFile, context.redact(JSON.stringify(diagnostic, null, 2)));
							evidence.push({ uiDiagnostic: diagnosticFile, ...diagnostic });
						} catch (captureError) {
							evidence.push({
								diagnosticPage: index,
								uiDiagnosticUnavailable: context.redact(String(captureError)),
							});
						}
					}),
				);
			} catch (captureError) {
				evidence.push({ uiDiagnosticUnavailable: context.redact(String(captureError)) });
			}
		}
		const screenshot = path.join(context.evidenceDir, `${scenario.id}-${status}.png`);
		try {
			await withTimeout(context.browser.page.screenshot(screenshot), 5000, "Scenario evidence screenshot");
			evidence.push({ screenshot });
		} catch (cause) {
			evidence.push({ screenshotUnavailable: context.redact(String(cause)) });
		}
		const result = {
			id: scenario.id,
			status,
			startedAt: new Date(started).toISOString(),
			durationMs: Date.now() - started,
			evidence,
			...(error ? { error } : {}),
		};
		results.push(result);
		await fs.writeFile(
			path.join(context.evidenceDir, `${scenario.id}.json`),
			context.redact(JSON.stringify(result, null, 2)),
		);
	}
	return results;
}
