import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { assertSpecWritePath, containedSpecPath } from "./artifacts";
import type { AIReqRequirementRecord, AIReqStoredRequirement } from "./types";
import { AIReqWorkspace } from "./workspace";

const RECORD_DIRECTORY = "docs/aireq-requirements";
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40,64}$/;
type Check = (value: unknown, location: string) => void;

const RECORD_STAGES = ["business", "requirements", "solution", "planning", "executing", "st", "pr", "testing"] as const;

function invalid(location: string, reason: string): never {
	throw new Error(`Invalid AIReq requirement record at ${location}: ${reason}`);
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
const stage = choice(...RECORD_STAGES);
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
export function validateAIReqRequirementRecord(value: unknown): asserts value is AIReqRequirementRecord {
	recordCheck(value, "record");
	const record = value as AIReqRequirementRecord;
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

export function aiReqRequirementPath(requirementId: string): string {
	identifier(requirementId, "requirementId");
	return `${RECORD_DIRECTORY}/${requirementId}.json`;
}
function digestBytes(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}
function decode(bytes: Uint8Array, requirementId: string): AIReqStoredRequirement {
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	validateAIReqRequirementRecord(value);
	if (value.requirementId !== requirementId) invalid("record.requirementId", "does not match filename");
	return { record: value, recordVersion: digestBytes(bytes) };
}

/** Preserve the existing workspace record serialization without mutating its input. */
export function serializeAIReqRequirement(record: AIReqRequirementRecord): Uint8Array {
	validateAIReqRequirementRecord(record);
	return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}
async function readAtRoot(root: string, requirementId: string): Promise<AIReqStoredRequirement> {
	const relative = aiReqRequirementPath(requirementId);
	await assertSpecWritePath(root, relative);
	return decode(await fs.readFile(await containedSpecPath(root, relative)), requirementId);
}

export async function loadAIReqRequirements(cwd: string): Promise<AIReqStoredRequirement[]> {
	const { root } = await AIReqWorkspace.resolve(cwd);
	const directory = await containedSpecPath(root, RECORD_DIRECTORY);
	let names: string[];
	try {
		const stat = await fs.lstat(path.join(root, RECORD_DIRECTORY));
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Invalid AIReq record directory: ${directory}`);
		names = await fs.readdir(directory);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const records: AIReqStoredRequirement[] = [];
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

export function occupiesAIReqAIReqelopment(record: AIReqRequirementRecord): boolean {
	if (record.lifecycle === "cancelled") return false;
	return !(record.pr?.state === "merged" && record.marks["pr-merged"]);
}

/** Caller must retain the same canonical lease for the entire mutation. */
export async function saveAIReqRequirementWithOwner(
	owner: AIReqWorkspace,
	record: AIReqRequirementRecord,
	expectedRecordVersion: string | null,
): Promise<AIReqStoredRequirement> {
	await owner.assertCurrentBranch();
	validateAIReqRequirementRecord(record);
	if (!owner.branch) throw new Error("AIReq records require an existing current Git branch");
	if (expectedRecordVersion !== null) digest(expectedRecordVersion, "expectedRecordVersion");
	let current: AIReqStoredRequirement | null = null;
	try {
		current = await readAtRoot(owner.root, record.requirementId);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if ((current?.recordVersion ?? null) !== expectedRecordVersion)
		throw new Error(`AIReq record CAS conflict: ${record.requirementId}`);
	if (current?.record.lifecycle === "completed" || current?.record.lifecycle === "cancelled")
		throw new Error(`AIReq requirement is read-only: ${record.requirementId}`);
	if (current && (current.record.changeId !== record.changeId || current.record.branch !== record.branch))
		throw new Error("AIReq requirement identity cannot change");
	if ((!current || occupiesAIReqAIReqelopment(current.record)) && record.branch !== owner.branch)
		throw new Error("AIReq record branch does not match the existing current branch");
	if (occupiesAIReqAIReqelopment(record)) await owner.assertDevelopmentAvailable(record.requirementId);
	if (!current) {
		const records = await loadAIReqRequirements(owner.root);
		if (
			records.some(
				other =>
					other.record.changeId === record.changeId ||
					other.record.changeId === record.requirementId ||
					other.record.requirementId === record.changeId,
			)
		)
			throw new Error(`AIReq change identifier already exists: ${record.changeId}`);
	}
	const relative = aiReqRequirementPath(record.requirementId);
	await assertSpecWritePath(owner.root, relative);
	await fs.mkdir(path.join(owner.root, RECORD_DIRECTORY), { recursive: true });
	await assertSpecWritePath(owner.root, relative);
	const bytes = serializeAIReqRequirement(record);
	const json = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
	const result = decode(bytes, record.requirementId);
	await owner.assertCurrentBranch();
	await writeFileAtomically(path.join(owner.root, relative), json);
	return result;
}
