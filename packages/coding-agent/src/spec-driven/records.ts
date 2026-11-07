import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { assertSpecWritePath, containedSpecPath } from "./artifacts";
import { DEV_STAGES } from "./stages";
import type { DevRequirementRecord, DevStoredRequirement } from "./types";
import { DevWorkspace } from "./workspace";

const RECORD_DIRECTORY = "docs/dev-requirements";
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40,64}$/;
type Check = (value: unknown, location: string) => void;

function invalid(location: string, reason: string): never {
	throw new Error(`Invalid Dev requirement record at ${location}: ${reason}`);
}
const text: Check = (value, location) => {
	if (typeof value !== "string" || !value.trim()) invalid(location, "expected nonempty string");
};
const string: Check = (value, location) => {
	if (typeof value !== "string") invalid(location, "expected string");
};
const digest: Check = (value, location) => {
	if (typeof value !== "string" || !HASH.test(value)) invalid(location, "expected SHA-256 digest");
};
const sha: Check = (value, location) => {
	if (typeof value !== "string" || !SHA.test(value)) invalid(location, "expected Git object ID");
};
const identifier: Check = (value, location) => {
	if (typeof value !== "string" || !ID.test(value)) invalid(location, "expected legal change identifier");
};
const relativePath: Check = (value, location) => {
	text(value, location);
	if (
		typeof value !== "string" ||
		path.isAbsolute(value) ||
		value.includes(":") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.split("/").some(part => !part || part === "." || part === "..")
	)
		invalid(location, "expected workspace-relative canonical path");
};
function choice(...values: readonly (string | number | boolean)[]): Check {
	return (value, location) => {
		if (!values.some(allowed => value === allowed)) invalid(location, `expected ${values.join(" | ")}`);
	};
}
function nullable(check: Check): Check {
	return (value, location) => {
		if (value !== null) check(value, location);
	};
}
function array(check: Check): Check {
	return (value, location) => {
		if (!Array.isArray(value)) invalid(location, "expected array");
		value.forEach((item, index) => check(item, `${location}[${index}]`));
	};
}
function object(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
	return (value, location) => {
		if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
		)
			invalid(location, "expected plain object");
		const entries = value as Record<string, unknown>;
		for (const key of Object.keys(entries)) {
			const check = Object.hasOwn(required, key)
				? required[key]
				: Object.hasOwn(optional, key)
					? optional[key]
					: undefined;
			if (!check) invalid(`${location}.${key}`, "unknown field");
			check(entries[key], `${location}.${key}`);
		}
		for (const key of Object.keys(required)) {
			if (!Object.hasOwn(entries, key)) invalid(`${location}.${key}`, "missing field");
		}
	};
}
const version = object({ path: relativePath, version: digest });
const person = object({ name: text, source: choice("local", "collab") }, { peerId: text });
const stage = choice(...DEV_STAGES);
const approval = object({ files: array(version), userReply: string }, { candidateId: text });
const decision = object(
	{ operationId: text, stage, actor: person, at: text, userReply: string, files: array(version) },
	{ candidateId: text },
);
const target = object({
	localSourceRef: text,
	sourceRepository: text,
	sourceRef: text,
	baseRepository: text,
	baseRef: text,
	remote: text,
	remoteUrl: text,
	targetRef: text,
	observedTip: nullable(sha),
});
const prRef = object({
	forge: choice("github", "gitlab"),
	repository: text,
	number: (value, location) => {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
			invalid(location, "expected positive PR number");
	},
	url: text,
	sourceRef: text,
	baseRef: text,
});
const progress = object(
	{},
	{
		synced: choice(true, false),
		archivedChangePath: relativePath,
		retirementCleanup: object({ paths: array(relativePath), diagnostic: string }),
		sideEffects: object(
			{ paths: array(relativePath), diagnostic: string },
			{
				expectedVersions: array(object({ path: relativePath, version: nullable(digest) })),
			},
		),
		archiveCleanup: object({ path: relativePath, diagnostic: string }),
		targetVersions: array(object({ path: relativePath, version: nullable(digest) })),
		ownership: object({ captureId: text, state: choice("pending", "settled") }),
	},
);
const recordCheck = object({
	schemaVersion: choice(1),
	requirementId: identifier,
	changeId: identifier,
	branch: text,
	stage,
	lifecycle: choice("active", "completed", "cancelling", "cancelled"),
	materials: array(
		object({
			id: text,
			kind: choice("business", "proposal", "delta", "solution", "plan", "report"),
			path: relativePath,
			version: digest,
		}),
	),
	decisions: array(decision),
	marks: object({}, { "st-complete": decision, "pr-submitted": decision, "pr-merged": decision, tested: decision }),
	solutionBasis: nullable(
		object({
			solutionVersion: digest,
			candidateIds: array(text),
			usableCandidateIds: array(text),
			source: choice("single-agent", "team"),
			sourceSessionId: text,
			sourceEntryIds: array(text),
		}),
	),
	report: object({ development: nullable(approval), st: nullable(version) }),
	syncRevisions: array(
		object({
			operationId: text,
			files: array(version),
			mainSpecs: array(object({ path: relativePath, version: nullable(digest) })),
			archivedChangePath: nullable(relativePath),
			progress,
		}),
	),
	gitOperations: array(
		object({
			operationId: text,
			kind: choice(
				"st-complete",
				"pr-submitted",
				"pr-merged",
				"tested",
				"set-test-state",
				"link-fix",
				"commit",
				"cancel",
			),
			actor: person,
			at: text,
			files: array(version),
			target,
			authorizedCommits: array(sha),
			knownCommitShas: array(sha),
		}),
	),
	pr: nullable(
		object({
			pr: prRef,
			state: choice("open", "closed", "merged"),
			headSha: sha,
			baseSha: sha,
			mergeSha: nullable(sha),
			observedAt: text,
		}),
	),
	testing: choice("not-started", "in-progress", "failed", "retest-pending", "tested"),
	relatedRequirementIds: array(identifier),
});

/** Reject unknown fields at every level so native state, bodies and tokens cannot leak into Git. */
export function validateDevRequirementRecord(value: unknown): asserts value is DevRequirementRecord {
	recordCheck(value, "record");
	const record = value as DevRequirementRecord;
	for (const [name, ids] of [
		["materials", record.materials.map(material => material.id)],
		["gitOperations", record.gitOperations.map(operation => operation.operationId)],
		["relatedRequirementIds", record.relatedRequirementIds],
	] as const) {
		if (new Set(ids).size !== ids.length) invalid(`record.${name}`, "duplicate identity");
	}
	if (record.relatedRequirementIds.includes(record.requirementId))
		invalid("record.relatedRequirementIds", "self reference");
	if (record.solutionBasis) {
		const basis = record.solutionBasis;
		if (
			new Set(basis.candidateIds).size !== basis.candidateIds.length ||
			new Set(basis.usableCandidateIds).size !== basis.usableCandidateIds.length ||
			basis.usableCandidateIds.some(id => !basis.candidateIds.includes(id))
		)
			invalid("record.solutionBasis", "invalid candidate identities");
	}
}

export function devRequirementPath(requirementId: string): string {
	identifier(requirementId, "requirementId");
	return `${RECORD_DIRECTORY}/${requirementId}.json`;
}
function digestBytes(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}
function decode(bytes: Uint8Array, requirementId: string): DevStoredRequirement {
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	validateDevRequirementRecord(value);
	if (value.requirementId !== requirementId) invalid("record.requirementId", "does not match filename");
	return { record: value, recordVersion: digestBytes(bytes) };
}

/** Shared by worktree publication and isolated Git trees; this function never mutates its input. */
export function serializeDevRequirement(record: DevRequirementRecord): Uint8Array {
	validateDevRequirementRecord(record);
	return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}
async function readAtRoot(root: string, requirementId: string): Promise<DevStoredRequirement> {
	const relative = devRequirementPath(requirementId);
	await assertSpecWritePath(root, relative);
	return decode(await fs.readFile(await containedSpecPath(root, relative)), requirementId);
}

/** Read-only: does not acquire a workspace lease, native runtime or model. */
export async function readDevRequirement(cwd: string, requirementId: string): Promise<DevStoredRequirement> {
	return readAtRoot((await DevWorkspace.resolve(cwd)).root, requirementId);
}

export async function loadDevRequirements(cwd: string): Promise<DevStoredRequirement[]> {
	const { root } = await DevWorkspace.resolve(cwd);
	const directory = await containedSpecPath(root, RECORD_DIRECTORY);
	let names: string[];
	try {
		const stat = await fs.lstat(path.join(root, RECORD_DIRECTORY));
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Invalid Dev record directory: ${directory}`);
		names = await fs.readdir(directory);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const records: DevStoredRequirement[] = [];
	const errors: Error[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		try {
			records.push(await readAtRoot(root, name.slice(0, -5)));
		} catch (error) {
			errors.push(
				new Error(`${RECORD_DIRECTORY}/${name}: ${error instanceof Error ? error.message : String(error)}`, {
					cause: error,
				}),
			);
		}
	}
	if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join("\n"));
	return records;
}

export function occupiesDevDevelopment(record: DevRequirementRecord): boolean {
	if (record.lifecycle === "cancelled") return false;
	return !(record.pr?.state === "merged" && record.marks["pr-merged"]);
}

/** Caller must retain the same canonical lease for the entire mutation. */
export async function saveDevRequirementWithOwner(
	owner: DevWorkspace,
	record: DevRequirementRecord,
	expectedRecordVersion: string | null,
): Promise<DevStoredRequirement> {
	await owner.assertCurrentBranch();
	validateDevRequirementRecord(record);
	if (!owner.branch) throw new Error("Dev records require an existing current Git branch");
	if (expectedRecordVersion !== null) digest(expectedRecordVersion, "expectedRecordVersion");
	let current: DevStoredRequirement | null = null;
	try {
		current = await readAtRoot(owner.root, record.requirementId);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if ((current?.recordVersion ?? null) !== expectedRecordVersion)
		throw new Error(`Dev record CAS conflict: ${record.requirementId}`);
	if (current?.record.lifecycle === "completed" || current?.record.lifecycle === "cancelled")
		throw new Error(`Dev requirement is read-only: ${record.requirementId}`);
	if (current && (current.record.changeId !== record.changeId || current.record.branch !== record.branch))
		throw new Error("Dev requirement identity cannot change");
	if ((!current || occupiesDevDevelopment(current.record)) && record.branch !== owner.branch)
		throw new Error("Dev record branch does not match the existing current branch");
	if (occupiesDevDevelopment(record)) await owner.assertDevelopmentAvailable(record.requirementId);
	if (!current) {
		const records = await loadDevRequirements(owner.root);
		if (
			records.some(
				other =>
					other.record.changeId === record.changeId ||
					other.record.changeId === record.requirementId ||
					other.record.requirementId === record.changeId,
			)
		)
			throw new Error(`Dev change identifier already exists: ${record.changeId}`);
	}
	const relative = devRequirementPath(record.requirementId);
	await assertSpecWritePath(owner.root, relative);
	await fs.mkdir(path.join(owner.root, RECORD_DIRECTORY), { recursive: true });
	await assertSpecWritePath(owner.root, relative);
	const bytes = serializeDevRequirement(record);
	const json = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
	const result = decode(bytes, record.requirementId);
	await owner.assertCurrentBranch();
	await writeFileAtomically(path.join(owner.root, relative), json);
	return result;
}

export async function saveDevRequirement(
	cwd: string,
	record: DevRequirementRecord,
	expectedRecordVersion: string | null,
): Promise<DevStoredRequirement> {
	const owner = await DevWorkspace.acquire(cwd);
	try {
		return await owner.saveRequirement(record, expectedRecordVersion);
	} finally {
		owner.release();
	}
}

/** Check every dated material namespace: yesterday's cancelled ID is never reusable. */
export async function allocateDevRequirementId(cwd: string, preferred?: string): Promise<string> {
	const { root } = await DevWorkspace.resolve(cwd);
	const base = preferred ?? `requirement-${crypto.randomUUID()}`;
	identifier(base, "preferred");
	const reserved = new Set<string>();
	for (const { record } of await loadDevRequirements(root)) {
		reserved.add(record.requirementId);
		reserved.add(record.changeId);
	}
	for (const directory of [
		"openspec/changes",
		"openspec/changes/archive",
		"docs/business-requirements",
		"docs/superpowers/plans",
	]) {
		let names: string[];
		try {
			names = await fs.readdir(await containedSpecPath(root, directory));
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		for (const name of names) {
			const dated = name.replace(/^\d{4}-\d{2}-\d{2}-/, "");
			reserved.add(dated);
			reserved.add(dated.replace(/(?:-solutions\.json|-completion\.md|\.md)$/, ""));
		}
	}
	let candidate = base;
	for (let suffix = 2; reserved.has(candidate); suffix++) candidate = `${base}-${suffix}`;
	return candidate;
}

/** The operation's introducing commit is found from actual record blobs and all parents, never its subject. */
export async function resolveDevOperationCommit(
	cwd: string,
	requirementId: string,
	operationId: string,
): Promise<string | null> {
	const { root } = await DevWorkspace.resolve(cwd);
	const repo = vcs.requireGit(root);
	const relative = devRequirementPath(requirementId);
	text(operationId, "operationId");
	if (!(await repo.headSha())) return null;
	const commits = await repo.revListTouching("HEAD", relative, 2_147_483_647);
	const readOperation = async (commit: string): Promise<boolean> => {
		try {
			const blob = await repo.showBlob(`${commit}:${relative}`);
			if (blob.truncated) throw new Error(`Dev requirement blob is truncated: ${commit}:${relative}`);
			return decode(blob.data, requirementId).record.gitOperations.some(
				operation => operation.operationId === operationId,
			);
		} catch (error) {
			if (vcs.isVcsError(error) && (error.code === "ObjectNotFound" || error.code === "RefNotFound")) return false;
			throw error;
		}
	};
	let found: string | null = null;
	for (const commit of commits) {
		if (!(await readOperation(commit))) continue;
		const details = await repo.commitDetails(commit);
		let inherited = false;
		for (const parent of details.parents) {
			if (await readOperation(parent)) {
				inherited = true;
				break;
			}
		}
		if (inherited) continue;
		if (found && found !== commit)
			throw new Error(`Dev operation appears in multiple independent commits: ${operationId}`);
		found = commit;
	}
	return found;
}
