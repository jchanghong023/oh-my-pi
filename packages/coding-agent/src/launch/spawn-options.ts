/** Platform-specific options for the launch broker and its non-PTY children. */
export interface DaemonSpawnOptions {
	detached: boolean;
	windowsHide?: boolean;
}

/** Keep launch processes alive across consumers while controlling Windows console visibility. */
export function resolveDaemonSpawnOptions(opts: {
	platform: NodeJS.Platform;
	hostHasInheritableConsole: boolean;
}): DaemonSpawnOptions {
	if (opts.platform !== "win32") return { detached: true };
	return {
		detached: true,
		windowsHide: !opts.hostHasInheritableConsole,
	};
}
