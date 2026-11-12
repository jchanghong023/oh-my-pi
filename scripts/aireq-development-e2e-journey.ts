import * as fs from "node:fs/promises";
import * as path from "node:path";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import type { AIReqNativeSurfaceSnapshot } from "../packages/coding-agent/src/aireq-workbench/native/native-surface-types";
import type { SessionEntry } from "../packages/coding-agent/src/session/session-entries";
import type {
	AIReqFileVersion,
	AIReqRequirementGroup,
	AIReqSystemRequirement,
	AIReqWorkflowStage,
	AIReqWorkflowView,
} from "../packages/coding-agent/src/aireq-workbench/workflow-types";
import { decodeRequirementPackage } from "../packages/coding-agent/src/aireq-workbench/requirement-package";
import { pollWorkflow, workflowGit } from "../packages/coding-agent/test/aireq-workbench/workflow-fixture";
import type { DevelopmentBrowser, DevelopmentPage } from "./webgui-platform-smoke";

export const DEV_REAL_BUSINESS = `Inspect the actual existing Python machine_info.py application and tests. Add one bounded useful feature: standard-library --help usage with clear explanations of the reported machine fields. Preserve byte-for-byte no-argument output behavior and unknown-argument refusal, including the existing explicit rejection of --json. Help must exit successfully without probing the machine or changing files; include the actual command syntax and field meanings. Do not introduce argparse exits that alter unknown-argument behavior. Exactly one complete SR is appropriate. No dependencies, network calls or unrelated features. Write complete IR/SR scope, rules, edge cases and executable acceptance criteria. Distinguish confirmed facts from technical unknowns; stop interviewing and retain unknowns for solution inspection. This message does not approve requirements, review or any phase. Later execution must author real Python changes and tests, run separate real UT and CLI/subprocess ST, and preserve exact commands, actual output, failed attempts and exit codes in distinct reports. Never fabricate passing results.`;
export const DEV_VERSION_BUSINESS = `Inspect the actual existing Python machine_info.py application and tests. Add a bounded standard-library --version option with a stable documented application version string and exit code zero. Preserve the existing --help feature if present, byte-for-byte no-argument behavior and unknown-argument refusal, including --json rejection. --version must not probe the machine or change files. One complete IR with exactly one SR. No dependencies, network, telemetry or unrelated changes. Write all rules and executable acceptance criteria. Stop interviewing; retain technical unknowns without guessing. No confirmation/review/phase approval is implied. During execution write actual code and tests and run separate real UT and CLI/subprocess ST, recording actual commands, output, errors, attempts and exit codes in distinct reports.`;

export interface AIReqJourneyEvidence {
	id: string;
	status: "passed" | "failed" | "blocked";
	startedAt: string;
	completedAt: string;
	facts?: unknown;
	error?: string;
}
export interface AIReqMergeFile extends AIReqFileVersion {
	/** Git tree mode, including 000000 for a deleted path. */
	gitMode: string;
}
export interface AIReqMergeRequest {
	kind: "requirements" | "code";
	projectId: string;
	irId: string;
	srId?: string;
	root: string;
	worktree: string;
	sourceBranch: string;
	targetBranch: string;
	files: AIReqMergeFile[];
}
export interface AIReqManualMergeReceipt {
	kind: "requirements" | "code";
	irId: string;
	srId?: string;
	commit: string;
	targetBranch: string;
	/** A local Git test merge is never evidence of a platform review/approval. */
	platformVerified: false;
	mode: "controlled-test-scope" | "externally-manually-merged";
	prUrl: string;
}
export interface AIReqJourneyContext {
	browser: DevelopmentBrowser;
	url: string;
	root: string;
	businessProject: string;
	secondaryProject: string;
	evidenceDir: string;
	downloadDirectory: string;
	business?: string;
	timeoutMs: number;
	redact(text: string): string;
	view(projectId?: string, irId?: string, srId?: string): Promise<AIReqWorkflowView>;
	material(
		projectId: string,
		irId: string,
		file: string,
		srId?: string,
	): Promise<{ content?: string; error?: string }>;
	/** A human declaration (or disclosed controlled-test URL), never a merge/platform receipt. */
	codePrUrl(request: AIReqMergeRequest): Promise<string>;
	/** Authenticated existing API negative probe, used only because completed SRs expose no Back control. */
	completedBack(request: {
		projectId: string;
		irId: string;
		srId: string;
		expectedRevision: number;
	}): Promise<{ httpStatus: number; status?: string; error?: string }>;
	/** Only explicit authorized external orchestration may make the actual Git merge. */
	manualMerge(request: AIReqMergeRequest): Promise<AIReqManualMergeReceipt>;
	record(item: AIReqJourneyEvidence): Promise<void>;
}

export const DEV_JOURNEY_STEPS = [
	"production-native-ui",
	"browser-favicon-resource",
	"release-organization",
	"local-intake",
	"source-project-registration",
	"browser-intake",
	"real-requirements",
	"fixed-snapshot-review",
	"review-invalidation",
	"zip-handoff",
	"zip-import",
	"requirements-pr-registration",
	"requirements-exact-merge",
	"group-freeze",
	"sr-solution",
	"project-single-sr",
	"solution-approval",
	"planning-approval",
	"execution-real-ut-st",
	"material-menu-readonly-download",
	"material-discuss-unsent-native-draft",
	"native-file-git-readonly",
	"history-not-transition",
	"code-preserving-back",
	"invalidated-material-history",
	"detach-reconnect",
	"delivery-pr",
	"code-pr-registration",
	"pr-repair-back",
	"pr-repair-real-ut-st",
	"pr-repair-reapproval",
	"code-pr-resubmission",
	"code-exact-merge",
	"completed-back-refusal",
	"project-isolation",
	"native-settings-skills",
	"stop-settlement",
] as const;

const PUBLIC_SELECTORS: Record<string, string> = {
	workbench: "aireq-workflow-root",
	project: "project-select",
	import: "import-package",
	"confirm-requirements": "requirement-confirm",
	"download-package": "requirement-download",
	"requirements-merged": "requirements-pr-merged",
	"approve-stage": "stage-approve",
	"code-merged": "code-pr-merged",
	"register-project": "project-register",
	"settings-close": "settings-back-button",
	"native-settings": "settings",
	"native-settings-panel": "aireq-project-settings",
	"native-settings-close": "settings-back-button",
};
const selector = (value: string) => `[data-testid="${PUBLIC_SELECTORS[value] ?? value}"]`;
const quoted = (value: string) => JSON.stringify(value);
function demand(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
export function assertRealMaterial(text: string, label: string, terms: RegExp[] = [], minimum = 160): void {
	demand(text.trim().length >= minimum, `${label}: substantive model-authored content is missing`);
	demand(
		!/\b(?:lorem ipsum|TODO:\s*implement|mock production|placeholder implementation|tests? (?:were |are )?not (?:actually )?run)\b/iu.test(
			text,
		),
		`${label}: placeholder or unexecuted deliverable`,
	);
	for (const term of terms) demand(term.test(text), `${label}: missing semantic evidence ${term}`);
}
function assertExactVersions(
	actual: readonly AIReqFileVersion[],
	expected: readonly AIReqFileVersion[],
	label: string,
): void {
	demand(
		actual.length === expected.length &&
			new Set(actual.map(file => file.path)).size === actual.length &&
			expected.every(file =>
				actual.some(item => item.path === file.path && item.sha256 === file.sha256 && item.size === file.size),
			),
		`${label}: exact file/deletion manifest differs`,
	);
}
/** Read committed native Git members/blobs, never checkout bytes or newline-delimited path guesses. */
export async function committedManifest(
	root: string,
	commit: string,
	paths: readonly string[],
): Promise<AIReqMergeFile[]> {
	demand(paths.length > 0 && new Set(paths).size === paths.length, "Committed manifest requires unique paths");
	const repo = requireGit(root);
	const members = new Set(await repo.lsTree(commit, [...paths]));
	const modes = new Map(
		(await workflowGit(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", commit, "--", ...paths]))
			.split("\0")
			.filter(Boolean)
			.map(record => {
				const tab = record.indexOf("\t");
				demand(tab >= 0, "Malformed committed Git tree record");
				return [record.slice(tab + 1), record.slice(0, 6)] as const;
			}),
	);
	return Promise.all(
		paths.map(async file => {
			if (!members.has(file))
				return {
					path: file,
					sha256: new Bun.CryptoHasher("sha256").update("").digest("hex"),
					size: -1,
					gitMode: "000000",
				};
			const blob = await repo.showBlob(`${commit}:${file}`);
			demand(!blob.truncated, `Committed blob was truncated: ${file}`);
			const gitMode = modes.get(file);
			demand(gitMode, `Native Git member lacks a tree mode: ${file}`);
			return {
				path: file,
				sha256: new Bun.CryptoHasher("sha256").update(blob.data).digest("hex"),
				size: blob.data.length,
				gitMode,
			};
		}),
	);
}
export async function assertMergeManifest(root: string, commit: string, request: AIReqMergeRequest): Promise<void> {
	const actual = await committedManifest(
		root,
		commit,
		request.files.map(file => file.path),
	);
	assertExactVersions(actual, request.files, `${request.kind} committed authority`);
	demand(
		actual.every(file =>
			request.files.some(expected => expected.path === file.path && expected.gitMode === file.gitMode),
		),
		`${request.kind}: committed Git modes differ`,
	);
	if (request.kind === "requirements") {
		const prefix = `docs/aireq/requirements/${request.irId}/`;
		const expected = request.files
			.filter(file => file.path.startsWith(prefix) && file.size >= 0)
			.map(file => file.path)
			.sort();
		const members = (await requireGit(root).lsTree(commit, [prefix.slice(0, -1)])).sort();
		demand(
			JSON.stringify(members) === JSON.stringify(expected),
			"Native Git IR/SR member set differs from confirmed authority",
		);
	}
}
export async function domObservation(
	page: DevelopmentPage,
): Promise<{ text: string; title: string; errors: string[] }> {
	return page.evaluate(
		`({text:document.body.innerText,title:document.title,errors:Array.from(document.querySelectorAll('[role="alert"],[data-dev="error"]')).map(e=>e.innerText)})`,
	);
}
async function present(page: DevelopmentPage, value: string): Promise<boolean> {
	return page.evaluate(`Boolean(document.querySelector(${quoted(value)}))`);
}
async function waitVisible(context: AIReqJourneyContext, value: string): Promise<void> {
	await pollWorkflow(
		async () =>
			context.browser.page.evaluate<boolean>(
				`(()=>{const e=document.querySelector(${quoted(value)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled})()`,
			),
		Boolean,
		`Visible enabled ${value}`,
		context.timeoutMs,
	);
}
async function click(context: AIReqJourneyContext, action: string): Promise<void> {
	let publication: { projectId: string; irId: string; srId?: string; operations: Set<string> } | undefined;
	if (action.startsWith("publish-") || action.startsWith("push-")) {
		const summary = `details:has(${selector(action)}) > summary`;
		const open = await context.browser.page.evaluate<boolean>(
			`Boolean(document.querySelector(${quoted(summary)})?.parentElement.open)`,
		);
		if (!open) await context.browser.page.click(summary);
		if (action.endsWith("-development")) {
			await waitVisible(context, '[data-testid="publish-file"][data-path="machine_info.py"]');
			const boxes = await context.browser.page.evaluate<Array<{ path: string; checked: boolean }>>(
				`Array.from(document.querySelectorAll('[data-testid="publish-file"]')).map(e=>({path:e.getAttribute('data-path'),checked:e.checked}))`,
			);
			const allowed = boxes.filter(item =>
				/^(?:machine_info\.py|(?:tests?\/.*|test_[^/]+)\.py|docs\/dev\/development\/[^/]+\/[^/]+\.md|README\.md)$/u.test(
					item.path,
				),
			);
			demand(
				allowed.some(item => item.path === "machine_info.py") &&
					allowed.some(item => /test.*\.py$/u.test(item.path)),
				"Explicit publication lacks the actual application and regression tests",
			);
			for (const item of allowed)
				if (!item.checked)
					await context.browser.page.click(`[data-testid="publish-file"][data-path=${quoted(item.path)}]`);
		}
		const binding = await context.browser.page.evaluate<{ projectId: string; irId: string; srId?: string }>(
			`(()=>{const header=document.querySelector('header[data-ir-id]');return {projectId:document.querySelector(${quoted(selector("project"))}).value,irId:header.getAttribute('data-ir-id'),srId:header.getAttribute('data-sr-id')||undefined}})()`,
		);
		publication = {
			...binding,
			operations: new Set(
				(await context.view(binding.projectId)).operations.map(operation => operation.operationId),
			),
		};
	}
	await waitVisible(context, selector(action));
	await context.browser.page.click(selector(action));
	if (publication) {
		const binding = publication;
		await pollWorkflow(
			async () => {
				const view = await context.view(binding.projectId);
				const receipt = view.operations.find(
					operation =>
						!binding.operations.has(operation.operationId) &&
						operation.type === "publishMaterials" &&
						operation.irId === binding.irId &&
						operation.srId === binding.srId,
				);
				if (receipt?.status === "failed")
					throw new Error(
						`Actual publication failed: ${receipt.error}; checkpoints=${JSON.stringify(receipt.steps)}`,
					);
				return receipt;
			},
			receipt => receipt?.status === "completed",
			"Actual scoped commit/push receipt",
			context.timeoutMs,
		);
	}
}
async function fill(context: AIReqJourneyContext, action: string, value: string): Promise<void> {
	await waitVisible(context, selector(action));
	await context.browser.page.clear(selector(action));
	await context.browser.page.type(selector(action), value);
}
async function send(context: AIReqJourneyContext, text: string): Promise<void> {
	const binding = await context.browser.page.evaluate<{ projectId: string; irId: string; srId?: string }>(
		`(()=>{const h=document.querySelector('header[data-ir-id]');return {projectId:document.querySelector(${quoted(selector("project"))}).value,irId:h?.getAttribute('data-ir-id'),srId:h?.getAttribute('data-sr-id')||undefined}})()`,
	);
	demand(binding.projectId && binding.irId, "Native input requires an explicit project/IR selection");
	await pollWorkflow(
		async () => {
			const view = await context.view(binding.projectId, binding.irId, binding.srId);
			const group = [...view.groups, ...view.drafts].find(item => item.id === binding.irId);
			const sr = binding.srId
				? view.srs.find(item => item.id === binding.srId && item.irId === binding.irId)
				: undefined;
			demand(
				group && (binding.srId ? sr?.status === "developing" : group.status !== "frozen"),
				"Selected Dev object is read-only; native input is not authorized",
			);
			const ref = view.sessions
				.filter(
					item =>
						item.irId === binding.irId &&
						item.srId === binding.srId &&
						item.role === (sr?.stage ?? "requirements") &&
						item.phase === (sr?.stage ?? "requirements") &&
						(!sr || item.round === sr.round),
				)
				.at(-1);
			return (
				ref &&
				context.browser.page.evaluate<boolean>(
					`Boolean(document.querySelector(${quoted(`[data-testid="aireq-native-surface"][data-session-id="${ref.sessionId}"][data-phase="${ref.phase}"][data-round="${ref.round}"]`)}))`,
				)
			);
		},
		Boolean,
		"Exact selected native session composer binding",
		context.timeoutMs,
	);
	// The copied native Lexical composer is the user input surface, not a second chat implementation.
	const input = '[data-testid="v4-composer-input"][contenteditable="true"]';
	await waitVisible(context, input);
	await context.browser.page.clearDraft();
	await context.browser.page.typeDraft(text);
	await waitVisible(context, '[data-testid="v4-composer-send"]');
	await context.browser.page.click('[data-testid="v4-composer-send"]');
}
async function selectValue(context: AIReqJourneyContext, action: string, value: string): Promise<void> {
	const query = selector(action);
	await waitVisible(context, query);
	const selection = await context.browser.page.evaluate<{ target: number; current: number }>(
		`(()=>{const e=document.querySelector(${quoted(query)});const options=Array.from(e.options).filter(option=>!option.disabled);return {target:options.findIndex(option=>option.value===${quoted(value)}),current:options.findIndex(option=>option.value===e.value)}})()`,
	);
	demand(selection.target >= 0, `Missing public option ${action}`);
	await context.browser.page.click(query);
	await context.browser.page.press(query, "Escape");
	const delta = selection.target - selection.current;
	for (let offset = 0; offset < Math.abs(delta); offset++)
		await context.browser.page.press(query, delta > 0 ? "ArrowDown" : "ArrowUp");
	await context.browser.page.press(query, "Tab");
}

/** Read this document's clientId from real public request timing, never the runner's separate API identity. */
async function nativeSurface(context: AIReqJourneyContext): Promise<AIReqNativeSurfaceSnapshot> {
	const url = await pollWorkflow(
		() =>
			context.browser.page.evaluate<string | null>(
				`(()=>{const surface=document.querySelector('[data-testid="aireq-native-surface"]');const header=document.querySelector('header[data-ir-id]');const project=document.querySelector('[data-testid="project-select"]')?.value;if(!surface||!header||!project)return null;const endpoint=new URL('workflow/native-surface',document.baseURI);const info=new URL('server-info',document.baseURI);const entries=performance.getEntriesByType('resource');for(let i=entries.length-1;i>=0;i--){const observed=new URL(entries[i].name,document.baseURI);const client=observed.searchParams.get('clientId');if(observed.origin!==location.origin||![endpoint.pathname,info.pathname].includes(observed.pathname)||!client)continue;const q=endpoint.searchParams;q.set('clientId',client);q.set('projectId',project);q.set('irId',header.getAttribute('data-ir-id'));const sr=header.getAttribute('data-sr-id');if(sr)q.set('srId',sr);q.set('sessionId',surface.getAttribute('data-session-id'));q.set('phase',surface.getAttribute('data-phase'));q.set('round',surface.getAttribute('data-round'));return endpoint.href;}return null;})()`,
			),
		value => value !== null,
		"Public native surface request with this page's exact binding",
		context.timeoutMs,
	);
	demand(url, "No native surface request from the actual browser page");
	return context.browser.page.evaluate<AIReqNativeSurfaceSnapshot>(
		`(async()=>{const url=new URL(${quoted(url)});const response=await fetch(url,{credentials:'same-origin',cache:'no-store',headers:{'X-Dev-Client':url.searchParams.get('clientId')}});if(!response.ok)throw new Error('Native surface observation HTTP '+response.status);return response.json();})()`,
	);
}
function nativeDraft(surface: AIReqNativeSurfaceSnapshot): string {
	const event = surface.events.filter(item => item.method === "setEditorText").at(-1);
	return event?.method === "setEditorText" ? event.value : "";
}
function workflowAuthority(view: AIReqWorkflowView): string {
	return JSON.stringify({
		revision: view.revision,
		groups: view.groups,
		drafts: view.drafts,
		srs: view.srs,
		sessions: view.sessions,
		operations: view.operations,
		running: view.running,
		activeSrId: view.activeSrId,
	});
}
async function selectMaterial(
	context: AIReqJourneyContext,
	projectId: string,
	irId: string,
	sr: AIReqSystemRequirement,
	file: AIReqFileVersion & { valid: boolean },
): Promise<string> {
	demand(sr.worktree, "Material browser observation needs the actual owned SR worktree");
	const bytes = await fs.readFile(path.join(sr.worktree.path, file.path));
	demand(
		bytes.length === file.size && new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === file.sha256,
		`Material host bytes differ from the recorded version: ${file.path}`,
	);
	const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const host = await context.material(projectId, irId, file.path, sr.id);
	demand(!host.error && host.content === content, `Public material does not match real host UTF8: ${file.path}`);
	await selectValue(context, "material-menu", file.path);
	await pollWorkflow(
		() =>
			context.browser.page.evaluate<{
				path: string | null;
				text: string | null;
				valid: string | null;
				editable: boolean;
			}>(
				`(()=>{const pane=document.querySelector('[data-testid="materials-pane"]');const material=pane?.querySelector('[data-testid="material"]');return {path:material?.getAttribute('data-material-path')??null,text:material?.querySelector('pre')?.textContent??null,valid:material?.getAttribute('data-material-valid')??null,editable:Boolean(pane?.querySelector('textarea,input,[contenteditable="true"]'))};})()`,
			),
		value =>
			value.path === file.path && value.text === content && value.valid === String(file.valid) && !value.editable,
		`Exact readonly host material ${file.path}`,
		context.timeoutMs,
	);
	return content;
}
async function createRelease(context: AIReqJourneyContext, projectId: string, title: string): Promise<string> {
	await click(context, "settings");
	await fill(context, "release-title", title);
	await click(context, "create-release");
	const view = await pollWorkflow(
		() => context.view(projectId),
		value => value.releases.some(release => release.title === title),
		"Explicit Release creation",
		context.timeoutMs,
	);
	const id = view.releases.find(release => release.title === title)!.id;
	await click(context, "settings-close");
	await selectValue(context, "release-select", id);
	return id;
}
async function generateStage(
	context: AIReqJourneyContext,
	projectId: string,
	srId: string,
	stage: AIReqWorkflowStage,
): Promise<AIReqSystemRequirement> {
	await pollWorkflow(
		() => context.view(projectId),
		value => value.srs.some(sr => sr.id === srId && sr.stage === stage),
		`Entered ${stage}`,
		context.timeoutMs,
	);
	await waitVisible(context, `header[data-sr-id=${quoted(srId)}][data-stage=${quoted(stage)}]`);
	await send(
		context,
		`Work on the explicitly authorized current ${stage} phase only. Inspect the frozen complete IR/SR, original application/tests and approved prior materials. Produce the real complete output files required by the native output contract. ${stage === "executing" ? "Implement the approved actual Python change and tests. Use separate native tool calls for real UT and subprocess/CLI ST now; preserve exact output, errors, failed attempts and exit status in distinct reports. Write completion.md last, only after both real reports." : "Do not implement code or claim tests ran in this read-only technical/document phase."} Do not advance phases, register/merge PRs or manufacture approvals. Never print inherited environment, credentials, capability URLs or auth configuration.`,
	);
	return stageReady(context, projectId, srId, stage);
}
async function waitGroup(context: AIReqJourneyContext, projectId: string, id: string): Promise<AIReqRequirementGroup> {
	const view = await pollWorkflow(
		() => context.view(projectId, id),
		value =>
			[...value.groups, ...value.drafts].some(
				group => group.id === id && group.files.length > 0 && group.srIds.length > 0,
			) && !value.running.some(ref => ref.irId === id),
		"Complete model IR + SR",
		context.timeoutMs,
	);
	return [...view.groups, ...view.drafts].find(group => group.id === id)!;
}
async function currentGroup(context: AIReqJourneyContext, projectId: string, irId: string): Promise<AIReqRequirementGroup> {
	const view = await context.view(projectId, irId);
	const group = [...view.groups, ...view.drafts].find(item => item.id === irId);
	demand(group, "Selected requirement group disappeared");
	return group;
}
async function currentSr(context: AIReqJourneyContext, projectId: string, srId: string): Promise<AIReqSystemRequirement> {
	const sr = (await context.view(projectId)).srs.find(item => item.id === srId);
	demand(sr, "Selected SR disappeared");
	return sr;
}
async function selectObject(context: AIReqJourneyContext, irId: string, srId?: string): Promise<void> {
	const query = srId ? `button[data-sr-id=${quoted(srId)}]` : `button[data-ir-id=${quoted(irId)}]`;
	await waitVisible(context, query);
	await context.browser.page.click(query);
	await waitVisible(
		context,
		`header[data-ir-id=${quoted(irId)}]${srId ? `[data-sr-id=${quoted(srId)}]` : ":not([data-sr-id])"}`,
	);
}
function completedOperation(view: AIReqWorkflowView, type: string, irId: string, srId?: string) {
	const receipt = view.operations.findLast(item => item.type === type && item.irId === irId && item.srId === srId);
	demand(receipt?.status === "completed", `Missing completed native ${type} receipt for the exact object`);
	return receipt;
}
async function stageReady(
	context: AIReqJourneyContext,
	projectId: string,
	srId: string,
	stage: AIReqWorkflowStage,
): Promise<AIReqSystemRequirement> {
	const view = await pollWorkflow(
		() => context.view(projectId),
		value => {
			const sr = value.srs.find(item => item.id === srId);
			return (
				sr?.stage === stage &&
				sr.materials.some(item => item.stage === stage && item.valid && item.round === sr.round) &&
				!value.running.some(ref => ref.srId === srId)
			);
		},
		`Real ${stage} documents`,
		context.timeoutMs,
	);
	return view.srs.find(item => item.id === srId)!;
}
async function materialContent(
	context: AIReqJourneyContext,
	projectId: string,
	irId: string,
	srId?: string,
): Promise<string> {
	const view = await context.view(projectId, irId, srId);
	const bodies = await Promise.all(
		view.materials
			.filter(item => item.irId === irId && (!srId || item.srId === srId) && item.valid)
			.map(async item => {
				const material = await context.material(projectId, irId, item.path, srId);
				demand(
					!material.error && material.content,
					`Actual material unavailable: ${item.path}: ${material.error ?? "missing content"}`,
				);
				return material.content;
			}),
	);
	return bodies.join("\n\n");
}
async function trackedWorktreeBytes(root: string): Promise<Map<string, string>> {
	const files = (await workflowGit(root, ["ls-files", "-z"])).split("\0").filter(Boolean);
	const changed = (await workflowGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
		.split("\0")
		.filter(Boolean);
	const result = new Map<string, string>();
	for (const file of new Set([...files, ...changed])) {
		if (file.startsWith("docs/aireq/") || file.startsWith(".omp/")) continue;
		try {
			const bytes = await fs.readFile(path.join(root, file));
			result.set(file, new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			result.set(file, "deleted");
		}
	}
	return result;
}
async function nativeExecutionEvidence(
	sr: AIReqSystemRequirement,
	requireImplementation = true,
): Promise<{ writes: string[]; checks: string[]; failedResults: number }> {
	const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
	const results: Array<{ toolCallId?: string; isError?: boolean; content?: unknown; details?: unknown }> = [];
	for (const ref of sr.sessions.filter(item => item.phase === "executing" && item.round === sr.round)) {
		const source = await fs.readFile(ref.sessionFile, "utf8");
		for (const line of source.split(/\r?\n/u).filter(Boolean)) {
			const entry = JSON.parse(line) as SessionEntry;
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message?.role === "assistant" && Array.isArray(message.content))
				for (const part of message.content) if (part.type === "toolCall") calls.push(part);
			if (message?.role === "toolResult") results.push(message);
		}
	}
	const writes = calls
		.filter(call => {
			const input = call.arguments as { path?: unknown };
			return (
				/^(?:write|edit)$/u.test(call.name) &&
				typeof input?.path === "string" &&
				/\.py$/iu.test(input.path) &&
				results.some(result => result.toolCallId === call.id && !result.isError)
			);
		})
		.map(call => call.id);
	const completed = calls.filter(
		call =>
			/^(?:bash|python)$/u.test(call.name) &&
			results.some(result => {
				if (result.toolCallId !== call.id || result.isError) return false;
				const details = (result.details ?? {}) as {
					exitCode?: number;
					timedOut?: boolean;
					cancelled?: boolean;
					async?: { state?: string };
					service?: unknown;
				};
				// Native Bash only carries details.exitCode for nonzero exits; completed
				// non-error results are successful, unlike background/service admissions.
				return (
					!details.timedOut &&
					!details.cancelled &&
					!details.service &&
					(!details.async || details.async.state === "completed") &&
					(details.exitCode === undefined || details.exitCode === 0)
				);
			}),
	);
	const unit = completed.filter(call => /pytest|unittest/iu.test(JSON.stringify(call.arguments)));
	const system = completed.filter(call =>
		/subprocess|machine_info\.py[^\n]*(?:--help|--version|--json)|test[^"\n]*(?:system|cli|_st\b)/iu.test(
			JSON.stringify(call.arguments),
		),
	);
	const pair = unit
		.flatMap(ut =>
			system
				.filter(st => st.id !== ut.id && JSON.stringify(st.arguments) !== JSON.stringify(ut.arguments))
				.map(st => [ut.id, st.id]),
		)
		.at(0);
	const checks = pair ?? [];
	demand(
		!requireImplementation || writes.length > 0,
		"No actual native Python write/edit tool call exists; material prose is not implementation evidence",
	);
	demand(
		checks.length >= 2,
		"Separate successful native UT and ST tool results are required; model report prose alone is insufficient",
	);
	return { writes, checks, failedResults: results.filter(result => result.isError).length };
}

/** Mutations use visible native controls; the sole API mutation probe asserts completed Back refusal. */
export async function runAIReqJourney(context: AIReqJourneyContext): Promise<AIReqJourneyEvidence[]> {
	const items: AIReqJourneyEvidence[] = [];
	async function step<T>(id: (typeof DEV_JOURNEY_STEPS)[number], action: () => Promise<T>): Promise<T> {
		const startedAt = new Date().toISOString();
		try {
			const facts = await action();
			const evidence: AIReqJourneyEvidence = {
				id,
				status: "passed",
				startedAt,
				completedAt: new Date().toISOString(),
				facts,
			};
			items.push(evidence);
			await context.record(evidence);
			return facts;
		} catch (error) {
			const evidence: AIReqJourneyEvidence = {
				id,
				status: "failed",
				startedAt,
				completedAt: new Date().toISOString(),
				error: context.redact(String(error)),
			};
			items.push(evidence);
			await context.record(evidence);
			const observed = await domObservation(context.browser.page).catch(() => undefined);
			if (observed)
				await fs.writeFile(
					path.join(context.evidenceDir, `${id}-failure-dom.json`),
					context.redact(JSON.stringify(observed, null, 2)),
				);
			if (observed && context.redact(observed.text) === observed.text)
				await context.browser.page.screenshot(path.join(context.evidenceDir, `${id}-failure.png`)).catch(() => {});
			throw error;
		}
	}
	await step("production-native-ui", async () => {
		await context.browser.page.navigate(context.url);
		await waitVisible(context, selector("workbench"));
		await waitVisible(context, selector("materials-pane"));
		const info = await domObservation(context.browser.page);
		demand(!/协同需求编辑台|方案对比|独立测试阶段/u.test(info.text), "Retired Dev UI remains visible");
		return { title: info.title, copiedNativeShell: true, browser: context.browser.identity };
	});
	await step("browser-favicon-resource", async () => {
		const resource = await context.browser.page.evaluate<{
			href: string;
			status: number;
			contentType: string;
			bytes: number[];
			requested: boolean;
		}>(
			`(async()=>{const icon=document.querySelector('link[rel~="icon"]');if(!icon)throw new Error('No explicit Dev favicon link');const url=new URL(icon.getAttribute('href'),document.baseURI);const base=new URL(document.baseURI);if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname)||url.pathname==='/favicon.ico')throw new Error('Favicon escaped Dev capability path');const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});const bytes=Array.from(new Uint8Array(await response.arrayBuffer()));return {href:url.href,status:response.status,contentType:response.headers.get('content-type')||'',bytes,requested:performance.getEntriesByType('resource').some(entry=>entry.name===url.href)};})()`,
		);
		demand(
			resource.status === 200 && resource.bytes.length > 0 && resource.requested,
			"Actual browser favicon request failed",
		);
		demand(/image\/|octet-stream/iu.test(resource.contentType), "Favicon response is not an icon resource");
		return {
			url: context.redact(resource.href),
			status: resource.status,
			contentType: resource.contentType,
			size: resource.bytes.length,
			sha256: new Bun.CryptoHasher("sha256").update(new Uint8Array(resource.bytes)).digest("hex"),
			browserResourceRequestObserved: true,
		};
	});
	let view = await context.view();
	const projectId = view.projects.find(item => path.resolve(item.root) === path.resolve(context.root))?.id;
	demand(projectId, "Actual requested test root is not the registered project");
	const primaryRelease = await step("release-organization", async () =>
		createRelease(context, projectId, `Acceptance ${Date.now()}`),
	);
	view = await context.view(projectId);
	const initialIds = new Set([...view.groups, ...view.drafts].map(item => item.id));
	const local = await step("local-intake", async () => {
		await click(context, "new-local");
		view = await pollWorkflow(
			() => context.view(projectId),
			value => value.drafts.some(item => !initialIds.has(item.id) && item.origin === "local"),
			"Local intake worktree",
			context.timeoutMs,
		);
		const group = view.drafts.find(item => !initialIds.has(item.id) && item.origin === "local")!;
		demand(
			group.worktree && path.resolve(group.worktree.path) !== path.resolve(context.root),
			"Local intake did not create an isolated linked worktree",
		);
		demand(
			(await workflowGit(group.worktree.path, ["rev-parse", "HEAD"])) === group.worktree.baseCommit,
			"Local intake is not based on its recorded default commit",
		);
		await selectObject(context, group.id);
		await send(
			context,
			`${context.business ?? DEV_REAL_BUSINESS}\nThis is the developer-local intake source. Stable SR ids must use the current native IR id as a unique prefix, with human-readable titles independent of those ids.`,
		);
		const completed = await waitGroup(context, projectId, group.id);
		demand(
			completed.srIds.length === 1 && !completed.confirmation,
			"Local discussion must produce one complete SR without implicit confirmation",
		);
		assertRealMaterial(await materialContent(context, projectId, group.id), "Local IR/SR", [
			/--help|--version|帮助|版本/iu,
			/machine_info/iu,
			/验收|acceptance/iu,
		]);
		return {
			irId: group.id,
			branch: group.worktree.branch,
			baseCommit: group.worktree.baseCommit,
			files: completed.files,
			srIds: completed.srIds,
			nativeSessions: completed.sessions,
		};
	});
	const sourceProjectId = await step("source-project-registration", async () => {
		await click(context, "settings");
		await fill(context, "project-root", context.businessProject);
		await fill(context, "project-name", "Business source clone");
		await click(context, "register-project");
		const registeredSource = await pollWorkflow(
			() => context.view(),
			value => value.projects.some(project => path.resolve(project.root) === path.resolve(context.businessProject)),
			"Business source registration",
			context.timeoutMs,
		);
		const sourceProjectId = registeredSource.projects.find(
			project => path.resolve(project.root) === path.resolve(context.businessProject),
		)!.id;
		await click(context, "settings-close");
		await selectValue(context, "project", sourceProjectId);
		await createRelease(context, sourceProjectId, `Business handoff ${Date.now()}`);
		return sourceProjectId;
	});
	const browserDraft = await step("browser-intake", async () => {
		const before = await workflowGit(context.businessProject, ["worktree", "list", "--porcelain"]);
		await click(context, "new-browser");
		const observed = await pollWorkflow(
			() => context.view(sourceProjectId),
			value => value.drafts.some(item => item.origin === "browser"),
			"Browser draft",
			context.timeoutMs,
		);
		const group = observed.drafts.find(item => item.origin === "browser")!;
		demand(!group.worktree, "Browser intake created a Git worktree");
		demand(
			(await workflowGit(context.businessProject, ["worktree", "list", "--porcelain"])) === before,
			"Browser intake changed the Git worktree set",
		);
		return { irId: group.id, gitEffects: false };
	});
	await selectObject(context, browserDraft.irId);
	await step("real-requirements", async () => {
		await send(
			context,
			`${context.business ?? DEV_REAL_BUSINESS}\nThis is browser-only business intake. Stable SR ids must use the current native IR id as a unique prefix, with human-readable titles independent of those ids.`,
		);
		const group = await waitGroup(context, sourceProjectId, browserDraft.irId);
		demand(group.srIds.length === 1, "Bounded feature must have exactly one SR");
		demand(
			group.title.length > 4 && !/^new|untitled|新建|未命名/iu.test(group.title),
			"AI did not supply a business title",
		);
		assertRealMaterial(await materialContent(context, sourceProjectId, group.id), "IR/SR", [
			/--help|--version|帮助|版本/iu,
			/machine_info/iu,
			/验收|acceptance/iu,
		]);
		return { irId: group.id, title: group.title, srIds: group.srIds, files: group.files };
	});
	await step("fixed-snapshot-review", async () => {
		await click(context, "confirm-requirements");
		const reviewed = await pollWorkflow(
			() => context.view(sourceProjectId),
			value => value.groups.some(item => item.id === browserDraft.irId && item.review?.passed && item.confirmation),
			"Independent native review",
			context.timeoutMs,
		);
		const group = reviewed.groups.find(item => item.id === browserDraft.irId)!;
		demand(
			group.review?.snapshotDigest === group.snapshot?.digest &&
				group.confirmation?.snapshotDigest === group.snapshot?.digest,
			"Review/confirmation do not refer to the exact same snapshot",
		);
		demand(
			group.review?.reviewer.sessionId !== group.sessions.find(item => item.role === "requirements")?.sessionId,
			"Review reused the requirement actor",
		);
		const report = JSON.parse(group.review!.report);
		demand(
			report.snapshotDigest === group.snapshot!.digest &&
				report.verdict === "pass" &&
				Array.isArray(report.findings) &&
				report.findings.every((finding: unknown) => typeof finding === "string"),
			"Independent model review did not return the actual fixed-snapshot review contract",
		);
		return { snapshotDigest: group.snapshot!.digest, review: group.review };
	});
	await step("review-invalidation", async () => {
		const previous = (await currentGroup(context, sourceProjectId, browserDraft.irId)).snapshot!.digest;
		await send(
			context,
			`Clarify the confirmed acceptance with a concrete regression case: --json must still fail with the existing error/exit semantics, and the requested ${context.business === DEV_VERSION_BUSINESS ? "--version" : "--help"} option must not perform machine probing. Do not add other options or scope. Update the actual IR and full SR, not only chat. Fresh confirmation and independent review are required; do not auto-approve.`,
		);
		await pollWorkflow(
			() => context.view(sourceProjectId),
			value => {
				const group = [...value.groups, ...value.drafts].find(item => item.id === browserDraft.irId);
				return Boolean(
					group &&
					!group.confirmation &&
					group.snapshot?.digest !== previous &&
					!value.running.some(ref => ref.irId === group.id),
				);
			},
			"Material change invalidates exact confirmation",
			context.timeoutMs,
		);
		demand(
			!(await present(context.browser.page, `${selector("download-package")}:not([disabled])`)),
			"Changed snapshot remains downloadable",
		);
		await click(context, "confirm-requirements");
		const reviewed = await pollWorkflow(
			() => context.view(sourceProjectId),
			value =>
				value.groups.some(
					item =>
						item.id === browserDraft.irId &&
						item.review?.passed &&
						item.confirmation?.snapshotDigest === item.snapshot?.digest,
				),
			"Fresh review after change",
			context.timeoutMs,
		);
		const group = reviewed.groups.find(item => item.id === browserDraft.irId)!;
		demand(group.snapshot?.digest !== previous, "Material bytes did not change");
		return { previousDigest: previous, newDigest: group.snapshot!.digest, reviewId: group.review!.id };
	});
	const handoff = await step("zip-handoff", async () => {
		const existing = new Set(await fs.readdir(context.downloadDirectory));
		await click(context, "download-package");
		const file = await pollWorkflow(
			async () => {
				const entries = await fs.readdir(context.downloadDirectory);
				if (entries.some(name => name.endsWith(".part") || name.endsWith(".crdownload"))) return "";
				const candidate = entries.find(name => !existing.has(name) && name.endsWith(".zip"));
				return candidate && (await fs.stat(path.join(context.downloadDirectory, candidate))).size > 0
					? candidate
					: "";
			},
			Boolean,
			"Completed native ZIP download",
			context.timeoutMs,
		);
		const source = path.join(context.downloadDirectory, file);
		const bytes = await fs.readFile(source);
		const decoded = await decodeRequirementPackage(bytes);
		const group = await currentGroup(context, sourceProjectId, browserDraft.irId);
		demand(decoded.manifest.snapshot.irId === browserDraft.irId, "Downloaded ZIP belongs to a different IR");
		demand(
			decoded.manifest.snapshot.digest === group.snapshot?.digest &&
				decoded.manifest.confirmation.snapshotDigest === group.confirmation?.snapshotDigest &&
				decoded.manifest.review.id === group.review?.id,
			"ZIP does not carry the current exact snapshot, confirmation and independent review",
		);
		assertExactVersions(decoded.manifest.files, group.snapshot!.files, "ZIP complete IR/SR/attachment authority");
		const transport = path.join(context.evidenceDir, "local-simulated-nfs-handoff");
		await fs.mkdir(transport, { recursive: true });
		const target = path.join(transport, "requirements.zip");
		await fs.copyFile(source, target);
		demand(Buffer.compare(bytes, await fs.readFile(target)) === 0, "Handoff changed package bytes");
		return {
			file: target,
			packageId: decoded.manifest.packageId,
			digest: decoded.digest,
			files: decoded.manifest.files,
			snapshotDigest: decoded.manifest.snapshot.digest,
			reviewId: decoded.manifest.review.id,
			transport: "local-directory simulation; NOT real NFS or multi-host evidence",
		};
	});
	const imported = await step("zip-import", async () => {
		await selectValue(context, "project", projectId);
		await selectValue(context, "release-select", primaryRelease);
		const before = await context.view(projectId);
		const count = before.groups.length + before.drafts.length;
		const sessions = before.sessions.length;
		await context.browser.page.upload(selector("import"), [handoff.file]);
		const next = await pollWorkflow(
			() => context.view(projectId),
			value => value.groups.length + value.drafts.length > count,
			"Package import",
			context.timeoutMs,
		);
		const group = [...next.groups, ...next.drafts].find(
			item => item.origin === "import" && item.packageId === handoff.packageId,
		)!;
		demand(
			group?.worktree &&
				group.id === browserDraft.irId &&
				group.projectId === projectId &&
				sourceProjectId !== projectId,
			"Import did not preserve stable IDs in an independent target-project worktree",
		);
		demand(!group.requirementsPr && !next.activeSrId, "Import automatically published PR or started development");
		demand(next.sessions.length === sessions, "Import unexpectedly repeated native review");
		assertExactVersions(group.files, handoff.files, "Imported requirement bytes");
		demand(
			group.snapshot?.digest === handoff.snapshotDigest &&
				group.review?.id === handoff.reviewId &&
				group.confirmation?.snapshotDigest === handoff.snapshotDigest &&
				group.review?.passed,
			"Import lost the original fixed-snapshot confirmation/review authority",
		);
		return { irId: group.id, srId: group.srIds[0], branch: group.worktree.branch, worktree: group.worktree.path };
	});
	await selectObject(context, imported.irId);
	const requirementMerge = await step("requirements-pr-registration", async () => {
		await click(context, "push-requirements");
		const group = await currentGroup(context, projectId, imported.irId);
		const project = (await context.view(projectId)).projects.find(item => item.id === projectId)!;
		const authority = [...group.snapshot!.files, ...(group.evidenceFiles ?? []), ...(group.retiredFiles ?? [])];
		demand(group.evidenceFiles?.length, "Published requirement authority lacks confirmation/review evidence");
		const files = await committedManifest(
			group.worktree!.path,
			"HEAD",
			authority.map(file => file.path),
		);
		assertExactVersions(files, authority, "Published complete requirement authority");
		const request: AIReqMergeRequest = {
			kind: "requirements",
			projectId,
			irId: group.id,
			root: context.root,
			worktree: group.worktree!.path,
			sourceBranch: group.worktree!.branch,
			targetBranch: project.defaultBranch,
			files,
		};
		await assertMergeManifest(request.worktree, "HEAD", request);
		// This callback is outside the application and must disclose actual Git/platform scope.
		const receipt = await context.manualMerge(request);
		demand(
			receipt.platformVerified === false && receipt.kind === "requirements" && receipt.irId === group.id,
			"Invalid manual requirement PR receipt",
		);
		await fill(context, "requirements-pr-url", receipt.prUrl);
		await click(context, "requirements-pr-submit");
		const registered = await pollWorkflow(
			() => context.view(projectId),
			value => value.groups.some(item => item.id === group.id && item.requirementsPr?.url === receipt.prUrl),
			"Manual requirement PR registration",
			context.timeoutMs,
		);
		demand(
			registered.groups.find(item => item.id === group.id)?.requirementsPr?.platformVerified === false,
			"Git registration was labeled platform approval",
		);
		return receipt;
	});
	await step("requirements-exact-merge", async () => {
		await click(context, "requirements-merged");
		const frozen = await pollWorkflow(
			() => context.view(projectId),
			value => value.groups.some(item => item.id === imported.irId && item.status === "frozen" && item.merge),
			"Git exact-content requirement merge",
			context.timeoutMs,
		);
		const group = frozen.groups.find(item => item.id === imported.irId)!;
		demand(
			group.merge!.commit === requirementMerge.commit,
			"Git-confirmed default commit differs from actual manual merge receipt",
		);
		assertExactVersions(
			group.merge!.files,
			[...group.snapshot!.files, ...(group.evidenceFiles ?? []), ...(group.retiredFiles ?? [])],
			"Git merge complete frozen materials, evidence and retired paths",
		);
		return { merge: group.merge, platformVerified: false, mode: requirementMerge.mode };
	});
	await step("group-freeze", async () => {
		const before = await currentGroup(context, projectId, imported.irId);
		const editable = await present(context.browser.page, '[data-testid="v4-composer-input"][contenteditable="true"]');
		if (editable) {
			await send(
				context,
				"Rename this frozen business requirement and remove its SR. This unauthorized destructive edit must be rejected by the backend without changing frozen bytes.",
			);
			await pollWorkflow(
				() => context.view(projectId),
				value => !value.running.some(ref => ref.irId === imported.irId),
				"Frozen edit attempt settles",
				context.timeoutMs,
			);
		}
		const after = await currentGroup(context, projectId, imported.irId);
		demand(
			before.title === after.title &&
				JSON.stringify(before.files) === JSON.stringify(after.files) &&
				JSON.stringify(before.srIds) === JSON.stringify(after.srIds),
			"Frozen business authority changed",
		);
		const observed = await domObservation(context.browser.page);
		demand(
			/冻结|锁定|frozen|locked|read.only|拒绝|denied/iu.test(observed.text),
			"Frozen edit rejection is not visible",
		);
		return {
			snapshotDigest: after.snapshot!.digest,
			immutableFiles: after.files,
			browserWriteAdmission: editable
				? "attempted through native composer"
				: "no editable native surface; direct tool/descendant freeze negatives belong to deterministic native suite",
		};
	});
	await step("sr-solution", async () => {
		const beforeSelection = await context.view(projectId, imported.irId);
		const worktrees = await workflowGit(context.root, ["worktree", "list", "--porcelain"]);
		await selectObject(context, imported.irId, imported.srId);
		const selected = await context.view(projectId, imported.irId, imported.srId);
		const pending = selected.srs.find(item => item.id === imported.srId)!;
		demand(
			pending.status === "pending" && !pending.worktree && !pending.stage && !pending.sessions.length,
			"Viewing a pending SR implicitly started development",
		);
		demand(
			JSON.stringify(selected.sessions) === JSON.stringify(beforeSelection.sessions) &&
				(await workflowGit(context.root, ["worktree", "list", "--porcelain"])) === worktrees &&
				!(await present(context.browser.page, '[data-testid="v4-composer-input"][contenteditable="true"]')),
			"Readonly SR selection created native work or an editable composer",
		);
		await click(context, "start-sr");
		const sr = await generateStage(context, projectId, imported.srId, "solution");
		demand(
			sr.worktree?.path !== imported.worktree && sr.worktree?.path !== context.root,
			"SR did not get a persistent independent worktree",
		);
		assertRealMaterial(await materialContent(context, projectId, imported.irId, sr.id), "Technical solution", [
			/--help|--version|帮助|版本/iu,
			/风险|risk|取舍|trade/iu,
		]);
		return { srId: sr.id, worktree: sr.worktree, sessions: sr.sessions };
	});
	await step("project-single-sr", async () => {
		const active = await context.view(projectId);
		demand(
			active.activeSrId === imported.srId && active.srs.filter(item => item.status === "developing").length === 1,
			"Project does not hold one developing SR slot",
		);
		return { activeSrId: active.activeSrId, slotCurrentlyHeld: true };
	});
	await step("solution-approval", async () => {
		await click(context, "approve-stage");
		const sr = await generateStage(context, projectId, imported.srId, "planning");
		demand(
			sr.approvals.some(item => item.stage === "solution"),
			"Explicit versioned solution approval absent",
		);
		return { approvals: sr.approvals };
	});
	await step("planning-approval", async () => {
		assertRealMaterial(await materialContent(context, projectId, imported.irId, imported.srId), "Development plan", [
			/pytest|unittest|UT|单元/iu,
			/CLI|ST|系统/iu,
		]);
		await click(context, "approve-stage");
		return { stage: (await generateStage(context, projectId, imported.srId, "executing")).stage };
	});
	await step("execution-real-ut-st", async () => {
		const sr = await stageReady(context, projectId, imported.srId, "executing");
		for (const kind of ["completion", "ut", "st"] as const)
			demand(
				sr.materials.some(item => item.kind === kind && item.valid && item.round === sr.round),
				`Execution omits separate ${kind} material`,
			);
		for (const kind of ["ut", "st"] as const) {
			const file = sr.materials.find(item => item.kind === kind && item.valid && item.round === sr.round)!;
			const report = await context.material(projectId, imported.irId, file.path, sr.id);
			assertRealMaterial(
				report.content ?? "",
				`${kind.toUpperCase()} report`,
				[/python|pytest|unittest|命令|command/iu, /passed|通过|(?:exit|退出|status|状态)[^\n]{0,40}0|\bOK\b/iu],
				80,
			);
		}
		const material = await materialContent(context, projectId, imported.irId, sr.id);
		assertRealMaterial(material, "Execution and UT/ST", [
			/--help|--version|帮助|版本/iu,
			/pytest|unittest/iu,
			/(?:exit|退出|status|状态)[^\n]{0,40}0|passed|通过/iu,
			/python[^\n]*(?:-m|\.py)|subprocess/iu,
		]);
		const files = await trackedWorktreeBytes(sr.worktree!.path);
		const changed = [
			...new Set([
				...(await workflowGit(sr.worktree!.path, ["diff", "--name-only", sr.worktree!.baseCommit])).split(/\r?\n/u),
				...(await workflowGit(sr.worktree!.path, ["ls-files", "--others", "--exclude-standard"])).split(/\r?\n/u),
			]),
		].filter(Boolean);
		demand(
			changed.includes("machine_info.py") && changed.some(file => /test.*\.py$/u.test(file)),
			"Native execution did not actually change the application and Python regression tests",
		);
		const native = await nativeExecutionEvidence(sr);
		return { materials: sr.materials, implementationFiles: [...files.entries()], changedFiles: changed, native };
	});
	const browsedMaterial = await step("material-menu-readonly-download", async () => {
		const before = await context.view(projectId, imported.irId, imported.srId);
		const sr = before.srs.find(item => item.id === imported.srId)!;
		demand(sr.stage === "executing" && sr.worktree, "Material controls must run on actual executing outputs");
		const listed = before.materials.filter(
			item => item.irId === imported.irId && (!item.srId || item.srId === sr.id),
		);
		demand(
			listed.filter(item => item.kind === "solution" && item.valid).length === 1,
			"Unified materials contain more than one current solution",
		);
		const selected: Array<{ kind: string; path: string; sha256: string; size: number }> = [];
		for (const kind of ["ir", "sr", "solution", "plan", "completion", "ut", "st"] as const) {
			const file = listed.find(item => item.kind === kind && item.valid);
			demand(file, `Unified menu lacks actual valid ${kind} material`);
			await selectMaterial(context, projectId, imported.irId, sr, file);
			selected.push({ kind, path: file.path, sha256: file.sha256, size: file.size });
		}
		const file = sr.materials.find(item => item.kind === "ut" && item.valid && item.round === sr.round)!;
		const content = await selectMaterial(context, projectId, imported.irId, sr, file);
		await click(context, "material-collapse");
		await waitVisible(context, selector("material-reopen"));
		demand(
			!(await present(context.browser.page, selector("material-menu"))),
			"Collapsed material menu remained mounted",
		);
		await click(context, "material-reopen");
		await pollWorkflow(
			() =>
				context.browser.page.evaluate<boolean>(
					`document.querySelector('[data-testid="material-menu"]')?.value===${quoted(file.path)}&&document.querySelector('[data-testid="material"] pre')?.textContent===${quoted(content)}`,
				),
			Boolean,
			"Reopened material retains exact selection and content",
			context.timeoutMs,
		);
		const existing = new Set(await fs.readdir(context.downloadDirectory));
		await click(context, "material-download");
		const download = await pollWorkflow(
			async () => {
				const entries = await fs.readdir(context.downloadDirectory);
				if (entries.some(name => !existing.has(name) && /\.(?:part|crdownload)$/u.test(name))) return "";
				const candidates = entries.filter(name => !existing.has(name) && /\.md$/iu.test(name));
				demand(candidates.length <= 1, "Material download produced ambiguous new Markdown files");
				return candidates[0] ?? "";
			},
			Boolean,
			"Actual Markdown material download in the browser download directory",
			context.timeoutMs,
		);
		const bytes = await fs.readFile(path.join(context.downloadDirectory, download));
		const hostBytes = await fs.readFile(path.join(sr.worktree.path, file.path));
		demand(
			bytes.equals(hostBytes) && bytes.equals(Buffer.from(content, "utf8")),
			"Material download differs from exact host UTF8 bytes",
		);
		const errorsBefore = (await domObservation(context.browser.page)).errors;
		await click(context, "material-copy");
		const errorsAfterClick = (await domObservation(context.browser.page)).errors;
		demand(
			workflowAuthority(await context.view(projectId, imported.irId, sr.id)) === workflowAuthority(before),
			"Readonly material controls invoked work or changed authority",
		);
		return {
			path: file.path,
			content,
			sha256: file.sha256,
			size: file.size,
			selected,
			historicalStagesViewed: ["solution", "planning"],
			collapseReopenRetainedSelection: true,
			download: { file: download, bytes: bytes.length, exactHostUtf8: true },
			copy: {
				clicked: true,
				errorsBefore,
				errorsAfterClick,
				evidence:
					"Click/error observation only; clipboard completion and copied bytes are not observed by this journey.",
				clipboardReadLimit:
					"No safe system-clipboard read/restore API in DevelopmentPage; Firefox 128 copied-byte verification remains unobserved. Parent Chrome fixture covers the exact copied-text contract separately.",
			},
		};
	});
	await step("material-discuss-unsent-native-draft", async () => {
		const before = await context.view(projectId, imported.irId, imported.srId);
		const sr = before.srs.find(item => item.id === imported.srId)!;
		const active = sr.sessions.filter(ref => ref.phase === sr.stage && ref.round === sr.round).at(-1);
		demand(
			active && !before.running.some(ref => ref.srId === sr.id),
			"Discuss requires the settled exact current native session",
		);
		const journal = await fs.readFile(active.sessionFile, "utf8");
		const initial = await nativeSurface(context);
		demand(
			initial.target.sessionId === active.sessionId &&
				initial.target.phase === "executing" &&
				initial.target.round === sr.round,
			"Discussion surface is not the actual executing session",
		);
		demand(nativeDraft(initial) === "", "Refusing to replace an existing unowned native draft");
		demand(
			await context.browser.page.evaluate<boolean>(
				`document.querySelector('[data-testid="v4-composer-input"][contenteditable="true"]')?.textContent===''`,
			),
			"Refusing to append to an existing unsynchronized/unowned browser draft",
		);
		const independent = await context.browser.newPage();
		let owned = false;
		const seed = `Unsent material discussion ${crypto.randomUUID()}`;
		try {
			await independent.navigate(context.url);
			const other = { ...context, browser: { ...context.browser, page: independent } };
			await waitVisible(other, selector("workbench"));
			await selectValue(other, "project", sourceProjectId);
			await selectObject(other, browserDraft.irId);
			const otherBefore = await nativeSurface(other);
			demand(
				otherBefore.target.projectId === sourceProjectId && otherBefore.target.sessionId !== active.sessionId,
				"Independent draft observation is not another project's actual native session",
			);
			const otherAuthority = workflowAuthority(await context.view(sourceProjectId, browserDraft.irId));
			await waitVisible(context, '[data-testid="v4-composer-input"][contenteditable="true"]');
			owned = true;
			await context.browser.page.typeDraft(seed);
			await pollWorkflow(
				() => nativeSurface(context),
				surface => nativeDraft(surface) === seed,
				"Owned unsent native Markdown seed",
				context.timeoutMs,
			);
			await click(context, "material-discuss");
			const expected =
				`${seed}\n\n请讨论以下只读材料（${browsedMaterial.path}）：\n\n${browsedMaterial.content}`.trim();
			const inserted = await pollWorkflow(
				() => nativeSurface(context),
				surface =>
					surface.target.sessionId === active.sessionId &&
					surface.target.round === sr.round &&
					nativeDraft(surface) === expected,
				"Exact actual material inserted into current unsent native Markdown draft",
				context.timeoutMs,
			);
			const otherAfter = await nativeSurface(other);
			demand(
				JSON.stringify(otherAfter.target) === JSON.stringify(otherBefore.target) &&
					nativeDraft(otherAfter) === nativeDraft(otherBefore) &&
					workflowAuthority(await context.view(sourceProjectId, browserDraft.irId)) === otherAuthority,
				"Material discussion leaked into another project's native draft or invoked work",
			);
			demand(
				workflowAuthority(await context.view(projectId, imported.irId, sr.id)) === workflowAuthority(before) &&
					(await fs.readFile(active.sessionFile, "utf8")) === journal,
				"Discuss sent native input/model work or changed phase, round, approvals or materials",
			);
			return {
				target: inserted.target,
				editorEvent: inserted.events.filter(event => event.method === "setEditorText").at(-1),
				expectedMarkdown: expected,
				otherUnchangedTarget: otherAfter.target,
				noInputReceiptOrJournalChange: true,
				noWorkflowAuthorityChange: true,
				ownedDraftClearedWithRealEditorActions: true,
				copyErrorsAfterDiscussion: (await domObservation(context.browser.page)).errors,
			};
		} finally {
			try {
				if (owned) {
					const current = await nativeSurface(context);
					demand(
						current.target.sessionId === active.sessionId && nativeDraft(current).startsWith(seed),
						"Refusing to clear a foreign draft or changed native binding",
					);
					await context.browser.page.clearDraft();
					await pollWorkflow(
						() => nativeSurface(context),
						surface => nativeDraft(surface) === "",
						"Owned discussion draft cleared with real editor actions",
						context.timeoutMs,
					);
					demand(
						workflowAuthority(await context.view(projectId, imported.irId, sr.id)) ===
							workflowAuthority(before) && (await fs.readFile(active.sessionFile, "utf8")) === journal,
						"Clearing the unsent draft submitted input or changed workflow authority",
					);
				}
			} finally {
				await independent.close();
			}
		}
	});
	await step("native-file-git-readonly", async () => {
		const before = await context.view(projectId, imported.irId, imported.srId);
		const sr = before.srs.find(item => item.id === imported.srId)!;
		demand(sr.worktree, "File/Git inspection needs the real owned SR worktree");
		const worktree = sr.worktree.path;
		const bytes = await trackedWorktreeBytes(worktree);
		const gitBefore = {
			head: await requireGit(worktree).headSha(),
			index: await workflowGit(worktree, ["ls-files", "--stage", "-z"]),
			status: await workflowGit(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]),
		};
		const surface = await nativeSurface(context);
		await click(context, "material-collapse");
		const sidePaneWasOpen = await context.browser.page.evaluate<boolean>(
			`Boolean(document.querySelector('[data-workspace-side-frame][aria-hidden="false"]'))`,
		);
		if (!sidePaneWasOpen) await click(context, "side-pane-toggle");
		await waitVisible(context, "[data-side-pane-add-tab-trigger]");
		await context.browser.page.click("[data-side-pane-add-tab-trigger]");
		await click(context, "side-pane-launcher-files");
		const fileRow =
			'[data-workspace-side-frame][aria-hidden="false"] [data-state="active"] [data-testid="workspace-file-tree-panel"] [data-testid^="workspace-file-tree-row-"][title="machine_info.py"]';
		await waitVisible(context, fileRow);
		await context.browser.page.click(fileRow);
		const source = await fs.readFile(path.join(worktree, "machine_info.py"), "utf8");
		const line = source.split(/\r?\n/u).find(text => text.trim().length >= 16 && !text.trim().startsWith("#"));
		demand(line, "Owned Python application has no substantive preview line");
		const preview = await pollWorkflow(
			() =>
				context.browser.page.evaluate<string>(
					`document.querySelector('[data-testid="preview-pane"]')?.innerText||''`,
				),
			text => text.includes(line.trim()),
			"Real owned-worktree file appears in native file preview",
			context.timeoutMs,
		);
		await context.browser.page.click("[data-side-pane-add-tab-trigger]");
		await click(context, "side-pane-launcher-review");
		const git = await pollWorkflow(
			() =>
				context.browser.page.evaluate<string>(`document.querySelector('[data-testid="git-pane"]')?.innerText||''`),
			text => text.includes("machine_info.py"),
			"Actual modified application appears in native Git review",
			context.timeoutMs,
		);
		if (!sidePaneWasOpen) await click(context, "side-pane-toggle");
		await click(context, "material-reopen");
		const afterBytes = await trackedWorktreeBytes(worktree);
		demand(
			JSON.stringify([...afterBytes]) === JSON.stringify([...bytes]) &&
				(await requireGit(worktree).headSha()) === gitBefore.head &&
				(await workflowGit(worktree, ["ls-files", "--stage", "-z"])) === gitBefore.index &&
				(await workflowGit(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])) === gitBefore.status &&
				workflowAuthority(await context.view(projectId, imported.irId, sr.id)) === workflowAuthority(before) &&
				JSON.stringify((await nativeSurface(context)).target) === JSON.stringify(surface.target),
			"Readonly native file/Git panels changed host bytes, Git, workflow or native binding",
		);
		return { worktree, path: "machine_info.py", sourceLine: line, preview, git, gitBefore, noWrites: true };
	});
	await step("history-not-transition", async () => {
		const before = await currentSr(context, projectId, imported.srId);
		const activeRef = before.sessions.filter(ref => ref.phase === before.stage && ref.round === before.round).at(-1);
		demand(activeRef, "Current stage has no exact native history reference");
		const journal = await fs.readFile(activeRef.sessionFile, "utf8");
		const head = await requireGit(before.worktree!.path).headSha();
		const authority = workflowAuthority(await context.view(projectId, imported.irId, imported.srId));
		const surfaceBefore = await nativeSurface(context);
		demand(
			before.stage === "executing" && surfaceBefore.target.sessionId === activeRef.sessionId,
			"History proof must view solution during actual executing, not planning",
		);
		await context.browser.page.click(`${selector("history")} > summary`);
		await click(context, "stage-solution");
		const solution = before.materials.find(item => item.kind === "solution");
		demand(solution, "No actual historical solution exists");
		await waitVisible(context, `${selector("material")}[data-material-path=${quoted(solution.path)}]`);
		const expected = await context.material(projectId, imported.irId, solution.path, imported.srId);
		await pollWorkflow(
			() =>
				context.browser.page.evaluate<string>(`document.querySelector(${quoted(selector("material"))}).innerText`),
			text => Boolean(expected.content && text.includes(expected.content.trim())),
			"Historical solution is actually rendered",
			context.timeoutMs,
		);
		const surfaceViewingHistory = await nativeSurface(context);
		demand(
			JSON.stringify(surfaceViewingHistory.target) === JSON.stringify(surfaceBefore.target) &&
				nativeDraft(surfaceViewingHistory) === nativeDraft(surfaceBefore),
			"Historical viewing switched the actual native chat or draft",
		);
		const after = await currentSr(context, projectId, imported.srId);
		demand(
			after.stage === before.stage &&
				after.round === before.round &&
				JSON.stringify(after.approvals) === JSON.stringify(before.approvals),
			"History navigation made a workflow transition",
		);
		await context.browser.page.reload();
		await waitVisible(context, `header[data-sr-id=${quoted(imported.srId)}][data-stage=${quoted(before.stage!)}]`);
		await waitVisible(context, `${selector("stage-solution")}[aria-pressed="true"]`);
		await waitVisible(context, `${selector("material")}[data-material-path=${quoted(solution.path)}]`);
		await waitVisible(context, `[data-testid="aireq-native-surface"][data-session-id=${quoted(activeRef.sessionId)}]`);
		const surfaceReloaded = await nativeSurface(context);
		demand(
			surfaceReloaded.target.projectId === surfaceBefore.target.projectId &&
				surfaceReloaded.target.irId === surfaceBefore.target.irId &&
				surfaceReloaded.target.srId === surfaceBefore.target.srId &&
				surfaceReloaded.target.sessionId === surfaceBefore.target.sessionId &&
				surfaceReloaded.target.phase === surfaceBefore.target.phase &&
				surfaceReloaded.target.round === surfaceBefore.target.round &&
				nativeDraft(surfaceReloaded) === nativeDraft(surfaceBefore) &&
				workflowAuthority(await context.view(projectId, imported.irId, imported.srId)) === authority,
			"Historical view restoration changed workflow authority or exact native conversation",
		);
		demand(
			(await fs.readFile(activeRef.sessionFile, "utf8")) === journal &&
				(await requireGit(before.worktree!.path).headSha()) === head &&
				JSON.stringify((await currentSr(context, projectId, imported.srId)).materials) ===
					JSON.stringify(before.materials),
			"Historical view/reload changed native history, Git or material validity",
		);
		await click(context, `stage-${before.stage!}`);
		return {
			stage: after.stage,
			round: after.round,
			nativeSessionId: activeRef.sessionId,
			historicalViewingStageRestored: "solution",
			noNativeReplay: true,
			nativeBindingBefore: surfaceBefore.target,
			nativeBindingWhileViewingHistory: surfaceViewingHistory.target,
			nativeBindingAfterReload: surfaceReloaded.target,
			runningBoundary:
				"Settled executing phase; this step does not claim continuity of an in-flight tool/model request.",
		};
	});
	await step("code-preserving-back", async () => {
		const before = await currentSr(context, projectId, imported.srId);
		const bytes = await trackedWorktreeBytes(before.worktree!.path);
		const head = await requireGit(before.worktree!.path).headSha();
		await click(context, "back-planning");
		const after = await generateStage(context, projectId, imported.srId, "planning");
		demand(
			after.round > before.round && after.worktree!.path === before.worktree!.path,
			"Back did not retain persistent worktree/new round",
		);
		const kept = await trackedWorktreeBytes(after.worktree!.path);
		for (const [file, hash] of bytes) demand(kept.get(file) === hash, `Back changed retained code: ${file}`);
		demand(
			after.approvals.every(item => item.stage === "solution") &&
				!after.materials.some(item => item.stage === "executing" && item.valid),
			"Back retained a planning/execution approval or valid downstream report",
		);
		demand(
			before.sessions.every(ref => after.sessions.some(current => current.sessionId === ref.sessionId)),
			"Back discarded actual previous-round native history",
		);
		const state = await context.view(projectId, imported.irId, imported.srId);
		const receipt = completedOperation(state, "backStage", imported.irId, imported.srId);
		demand(
			after.round === before.round + 1 &&
				!after.codePr &&
				!after.codeMerge &&
				state.activeSrId === after.id &&
				after.status === "developing" &&
				!state.running.some(ref => ref.srId === after.id && ref.round === before.round) &&
				receipt.steps.some(item => item.name === "back" && item.detail === `executing->planning:${after.round}`) &&
				(await requireGit(after.worktree!.path).headSha()) === head,
			"Back did not settle the old round, retain its slot, clear downstream PR authority, or preserve Git HEAD",
		);
		return {
			oldRound: before.round,
			newRound: after.round,
			retainedCode: [...bytes.entries()],
			receipt,
			slotRetained: true,
			head,
		};
	});
	await step("invalidated-material-history", async () => {
		const before = await context.view(projectId, imported.irId, imported.srId);
		const sr = before.srs.find(item => item.id === imported.srId)!;
		const viewed: Array<{ kind: string; path: string; round: number; sha256: string; status: string }> = [];
		for (const kind of ["ut", "st"] as const) {
			const report = sr.materials.find(item => item.kind === kind && !item.valid && item.round < sr.round);
			demand(report, `Back did not retain actual invalid historical ${kind.toUpperCase()} material`);
			await selectMaterial(context, projectId, imported.irId, sr, report);
			const status = await context.browser.page.evaluate<string>(
				`document.querySelector('[data-testid="material"] [role="status"]')?.textContent||''`,
			);
			demand(
				/已失效.*重新生成|历史查看/u.test(status),
				"Invalid historical test report was presented as a current conclusion",
			);
			viewed.push({ kind, path: report.path, round: report.round, sha256: report.sha256, status });
		}
		demand(
			workflowAuthority(await context.view(projectId, imported.irId, sr.id)) === workflowAuthority(before),
			"Invalid history viewing changed approvals, materials or native work",
		);
		const plan = sr.materials.find(item => item.kind === "plan" && item.valid && item.round === sr.round);
		demand(plan, "Regenerated current planning material is missing");
		await selectMaterial(context, projectId, imported.irId, sr, plan);
		return {
			stage: sr.stage,
			round: sr.round,
			viewed,
			boundary: "Real invalidated UT/ST history only; no fabricated missing-file or transport-error state.",
		};
	});
	await step("detach-reconnect", async () => {
		const before = await currentSr(context, projectId, imported.srId);
		const marker = `dev-reconnect-${crypto.randomUUID()}`;
		await send(
			context,
			`Discussion only, audit ${marker}: read the actual Python argument-handling implementation and its regression tests. Explain the exact existing refusal behavior for --json and how the approved plan preserves it. Cite real source symbols/tests after reading them. Do not modify any file, execute tests, approve a phase or register a PR.`,
		);
		const working = await pollWorkflow(
			() => context.view(projectId),
			value => value.running.some(ref => ref.srId === imported.srId),
			"Actual Beam inference before detach",
			context.timeoutMs,
		);
		const exact = working.running.find(ref => ref.srId === imported.srId)!;
		const detached = await context.browser.newPage();
		await detached.navigate(context.url);
		const otherPage = { ...context, browser: { ...context.browser, page: detached } };
		await waitVisible(otherPage, selector("workbench"));
		await selectValue(otherPage, "project", sourceProjectId);
		await selectObject(otherPage, browserDraft.irId);
		const otherBefore = await currentGroup(context, sourceProjectId, browserDraft.irId);
		await context.browser.page.reload();
		await waitVisible(context, selector("workbench"));
		await selectObject(context, imported.irId, imported.srId);
		await pollWorkflow(
			() => context.view(projectId),
			value => !value.running.some(ref => ref.srId === imported.srId),
			"Same native turn finishes across browser reconnect",
			context.timeoutMs,
		);
		const after = await currentSr(context, projectId, imported.srId);
		demand(
			after.worktree!.path === before.worktree!.path && after.round === before.round && after.stage === before.stage,
			"Reconnect changed round or worktree",
		);
		demand(
			after.sessions.some(ref => ref.sessionId === exact.sessionId && ref.round === exact.round),
			"Reconnect substituted another native session",
		);
		const transcript = (await fs.readFile(exact.sessionFile, "utf8"))
			.split(/\r?\n/u)
			.filter(Boolean)
			.map(line => JSON.parse(line) as SessionEntry);
		demand(
			transcript.filter(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes(marker),
			).length === 1,
			"Browser reconnect replayed or lost the actual submitted native message",
		);
		demand(
			await detached.evaluate<boolean>(
				`document.querySelector(${quoted(selector("project"))}).value===${quoted(sourceProjectId)}&&Boolean(document.querySelector(${quoted(`header[data-ir-id=${quoted(browserDraft.irId)}]:not([data-sr-id])`)}))&&!document.body.innerText.includes(${quoted(marker)})`,
			),
			"Another project's page received the in-flight source SR's late conversation or lost its own selection",
		);
		const otherAfter = await currentGroup(context, sourceProjectId, browserDraft.irId);
		demand(
			JSON.stringify(otherAfter) === JSON.stringify(otherBefore),
			"Cross-project observation mutated the independent business group",
		);
		await detached.close();
		return {
			sessions: after.sessions,
			worktree: after.worktree,
			round: after.round,
			actualInFlightSession: exact.sessionId,
			submittedMessageCount: 1,
			independentPage: { projectId: sourceProjectId, irId: browserDraft.irId, noCrossProjectMarker: true },
		};
	});
	await step("delivery-pr", async () => {
		await click(context, "approve-stage");
		const regenerated = await generateStage(context, projectId, imported.srId, "executing");
		const native = await nativeExecutionEvidence(regenerated, false);
		for (const kind of ["completion", "ut", "st"] as const)
			demand(
				regenerated.materials.some(item => item.kind === kind && item.valid && item.round === regenerated.round),
				`Reworked execution lacks current-round ${kind} evidence`,
			);
		await click(context, "approve-stage");
		const sr = await generateStage(context, projectId, imported.srId, "pr");
		assertRealMaterial(await materialContent(context, projectId, imported.irId, sr.id), "Delivery PR", [
			/--help|--version|帮助|版本/iu,
			/PR|交付|deliver/iu,
		]);
		const delivery = sr.materials.find(item => item.kind === "delivery" && item.valid && item.round === sr.round);
		demand(delivery, "No actual current delivery material is available to the unified menu");
		await selectMaterial(context, projectId, imported.irId, sr, delivery);
		return {
			materials: sr.materials,
			approvals: sr.approvals,
			reworkedExecution: { round: regenerated.round, native },
			readonlyDeliveryMenuPath: delivery.path,
		};
	});
	const initialCodePr = await step("code-pr-registration", async () => {
		await click(context, "push-development");
		const sr = await currentSr(context, projectId, imported.srId);
		const project = (await context.view(projectId)).projects.find(item => item.id === projectId)!;
		const repo = requireGit(sr.worktree!.path);
		const head = await repo.headSha();
		demand(head, "Code publication has no native Git HEAD");
		const changed = await repo.changedFiles({ base: sr.worktree!.baseCommit, head });
		const delivered = await committedManifest(sr.worktree!.path, head, changed);
		demand(
			!delivered.some(file =>
				/(?:^|\/)(?:\.omp|sessions?|chat|transcripts?|state\.json|registry-v1\.json)(?:\/|$)/iu.test(file.path),
			),
			"Code publication included private workflow/native-runtime state",
		);
		demand(
			delivered.some(file => file.path === "machine_info.py"),
			"Code PR publication did not commit the real implementation",
		);
		const request: AIReqMergeRequest = {
			kind: "code",
			projectId,
			irId: imported.irId,
			srId: sr.id,
			root: context.root,
			worktree: sr.worktree!.path,
			sourceBranch: sr.worktree!.branch,
			targetBranch: project.defaultBranch,
			files: delivered,
		};
		const prUrl = await context.codePrUrl(request);
		await fill(context, "code-pr-url", prUrl);
		await click(context, "code-pr-submit");
		const registered = await pollWorkflow(
			() => context.view(projectId),
			value => value.srs.some(item => item.id === sr.id && item.codePr?.url === prUrl),
			"Manual code PR registration",
			context.timeoutMs,
		);
		demand(
			registered.srs.find(item => item.id === sr.id)?.codePr?.platformVerified === false,
			"Code PR registration was mislabeled platform approval",
		);
		demand(registered.activeSrId === sr.id, "Waiting code PR released project slot early");
		const registration = completedOperation(registered, "markCodePrSubmitted", imported.irId, sr.id);
		demand(
			(await repo.headSha()) === head &&
				registered.srs.find(item => item.id === sr.id)?.stage === "pr" &&
				!registered.srs.find(item => item.id === sr.id)?.codeMerge,
			"PR registration committed code, advanced the phase or manufactured a merge fact",
		);
		await context.browser.page.reload();
		await waitVisible(context, `header[data-sr-id=${quoted(sr.id)}][data-stage="pr"]`);
		const recovered = await context.view(projectId, imported.irId, sr.id);
		const waiting = recovered.srs.find(item => item.id === sr.id)!;
		demand(
			recovered.activeSrId === sr.id &&
				waiting.status === "developing" &&
				waiting.codePr?.url === prUrl &&
				waiting.round === sr.round &&
				JSON.stringify(waiting.sessions) === JSON.stringify(sr.sessions) &&
				JSON.stringify(waiting.approvals) === JSON.stringify(sr.approvals) &&
				(await repo.headSha()) === head,
			"Browser recovery lost the waiting-PR slot, native identity or explicit approvals",
		);
		return { request, prUrl, delivered, registration, waitingPrRecovered: true };
	});
	const repairBack = await step("pr-repair-back", async () => {
		const before = await currentSr(context, projectId, imported.srId);
		demand(before.stage === "pr" && before.codePr && !before.codeMerge, "Repair must precede the actual code merge");
		const oldNative = await nativeExecutionEvidence(before, false);
		const bytes = await trackedWorktreeBytes(before.worktree!.path);
		const head = await requireGit(before.worktree!.path).headSha();
		const frozen = (await currentGroup(context, projectId, imported.irId)).snapshot;
		for (const kind of ["completion", "ut", "st", "delivery"] as const)
			demand(
				before.materials.some(item => item.kind === kind && item.valid),
				`PR lacks prior ${kind} authority`,
			);
		await click(context, "back-executing");
		const state = await pollWorkflow(
			() => context.view(projectId, imported.irId, imported.srId),
			value =>
				value.srs.some(
					item => item.id === before.id && item.stage === "executing" && item.round === before.round + 1,
				) && !value.running.some(ref => ref.srId === before.id),
			"Visible PR Back settles into a fresh execution round",
			context.timeoutMs,
		);
		const after = state.srs.find(item => item.id === before.id)!;
		const kept = await trackedWorktreeBytes(after.worktree!.path);
		demand(
			after.status === "developing" &&
				state.activeSrId === after.id &&
				after.worktree!.path === before.worktree!.path &&
				!after.codePr &&
				!after.codeMerge &&
				!after.materialDigest &&
				after.approvals.every(item => item.stage === "solution" || item.stage === "planning") &&
				before.approvals
					.filter(item => item.stage === "solution" || item.stage === "planning")
					.every(item => after.approvals.some(current => current.operationId === item.operationId)) &&
				!after.materials.some(item => (item.stage === "executing" || item.stage === "pr") && item.valid),
			"PR Back retained stale execution/delivery approvals, reports or PR authority",
		);
		demand(
			JSON.stringify([...kept]) === JSON.stringify([...bytes]) &&
				(await requireGit(after.worktree!.path).headSha()) === head &&
				JSON.stringify((await currentGroup(context, projectId, imported.irId)).snapshot) ===
					JSON.stringify(frozen) &&
				before.sessions.every(ref => after.sessions.some(current => current.sessionId === ref.sessionId)),
			"PR Back changed code, Git, frozen requirements or retained native references",
		);
		const receipt = completedOperation(state, "backStage", imported.irId, after.id);
		demand(
			receipt.steps.some(item => item.name === "back" && item.detail === `pr->executing:${after.round}`),
			"PR repair omitted the actual native Back checkpoint",
		);
		return {
			oldRound: before.round,
			newRound: after.round,
			oldNative,
			retainedCode: [...bytes],
			frozen,
			invalidatedMaterials: after.materials.filter(item => !item.valid),
			retainedApprovals: after.approvals,
			receipt,
			head,
		};
	});
	const repairedExecution = await step("pr-repair-real-ut-st", async () => {
		const option = context.business === DEV_VERSION_BUSINESS ? "--version" : "--help";
		const request = `Please repair the regression coverage for the existing approved ${option} requirement in the current executing round ${repairBack.newRound}. This explicitly authorizes only a narrowly bounded pre-merge correction under the SAME frozen IR/SR and approved plan: inspect the existing ${option} implementation and strengthen its Python regression tests to demonstrate the already-required successful exit, no machine probing and no file changes, while preserving no-argument output and --json/unknown-argument refusal. Add a concrete missing regression assertion or improve an existing assertion for that requirement; fix application code only if inspection exposes a genuine violation of it. No new option, feature, dependency or change to frozen requirements/solution/plan. Retain existing code, inspect for inconsistent old implementation remnants, and use actual native tools to edit the real Python tests. Run separate fresh real UT and subprocess/CLI ST tool calls in THIS round, recording exact commands, output, exit statuses and failures in separate ut.md/st.md. Old reports and model prose are not evidence of execution. Regenerate completion.md LAST. Phase approvals, publication, PR registration and merge remain exclusively user-owned actions outside this authorization. Inherited credentials, environment and capability URLs stay private.`;
		await send(context, request);
		const sr = await stageReady(context, projectId, imported.srId, "executing");
		demand(sr.round === repairBack.newRound, "Repair escaped its explicitly authorized execution round");
		const native = await nativeExecutionEvidence(sr);
		demand(
			native.checks.every(id => !repairBack.oldNative.checks.includes(id)) &&
				native.writes.every(id => !repairBack.oldNative.writes.includes(id)),
			"Repair reused old native implementation/UT/ST tool-call evidence",
		);
		const bytes = await trackedWorktreeBytes(sr.worktree!.path);
		const retainedCode = new Map(repairBack.retainedCode);
		const changedRegressionTests = [...bytes].filter(
			([file, hash]) => /test.*\.py$/u.test(file) && retainedCode.get(file) !== hash,
		);
		demand(
			changedRegressionTests.length > 0,
			"Explicit repair did not actually strengthen real Python regression tests",
		);
		for (const kind of ["completion", "ut", "st"] as const) {
			const file = sr.materials.find(item => item.kind === kind && item.valid && item.round === sr.round);
			demand(file, `Repair lacks fresh current-round ${kind} material`);
			const report = await context.material(projectId, imported.irId, file.path, sr.id);
			assertRealMaterial(report.content ?? "", `Repaired ${kind}`, [], 80);
		}
		demand(
			!sr.approvals.some(item => item.stage === "executing" || item.stage === "pr") &&
				!sr.codePr &&
				!sr.codeMerge &&
				JSON.stringify((await currentGroup(context, projectId, imported.irId)).snapshot) ===
					JSON.stringify(repairBack.frozen),
			"Repair implicitly approved delivery or changed frozen business authority",
		);
		return { round: sr.round, explicitRequest: request, native, materials: sr.materials, changedRegressionTests };
	});
	await step("pr-repair-reapproval", async () => {
		await click(context, "approve-stage");
		const sr = await generateStage(context, projectId, imported.srId, "pr");
		demand(
			sr.round === repairedExecution.round &&
				sr.approvals.some(item => item.stage === "executing" && item.round === sr.round) &&
				sr.materials.some(item => item.kind === "delivery" && item.valid && item.round === sr.round) &&
				!sr.codePr &&
				!sr.codeMerge,
			"Explicit repair reapproval did not produce fresh delivery authority without a fabricated PR/merge",
		);
		return { round: sr.round, approvals: sr.approvals, materials: sr.materials };
	});
	const codeMerge = await step("code-pr-resubmission", async () => {
		await click(context, "push-development");
		const sr = await currentSr(context, projectId, imported.srId);
		const repo = requireGit(sr.worktree!.path);
		const head = await repo.headSha();
		demand(head, "Repaired publication has no actual native Git HEAD");
		const changed = await repo.changedFiles({ base: sr.worktree!.baseCommit, head });
		const delivered = await committedManifest(sr.worktree!.path, head, changed);
		demand(
			!delivered.some(file =>
				/(?:^|\/)(?:\.omp|sessions?|chat|transcripts?|state\.json|registry-v1\.json)(?:\/|$)/iu.test(file.path),
			),
			"Repaired publication included private workflow/native-runtime state",
		);
		const request: AIReqMergeRequest = { ...initialCodePr.request, files: delivered };
		await assertMergeManifest(sr.worktree!.path, head, request);
		await fill(context, "code-pr-url", initialCodePr.prUrl);
		await click(context, "code-pr-submit");
		const registered = await pollWorkflow(
			() => context.view(projectId),
			value => value.srs.some(item => item.id === sr.id && item.codePr?.url === initialCodePr.prUrl),
			"Explicit repaired code PR resubmission",
			context.timeoutMs,
		);
		const submitted = registered.srs.find(item => item.id === sr.id)!;
		const registration = completedOperation(registered, "markCodePrSubmitted", imported.irId, sr.id);
		demand(
			submitted.round === repairedExecution.round &&
				submitted.stage === "pr" &&
				submitted.codePr?.platformVerified === false &&
				!submitted.codeMerge &&
				registered.activeSrId === sr.id &&
				(await repo.headSha()) === head &&
				registration.operationId !== initialCodePr.registration.operationId,
			"Repair resubmission reused the old registration, lost its slot or manufactured a merge/platform approval",
		);
		const receipt = await context.manualMerge(request);
		demand(
			receipt.kind === "code" &&
				receipt.irId === imported.irId &&
				receipt.srId === sr.id &&
				receipt.prUrl === initialCodePr.prUrl &&
				receipt.platformVerified === false,
			"Actual repaired merge receipt differs from the explicitly resubmitted code PR",
		);
		return { ...receipt, delivered, registration, sourceCommit: head };
	});
	await step("code-exact-merge", async () => {
		const before = await currentSr(context, projectId, imported.srId);
		const bytes = await trackedWorktreeBytes(before.worktree!.path);
		const branch = await workflowGit(before.worktree!.path, ["symbolic-ref", "--short", "HEAD"]);
		const journals = await Promise.all(
			before.sessions.map(async ref => ({ ref, bytes: await fs.readFile(ref.sessionFile) })),
		);
		await click(context, "code-merged");
		const completed = await pollWorkflow(
			() => context.view(projectId),
			value =>
				value.srs.some(item => item.id === imported.srId && item.status === "completed" && item.codeMerge) &&
				!value.activeSrId &&
				!value.running.some(item => item.srId === imported.srId),
			"Git code merge plus recursive settlement",
			context.timeoutMs,
		);
		const sr = completed.srs.find(item => item.id === imported.srId)!;
		demand(sr.codeMerge!.commit === codeMerge.commit, "Git-confirmed code target differs from manual receipt");
		assertExactVersions(
			sr.codeMerge!.files,
			codeMerge.delivered,
			"Git completion application/test/report/deletion authority",
		);
		demand(
			!(await requireGit(sr.worktree!.path).hasDiff({
				base: "HEAD",
				head: sr.codeMerge!.commit,
				files: codeMerge.delivered.map(file => file.path),
			})),
			"Git completion changed delivered content or modes",
		);
		const receipt = completedOperation(completed, "markCodeMerged", imported.irId, imported.srId);
		demand(
			receipt.steps.some(item => item.name === "code-merged" && item.detail === sr.codeMerge!.commit),
			"Code completion omitted its actual exact-Git settlement checkpoint",
		);
		demand(
			sr.worktree?.path === before.worktree!.path &&
				(await workflowGit(sr.worktree.path, ["symbolic-ref", "--short", "HEAD"])) === branch &&
				JSON.stringify([...(await trackedWorktreeBytes(sr.worktree.path))]) === JSON.stringify([...bytes]),
			"Completion cleaned, rewrote or switched the retained development checkout",
		);
		for (const journal of journals) {
			const retained = await fs.readFile(journal.ref.sessionFile);
			demand(
				sr.sessions.some(
					ref => ref.sessionId === journal.ref.sessionId && ref.sessionFile === journal.ref.sessionFile,
				) && retained.subarray(0, journal.bytes.length).equals(journal.bytes),
				"Completion discarded or rewrote actual native history",
			);
		}
		await waitVisible(context, `header[data-sr-id=${quoted(sr.id)}]`);
		await pollWorkflow(
			() => domObservation(context.browser.page),
			observation => /自行清理 worktree/u.test(observation.text),
			"Completed checkout cleanup remains an explicit user decision",
			context.timeoutMs,
		);
		demand(
			!(await present(
				context.browser.page,
				'[data-testid="back-solution"],[data-testid="back-planning"],[data-testid="back-executing"],[data-testid="stage-approve"],[data-testid="start-sr"],[data-testid="v4-composer-input"][contenteditable="true"]',
			)),
			"Completed SR exposed a write/Back/start surface",
		);
		return {
			codeMerge: sr.codeMerge,
			platformVerified: false,
			mode: codeMerge.mode,
			slotReleased: true,
			receipt,
			worktreeRetained: sr.worktree,
			retainedNativeSessions: journals.map(item => item.ref.sessionId),
			cleanupIsManual: true,
		};
	});
	await step("completed-back-refusal", async () => {
		const before = await context.view(projectId, imported.irId, imported.srId);
		const sr = before.srs.find(item => item.id === imported.srId)!;
		demand(
			sr.status === "completed" && sr.codeMerge && !before.activeSrId,
			"Back refusal requires a genuinely completed SR",
		);
		const absent = '[data-testid="back-solution"],[data-testid="back-planning"],[data-testid="back-executing"]';
		demand(!(await present(context.browser.page, absent)), "Completed SR unexpectedly exposes a Back control");
		const bytes = await trackedWorktreeBytes(sr.worktree!.path);
		const head = await requireGit(sr.worktree!.path).headSha();
		const branch = await workflowGit(sr.worktree!.path, ["symbolic-ref", "--short", "HEAD"]);
		const journals = await Promise.all(
			sr.sessions.map(async ref => ({ ref, bytes: await fs.readFile(ref.sessionFile) })),
		);
		const refusal = await context.completedBack({
			projectId,
			irId: imported.irId,
			srId: sr.id,
			expectedRevision: before.revision,
		});
		demand(
			(refusal.httpStatus === 409 || refusal.status === "failed") &&
				/SR is not the active developing SR/u.test(refusal.error ?? ""),
			`Completed Back was not refused by the documented terminal-state gate: ${JSON.stringify(refusal)}`,
		);
		const after = await context.view(projectId, imported.irId, imported.srId);
		const retained = after.srs.find(item => item.id === sr.id)!;
		demand(
			JSON.stringify(retained) === JSON.stringify(sr) &&
				!after.activeSrId &&
				!after.running.some(ref => ref.srId === sr.id) &&
				JSON.stringify(after.sessions) === JSON.stringify(before.sessions) &&
				(await requireGit(sr.worktree!.path).headSha()) === head &&
				(await workflowGit(sr.worktree!.path, ["symbolic-ref", "--short", "HEAD"])) === branch &&
				JSON.stringify([...(await trackedWorktreeBytes(sr.worktree!.path))]) === JSON.stringify([...bytes]),
			"Rejected completed Back reopened the SR, consumed a slot, started work or mutated retained code/Git/history references",
		);
		for (const journal of journals)
			demand(
				(await fs.readFile(journal.ref.sessionFile)).equals(journal.bytes),
				"Rejected completed Back changed native history",
			);
		await context.browser.page.reload();
		await waitVisible(context, `header[data-sr-id=${quoted(sr.id)}]`);
		await pollWorkflow(
			() => domObservation(context.browser.page),
			value => /流程已结束/u.test(value.text) && /自行清理 worktree/u.test(value.text),
			"Completed SR remains terminal and manually cleanable after refused Back/reload",
			context.timeoutMs,
		);
		demand(
			!(await present(context.browser.page, absent)),
			"Refused Back/reload reintroduced completed Back controls",
		);
		return {
			control: "deliberately absent; authenticated existing workflow/command API refusal observed",
			refusal,
			completedStateRetained: true,
			slotReleased: true,
			running: after.running,
			worktree: retained.worktree,
			retainedNativeSessions: journals.map(item => item.ref.sessionId),
			head,
			branch,
		};
	});
	await step("project-isolation", async () => {
		await click(context, "settings");
		await fill(context, "project-root", context.secondaryProject);
		await fill(context, "project-name", "Isolated secondary acceptance project");
		await click(context, "register-project");
		await click(context, "settings-close");
		const next = await pollWorkflow(
			() => context.view(),
			value => value.projects.some(project => path.resolve(project.root) === path.resolve(context.secondaryProject)),
			"Isolated project registration",
			context.timeoutMs,
		);
		const secondary = next.projects.find(item => path.resolve(item.root) === path.resolve(context.secondaryProject));
		demand(secondary && secondary.id !== projectId, "Second project did not register separately");
		await selectValue(context, "project", secondary.id);
		const isolated = await context.view(secondary.id);
		demand(
			!isolated.groups.some(item => item.id === imported.irId) &&
				!isolated.srs.some(item => item.id === imported.srId),
			"Project B exposed Project A objects",
		);
		await pollWorkflow(
			() =>
				context.browser.page.evaluate<boolean>(
					`document.querySelector(${quoted(selector("project"))}).value===${quoted(secondary.id)}&&!document.querySelector(${quoted(`button[data-ir-id=${quoted(imported.irId)}]`)})`,
				),
			Boolean,
			"Rendered project isolation",
			context.timeoutMs,
		);
		await context.browser.page.reload();
		await waitVisible(context, selector("workbench"));
		demand(
			await context.browser.page.evaluate<boolean>(
				`document.querySelector(${quoted(selector("project"))}).value===${quoted(secondary.id)}`,
			),
			"Browser reconnect lost the selected project",
		);
		demand(
			(await context.view(secondary.id)).projects.some(item => item.id === projectId),
			"Project registry did not survive browser reconnect",
		);
		return { primary: projectId, secondary: secondary.id };
	});
	await step("native-settings-skills", async () => {
		await click(context, "native-settings");
		await waitVisible(context, selector("native-settings-panel"));
		await click(context, "settings-section-nav-skill");
		const observed = await domObservation(context.browser.page);
		demand(
			/Skill/iu.test(observed.text) && /MCP|模型|model/iu.test(observed.text),
			"Copied native settings/Skill capabilities missing",
		);
		await click(context, "native-settings-close");
		return {
			retainedNativeSettings: true,
			retainedSkillSurface: true,
			textOnlyModel: true,
			imageInference: "not claimed: catalog Beam Free is text-only",
		};
	});
	await step("stop-settlement", async () => {
		await selectValue(context, "project", projectId);
		await selectValue(context, "release-select", primaryRelease);
		await selectObject(context, local.irId);
		await click(context, "stop");
		const settled = await pollWorkflow(
			() => context.view(projectId),
			value => value.running.length === 0 && !value.activeSrId,
			"No surviving native actors or active SR",
			context.timeoutMs,
		);
		return { running: settled.running, activeSrId: settled.activeSrId ?? null, retainedSessions: settled.sessions };
	});
	return items;
}
