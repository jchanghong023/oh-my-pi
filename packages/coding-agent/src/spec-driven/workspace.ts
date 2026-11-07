import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type FileLockHandle, isEnoent, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { assertSpecWritePath } from "./artifacts";
import { loadDevRequirements, occupiesDevDevelopment, saveDevRequirementWithOwner } from "./records";
import type { DevRequirementRecord, DevStoredRequirement } from "./types";

export interface DevWorkspaceIdentity {
	root: string;
	branch: string | null;
}

/** A process lease is not the development slot: the latter is derived from Git records. */
export class DevWorkspace {
	readonly localDirectory: string;
	#lease: FileLockHandle | undefined;
	#pending: Promise<void> = Promise.resolve();

	private constructor(
		readonly root: string,
		readonly branch: string | null,
		lease: FileLockHandle,
	) {
		this.localDirectory = path.join(root, ".omp", "dev-workbench");
		this.#lease = lease;
	}

	/** Read-only identity discovery never takes ownership or creates local state. */
	static async resolve(cwd: string): Promise<DevWorkspaceIdentity> {
		const entered = await fs.realpath(cwd);
		const repo = vcs.git(entered);
		const root = await fs.realpath(repo?.info().repoRoot ?? entered);
		return { root, branch: repo ? ((await repo.currentBranch()) ?? null) : null };
	}

	static async acquire(cwd: string): Promise<DevWorkspace> {
		const { root, branch } = await DevWorkspace.resolve(cwd);
		const relative = ".omp/dev-workbench/owner";
		await assertSpecWritePath(root, relative);
		await fs.mkdir(path.join(root, ".omp", "dev-workbench"), { recursive: true });
		await assertSpecWritePath(root, relative);
		const lease = tryAcquireFileLock(path.join(root, relative));
		if (!lease) throw new Error(`Dev 工作区已被占用：${root}`);
		return new DevWorkspace(root, branch, lease);
	}

	assertOwned(): void {
		if (!this.#lease) throw new Error("Dev 工作区控制权已释放");
	}

	async assertCurrentBranch(): Promise<void> {
		this.assertOwned();
		const current = await DevWorkspace.resolve(this.root);
		if (current.root !== this.root || current.branch !== this.branch)
			throw new Error("Dev 工作区分支已改变；请结清当前操作并重新准入");
	}

	async assertDevelopmentAvailable(requirementId?: string): Promise<void> {
		await this.assertCurrentBranch();
		if (!this.branch) throw new Error("开发需求需要 Git 仓库中的既有当前分支");
		const records = await loadDevRequirements(this.root);
		const occupant = records.find(
			({ record }) =>
				record.requirementId !== requirementId && record.branch === this.branch && occupiesDevDevelopment(record),
		);
		if (occupant) throw new Error(`开发名额已被占用：${occupant.record.requirementId}`);
		await this.#assertCancellationJournalsSettled(records, requirementId);
		await this.#assertCancellationsSettled(records, requirementId);
	}

	/** Serialize mutations made through a retained owner, including concurrent CAS attempts. */
	async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		this.assertOwned();
		const previous = this.#pending;
		const settled = Promise.withResolvers<void>();
		this.#pending = settled.promise;
		await previous;
		try {
			await this.assertCurrentBranch();
			return await operation();
		} finally {
			settled.resolve();
		}
	}

	saveRequirement(record: DevRequirementRecord, expectedRecordVersion: string | null): Promise<DevStoredRequirement> {
		return this.exclusive(() => saveDevRequirementWithOwner(this, record, expectedRecordVersion));
	}

	async readLocal<T>(name: string, validate: (value: unknown) => T): Promise<T | null> {
		this.assertOwned();
		const file = this.#localFile(name);
		await assertSpecWritePath(this.root, file);
		let bytes: string;
		try {
			bytes = await fs.readFile(path.join(this.root, file), "utf8");
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
		return validate(JSON.parse(bytes));
	}

	saveLocal(name: string, value: unknown): Promise<void> {
		return this.exclusive(async () => {
			const file = this.#localFile(name);
			const json = JSON.stringify(value);
			if (json === undefined) throw new TypeError("Dev local metadata must be JSON serializable");
			await assertSpecWritePath(this.root, file);
			await writeFileAtomically(path.join(this.root, file), `${json}\n`);
		});
	}

	release(): void {
		this.#lease?.release();
		this.#lease = undefined;
	}

	async #assertCancellationJournalsSettled(records: DevStoredRequirement[], requirementId?: string): Promise<void> {
		const directory = ".omp/dev-workbench/cancellations";
		await assertSpecWritePath(this.root, `${directory}/admission`);
		let names: string[];
		try {
			names = await fs.readdir(path.join(this.root, directory));
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		const object = (value: unknown): Record<string, unknown> => {
			if (value === null || typeof value !== "object" || Array.isArray(value))
				throw new Error("Dev cancellation settlement journal is malformed");
			return value as Record<string, unknown>;
		};
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error("Unsafe Dev cancellation journal identity");
			const relative = `${directory}/${name}`;
			await assertSpecWritePath(this.root, relative);
			const journal = object(JSON.parse(await fs.readFile(path.join(this.root, relative), "utf8")));
			if (typeof journal.started !== "boolean" || typeof journal.complete !== "boolean")
				throw new Error("Dev cancellation settlement journal lacks completion facts");
			if (!journal.started || journal.complete) continue;
			const binding = object(object(object(journal.plan).preview).binding);
			if (typeof binding.requirementId !== "string")
				throw new Error("Dev cancellation journal lacks requirement identity");
			if (binding.requirementId === requirementId) continue;
			const record = records.find(item => item.record.requirementId === binding.requirementId)?.record;
			if (record && record.branch !== this.branch) continue;
			throw new Error(`开发名额仍被未结清取消占用：${binding.requirementId}`);
		}
	}

	async #assertCancellationsSettled(records: DevStoredRequirement[], requirementId?: string): Promise<void> {
		const directory = ".omp/dev-workbench/git-operations";
		await assertSpecWritePath(this.root, `${directory}/admission`);
		let operations: string[];
		try {
			operations = await fs.readdir(path.join(this.root, directory));
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		const object = (value: unknown): Record<string, unknown> => {
			if (value === null || typeof value !== "object" || Array.isArray(value))
				throw new Error("Dev cancellation recovery metadata is malformed");
			return value as Record<string, unknown>;
		};
		for (const operationId of operations) {
			if (!/^[a-zA-Z0-9_-]+$/.test(operationId)) throw new Error("Unsafe Dev operation recovery identity");
			const relative = `${directory}/${operationId}/receipt.json`;
			await assertSpecWritePath(this.root, relative);
			let content: string;
			try {
				content = await fs.readFile(path.join(this.root, relative), "utf8");
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const receipt = object(JSON.parse(content));
			const preview = object(object(receipt.state).preview);
			if (preview.operation !== "cancel") continue;
			const binding = object(preview.binding);
			if (typeof binding.requirementId !== "string")
				throw new Error("Dev cancellation recovery lacks requirement identity");
			if (binding.requirementId === requirementId) continue;
			const record = records.find(item => item.record.requirementId === binding.requirementId)?.record;
			if (record && record.branch !== this.branch) continue;
			const result = object(receipt.result);
			const commit = object(result.commit);
			if (
				result.save !== "succeeded" ||
				commit.status !== "succeeded" ||
				commit.indexReconciled !== true ||
				object(result.push).status !== "succeeded"
			)
				throw new Error(`开发名额仍被未结清取消占用：${binding.requirementId}`);
		}
	}

	#localFile(name: string): string {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error(`Unsafe Dev local metadata name: ${name}`);
		return `.omp/dev-workbench/${name}.json`;
	}
}
