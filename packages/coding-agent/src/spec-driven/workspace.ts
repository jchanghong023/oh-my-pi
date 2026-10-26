import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type FileLockHandle, isEnoent, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { SpecAdmissionError } from "./orchestrator";

/** Owns only Dev persistence; native work must settle before the caller releases its lease. */
export class DevWorkspace {
	readonly statePath: string;
	#lease: FileLockHandle | undefined;

	constructor(
		readonly root: string,
		lease: FileLockHandle,
	) {
		this.statePath = path.join(root, ".omp", "dev", "state.json");
		this.#lease = lease;
	}

	static async acquire(cwd: string): Promise<DevWorkspace> {
		const root = await fs.realpath(vcs.gitInfo(cwd)?.repoRoot ?? cwd);
		const statePath = path.join(root, ".omp", "dev", "state.json");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		const lease = tryAcquireFileLock(statePath);
		if (!lease) throw new SpecAdmissionError(`Dev 工作区已被占用：${root}`);
		return new DevWorkspace(root, lease);
	}

	async read(): Promise<unknown> {
		this.#assertOwned();
		let content: string;
		try {
			content = await fs.readFile(this.statePath, "utf8");
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
		// SyntaxError is deliberately distinct from I/O failures; recovery belongs to the controller.
		return JSON.parse(content);
	}

	async save(state: unknown): Promise<void> {
		this.#assertOwned();
		const content = JSON.stringify(state);
		if (content === undefined) throw new TypeError("Dev state must be JSON serializable");
		await writeFileAtomically(this.statePath, `${content}\n`);
	}

	/** Remove only Dev state, never native sessions, artifacts or workspace configuration. */
	async clear(): Promise<void> {
		this.#assertOwned();
		try {
			await fs.unlink(this.statePath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}

	release(): void {
		this.#lease?.release();
		this.#lease = undefined;
	}

	#assertOwned(): void {
		if (!this.#lease) throw new Error("Dev 工作区控制权已释放");
	}
}
