type NativeSnapshot = { screen: string; cursor: { x: number; y: number } };
type Snapshot = NativeSnapshot & { columns: number; rows: number };
type Tui = (...args: string[]) => Promise<string>;
type SnapshotReader = (tui: Tui) => Promise<NativeSnapshot>;

// tui-test decodes the real PTY/ConPTY stream. These are sampled snapshots,
// not completed-frame coverage: the VT journey owns the all-frame oracle.
export class CompactScreenRecording {
	readonly #tui: Tui;
	readonly #read: SnapshotReader;
	readonly #frames: Array<{ event: string; snapshot: Snapshot }> = [];
	readonly #timeline: string[] = [];
	#failure: unknown;
	#running = false;
	#loop?: Promise<void>;
	#sequence = 0;
	#columns: number;
	#rows: number;
	#lock = Promise.resolve();
	constructor(tui: Tui, read: SnapshotReader, columns: number, rows: number) {
		this.#tui = tui;
		this.#read = read;
		this.#columns = columns;
		this.#rows = rows;
	}

	mark(event: string): void {
		this.#timeline.push(`${++this.#sequence} ${event}`);
	}

	async #locked<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.#lock;
		const release = Promise.withResolvers<void>();
		this.#lock = release.promise;
		await previous;
		try {
			return await action();
		} finally {
			release.resolve();
		}
	}

	// Only the harness resizes this session. Serialize each actual resize with
	// state reads so a sample cannot pair an old size with a new caret.
	async resize(columns: number, rows: number, action: () => Promise<string>): Promise<string> {
		return this.#locked(async () => {
			const result = await action();
			this.#columns = columns;
			this.#rows = rows;
			return result;
		});
	}

	start(): void {
		this.#running = true;
		this.#loop = (async () => {
			while (this.#running) {
				await Bun.sleep(200);
				if (!this.#running) break;
				try {
					await this.#observe("ongoing sample");
				} catch (error) {
					// Keep the first bad sample even if a subsequent repaint recovers.
					this.#failure ??= error;
					break;
				}
			}
		})();
	}

	async stop(): Promise<void> {
		this.#running = false;
		await this.#loop;
		if (this.#failure) throw this.#failure;
	}

	async captureFailure(): Promise<void> {
		try {
			await this.#observe("failure current screen");
		} catch {
			// The last successful sample remains available if the PTY exited.
		}
	}

	async checkpoint(event: string, check?: (snapshot: Snapshot) => void): Promise<Snapshot> {
		this.mark(event);
		if (this.#failure) throw this.#failure;
		return this.#observe(event, check);
	}

	// A PTY acknowledgement can precede the app repaint; global visual idle
	// never arrives while a tool spinner runs. Observe stability rather than
	// an expected assertion result. The minimum also covers the renderer's
	// 120ms resize settle and 200ms CPR fallback.
	async waitForVisualHandoff(event = "resize"): Promise<void> {
		this.mark(`${event} visual handoff`);
		if (this.#failure) throw this.#failure;
		const started = Date.now();
		let previous = "";
		let stableSince = started;
		while (Date.now() - started < 60_000) {
			const frame = await this.#observe("resize handoff sample");
			const footer = frame.screen
				.split("\n")
				.filter(line => line.trim())
				.slice(-2)
				.join("\n");
			const fingerprint = JSON.stringify([frame.cursor.x, frame.cursor.y, footer]);
			const now = Date.now();
			if (fingerprint !== previous) {
				previous = fingerprint;
				stableSince = now;
			} else if (now - started >= 500 && now - stableSince >= 250) {
				return;
			}
			await Bun.sleep(100);
		}
		throw new Error(`${event} did not reach a stable sampled footer and caret within 60 seconds`);
	}

	async #observe(event: string, check?: (snapshot: Snapshot) => void): Promise<Snapshot> {
		return this.#locked(async () => {
			const snapshot = { ...(await this.#read(this.#tui)), columns: this.#columns, rows: this.#rows };
			this.#frames.push({ event, snapshot });
			if (this.#frames.length > 40) this.#frames.shift();
			const { screen, cursor, columns, rows } = snapshot;
			if (!screen.trim()) throw new Error(`Empty viewport after startup: ${event}`);
			if (
				!Number.isInteger(cursor.x) ||
				!Number.isInteger(cursor.y) ||
				cursor.x < 0 ||
				cursor.y < 0 ||
				cursor.x >= columns ||
				cursor.y >= rows
			)
				throw new Error(`Caret outside ${columns}x${rows} viewport: ${event} (${cursor.x}, ${cursor.y})`);
			check?.(snapshot);
			return snapshot;
		});
	}

	evidence(): string {
		return `Sampled viewport evidence (not all PTY frames)\n\nTrigger timeline:\n${this.#timeline.join("\n")}\n\n${this.#frames
			.map(
				({ event, snapshot }, index) =>
					`Screen ${index + 1}: ${event}, ${snapshot.columns}x${snapshot.rows}, caret (${snapshot.cursor.x}, ${snapshot.cursor.y})\n${snapshot.screen
						.split("\n")
						.map((line, row) => `${String(row).padStart(3, "0")} ${line}`)
						.join("\n")}`,
			)
			.join("\n\n")}`;
	}
}

// The draft's tail and caret must be inside the composer, not merely present
// in transcript/scrollback. Long drafts may legitimately scroll their prefix.
export function expectVisibleDraft(snapshot: Snapshot, tail: string, columns: number, rows: number): void {
	const lines = snapshot.screen.split("\n");
	const start = lines.findLastIndex(line => line.startsWith("╭── "));
	const end = lines.findIndex((line, index) => index > start && line.startsWith("╰─"));
	if (start < 0 || end <= start || snapshot.cursor.y <= start || snapshot.cursor.y >= end)
		throw new Error("Composer borders and focused draft caret are not ordered in the visible viewport");
	if (snapshot.cursor.x < 3 || snapshot.cursor.x >= columns || snapshot.cursor.y >= rows)
		throw new Error("Draft caret is outside the resized composer viewport");
	if (
		!lines
			.slice(start + 1, end)
			.join("\n")
			.includes(tail)
	)
		throw new Error(`Visible composer does not contain draft tail ${tail}`);
}
