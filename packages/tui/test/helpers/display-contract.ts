import type { TUI } from "../../src/tui";
import type { VirtualTerminal } from "../virtual-terminal";

export interface DisplayFrame {
	event: string;
	columns: number;
	rows: number;
	viewport: readonly string[];
	cursor: { row: number; col: number; visible: boolean };
}

const EVIDENCE_FRAMES = 5;

/** Screen-level assertions and bounded, reproducible evidence for a test journey. */
export class DisplayContract {
	readonly #seed: number;
	readonly #frames: DisplayFrame[] = [];
	#failure?: Error;

	constructor(seed: number) {
		this.#seed = seed;
	}

	observe(event: string, terminal: VirtualTerminal, check?: (frame: DisplayFrame) => void): DisplayFrame {
		const frame: DisplayFrame = {
			event,
			columns: terminal.columns,
			rows: terminal.rows,
			viewport: terminal.getViewport(),
			cursor: { ...terminal.getCursor(), visible: terminal.isCursorVisible() },
		};
		this.#frames.push(frame);
		if (this.#frames.length > EVIDENCE_FRAMES) this.#frames.shift();
		try {
			if (
				!Number.isInteger(frame.columns) ||
				frame.columns <= 0 ||
				!Number.isInteger(frame.rows) ||
				frame.rows <= 0
			) {
				throw new Error(`invalid geometry ${frame.columns}x${frame.rows}`);
			}
			if (frame.viewport.length !== frame.rows) {
				throw new Error(`viewport has ${frame.viewport.length} rows, expected ${frame.rows}`);
			}
			if (
				!Number.isInteger(frame.cursor.row) ||
				frame.cursor.row < 0 ||
				frame.cursor.row >= frame.rows ||
				!Number.isInteger(frame.cursor.col) ||
				frame.cursor.col < 0 ||
				frame.cursor.col >= frame.columns
			) {
				throw new Error(`cursor outside viewport: ${frame.cursor.row},${frame.cursor.col}`);
			}
			for (let row = 0; row < frame.viewport.length; row++) {
				const width = Bun.stringWidth(frame.viewport[row] ?? "");
				if (width > frame.columns) throw new Error(`row ${row} is ${width} cells wide, exceeds ${frame.columns}`);
			}
			check?.(frame);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const failure = new Error(`Display contract failed: ${reason}\n${this.evidence()}`, { cause: error });
			this.#failure ??= failure;
			throw failure;
		}
		return frame;
	}

	/**
	 * Inspect every actual TUI frame write. The TUI isolates listener errors, so
	 * retain the first failure and require checkpoints to call assertHealthy().
	 */
	watch(ui: TUI, terminal: VirtualTerminal, event: () => string, check?: (frame: DisplayFrame) => void): () => void {
		return ui.addFrameWriteListener(() => {
			try {
				this.observe(event(), terminal, check);
			} catch (error) {
				this.#failure ??= error instanceof Error ? error : new Error(String(error));
			}
		});
	}

	assertHealthy(): void {
		if (this.#failure) throw this.#failure;
	}

	/** Oldest to newest: the last frame is the current failure, earlier frames are prior evidence. */
	evidence(): string {
		const frames = this.#frames.map((frame, index) => {
			const label = index === this.#frames.length - 1 ? "current" : `prior ${index + 1}`;
			const rows = frame.viewport.map((line, row) => `${String(row).padStart(3, "0")}: ${JSON.stringify(line)}`);
			return [
				`${label}: event=${JSON.stringify(frame.event)} ${frame.columns}x${frame.rows} cursor=${frame.cursor.row},${frame.cursor.col} visible=${frame.cursor.visible}`,
				...rows,
			].join("\n");
		});
		return [`seed=${this.#seed}`, ...frames].join("\n");
	}
}
