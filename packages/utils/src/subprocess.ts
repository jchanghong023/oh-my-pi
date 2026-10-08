/**
 * Terminate a subprocess owned by the caller and await its exit, without loading
 * the native addon. POSIX process-group termination requires a child spawned
 * with `detached: true`; never pass an unrelated process or group leader.
 */
export async function terminateOwnedSubprocess(child: Bun.Subprocess, options: { detached: boolean }): Promise<void> {
	// An exited child's PID (and POSIX group ID) may already belong to someone else.
	if (child.exitCode !== null) {
		await child.exited;
		return;
	}

	if (process.platform === "win32") {
		const terminator = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			windowsHide: true,
		});
		const [exitCode, stderr] = await Promise.all([terminator.exited, new Response(terminator.stderr).text()]);
		// The child may have exited naturally between the guard and taskkill.
		if (exitCode !== 0 && child.exitCode === null) {
			throw new Error(
				`Failed to terminate owned process tree ${child.pid} (taskkill exit ${exitCode}): ${stderr.trim()}`,
			);
		}
	} else if (options.detached) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			// ESRCH means the owned group exited while cancellation was being delivered.
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	} else {
		child.kill("SIGKILL");
	}
	await child.exited;
}
