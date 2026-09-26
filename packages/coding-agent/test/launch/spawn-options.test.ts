import { describe, expect, it } from "bun:test";
import { resolveDaemonSpawnOptions } from "../../src/launch/spawn-options";

describe("resolveDaemonSpawnOptions", () => {
	it("hides Windows daemons when the host has no console", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				hostHasInheritableConsole: false,
			}),
		).toEqual({ detached: true, windowsHide: true });
	});

	it("keeps the Windows host console visible while detaching", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				hostHasInheritableConsole: true,
			}),
		).toEqual({ detached: true, windowsHide: false });
	});

	it("keeps POSIX daemons in their own session", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "linux",
				hostHasInheritableConsole: false,
			}),
		).toEqual({ detached: true });
	});
});
