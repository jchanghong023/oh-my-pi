import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter, withTimeout } from "@oh-my-pi/pi-utils";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../packages/coding-agent/src/slash-commands/builtin-registry";
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
	"profile-agents",
	"file-git-refresh",
	"parallel-isolation",
	"commands-skills",
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
async function textWithin(page: DevelopmentPage, selector: string): Promise<string> {
	return page.evaluate<string>(
		`(function(){var root=document.querySelector(${JSON.stringify(selector)});if(!root)return '';function read(e){var text=e.innerText||e.textContent||'';var all=e.querySelectorAll('*');for(var i=0;i<all.length;i++)if(all[i].shadowRoot)text+='\\n'+read(all[i].shadowRoot);return text;}return read(root);})()`,
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
			!(await fs.stat(path.join(context.root, ".omp", "dev-workbench", "browser-mode")).then(
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
			id: "profile-agents",
			async run(evidence) {
				await click(page, tid("task-settings-button"));
				await click(page, tid("settings-section-nav-personalization"));
				const target = path.join(context.agentDir, "AGENTS.md");
				await observe(
					() => body(page),
					text => text.includes(target) || text.includes(target.replaceAll("\\", "/")),
					"actual effective profile AGENTS path",
				);
				const marker = `Acceptance profile instructions ${crypto.randomUUID()}`;
				await fill(page, tid("settings-personalization-editor"), marker);
				await click(page, tid("settings-personalization-save"));
				const persisted = await observe(
					() => fs.readFile(target, "utf8").catch(() => ""),
					value => value.includes(marker),
					"real profile AGENTS persistence",
				);
				const unsaved = `${marker}\nUnsaved profile draft`;
				await fill(page, tid("settings-personalization-editor"), unsaved);
				await click(page, tid("settings-back-button"));
				check(
					(await fs.readFile(target, "utf8")) === persisted,
					"Leaving settings persisted an unsubmitted profile draft",
				);
				await click(page, tid("task-settings-button"));
				await click(page, tid("settings-section-nav-personalization"));
				await observe(
					() =>
						page.evaluate<string>(
							`document.querySelector(${JSON.stringify(tid("settings-personalization-editor"))}).value`,
						),
					value => value === unsaved,
					"unsaved profile draft retained across navigation",
				);
				await click(page, tid("settings-personalization-cancel"));
				check(
					!(await fs.stat(path.join(context.projectA, "AGENTS.md")).then(
						() => true,
						() => false,
					)),
					"Profile save wrote project AGENTS instead",
				);
				evidence.push({ path: target, content: persisted, projectUntouched: true });
				await click(page, tid("settings-back-button"));
			},
		},
		{
			id: "file-git-refresh",
			async run(evidence) {
				const projectId = new URL(await page.evaluate<string>("location.href")).searchParams.get("project");
				await click(page, `[data-project-id=${JSON.stringify(projectId)}] ${tid("virtual-project-files")}`);
				await observe(
					() => textWithin(page, tid("workspace-file-tree-panel")),
					text => text.includes("native-development.txt"),
					"native tool write automatically appears in its file tree",
				);
				const gitPage = await context.browser.newPage();
				await gitPage.navigate(await page.evaluate<string>("location.href"));
				// Git is a retained side-pane review tab, not the removed header toggle.
				if (!(await visible(gitPage, tid("git-pane")))) {
					if (!(await visible(gitPage, "[data-side-pane-add-tab-trigger]")))
						await click(
							gitPage,
							`[data-project-id=${JSON.stringify(projectId)}] ${tid("virtual-project-files")}`,
						);
					await click(gitPage, "[data-side-pane-add-tab-trigger]");
					await click(gitPage, tid("side-pane-launcher-review"));
				}
				await observe(
					() => textWithin(gitPage, tid("git-pane")),
					text => text.includes("native-development.txt"),
					"native tool write appears in Git",
				);
				await selectedSession(page, a());
				const nativeFile = "native-live-refresh.txt";
				const nativeFirst = `native-first-${crypto.randomUUID()}`;
				const nativeSecond = `native-second-${crypto.randomUUID()}`;
				evidence.push(...(await development(context, page, a(), nativeFile, nativeFirst)));
				await observe(
					() => textWithin(page, tid("workspace-file-tree-panel")),
					text => text.includes(nativeFile),
					"native tool creation refreshes the already-open file tree",
				);
				await observe(
					() => textWithin(gitPage, tid("git-pane")),
					text => text.includes(nativeFile),
					"native tool creation refreshes the already-open Git view",
				);
				await click(
					page,
					`${tid("workspace-file-tree-panel")} [data-testid^="workspace-file-tree-row-"][title=${JSON.stringify(nativeFile)}]`,
				);
				await clickNamed(gitPage, tid("git-pane"), /native-live-refresh\.txt/);
				await observe(
					() => textWithin(page, tid("preview-pane")),
					text => text.includes(nativeFirst),
					"native-created file opens its actual preview",
				);
				await observe(
					() => textWithin(gitPage, tid("git-pane")),
					text => text.includes(nativeFirst),
					"native-created file opens its actual Git diff",
				);
				evidence.push(...(await development(context, page, a(), nativeFile, nativeSecond)));
				await observe(
					() => textWithin(page, tid("preview-pane")),
					text => text.includes(nativeSecond) && !text.includes(nativeFirst),
					"native tool modification refreshes the open preview without reload",
				);
				await observe(
					() => textWithin(gitPage, tid("git-pane")),
					text => text.includes(nativeSecond) && !text.includes(nativeFirst),
					"native tool modification refreshes the open Git diff without reload",
				);
				const external = path.join(context.projectA, "external-refresh.ts");
				await fs.writeFile(external, "export const externalMarker = 'external-first';\n");
				await observe(
					() => textWithin(page, tid("workspace-file-tree-panel")),
					text => text.includes("external-refresh.ts"),
					"external file create auto-refresh",
				);
				await observe(
					() => textWithin(gitPage, tid("git-pane")),
					text => text.includes("external-refresh.ts"),
					"already-open Git view auto-refreshes external creation",
				);
				await click(
					page,
					`${tid("workspace-file-tree-panel")} [data-testid^="workspace-file-tree-row-"][title="external-refresh.ts"]`,
				);
				await observe(
					() => textWithin(page, tid("preview-pane")),
					text => text.includes("external-first"),
					"real native file preview",
				);
				await clickNamed(gitPage, tid("git-pane"), /external-refresh\.ts/);
				await observe(
					() => textWithin(gitPage, tid("git-pane")),
					text => text.includes("external-first"),
					"real Git diff content",
				);
				await fs.writeFile(external, "export const externalMarker = 'external-second';\n");
				await observe(
					() => textWithin(page, tid("preview-pane")),
					text => text.includes("external-second") && !text.includes("external-first"),
					"external preview update without reload",
				);
				await observe(
					() => textWithin(gitPage, tid("git-pane")),
					text => text.includes("external-second") && !text.includes("external-first"),
					"already-open Git diff updates without reload",
				);
				await gitPage.screenshot(path.join(context.evidenceDir, "native-git-live-diff.png"));
				await fs.rm(external);
				await observe(
					() => textWithin(page, tid("preview-pane")),
					text => !text.includes("external-second") && /不存在|not found|ENOENT|已删除|missing/i.test(text),
					"deleted preview reports real missing state",
				);
				await observe(
					() => textWithin(gitPage, tid("git-pane")),
					text => !text.includes("external-refresh.ts"),
					"deleted untracked file leaves Git automatically",
				);
				evidence.push({
					cwd: context.projectA,
					createModifyDelete: external,
					nativeCreateModify: path.join(context.projectA, nativeFile),
					nativeContents: [nativeFirst, nativeSecond],
					manuallyRefreshed: false,
					gitWriteApiUsed: false,
					gitScreenshot: path.join(context.evidenceDir, "native-git-live-diff.png"),
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
			id: "commands-skills",
			async run(evidence) {
				await exerciseCommands(context, evidence);
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

interface CommandCase {
	input: string;
	result: RegExp;
	interaction?: "select" | "confirm" | "input" | "ask";
	file?: string;
	fileContent?: string;
	destructive?: boolean;
	/** Only an existing native capability/auth prerequisite, never missing WebGUI adaptation. */
	nativeRejection?: RegExp;
}
/** Explicit native semantics: no blanket command-name echo or generic success expectation. */
const COMMAND_CASES: Record<string, CommandCase> = {
	advisor: { input: "/advisor status", result: /advisor|顾问|disabled|off|未启用/i },
	export: { input: "/export command-export.html", result: /export|导出|html/i, file: "command-export.html" },
	trace: { input: "/trace", result: /trace|追踪|dashboard|http/i },
	dump: { input: "/dump", result: /transcript|request|json|对话|复制/i },
	share: {
		input: "/share",
		result: /https:\/\/|encrypted|分享成功|shared/i,
		nativeRejection:
			/GitHub.*(?:token|auth)|(?:token|credential|auth).*GitHub|share.*server.*(?:not configured|unavailable)/i,
		destructive: true,
	},
	collab: { input: "/collab status", result: /collab|协作|host|guest|not.*active/i },
	join: {
		input: "/join",
		result: /usage|用法|link|username|链接|用户名/i,
		nativeRejection: /Usage:.*join|join.*(?:link|username).*required/i,
	},
	leave: { input: "/leave", result: /collab|leave|not.*session|协作|离开|未加入/i },
	browser: { input: "/browser headless", result: /headless|无头/i },
	copy: { input: "/copy link", result: /Copied to browser clipboard/i },
	open: { input: "/open link", result: /open|http/i },
	mcp: { input: "/mcp list", result: /No MCP servers configured|MCP.*server|服务器/i },
	ssh: { input: "/ssh list", result: /ssh|hosts|主机|configured|没有/i },
	new: { input: "/new", result: /session|会话|新建/i, destructive: true },
	fresh: { input: "/fresh", result: /fresh|reset|重置|stream/i },
	clear: { input: "/clear", result: /clear|context|清空|上下文/i, destructive: true },
	delete: { input: "/delete", result: /delete|删除|session|会话/i, interaction: "confirm", destructive: true },
	compact: { input: "/compact", result: /compact|压缩|token|上下文/i },
	shake: { input: "/shake", result: /shake|elid|dropped|清理|移除|内容/i },
	handoff: {
		input: "/handoff Summarize this isolated acceptance session only.",
		result: /handoff|compact|交接|压缩/i,
	},
	resume: { input: "/resume", result: /session|会话|resume|继续/i, interaction: "select", destructive: true },
	pin: { input: "/pin", result: /pin|置顶|unpin/i },
	unpin: { input: "/unpin", result: /unpinned|not pinned|取消置顶/i },
	btw: { input: "/btw Reply exactly native-btw-answer.", result: /native-btw-answer/ },
	tan: {
		input: "/tan Use the native write tool to create command-tan.txt with exactly native-tan.",
		result: /tangential|native-tan|子代理/i,
		file: "command-tan.txt",
		fileContent: "native-tan",
		destructive: true,
	},
	omfg: {
		input: "/omfg Keep all acceptance file writes in the selected workspace.",
		result: /rule|TTSR|规则|保存/i,
		interaction: "confirm",
		destructive: true,
	},
	cleanse: {
		input: "/cleanse",
		result: /cleanse|diagnostic|detect|fix|诊断/i,
		interaction: "input",
		destructive: true,
	},
	retry: { input: "/retry", result: /nothing to retry|没有.*重试|no failed/i, nativeRejection: /Nothing to retry/i },
	debug: { input: "/debug", result: /debug|调试|diagnostic/i, interaction: "select" },
	memory: { input: "/memory stats", result: /memory|记忆|backend|条目|entries/i },
	rename: { input: "/rename Native acceptance command title", result: /Native acceptance command title/ },
	move: { input: "/move ../project-b", result: /Moved to .*project-b|移动.*project-b/i, destructive: true },
	wt: {
		input: "/wt acceptance-command-worktree",
		result: /worktree|acceptance-command-worktree|工作树/i,
		destructive: true,
	},
	"add-dir": { input: "/add-dir ../project-b", result: /project-b|Added|添加/i, destructive: true },
	"remove-dir": { input: "/remove-dir ../project-b", result: /project-b|Removed|移除/i, destructive: true },
	dirs: { input: "/dirs", result: /project-a|workspace|工作区/i },
	exit: { input: "/exit", result: /exit|退出|关闭/i, destructive: true },
	restart: { input: "/restart", result: /restart|重启|resum/i, destructive: true },
	todo: { input: "/todo append acceptance-native-command-task", result: /acceptance-native-command-task/ },
	session: { input: "/session info", result: /session|cwd|会话|目录/i },
	jobs: { input: "/jobs", result: /jobs|background|任务|作业|No /i },
	usage: { input: "/usage show", result: /usage|limit|用量|额度|provider/i },
	stats: { input: "/stats", result: /stats|dashboard|http|统计/i },
	changelog: { input: "/changelog last 1", result: /changelog|version|更新|变更|\d+\.\d+/i },
	hotkeys: { input: "/hotkeys", result: /shortcut|hotkey|ctrl|快捷|键/i },
	tools: { input: "/tools", result: /read|write|bash|工具/i },
	context: { input: "/context", result: /context|token|上下文/i },
	extensions: { input: "/extensions", result: /extension|扩展|dashboard/i },
	security: { input: "/security scans", result: /scan|扫描|No |没有/i },
	settings: { input: "/settings", result: /settings|设置/i, interaction: "select" },
	display: { input: "/display compact", result: /compact|紧凑/i },
	setup: { input: "/setup", result: /provider|提供商|认证|setup/i, interaction: "select" },
	plan: { input: "/plan", result: /plan|计划/i, destructive: true },
	"plan-review": {
		input: "/plan-review",
		result: /plan|review|计划|评审/i,
		nativeRejection: /Plan.*(?:not enabled|inactive)|No .*plan|plan.*not.*available/i,
		destructive: true,
	},
	vibe: { input: "/vibe", result: /vibe|worker|mode|模式/i, destructive: true },
	goal: { input: "/goal show", result: /goal|目标|未设置|No /i },
	"goal-autopilot": { input: "/goal-autopilot show", result: /goal|目标|未设置|No /i },
	"guided-goal": {
		input: "/guided-goal Build an acceptance marker in this isolated workspace.",
		result: /goal|目标|ask|问题/i,
		interaction: "ask",
		destructive: true,
	},
	loop: { input: "/loop", result: /loop|循环|repeat|重复/i, destructive: true },
	force: { input: "/force write", result: /write|force|工具|强制/i },
	live: {
		input: "/live",
		result: /live|voice|audio|语音|microphone/i,
		nativeRejection:
			/Codex.*(?:login|sign.in|auth|credential)|(?:login|sign.in|auth|credential).*Codex|OPENAI_API_KEY/i,
		destructive: true,
	},
	record: {
		input: "/record",
		result: /record|录制|screen/i,
		nativeRejection:
			/Native display capture is unavailable|does not support native MediaRecorder|no supported native WebM video encoder|Permission denied|NotAllowedError|Display capture request was canceled/i,
		destructive: true,
	},
	pause: { input: "/pause", result: /paus|resum|冻结|恢复|暂停/i, destructive: true },
	"forget-approvals": { input: "/forget-approvals", result: /forgotten|approval|授权|批准|清除/i },
	quit: { input: "/quit", result: /quit|exit|退出|关闭/i, destructive: true },
	crawl: {
		input: "/crawl {{url}} --no-scroll --max-pages 1 --wait 0 --output crawl-output",
		result: /saved|crawl-output|保存/i,
		nativeRejection:
			/omp browser relay is not reachable|its extension never connected|extension disconnected|relay extension is not connected/i,
		destructive: true,
	},
	marketplace: { input: "/marketplace list", result: /marketplace|source|市场|源|No /i },
	plugins: { input: "/plugins list", result: /plugin|插件|No /i },
	skills: { input: "/skills installed", result: /skill|技能|installed|No /i },
	sketch: { input: "/sketch", result: /sketch|canvas|绘图|画布|http/i, destructive: true },
	dev: { input: "/dev", result: /dev|workbench|工作台|独占|占用/i, destructive: true },
	webgui: { input: "/webgui", result: /webgui|退出|关闭/i, destructive: true },
	minimal: {
		input: "/minimal Use native write to create command-minimal.txt with exactly minimal-native.",
		result: /minimal-native/,
		file: "command-minimal.txt",
		fileContent: "minimal-native",
	},
	forkreviewer: {
		input: "/forkreviewer Review only the isolated acceptance repository, read-only, no changes.",
		result: /review|审查|差异|commit|提交/i,
	},
	"jch-workflowzbatch": {
		input: "/jch-workflowzbatch 1 1 Read acceptance input only; do not change files or run tests.",
		result: /workflow|工作流|任务/i,
	},
	jchime: {
		input: "/jchime Read-only: describe IBus availability; do not invoke OS commands or modify input methods.",
		result: /IBus|输入法|ibus/,
	},
	team: { input: "/team configure", result: /team|模型|slot|槽位/i, interaction: "select" },
	queue: {
		input: "/queue Use the native write tool to create command-queue.txt containing exactly native-command-queue.",
		result: /native-command-queue/,
		file: "command-queue.txt",
		fileContent: "native-command-queue",
	},
	model: { input: "/model opencode-go/beam-free", result: /Model set to opencode-go\/beam-free|beam-free/ },
	switch: { input: "/switch opencode-go/beam-free", result: /Session-only model:.*beam-free|beam-free/ },
	fast: { input: "/fast status", result: /fast|priority|tier|快速/i },
	slow: { input: "/slow status", result: /slow|flex|priority|慢速/i },
	skillful: { input: "/skillful status", result: /Skill listing|技能/i },
	"extended-context": { input: "/extended-context status", result: /Extended context|扩展上下文/i },
	computer: { input: "/computer status", result: /computer|计算机|off|on/i },
	ratchet: {
		input: "/ratchet Read-only acceptance task: evaluate a one-line greeting; do not launch optimizations without asking first.",
		result: /ratchet|flow|eval|评估|ask/i,
		interaction: "ask",
		destructive: true,
	},
	prewalk: { input: "/prewalk off", result: /Prewalk.*off|handoff|交接/i },
	modelpreset: { input: "/modelpreset list", result: /preset|预设|No /i },
	effort: { input: "/effort off", result: /effort|thinking|off|思考/i },
	"reload-plugins": { input: "/reload-plugins", result: /reload|plugin|重新加载|插件/i },
	agents: { input: "/agents", result: /agent|代理|model|模型/i, interaction: "select", destructive: true },
	knowledge: { input: "/knowledge", result: /knowledge|知识|index|索引/i, interaction: "select", destructive: true },
	git: { input: "/git", result: /git|diff|变更/i, interaction: "select", destructive: true },
	local: {
		input: "/local acceptance.txt",
		result: /local|acceptance|editor|编辑/i,
		interaction: "input",
		destructive: true,
	},
	hub: { input: "/hub", result: /agent|subagent|代理|No /i, interaction: "select", destructive: true },
	branch: { input: "/branch", result: /branch|rewind|分支|回退/i, interaction: "select", destructive: true },
	fork: { input: "/fork", result: /fork|分支|会话/i, destructive: true },
	tree: { input: "/tree", result: /tree|branch|会话|分支/i, interaction: "select", destructive: true },
	login: { input: "/login", result: /login|provider|sign.in|登录|提供商/i, interaction: "select", destructive: true },
	logout: {
		input: "/logout",
		result: /logout|provider|sign.out|登出|提供商|logged|登录/i,
		interaction: "select",
		destructive: true,
	},
	seance: {
		input: "/seance",
		result: /seance|saved|session|consult|会话|历史/i,
		interaction: "select",
		destructive: true,
	},
};
async function applyBrowserAction(
	context: DevelopmentContext,
	page: DevelopmentPage,
	evidence: Evidence[],
): Promise<string | undefined> {
	const selector = tid("v4-native-browser-action");
	if (!(await visible(page, selector))) return;
	const identity = await page.evaluate<{ action: string; interactionId: string }>(
		`(function(){var e=document.querySelector(${JSON.stringify(selector)});return {action:e.getAttribute('data-native-action'),interactionId:e.getAttribute('data-interaction-id')};})()`,
	);
	check(identity.interactionId, "Browser command gesture has no native interaction identity");
	if (!["recordStop", "liveStop"].includes(identity.action)) await click(page, tid("v4-native-browser-action-accept"));
	let result: { pending: boolean; error: string };
	try {
		result = await observe(
			async () => ({
				pending: await page.evaluate<boolean>(
					`(function(){var e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.getAttribute('data-interaction-id')===${JSON.stringify(identity.interactionId)};})()`,
				),
				error: await page.evaluate<string>(
					`(function(){var e=document.querySelector(${JSON.stringify(`${selector} [role="alert"]`)});return e?e.innerText:'';})()`,
				),
			}),
			value => !value.pending || Boolean(value.error),
			`native ${identity.action} browser action acknowledgement`,
			30_000,
		);
	} catch (error) {
		if (["recordStart", "liveOffer", "liveAnswer"].includes(identity.action))
			throw new PlatformPrerequisiteError(
				`native-${identity.action}-permission`,
				`Actual browser permission/source selection did not complete: ${context.redact(String(error))}; no fake media or permission bypass is allowed`,
			);
		throw error;
	}
	evidence.push({
		...identity,
		result: result.error ? "browser-native-error" : "accepted",
		...(result.error ? { error: context.redact(result.error) } : {}),
	});
	if (result.error && result.pending) {
		await click(page, tid("v4-native-browser-action-cancel"));
		await observe(
			() => visible(page, selector),
			value => !value,
			"native failed browser action cancellation",
		);
	}
	return result.error || undefined;
}
async function commandCase(context: DevelopmentContext, name: string, spec: CommandCase): Promise<Evidence> {
	const page = context.browser.page;
	const id = await newSession(context, page, context.projectA);
	if (
		[
			"branch",
			"fork",
			"tree",
			"compact",
			"handoff",
			"resume",
			"copy",
			"open",
			"dump",
			"export",
			"restart",
			"remove-dir",
			"move",
		].includes(name)
	)
		await development(
			context,
			page,
			id,
			"command-seed.txt",
			`native-command-seed-${crypto.randomUUID()}`,
			["copy", "open"].includes(name)
				? `Your final assistant answer must include this exact Markdown link: [acceptance project chooser](${context.url})`
				: "",
		);
	if (["copy", "open"].includes(name))
		check(
			(await transcript(context, id)).entries.some(
				entry => entry.message?.role === "assistant" && content(entry).includes(context.url),
			),
			`/${name} requires a real assistant link, not a command/user echo`,
		);
	if (name === "local") {
		await send(
			page,
			"Use the native write tool to create local://acceptance.txt containing exactly local-editor-seed. This is an authorized session-local artifact, not a project file.",
		);
		await observe(
			context.artifactFiles,
			values => values.some(file => path.basename(file) === "acceptance.txt"),
			"native session-local editor fixture",
			context.timeoutMs,
		);
		await waitIdle(context, page);
	}
	if (name === "remove-dir") {
		await send(page, "/add-dir ../project-b");
		await observe(
			async () => (await transcript(context, id)).header.additionalDirectories,
			value =>
				Array.isArray(value) &&
				value.some(directory => typeof directory === "string" && samePath(directory, context.projectB)),
			"native added directory before removal",
		);
	}
	const before = await context.transcripts();
	const baseline = new Set(before.flatMap(source => source.entries.map(entry => entry.id)));
	const config = path.join(context.agentDir, "config.yml");
	const configBefore = await fs.readFile(config, "utf8");
	const input = spec.input.replaceAll("{{url}}", context.url);
	const artifactsBefore = new Set(await context.artifactFiles());
	const browserActions: Evidence[] = [];
	let browserError = "";
	await send(page, input);
	if (name === "restart") {
		const restart = await context.waitForRestart();
		check(
			(await fs.readFile(config, "utf8")) === configBefore,
			"Native restart changed isolated model/profile configuration",
		);
		check(
			(await context.transcripts()).some(source => source.header.id === id),
			"Native restart lost existing history",
		);
		await page.navigate(restart.url);
		check((await publicProjects(context)).length === 0, "Restarted standalone CLI eagerly reopened projects/Agents");
		await openProject(context, page, context.projectA);
		await click(page, tid(`task-item-${id}`));
		await click(page, `${tid("v4-native-history-resume")} button`);
		await observe(
			() =>
				page.evaluate<string>(
					`(function(){var e=document.querySelector(${JSON.stringify(tid("v4-model-config"))});return e?e.getAttribute('data-model'):'';})()`,
				),
			value => value === context.model.id,
			"restarted native history resumes its actual Beam Free model",
		);
		return {
			name,
			input,
			sessionId: id,
			cwd: context.projectA,
			outcome: "native-process-restarted-and-history-resumed",
			...restart,
		};
	}
	let interactionId: string | undefined;
	let interactionText: string | undefined;
	let interactionCancelled = false;
	const readOutcome = async () => {
		browserError = (await applyBrowserAction(context, page, browserActions)) ?? browserError;
		if (!(await context.isListening()))
			return {
				closed: true,
				text: "",
				error: "",
				outputs: [] as NativeRecord[],
				busy: false,
				question: false,
				interactionCancelled,
				sessionIds: [] as string[],
				nativeMode: undefined as string | undefined,
			};
		if (spec.interaction && (await visible(page, QUESTION))) {
			interactionId = await page.evaluate<string>(
				`document.querySelector(${JSON.stringify(QUESTION)}).getAttribute('data-interaction-id')`,
			);
			interactionText = await page.evaluate<string>(`document.querySelector(${JSON.stringify(QUESTION)}).innerText`);
			check(
				interactionId && (spec.interaction === "ask" || spec.result.test(interactionText)),
				`/${name} did not render its actual native interaction`,
			);
			if (await visible(page, ASK)) await clickNamed(page, ASK, /^忽略$/);
			else await click(page, tid("v4-user-input-cancel"));
			await observe(
				() => visible(page, QUESTION),
				value => !value,
				`/${name} authoritative cancellation`,
			);
			check(
				(await fs.readFile(config, "utf8")) === configBefore,
				`/${name} cancellation mutated model/provider configuration`,
			);
			interactionCancelled = true;
		}
		const text = await body(page);
		const error =
			browserError ||
			(await page.evaluate<string>(
				`(function(){var e=document.querySelector(${JSON.stringify(tid("chat-error-banner"))});return e?e.innerText:'';})()`,
			));
		if (
			/not implemented|missing.*handler|WebGUI.*(?:not supported|unavailable)|(?:not supported|unavailable).*WebGUI|尚未适配|未接入/i.test(
				error,
			)
		)
			throw new Error(`/${name} WebGUI implementation gap: ${context.redact(error)}`);
		const sources = await context.transcripts();
		const outputs = sources
			.flatMap(source => source.entries)
			.filter(entry => !baseline.has(entry.id) && entry.message?.role !== "user");
		const nativeMode =
			name === "dev"
				? (await publicProjects(context)).find(project => samePath(project.root, context.projectA))?.mode
				: undefined;
		return {
			closed: false,
			text,
			error,
			outputs,
			busy: await visible(page, STOP),
			question: await visible(page, QUESTION),
			interactionCancelled,
			sessionIds: sources.map(source => String(source.header.id)),
			nativeMode,
		};
	};
	const outcome = await observe(
		readOutcome,
		result => {
			if (["quit", "webgui", "exit"].includes(name)) return result.closed;
			if (result.interactionCancelled) return true;
			if (spec.nativeRejection && spec.nativeRejection.test(result.error || JSON.stringify(result.outputs)))
				return true;
			if (result.error) throw new Error(`/${name} native command failed: ${context.redact(result.error)}`);
			if (name === "open")
				return browserActions.some(action => action.action === "openUrl" && action.result === "accepted");
			if (name === "dev")
				return (
					result.nativeMode === "dev" &&
					browserActions.some(action => action.action === "openUrl" && action.result === "accepted")
				);
			if (name === "new" || name === "fork")
				return result.sessionIds.some(session => !before.some(source => source.header.id === session));
			return (
				!result.closed &&
				!result.busy &&
				!result.question &&
				spec.result.test(JSON.stringify(result.outputs)) &&
				spec.result.test(result.text)
			);
		},
		`/${name} native result, not command echo`,
		context.timeoutMs,
	);
	if (outcome.interactionCancelled)
		return {
			name,
			input,
			sessionId: id,
			cwd: context.projectA,
			interactionId,
			interactionText: context.redact(interactionText ?? ""),
			outcome: "native-interaction-cancelled",
			configUnchanged: true,
		};
	if (name === "open") {
		const opened = await observe(
			async () => {
				for (const candidate of await context.browser.pages())
					if (candidate !== page && (await candidate.evaluate<string>("location.href")) === context.url)
						return candidate;
				return undefined;
			},
			value => value !== undefined,
			"actual native /open public target page",
		);
		check(opened, "Native /open did not open its requested real browser page");
		await observe(
			async () =>
				(await visible(opened, tid("directory-browser-path"))) ||
				(await visible(opened, tid("virtual-project-add"))),
			Boolean,
			"native /open target renders the real standalone project chooser",
		);
		return {
			name,
			input,
			sessionId: id,
			cwd: context.projectA,
			outcome: "native-browser-link-opened",
			url: context.url,
			browserActions,
		};
	}
	if (name === "dev") {
		const workbench = await observe(
			async () => {
				for (const candidate of await context.browser.pages()) {
					const url = new URL(await candidate.evaluate<string>("location.href"));
					if (
						url.origin === new URL(context.url).origin &&
						url.pathname !== "/" &&
						!url.pathname.startsWith("/sketch/")
					)
						return { page: candidate, url: url.href };
				}
				return undefined;
			},
			value => value !== undefined,
			"actual native Dev workbench capability page",
		);
		check(workbench, "Dev handoff did not open its real native page");
		await observe(
			() => body(workbench.page),
			text => text.trim().length > 20,
			"native Dev workbench rendered",
		);
		const screenshot = path.join(context.evidenceDir, "native-dev-handoff.png");
		await workbench.page.screenshot(screenshot);
		return {
			name,
			input,
			sessionId: id,
			cwd: context.projectA,
			outcome: "native-mode-transferred",
			mode: outcome.nativeMode,
			workbenchUrl: workbench.url,
			screenshot,
			browserActions,
		};
	}
	if (name === "sketch" && !outcome.error) {
		const canvas = await observe(
			async () => {
				for (const candidate of await context.browser.pages()) {
					const url = await candidate.evaluate<string>("location.href");
					if (
						new URL(url).origin === new URL(context.url).origin &&
						/\/sketch\/[^/]+\/$/.test(new URL(url).pathname)
					)
						return candidate;
				}
				return undefined;
			},
			value => value !== undefined,
			"real native sketch popup",
		);
		check(canvas, "Native sketch did not open its real capability page");
		await canvas.draw("#canvas", [
			{ x: 40, y: 40 },
			{ x: 160, y: 80 },
			{ x: 220, y: 160 },
		]);
		await canvas.screenshot(path.join(context.evidenceDir, "native-sketch-drawing.png"));
		await click(canvas, "#sendButton");
		await observe(() => visible(page, tid("v4-native-browser-action")), Boolean, "native PNG attachment transfer");
		await applyBrowserAction(context, page, browserActions);
		const png = await observe(
			context.artifactFiles,
			values => values.some(file => !artifactsBefore.has(file) && /sketch-.*\.png$/i.test(file)),
			"native sketch PNG artifact",
		);
		const file = png.find(value => !artifactsBefore.has(value) && /sketch-.*\.png$/i.test(value))!;
		const bytes = await fs.readFile(file);
		check(bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "Sketch artifact is not real PNG bytes");
		browserActions.push({
			png: file,
			bytes: bytes.length,
			sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
		});
		await observe(
			() => page.evaluate<number>("document.querySelectorAll('[data-testid^=\"v4-attachment-\"]').length"),
			count => count > 0,
			"real native sketch attached to originating draft",
		);
	}
	if (name === "record" && !outcome.error) {
		await Bun.sleep(1200);
		await send(page, "/record");
		await observe(
			async () => {
				await applyBrowserAction(context, page, browserActions);
				return (await context.artifactFiles()).filter(file => !artifactsBefore.has(file) && /\.webm$/i.test(file));
			},
			values => values.length > 0,
			"stopped native recording downloaded real WebM",
			context.timeoutMs,
		);
		const files = (await context.artifactFiles()).filter(file => !artifactsBefore.has(file) && /\.webm$/i.test(file));
		for (const file of files) {
			const bytes = await fs.readFile(file);
			check(
				bytes.length > 512 && bytes.subarray(0, 4).toString("hex") === "1a45dfa3",
				"Browser recording is not a real nonempty WebM video",
			);
			browserActions.push({
				recording: file,
				bytes: bytes.length,
				sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			});
		}
	}
	if (spec.file) {
		const file = path.join(context.projectA, spec.file);
		const bytes = await observe(
			() => fs.readFile(file).catch(() => Buffer.alloc(0)),
			value => value.length > 0,
			`/${name} actual file result`,
			context.timeoutMs,
		);
		if (spec.fileContent)
			check(bytes.toString("utf8").trim() === spec.fileContent, `/${name} wrote incorrect native result bytes`);
		if (name === "export")
			check(/<html/i.test(bytes.toString("utf8")), "/export did not produce actual session HTML");
	}
	if (name === "new")
		check(
			(await context.transcripts()).some(
				source => !before.some(previous => previous.header.id === source.header.id),
			),
			"/new did not create a distinct native session",
		);
	if (name === "move")
		check(
			(await transcript(context, id)).header.cwd &&
				samePath(String((await transcript(context, id)).header.cwd), context.projectB),
			"/move did not persist the target native cwd",
		);
	const screenshot = path.join(context.evidenceDir, `command-${name.replace(/[^a-z0-9-]/gi, "-")}.png`);
	if (!outcome.closed) await page.screenshot(screenshot);
	return {
		name,
		input,
		sessionId: id,
		cwd: context.projectA,
		expectedNativeResult: spec.result.source,
		outcome: spec.nativeRejection?.test(outcome.error || JSON.stringify(outcome.outputs))
			? "native-capability-prerequisite-rejected"
			: "native-command-completed",
		actualResult: context.redact(JSON.stringify(outcome.outputs)),
		actualError: context.redact(outcome.error),
		browserActions,
		screenshot: outcome.closed ? undefined : screenshot,
		nativeFile: spec.file && path.join(context.projectA, spec.file),
	};
}
async function observedCommand(context: DevelopmentContext, name: string, spec: CommandCase): Promise<Evidence> {
	let error: string | undefined;
	try {
		const result = await commandCase(context, name, spec);
		const unexpected = (await context.transcripts())
			.flatMap(source => source.entries)
			.filter(
				entry =>
					entry.message?.role === "assistant" &&
					(entry.message.provider !== context.model.provider || entry.message.model !== context.model.id),
			);
		check(unexpected.length === 0, `/${name} invoked a model other than authorized OpenCode Go Beam Free`);
		return result;
	} catch (cause) {
		error = context.redact(String(cause));
		throw cause;
	} finally {
		const stem = `command-${name.replace(/[^a-z0-9-]/gi, "-")}`;
		const diagnostic: Evidence = { name, input: spec.input, ...(error ? { error } : {}) };
		try {
			const ui = await uiDiagnostic(context.browser.page);
			diagnostic.ui = ui;
			diagnostic.url = ui.url;
			diagnostic.visibleResult = context.redact(String(ui.visibleBody ?? ""));
			const screenshot = path.join(context.evidenceDir, `${stem}.png`);
			await withTimeout(context.browser.page.screenshot(screenshot), 5000, "Command diagnostic screenshot");
			diagnostic.screenshot = screenshot;
		} catch (cause) {
			diagnostic.pageUnavailable = context.redact(String(cause));
		}
		diagnostic.nativeSessions = (await context.transcripts()).map(value => ({
			id: value.header.id,
			cwd: value.header.cwd,
			transcript: value.file,
		}));
		await fs.writeFile(
			path.join(context.evidenceDir, `${stem}.json`),
			context.redact(JSON.stringify(diagnostic, null, 2)),
		);
	}
}
async function skillBinding(context: DevelopmentContext, source: NativeTranscript, name: string): Promise<Evidence> {
	const entry = source.entries.find(value => {
		const details = value.details as { name?: string } | undefined;
		return value.type === "custom_message" && value.customType === "skill-prompt" && details?.name === name;
	});
	check(entry, `/skill:${name} has no native policy-checked Skill prompt expansion`);
	const details = entry.details as { name: string; path: string; lineCount: number; prompt?: string };
	check(
		typeof details.path === "string" && details.path.length > 0,
		"Native Skill expansion lost its real source path",
	);
	const blocks = entry.content;
	const expanded =
		typeof blocks === "string"
			? blocks
			: Array.isArray(blocks)
				? blocks
						.filter(part => part?.type === "text")
						.map(part => part.text)
						.join("")
				: "";
	// The native invocation has already authorized this body. Compare its actual
	// source bytes only now; never read a denied catalogue entry around policy.
	const sourceText = await fs.readFile(details.path, "utf8");
	const actualBody = parseFrontmatter(sourceText, { source: details.path, repair: false, level: "off" }).body.trim();
	check(actualBody.length > 0 && expanded.includes(actualBody), `Native Skill ${name} did not expose its actual body`);
	check(
		details.lineCount === actualBody.split("\n").length && details.prompt?.startsWith(`/skill:${name}`),
		`Native Skill ${name} lost canonical invocation/body provenance`,
	);
	const file = path.join(context.evidenceDir, `skill-binding-${encodeURIComponent(name)}.json`);
	await fs.writeFile(
		file,
		context.redact(
			JSON.stringify(
				{
					name,
					canonical: `/skill:${name}`,
					sessionId: source.header.id,
					entryId: entry.id,
					details,
					actualBody,
					expanded,
				},
				null,
				2,
			),
		),
	);
	return {
		name,
		canonical: `/skill:${name}`,
		nativeEntryId: entry.id,
		sourcePath: details.path,
		bodyBytes: Buffer.byteLength(actualBody),
		bodySha256: new Bun.CryptoHasher("sha256").update(actualBody).digest("hex"),
		nativeBodyAccess: "authorized-by-real-invocation",
		bindingEvidence: file,
	};
}
interface CatalogueItem {
	id: string;
	section: string;
	text: string;
	selected: boolean;
}
async function nativeCatalogue(page: DevelopmentPage): Promise<CatalogueItem[]> {
	await fill(page, INPUT, "/");
	const selector = tid("prompt-suggestion-panel");
	await observe(() => visible(page, selector), Boolean, "actual native command/Skill suggestions");
	await observe(
		() =>
			page.evaluate<number>(
				`document.querySelectorAll(${JSON.stringify(`${selector} [data-status="loading"]`)}).length`,
			),
		value => value === 0,
		"effective native catalogue discovery",
	);
	const read = () =>
		page.evaluate<CatalogueItem[]>(
			`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${selector} [data-option-id]`)}),function(e){return {id:e.getAttribute('data-option-id'),section:e.getAttribute('data-section-id'),text:e.innerText,selected:e.getAttribute('data-selected')==='true'};})`,
		);
	let items = await observe(read, value => value.some(item => item.selected), "native selected suggestion");
	const seen = new Set<string>();
	const catalogue = new Map<string, CatalogueItem>();
	for (;;) {
		for (const item of items) catalogue.set(item.id, item);
		const selected = items.find(item => item.selected);
		check(selected, "Native suggestion selection disappeared during keyboard navigation");
		if (seen.has(selected.id)) break;
		seen.add(selected.id);
		await page.press(INPUT, "ArrowDown");
		await Bun.sleep(40); // Let the actual virtualized menu render its newly selected row.
		items = await read();
	}
	await page.clearDraft();
	return [...catalogue.values()];
}
export async function exerciseCommands(context: DevelopmentContext, evidence: Evidence[] = []): Promise<Evidence[]> {
	const failures: string[] = [];
	const page = context.browser.page;
	const skillFile = path.join(context.projectA, ".omp", "skills", "acceptance-local", "SKILL.md");
	const skillSource = await fs.readFile(skillFile, "utf8");
	const skillMarker = skillSource.match(/native-effective-skill-[a-f0-9-]+/)?.[0];
	check(skillMarker, "Isolated native Skill fixture is missing its actual task marker");
	await newSession(context, page, context.projectA);
	const catalogue = await nativeCatalogue(page);
	evidence.push({ nativeEffectiveCatalogue: catalogue });
	const missing = BUILTIN_SLASH_COMMAND_DEFS.filter(
		command =>
			!catalogue.some(
				item => item.id === `slash:${command.name}` || item.text.split(/\s/, 1)[0] === `/${command.name}`,
			),
	);
	if (missing.length) {
		const error = `Native GUI omitted TUI builtin commands: ${missing.map(command => command.name).join(", ")}`;
		failures.push(error);
		evidence.push({ status: "failed", nativeBuiltinCatalogueError: error });
	}
	const skillNames = [
		...new Set(
			catalogue
				.filter(item => item.section === "skills")
				.map(item => item.text.trim().match(/^\/skill:([^\s]+)/)?.[1])
				.filter((value): value is string => Boolean(value)),
		),
	];
	for (const item of catalogue.filter(value => value.section === "skills")) {
		const name = item.text.trim().match(/^\/skill:([^\s]+)/)?.[1];
		if (!name || item.id !== `slash:skill:${name}`) {
			const error = `Effective Skill has no canonical native binding: ${JSON.stringify(item)}`;
			failures.push(error);
			evidence.push({ status: "failed", nativeSkillBindingError: error });
		}
	}
	if (!skillNames.includes("acceptance-local")) {
		const error = `Controlled project Skill is absent from the native Skills section: ${JSON.stringify(skillNames)}`;
		failures.push(error);
		evidence.push({ status: "failed", nativeSkillCatalogueError: error });
	}
	evidence.push({ effectiveNativeSkills: skillNames, controlledSkillFixture: skillFile });
	for (const command of BUILTIN_SLASH_COMMAND_DEFS) {
		const promptKeyword = command.description.startsWith("Send the ");
		const spec =
			COMMAND_CASES[command.name] ??
			(promptKeyword
				? {
						input: `/${command.name} Reply exactly native-keyword-${command.name}; do not change files.`,
						result: new RegExp(`native-keyword-${command.name}`),
					}
				: undefined);
		if (!spec) {
			failures.push(`${command.name}: no reviewed semantic case`);
			evidence.push({
				name: command.name,
				status: "unverified",
				prerequisite: "reviewed-command-semantics",
				description: command.description,
			});
			continue;
		}
		try {
			const result = spec.destructive
				? await context.isolated(`command-${command.name}`, isolated =>
						observedCommand(isolated, command.name, spec),
					)
				: await observedCommand(context, command.name, spec);
			evidence.push({ ...result, status: "passed" });
		} catch (error) {
			const status = error instanceof PlatformPrerequisiteError ? "blocked" : "failed";
			failures.push(`${command.name}: ${status}: ${context.redact(String(error))}`);
			evidence.push({ name: command.name, status, input: spec.input, error: context.redact(String(error)) });
		}
	}
	// The controlled fixture proves positive native execution. Other effective
	// Skills receive only read-only prerequisite analysis, never an unrelated
	// archive/worktree/release workflow or the fixture's expected output.
	for (const skill of new Set(["acceptance-local", ...skillNames])) {
		try {
			const controlled = skill === "acceptance-local";
			const result = await observedCommand(
				context,
				`skill-${skill}`,
				controlled
					? {
							input: `/skill:${skill}`,
							result: /skill-result\.txt/,
							file: "skill-result.txt",
							fileContent: skillMarker,
						}
					: {
							input: `/skill:${skill} For this acceptance request, perform only a read-only prerequisite analysis of this Skill's supplied instructions. State the target inputs and prerequisites its workflow requires, and what is missing here. Do not execute its workflow, invoke tools, run commands, create/edit/delete files, install anything, or access personal data. If target input is missing, explain that requirement and stop; do not invent a target.`,
							result: /prerequisite|target|input|前提|条件|输入|目标|需要|缺少/i,
							interaction: "ask",
						},
			);
			const source = await transcript(context, String(result.sessionId));
			const binding = await skillBinding(context, source, skill);
			if (controlled)
				check(
					samePath(String(binding.sourcePath), skillFile) &&
						content(source.entries.find(entry => entry.id === binding.nativeEntryId)!).includes(skillMarker),
					"Controlled Skill expansion differs from its isolated project source and literal marker",
				);
			else
				check(
					!source.entries.some(
						entry => entry.message?.role === "assistant" && content(entry).includes('"toolCall"'),
					),
					`Read-only prerequisite analysis unexpectedly executed tools for Skill ${skill}`,
				);
			evidence.push({
				...result,
				status: "passed",
				effectiveSkill: binding,
				workflowExecuted: controlled,
				coverage: controlled
					? "native-expansion-and-real-tool-file"
					: "native-binding-body-access-and-read-only-prerequisites",
				...(controlled
					? { nativeToolEvidence: await toolEvidence(context, String(result.sessionId), "skill-result.txt") }
					: {}),
			});
		} catch (error) {
			failures.push(`skill ${skill}: ${context.redact(String(error))}`);
			evidence.push({ skill, status: "failed", error: context.redact(String(error)) });
		}
	}
	await newSession(context, page, context.projectA);
	const assistantCount = (await context.transcripts())
		.flatMap(source => source.entries)
		.filter(entry => entry.message?.role === "assistant").length;
	await send(page, "/omp-unknown-acceptance-command");
	await observe(
		() => body(page),
		text => /unknown.*command|未知.*命令|command.*not.found/i.test(text),
		"unknown slash command is rejected instead of becoming model chat",
	);
	check(
		(await context.transcripts())
			.flatMap(source => source.entries)
			.filter(entry => entry.message?.role === "assistant").length === assistantCount,
		"Unknown command was forwarded to a model",
	);
	await send(page, "/model omp-acceptance-invalid-model");
	await observe(
		() => body(page),
		text => /Unknown model.*omp-acceptance-invalid-model|未知.*模型/i.test(text),
		"invalid builtin argument follows native parser rejection",
	);
	check(
		(await context.transcripts())
			.flatMap(source => source.entries)
			.filter(entry => entry.message?.role === "assistant").length === assistantCount,
		"Invalid model argument invoked inference",
	);
	evidence.push({
		catalogue: BUILTIN_SLASH_COMMAND_DEFS.map(command => ({
			name: command.name,
			aliases: command.aliases,
			description: command.description,
		})),
		unknownCommandRejected: true,
		effectiveSkill: skillFile,
	});
	if (failures.length) throw new Error(`Native command/Skill acceptance incomplete:\n${failures.join("\n")}`);
	return evidence;
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
			if (scenario.id === "file-git-refresh") await context.captureResources?.();
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
