import { jsx, type PageProps, signal } from "@oh-my-pi/pi-tui";
import { VERSION } from "@oh-my-pi/pi-utils";
import { presentFullscreen } from "../ui/apps/fullscreen";
import { StartupSplash } from "../ui/setup/splash";
import type { InteractiveModeContext } from "./types";

/** The setup screen occupies the entire terminal in both renderers. */
export const SETUP_PAGE: PageProps = { role: "omp.app.setup" };

/** A ticking clock for setup animations; `stop` ends it. */
export function setupClock(): { now: () => number; stop(): void } {
	const now = signal(Date.now());
	const timer = setInterval(() => now.set(Date.now()), 33);
	return { now, stop: () => clearInterval(timer) };
}

/** The standalone splash, until a key, a click or its time-out. */
export async function runStartupSplash(ctx: InteractiveModeContext): Promise<void> {
	const clock = setupClock();
	await presentFullscreen<void>(ctx.shell, () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		return {
			view: () => jsx(StartupSplash, { version: VERSION, now: clock.now, onDone: () => resolve() }),
			done: promise,
			page: SETUP_PAGE,
			mouse: "click",
			dispose: () => clock.stop(),
		};
	});
}
