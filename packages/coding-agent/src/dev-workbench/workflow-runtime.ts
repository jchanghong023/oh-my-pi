import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prompt } from "@oh-my-pi/pi-utils";
import outputContractTemplate from "../prompts/agents/dev-output-contract.md" with { type: "text" };
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions";
import type { CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { loadSessionFile, readSessionHeaderId } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";
import {
	createDevNativeActor,
	cancelSpecDescendantJobs,
	devNativeSessionOptions,
	type DevNativeActor,
	type DevNativeInputKind,
} from "../spec-driven/actors";
import {
	assertKeys,
	buildRequirementSnapshot,
	canonicalJson,
	safeMaterialPath,
	sha256,
	stableId,
} from "./requirement-package";
import type {
	DevAttachment,
	DevDocument,
	DevNativeSessionRef,
	DevRequirementContent,
	DevRequirementSnapshot,
	DevWorkflowStage,
} from "./workflow-types";

export interface DevWorkflowBinding {
	projectId: string;
	irId: string;
	srId?: string;
	phase: "requirements" | DevWorkflowStage;
	round: number;
}
export interface DevFrozenFile extends DevAttachment {
	digest: string;
}
export interface DevFrozenAuthority {
	digest: string;
	files: DevFrozenFile[];
	roots: string[];
}
export interface DevWorkflowPreparation {
	binding: DevWorkflowBinding;
	cwd?: string;
	outputPaths: string[];
	authority?: DevFrozenAuthority;
	contextFiles?: DevDocument[];
	decisions?: unknown;
	sessionRef?: DevNativeSessionRef;
	/** Explicit host admission only; ordinary post-delivery chat remains read-only. */
	authorizeWrites?: boolean;
	/** Recover only the exact persisted journal for viewing after its phase has ended. */
	readonlyRecovery?: boolean;
}
export interface DevNativeReviewReport {
	snapshotDigest: string;
	verdict: "pass" | "changes-required";
	findings: string[];
}
export interface DevWorkflowRuntime {
	prepare(input: DevWorkflowPreparation): Promise<DevNativeSessionRef>;
	submit(ref: DevNativeSessionRef, text: string): Promise<void>;
	runInput<T>(ref: DevNativeSessionRef, operation: () => Promise<T>, kind?: DevNativeInputKind): Promise<T>;
	review(input: {
		binding: DevWorkflowBinding;
		cwd?: string;
		files: DevFrozenFile[];
		snapshot: DevRequirementSnapshot;
		outputPath: string;
		contextFiles?: DevDocument[];
		decisions?: unknown;
	}): Promise<{ ref: DevNativeSessionRef; report: DevNativeReviewReport; snapshotDigest: string }>;
	session(ref: DevNativeSessionRef): AgentSession;
	references(): DevNativeSessionRef[];
	assertAuthority(ref: DevNativeSessionRef): Promise<void>;
	/** Settle all owned native work; boundary errors stay locked without preventing completed cleanup. */
	stop(binding?: DevWorkflowBinding): Promise<void>;
	back(binding: DevWorkflowBinding): Promise<void>;
	dispose(): Promise<void>;
}

const exec = promisify(execFile);
const roots = new WeakMap<AgentSession, { projectId: string; owners: number }>();
const ignored = new Set([".git", "node_modules", ".omp"]);
const readonlyTools = new Set([
	"read",
	"grep",
	"glob",
	"find",
	"web_search",
	"knowledge_search",
	"openwiki_search",
	"openwiki_read",
	"ask",
	"wait",
	"yield",
]);
function bindingKey(binding: DevWorkflowBinding): string {
	return canonicalJson({
		projectId: binding.projectId,
		irId: binding.irId,
		srId: binding.srId,
		phase: binding.phase,
		round: binding.round,
	});
}
function roleFor(phase: DevWorkflowBinding["phase"]): "requirements" | "solution" | "planner" | "executor" {
	return phase === "planning" ? "planner" : phase === "executing" || phase === "pr" ? "executor" : phase;
}
async function repository(cwd: string): Promise<string> {
	const result = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd,
		windowsHide: true,
	});
	return fs.realpath(result.stdout.trim());
}
function samePath(a: string, b: string): boolean {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
async function materialPath(cwd: string, relative: string): Promise<string> {
	safeMaterialPath(relative);
	const root = await fs.realpath(cwd);
	const target = path.resolve(root, relative);
	let ancestor = target;
	const missing: string[] = [];
	for (;;) {
		try {
			ancestor = await fs.realpath(ancestor);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			missing.unshift(path.basename(ancestor));
			const parent = path.dirname(ancestor);
			if (parent === ancestor) throw error;
			ancestor = parent;
		}
	}
	const actual = path.join(ancestor, ...missing);
	if (!samePath(target, actual)) throw new Error(`Material aliases are not permitted: ${relative}`);
	const local = path.relative(root, actual);
	if (local.startsWith("..") || path.isAbsolute(local)) throw new Error(`Material escapes worktree: ${relative}`);
	try {
		if ((await fs.stat(target)).nlink > 1) throw new Error(`Hard-linked material is not permitted: ${relative}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return target;
}

/** Exact bytes and membership, including nested files, are authoritative; symlink aliases are rejected. */
export async function assertDevFrozenAuthority(cwd: string, authority: DevFrozenAuthority): Promise<void> {
	if (!/^[a-f0-9]{64}$/.test(authority.digest) || !authority.files.length || !authority.roots.length)
		throw new Error("Frozen requirement authority is incomplete");
	const expected = new Map<string, string>();
	for (const file of authority.files) {
		const normalized = safeMaterialPath(file.path);
		if (expected.has(normalized) || sha256(file.content) !== file.digest)
			throw new Error(`Invalid frozen snapshot: ${file.path}`);
		expected.set(normalized, file.digest);
	}
	const found = new Set<string>();
	const walk = async (relative: string): Promise<void> => {
		const absolute = await materialPath(cwd, relative);
		const stat = await fs.lstat(absolute);
		if (stat.isSymbolicLink()) throw new Error(`Frozen requirement alias: ${relative}`);
		if (stat.isDirectory()) {
			for (const child of await fs.readdir(absolute)) await walk(`${relative}/${child}`);
			return;
		}
		if (!stat.isFile() || !expected.has(relative))
			throw new Error(`Unexpected frozen requirement member: ${relative}`);
		if (sha256(await fs.readFile(absolute)) !== expected.get(relative))
			throw new Error(`Frozen requirement changed: ${relative}`);
		found.add(relative);
	};
	for (const root of authority.roots) await walk(safeMaterialPath(root));
	for (const file of expected.keys())
		if (!found.has(file)) throw new Error(`Frozen requirement missing from whole-set authority: ${file}`);
}

/** Phase snapshots catch opaque shell/MCP/extension writes without stripping native capabilities. */
async function phaseSnapshot(cwd: string, allowed: ReadonlySet<string>): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	const walk = async (directory: string, prefix: string): Promise<void> => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (ignored.has(entry.name)) continue;
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				result.set(relative, `link:${await fs.readlink(absolute)}`);
				continue;
			}
			if (entry.isDirectory()) await walk(absolute, relative);
			else if (entry.isFile() && !allowed.has(relative)) result.set(relative, sha256(await fs.readFile(absolute)));
		}
	};
	await walk(cwd, "");
	return result;
}
function assertPhaseUnchanged(before: Map<string, string>, after: Map<string, string>): void {
	const changes = [...new Set([...before.keys(), ...after.keys()])].filter(
		file => before.get(file) !== after.get(file),
	);
	if (changes.length)
		throw new Error(
			`Native phase write boundary violated; files retained, formal output rejected: ${changes.join(", ")}`,
		);
}

async function originalSpecifications(cwd: string): Promise<DevDocument[]> {
	const documents: DevDocument[] = [];
	const walk = async (relative: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(path.join(cwd, relative), { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const file = `${relative}/${entry.name}`;
			if (entry.isSymbolicLink())
				throw new Error(`Original specification aliases require explicit resolution: ${file}`);
			if (entry.isDirectory()) await walk(file);
			else if (entry.isFile() && entry.name.endsWith(".md"))
				documents.push({ path: file, content: await fs.readFile(path.join(cwd, file), "utf8") });
		}
	};
	for (const root of ["openspec/specs", "requirements", "docs/requirements", "docs-zh-CN/requirements"])
		await walk(root);
	return documents.sort((a, b) => a.path.localeCompare(b.path));
}

interface DevWorkflowInteractionUI {
	ui: ExtensionUIContext;
	cancel(): void;
	dispose(): void;
}

export async function createDevWorkflowRuntime(args: {
	projectId: string;
	rootSession: AgentSession;
	settings: Settings;
	cwd: string;
	/** Capability-only parents are borrowed; their ordinary queues/Goal remain host-owned. */
	ownsRoot?: boolean;
	createInteractionUI?: (
		origin: Parameters<NonNullable<CreateAgentSessionOptions["createInteractionUI"]>>[0],
		owner: DevNativeSessionRef,
	) => DevWorkflowInteractionUI;
	uiForSession?: (session: AgentSession, owner: DevNativeSessionRef) => ExtensionUIContext;
	onSessionCreated?: (ref: DevNativeSessionRef, session: AgentSession) => void;
	assertCurrent: (binding: DevWorkflowBinding) => Promise<void>;
}): Promise<DevWorkflowRuntime> {
	stableId(args.projectId);
	const cwd = await fs.realpath(args.cwd);
	const common = await repository(cwd);
	if (!samePath(common, await repository(await fs.realpath(args.rootSession.sessionManager.getCwd()))))
		throw new Error("Dev native root belongs to another project repository");
	const previous = roots.get(args.rootSession);
	if (previous && previous.projectId !== args.projectId)
		throw new Error("A native root cannot be reused by another Dev project");
	roots.set(args.rootSession, { projectId: args.projectId, owners: (previous?.owners ?? 0) + 1 });
	type Entry = {
		ref: DevNativeSessionRef;
		actor: DevNativeActor;
		cwd: string;
		input: DevWorkflowPreparation;
		baseline?: Map<string, string>;
		baselineLoading?: Promise<void>;
		inputs?: number;
		locked?: Error;
		stopped: boolean;
		writable: boolean;
		release(): void;
		reportVersion?: string;
		baselineOutputs?: ReadonlySet<string>;
		reviewComplete?: boolean;
	};
	const entries = new Map<string, Entry>();
	const preparing = new Map<string, Promise<DevNativeSessionRef>>();
	let closing = false;
	let disposed = false;
	let failure: Error | undefined;
	const open = () => {
		if (closing || disposed || failure) throw failure ?? new Error("Dev native runtime is closed");
	};
	const keyFor = (binding: DevWorkflowBinding, reviewer = false) =>
		`${bindingKey(binding)}:${reviewer ? "reviewer" : roleFor(binding.phase)}`;
	const get = (ref: DevNativeSessionRef): Entry => {
		if (ref.projectId !== args.projectId) throw new Error("Native session project mismatch");
		const entry = entries.get(keyFor(ref, ref.role === "reviewer"));
		if (!entry || canonicalJson(entry.ref) !== canonicalJson(ref))
			throw new Error("Native session binding or history is unavailable");
		return entry;
	};
	const check = async (entry: Entry, admit = true): Promise<void> => {
		if (entry.locked) throw entry.locked;
		if (admit && (entry.stopped || closing || disposed || failure))
			throw failure ?? new Error("Native round has stopped");
		if (admit) await args.assertCurrent(entry.ref);
		try {
			if (entry.input.authority && !entry.reviewComplete)
				await assertDevFrozenAuthority(entry.cwd, entry.input.authority);
			if (entry.baseline)
				assertPhaseUnchanged(
					entry.baseline,
					await phaseSnapshot(entry.cwd, entry.baselineOutputs ?? new Set(entry.input.outputPaths)),
				);
		} catch (error) {
			entry.locked = error instanceof Error ? error : new Error(String(error));
			entry.writable = false;
			throw entry.locked;
		}
	};
	const prepare = async (requested: DevWorkflowPreparation, reviewer = false): Promise<DevNativeSessionRef> => {
		open();
		const input = structuredClone(requested);
		const binding: DevWorkflowBinding = {
			projectId: input.binding.projectId,
			irId: input.binding.irId,
			srId: input.binding.srId,
			phase: input.binding.phase,
			round: input.binding.round,
		};
		input.binding = binding;
		if (binding.projectId !== args.projectId) throw new Error("Native admission project mismatch");
		stableId(binding.irId);
		if (binding.srId) stableId(binding.srId);
		if (!Number.isSafeInteger(binding.round) || binding.round < 0) throw new Error("Invalid native round");
		if (binding.phase !== "requirements" && !binding.srId) throw new Error("Technical phase requires an exact SR");
		if (input.readonlyRecovery && (!input.sessionRef || input.authorizeWrites || reviewer))
			throw new Error("Read-only recovery requires an exact saved session and cannot authorize writes");
		const key = keyFor(binding, reviewer);
		const existing = entries.get(key);
		if (existing && !existing.stopped && !input.readonlyRecovery) {
			if (input.sessionRef && canonicalJson(input.sessionRef) !== canonicalJson(existing.ref))
				throw new Error("Native recovery binding mismatch");
			await check(existing);
			if (input.authority && canonicalJson(existing.input.authority) !== canonicalJson(input.authority))
				throw new Error("A native round cannot change frozen authority");
			if (input.authorizeWrites) existing.writable = true;
			return { ...existing.ref };
		}
		if (existing) {
			if (existing.locked) throw existing.locked;
			if (input.sessionRef && canonicalJson(input.sessionRef) !== canonicalJson(existing.ref))
				throw new Error("Native recovery binding mismatch");
			if (input.authority && canonicalJson(existing.input.authority) !== canonicalJson(input.authority))
				throw new Error("A native round cannot change frozen authority");
			if (!input.readonlyRecovery) await args.assertCurrent(binding);
			await existing.actor.dispose();
			existing.release();
			entries.delete(key);
			input.sessionRef ??= existing.ref;
		}
		const pending = preparing.get(key);
		if (pending) {
			const ref = await pending;
			return input.readonlyRecovery ? prepare(input, reviewer) : ref;
		}
		const operation = (async () => {
			const actorCwd = await fs.realpath(input.cwd ?? cwd);
			const draftCwd = path.join(common, "omp-dev-workflow-v1", "drafts", binding.irId);
			const managedDraft = binding.phase === "requirements" && samePath(actorCwd, draftCwd);
			if (!managedDraft && !samePath(await repository(actorCwd), common))
				throw new Error("Native worktree belongs to another project");
			const outputs = [...new Set(input.outputPaths.map(safeMaterialPath))];
			for (const output of outputs) await materialPath(actorCwd, output);
			input.outputPaths = outputs;
			if (!reviewer && binding.phase !== "requirements" && !input.authority)
				throw new Error("Technical phase requires frozen whole-group authority");
			if (input.authority) await assertDevFrozenAuthority(actorCwd, input.authority);
			if (!input.readonlyRecovery) await args.assertCurrent(binding);
			const role = reviewer ? "reviewer" : roleFor(binding.phase);
			const creationBaseline =
				role !== "executor" || binding.phase === "pr" ? await phaseSnapshot(actorCwd, new Set(outputs)) : undefined;
			const completionPath =
				binding.phase === "executing" ? outputs.find(file => /(?:^|\/)completion\.md$/.test(file)) : undefined;
			const reportVersion = async (): Promise<string | undefined> => {
				if (!completionPath) return undefined;
				try {
					return sha256(await fs.readFile(await materialPath(actorCwd, completionPath)));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
					throw error;
				}
			};
			const initialReportVersion = await reportVersion();
			const saved = input.sessionRef;
			if (saved) {
				if (bindingKey(saved) !== bindingKey(binding) || saved.role !== (reviewer ? "reviewer" : binding.phase))
					throw new Error("Native recovery binding mismatch");
				const history = await loadSessionFile(saved.sessionFile, undefined, { throwIfMissing: true });
				if (
					history.invalidHeader ||
					history.malformedRecords ||
					(await readSessionHeaderId(saved.sessionFile)) !== saved.sessionId
				)
					throw new Error("Native history is missing, malformed, or has another session ID");
				if (
					!history.entries.some(
						entry =>
							entry.type === "custom" &&
							entry.customType === "dev-workflow-binding" &&
							canonicalJson(entry.data) === canonicalJson(binding),
					)
				)
					throw new Error("Native history has no matching project/object/phase/round journal");
				const header = history.entries.find(entry => entry.type === "session");
				if (!header || header.type !== "session" || !samePath(await fs.realpath(header.cwd), actorCwd))
					throw new Error("Native history worktree does not match this object");
			}
			// Native journal lineage, registry ownership and interaction routing share
			// the actual requirements actor; the capability root is not its reviewer.
			const parent = reviewer
				? entries.get(keyFor({ ...binding, phase: "requirements", srId: undefined }))?.actor
				: undefined;
			if (reviewer && !parent) throw new Error("Independent reviewer requires its real requirements actor parent");
			const directory = path.join(
				args.rootSession.sessionManager.getSessionDir() ||
					SessionManager.getDefaultSessionDir(cwd, args.settings.getAgentDir()),
				"dev-workflow",
				args.projectId,
				binding.irId,
				binding.srId ?? "requirements",
			);
			const manager = await SessionManager.open(
				saved?.sessionFile ??
					path.join(directory, `${binding.phase}-${role}-${binding.round}-${crypto.randomUUID()}.jsonl`),
				directory,
				undefined,
				{
					initialCwd: actorCwd,
					parentSession:
						parent?.session.sessionFile ??
						parent?.session.sessionId ??
						args.rootSession.sessionFile ??
						args.rootSession.sessionId,
					suppressBreadcrumb: true,
				},
			);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Dev native journal persistence is unavailable");
			const nativeOwner: DevNativeSessionRef = {
				...binding,
				role: reviewer ? "reviewer" : binding.phase,
				sessionId: manager.getSessionId(),
				sessionFile,
			};
			const createInteractionUI = args.createInteractionUI;
			const inherited = await devNativeSessionOptions({
				root: args.rootSession,
				settings: args.settings,
				cwd: actorCwd,
				sessionManager: manager,
				role,
				createInteractionUI: createInteractionUI
					? origin => {
							const owner = entries.get(key);
							if (closing || disposed || owner?.stopped || owner?.locked)
								throw new Error("Native interaction owner is no longer active");
							return createInteractionUI(origin, nativeOwner);
						}
					: undefined,
			});
			if (managedDraft) {
				inherited.options.contextFiles = [...(args.rootSession.loadedProjectContext?.contextFiles ?? [])];
				inherited.options.rules = [...(args.rootSession.loadedProjectContext?.activeRules ?? [])];
				inherited.options.additionalDirectories = [
					...new Set([cwd, ...(inherited.options.additionalDirectories ?? [])]),
				];
			}
			if (parent) {
				inherited.options.parentAgentId = parent.id;
				inherited.options.interactionParentSessionId = parent.session.sessionId;
			}
			// An owned stage actor gets its real UI once its actual AgentSession exists.
			// The inherited factory remains on ToolSession for arbitrary-depth native children;
			// it must not mistake the ordinary capability parent for a workflow conversation.
			if (args.uiForSession) delete inherited.options.interactionParentSessionId;
			let entry: Entry;
			const suppliedContext = new Map(
				(await originalSpecifications(managedDraft ? cwd : actorCwd)).map(document => [document.path, document]),
			);
			for (const document of input.contextFiles ?? []) suppliedContext.set(document.path, document);
			const context = canonicalJson({
				binding,
				role,
				projectRoot: cwd,
				worktree: actorCwd,
				outputPaths: outputs,
				methods: inherited.methods,
				authority: input.authority
					? {
							...input.authority,
							files: input.authority.files.map(file => {
								if (typeof file.content === "string") return file;
								if (/\.(?:md|json|txt)$/i.test(file.path))
									return {
										...file,
										content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.content),
									};
								return {
									path: file.path,
									digest: file.digest,
									size: file.content.byteLength,
									binary: true,
									instruction: prompt.render(outputContractTemplate, { attachment: true }).trim(),
								};
							}),
						}
					: null,
				contextFiles: [...suppliedContext.values()],
				decisions: input.decisions ?? null,
				outputContract: prompt
					.render(outputContractTemplate, {
						reviewer,
						requirements: binding.phase === "requirements",
						solution: binding.phase === "solution",
						planning: binding.phase === "planning",
						pr: binding.phase === "pr",
					})
					.trim(),
			});
			try {
				const actor = await createDevNativeActor({
					name: role,
					options: inherited.options,
					context,
					uiForSession: args.uiForSession ? session => args.uiForSession!(session, nativeOwner) : undefined,
					check: async (name, raw) => {
						if (!entry) throw new Error("Native actor admission is not initialized");
						await check(entry);
						if (!entry.writable && !readonlyTools.has(name) && name !== "dev-input")
							throw new Error(
								"Native delivery is read-only; explicit phase authorization is required for further writes",
							);
						if (name === "write" || name === "edit") {
							const target = raw && typeof raw === "object" && "path" in raw ? raw.path : undefined;
							if (typeof target !== "string") throw new Error("Native file write requires an exact path");
							const relative = path.relative(actorCwd, path.resolve(actorCwd, target)).replaceAll("\\", "/");
							await materialPath(actorCwd, relative);
							if (input.authority?.roots.some(root => relative === root || relative.startsWith(`${root}/`)))
								throw new Error(`Frozen requirement write denied: ${relative}`);
							if ((role !== "executor" || binding.phase === "pr") && !outputs.includes(relative))
								throw new Error(`Phase write denied: ${relative}`);
						}
					},
					afterTool: async () => {
						if (!entry) return;
						await check(entry, false);
						const version = await reportVersion();
						if (version !== entry.reportVersion) {
							entry.reportVersion = version;
							if (version) {
								entry.writable = false;
								entry.baselineOutputs = new Set();
								entry.baseline = await phaseSnapshot(entry.cwd, entry.baselineOutputs);
								if (entry.actor.session.getGoalModeState()?.enabled)
									await entry.actor.session.goalRuntime.pauseGoal();
							}
						}
					},
					afterStop: async () => {
						if (!entry) return;
						try {
							await check(entry, false);
						} catch (error) {
							// A boundary lock rejects work and capture, not completed cleanup.
							// Actor.stop has already aborted and awaited all owned native work.
							if (!entry.locked || error !== entry.locked) throw error;
						}
					},
				});
				inherited.bind(actor.session);
				if (!actor.session.sessionFile) throw new Error("Dev native journal persistence is unavailable");
				const ref: DevNativeSessionRef = {
					...binding,
					role: reviewer ? "reviewer" : binding.phase,
					sessionId: actor.session.sessionId,
					sessionFile: actor.session.sessionFile,
				};
				if (ref.sessionId !== nativeOwner.sessionId || ref.sessionFile !== nativeOwner.sessionFile)
					throw new Error("Native actor changed its reserved session identity");
				entry = {
					ref,
					actor,
					cwd: actorCwd,
					input,
					baseline: creationBaseline,
					reportVersion: initialReportVersion,
					stopped: input.readonlyRecovery === true,
					writable: !input.readonlyRecovery && (!initialReportVersion || input.authorizeWrites === true),
					release: inherited.dispose,
				};
				entries.set(key, entry);
				await check(entry, false);
				entry.baseline = undefined;
				if (!saved) actor.session.sessionManager.appendCustomEntry("dev-workflow-binding", binding);
				args.onSessionCreated?.({ ...ref }, actor.session);
				if (closing) {
					await actor.stop();
					entry.stopped = true;
					throw new Error("Native preparation interrupted by settlement");
				}
				return { ...ref };
			} catch (error) {
				inherited.dispose();
				throw error;
			}
		})();
		preparing.set(key, operation);
		try {
			return await operation;
		} finally {
			preparing.delete(key);
		}
	};
	const stop = async (binding?: DevWorkflowBinding) => {
		closing = true;
		await Promise.allSettled(preparing.values());
		const selected = [...entries.values()].filter(
			entry => !binding || (entry.ref.irId === binding.irId && (!binding.srId || entry.ref.srId === binding.srId)),
		);
		for (const entry of selected) {
			entry.stopped = true;
			entry.writable = false;
		}
		const settled = await Promise.allSettled([
			...selected.map(entry => entry.actor.stop()),
			(async () => {
				if (!args.ownsRoot) return;
				if (args.rootSession.getGoalModeState()?.enabled) await args.rootSession.goalRuntime.pauseGoal();
				args.rootSession.clearQueue();
				await args.rootSession.abort({ clearQueuedInputs: true });
				if (args.rootSession.asyncJobManager) {
					const ownerId = args.rootSession.getAgentId();
					if (!ownerId) throw new Error("Native project root has no registry identity for settlement");
					if (
						!(await cancelSpecDescendantJobs(
							args.rootSession.asyncJobManager,
							ownerId,
							args.rootSession.agentRegistry,
						))
					)
						throw new Error("Native project root did not settle");
				}
			})(),
		]);
		const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
		if (rejected.length) {
			failure = new AggregateError(
				rejected.map(item => item.reason),
				"Native settlement failed; owner remains locked and files retained",
			);
			throw failure;
		}
		closing = false;
	};
	const runInput = async <T>(
		ref: DevNativeSessionRef,
		operation: () => Promise<T>,
		kind: DevNativeInputKind = "prompt",
	): Promise<T> => {
		open();
		const entry = get(ref);
		await check(entry);
		const first = !entry.inputs;
		entry.inputs = (entry.inputs ?? 0) + 1;
		try {
			if (first && (ref.phase !== "executing" || !entry.writable)) {
				entry.baselineOutputs = new Set(entry.writable ? entry.input.outputPaths : []);
				entry.baselineLoading = phaseSnapshot(entry.cwd, entry.baselineOutputs).then(snapshot => {
					entry.baseline = snapshot;
				});
			}
			await entry.baselineLoading;
			const value = await entry.actor.runInput(operation, kind);
			await check(entry);
			return value;
		} finally {
			entry.inputs--;
			if (!entry.inputs) {
				entry.baseline = undefined;
				entry.baselineLoading = undefined;
				entry.baselineOutputs = undefined;
				if (ref.role === "reviewer") entry.writable = false;
			}
		}
	};
	return {
		prepare: input => prepare(input),
		runInput,
		async submit(ref, text) {
			await runInput(ref, () =>
				get(ref).actor.session.prompt(text, {
					expandPromptTemplates: false,
					runCommands: false,
					throwOnDrop: true,
				}),
			);
		},
		async review(input) {
			open();
			const read = (file: string): DevDocument => {
				const found = input.files.find(item => item.path === file);
				if (!found || sha256(found.content) !== found.digest)
					throw new Error(`Fixed review snapshot missing or corrupt: ${file}`);
				return {
					path: file,
					content:
						typeof found.content === "string"
							? found.content
							: new TextDecoder("utf-8", { fatal: true }).decode(found.content),
				};
			};
			const referenced = new Set([input.snapshot.documentPath, ...input.snapshot.srs.map(sr => sr.documentPath)]);
			const content: DevRequirementContent = {
				title: input.snapshot.title,
				document: read(input.snapshot.documentPath),
				srs: input.snapshot.srs.map(sr => ({ id: sr.id, title: sr.title, document: read(sr.documentPath) })),
				attachments: input.files
					.filter(file => !referenced.has(file.path))
					.map(file => ({ path: file.path, content: file.content })),
			};
			if (
				canonicalJson(buildRequirementSnapshot(input.binding.projectId, input.binding.irId, content)) !==
				canonicalJson(input.snapshot)
			)
				throw new Error("Review snapshot is not the deterministic complete requirement set");
			const authority = {
				digest: input.snapshot.digest,
				files: input.files,
				roots: [`docs/dev/requirements/${input.binding.irId}`],
			};
			const binding = { ...input.binding, phase: "requirements" as const, srId: undefined };
			if (!entries.has(keyFor(binding)))
				throw new Error(
					"Independent review requires the actual requirements session parent and its native history",
				);
			const prior = entries.get(keyFor(binding, true));
			if (prior) {
				await prior.actor.dispose();
				prior.release();
				entries.delete(keyFor(binding, true));
			}
			const ref = await prepare(
				{
					binding,
					cwd: input.cwd,
					outputPaths: [input.outputPath],
					authority,
					decisions: input.decisions,
					contextFiles: input.contextFiles,
				},
				true,
			);
			const entry = get(ref);
			entry.baseline = await phaseSnapshot(entry.cwd, new Set(entry.input.outputPaths));
			try {
				await entry.actor.prompt(prompt.render(outputContractTemplate, { reviewRequest: true }).trim());
				await check(entry);
			} finally {
				entry.baseline = undefined;
				entry.writable = false;
				// The review snapshot is fixed for this native run, not a freeze of
				// the still-editable draft forever. Domain invalidates old review facts.
				entry.reviewComplete = true;
			}
			const raw: unknown = JSON.parse(await fs.readFile(await materialPath(entry.cwd, input.outputPath), "utf8"));
			assertKeys(raw, ["snapshotDigest", "verdict", "findings"], "native review report");
			if (
				raw.snapshotDigest !== input.snapshot.digest ||
				!["pass", "changes-required"].includes(String(raw.verdict)) ||
				!Array.isArray(raw.findings) ||
				raw.findings.some(finding => typeof finding !== "string" || !finding.trim()) ||
				(raw.verdict === "pass" ? raw.findings.length !== 0 : raw.findings.length === 0)
			)
				throw new Error("Native reviewer report does not match the fixed snapshot or verdict schema");
			return { ref, report: raw as unknown as DevNativeReviewReport, snapshotDigest: input.snapshot.digest };
		},
		session: ref => get(ref).actor.session,
		references: () => [...entries.values()].map(entry => ({ ...entry.ref })),
		assertAuthority: async ref => {
			await check(get(ref), false);
		},
		stop,
		back: binding => stop(binding),
		async dispose() {
			if (disposed) return;
			await stop();
			closing = true;
			const settled = await Promise.allSettled(
				[...entries.values()].map(async entry => {
					await entry.actor.dispose();
					entry.release();
				}),
			);
			const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
			if (rejected.length) {
				failure = new AggregateError(
					rejected.map(item => item.reason),
					"Native disposal failed; project root remains owned",
				);
				throw failure;
			}
			disposed = true;
			const owner = roots.get(args.rootSession);
			if (owner && owner.owners > 1) owner.owners--;
			else roots.delete(args.rootSession);
		},
	};
}
