import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import type { FileChangeReport } from "../tools";

export interface TurnFileChange {
	readonly path: string;
	readonly before: string | null;
	readonly after: string | null;
	readonly continuous: boolean;
}

export interface TurnFileChanges {
	readonly files: ReadonlyMap<string, TurnFileChange>;
	readonly revision: number;
}

/** Ephemeral projection of confirmed writes. Nothing here goes into the transcript. */
export class LatestTurnFileChanges {
	#sessionId = "";
	#turn = { files: new Map<string, TurnFileChange>(), revision: 0 };

	get(sessionId: string): TurnFileChanges {
		if (this.#sessionId !== sessionId) this.start(sessionId);
		return this.#turn;
	}

	start(sessionId: string): void {
		this.#sessionId = sessionId;
		this.#turn = { files: new Map(), revision: 0 };
	}

	record(sessionId: string, change: FileChangeReport): void {
		if (change.before === change.after) return;
		if (this.#sessionId !== sessionId) this.start(sessionId);
		const key = normalizePathForComparison(change.path);
		const { files } = this.#turn;
		const previous = files.get(key);
		files.set(key, {
			path: change.path,
			before: previous ? previous.before : change.before,
			after: change.after,
			continuous: previous === undefined || (previous.continuous && previous.after === change.before),
		});
		this.#turn.revision++;
	}
}
