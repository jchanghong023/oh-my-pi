import type { FramePlan, TerminalCapabilities, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import { createSurface, type SurfaceTemplate } from "@oh-my-pi/pi-tui/surface";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { Vt, type VtOptions } from "../driver-output/vt";

type Listener = (columns: number, rows: number) => void;

export const CAPABILITIES: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: true,
	hyperlinks: false,
	images: null,
	kittyKeyboard: false,
	bracketedPaste: true,
	background: null,
	dark: true,
	cell: null,
	multiplexer: null,
	textSizing: false,
	tsp: false,
	emoji: { vs16Wide: false, bareFits: false },
};

/** A backend driver over the real frame writer and a terminal emulator. */
export class VtDriver implements TerminalDriver {
	readonly vt: Vt;
	capabilities = CAPABILITIES;
	#replay = new Set<() => void>();
	#resize = new Set<Listener>();
	#paint = new Set<() => void>();

	constructor(options: VtOptions = {}) {
		this.vt = new Vt({
			canReplay: () => true,
			...options,
			onInvalidate: request => {
				if (request === "replay") for (const listener of this.#replay) listener();
				for (const listener of this.#resize) listener(this.columns, this.rows);
			},
		});
	}
	get columns(): number {
		return this.vt.term.columns;
	}
	get rows(): number {
		return this.vt.term.rows;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.vt.writer.stop();
	}
	present(frame: FramePlan): number | undefined {
		const acknowledged = this.vt.present(frame);
		for (const listener of this.#paint) listener();
		return acknowledged;
	}

	onPaint(listener: () => void): () => void {
		this.#paint.add(listener);
		return () => this.#paint.delete(listener);
	}
	writeRaw(): void {}
	onInput(): () => void {
		return () => {};
	}
	onResize(listener: Listener): () => void {
		this.#resize.add(listener);
		return () => this.#resize.delete(listener);
	}
	onCapabilities(): () => void {
		return () => {};
	}
	onReplay(listener: () => void): () => void {
		this.#replay.add(listener);
		return () => this.#replay.delete(listener);
	}
	resize(columns: number, rows: number): void {
		this.vt.resize(columns, rows);
		for (const listener of this.#resize) listener(columns, rows);
	}
	replaysOnResize(): boolean {
		return this.vt.writer.replaysOnWidthChange();
	}
	resetDisplay(): void {
		this.vt.writer.resetDisplay();
	}
	setTitle(): void {}
}

export function mountVt(template: () => SurfaceTemplate, options: VtOptions = {}) {
	const driver = new VtDriver(options);
	const surface = createSurface(template);
	const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, separator: () => 0 });
	backend.start();
	return {
		driver,
		surface,
		backend,
		vt: driver.vt,
		async dispose() {
			backend.stop();
			surface.dispose();
			await driver.stop();
		},
	};
}
