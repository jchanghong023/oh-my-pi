import { describe, expect, it } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class InputProbe implements Component {
	constructor(private readonly events: string[]) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.events.push("render");
		return ["probe"];
	}

	handleInput(_data: string): void {
		this.events.push("input");
	}
}

class DeferredRenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean; delayMs: number }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { callback, canceled: false, delayMs };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

describe("TUI input/render scheduling", () => {
	it("can commit a priority frame without waiting for queued immediates", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new InputProbe(events));

		try {
			tui.start();
			tui.renderNow();
			expect(events).toEqual(["render"]);

			for (const immediate of scheduler.immediates.splice(0)) immediate();
			expect(events).toEqual(["render"]);
		} finally {
			tui.stop();
		}
	});

	it("can process terminal input before a deferred ordinary repaint", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const probe = new InputProbe(events);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			const initialTimer = scheduler.timers.shift();
			if (initialTimer && !initialTimer.canceled) initialTimer.callback();
			events.length = 0;
			scheduler.nowMs = 100;

			tui.requestRender();
			term.sendInput("x");
			scheduler.immediates.shift()?.();
			const repaintTimer = scheduler.timers.shift();
			if (repaintTimer && !repaintTimer.canceled) repaintTimer.callback();

			expect(events[0]).toBe("input");
			expect(events).toContain("render");
		} finally {
			tui.stop();
		}
	});

	it.each([
		["linux", "1", true],
		["linux", " TRUE ", true],
		["linux", "yes", true],
		["linux", "On", true],
		["linux", "false", false],
		["linux", "", false],
		["win32", "1", false],
		["darwin", "yes", false],
	] as const)("coalesces background frames only for %s offline=%s", (platform, offline, throttled) => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const originalOffline = process.env.OMP_OFFLINE;
		Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
		process.env.OMP_OFFLINE = offline;
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new InputProbe(events));
		try {
			tui.start();
			scheduler.nowMs = 1000;
			tui.renderNow();
			for (const immediate of scheduler.immediates.splice(0)) immediate();
			scheduler.nowMs += 10;
			for (let i = 0; i < 20; i++) tui.requestRender();
			for (const immediate of scheduler.immediates.splice(0)) immediate();
			expect(scheduler.timers).toHaveLength(1);
			expect(scheduler.timers[0].delayMs).toBeCloseTo(throttled ? 90 : 1000 / 30 - 10);
			expect(events).toEqual(["render"]);
			scheduler.nowMs += scheduler.timers[0].delayMs;
			scheduler.timers[0].callback();
			expect(events).toEqual(["render", "render"]);
		} finally {
			tui.stop();
			Object.defineProperty(process, "platform", originalPlatform);
			if (originalOffline === undefined) delete process.env.OMP_OFFLINE;
			else process.env.OMP_OFFLINE = originalOffline;
		}
	});

	it.each(["x", "\x03", "\x1b"])("does not make input %j or a forced final paint wait for the offline floor", key => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const originalOffline = process.env.OMP_OFFLINE;
		Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
		process.env.OMP_OFFLINE = "on";
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const probe = new InputProbe(events);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);
		tui.setFocus(probe);
		try {
			tui.start();
			scheduler.nowMs = 1000;
			tui.renderNow();
			for (const immediate of scheduler.immediates.splice(0)) immediate();
			scheduler.nowMs += 10;
			tui.requestRender();
			for (const immediate of scheduler.immediates.splice(0)) immediate();
			const background = scheduler.timers.shift()!;
			expect(background.delayMs).toBe(90);
			term.sendInput(key);
			expect(events.at(-1)).toBe("input");
			for (const immediate of scheduler.immediates.splice(0)) immediate();
			expect(background.canceled).toBe(true);
			const input = scheduler.timers.shift()!;
			expect(input.delayMs).toBeLessThanOrEqual(1000 / 30 + 0.001);
			scheduler.nowMs += input.delayMs;
			input.callback();
			expect(events).toEqual(["render", "input", "render"]);

			tui.requestRender();
			for (const immediate of scheduler.immediates.splice(0)) immediate();
			const pending = scheduler.timers.shift()!;
			tui.requestRender(true);
			for (const immediate of scheduler.immediates.splice(0)) immediate();
			expect(pending.canceled).toBe(true);
			expect(events).toEqual(["render", "input", "render", "render"]);
		} finally {
			tui.stop();
			Object.defineProperty(process, "platform", originalPlatform);
			if (originalOffline === undefined) delete process.env.OMP_OFFLINE;
			else process.env.OMP_OFFLINE = originalOffline;
		}
	});
});
