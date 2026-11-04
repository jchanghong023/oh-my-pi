import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const repoRoot = path.resolve(import.meta.dir, "..");

async function git(cwd: string, args: string[], env = process.env): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(code, `git ${args.join(" ")}: ${stderr}`).toBe(0);
	return stdout.trim();
}

describe("fork Git hook contract", () => {
	// Repository-local state is intentionally inspected through Git rather than
	// by asserting source-code spelling in setup or installer scripts.
	it("disables hooks in this checkout and retains no dormant hook files", async () => {
		expect(await git(repoRoot, ["config", "--local", "--get", "core.hooksPath"])).toBe("/dev/null");
		const commonDir = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
		const hooks = path.resolve(repoRoot, commonDir, "hooks");
		let entries: string[];
		try {
			entries = await fs.readdir(hooks);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			entries = [];
		}
		expect(entries).toEqual([]);
	});

	// Adversarial hooks fail immediately if Git runs them. All writes, commits,
	// branch switches and push traffic are confined to disposable repositories.
	it("commits, checks out and pushes without running checks or tracking hooks", async () => {
		using temp = TempDir.createSync("@fork-disabled-hooks-");
		const repo = temp.join("work");
		const remote = temp.join("remote.git");
		await fs.mkdir(repo);
		const env = {
			...process.env,
			HOME: temp.path(),
			USERPROFILE: temp.path(),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: temp.join("empty-gitconfig"),
			GIT_CONFIG_COUNT: "0",
			GIT_DIR: undefined,
			GIT_WORK_TREE: undefined,
		};
		const hooksPath = await git(repoRoot, ["config", "--local", "--get", "core.hooksPath"]);
		expect(hooksPath).toBe("/dev/null");
		await git(repo, ["init", "--initial-branch=main"], env);
		await git(repo, ["config", "--local", "core.hooksPath", hooksPath], env);
		await git(repo, ["config", "--local", "user.name", "Hook contract"], env);
		await git(repo, ["config", "--local", "user.email", "hooks@example.invalid"], env);
		const marker = temp.join("hook-effects.txt");
		const quotedMarker = marker.replace(/\\/g, "/").replace(/'/g, "'\\''");
		for (const name of [
			"pre-commit",
			"prepare-commit-msg",
			"commit-msg",
			"post-commit",
			"post-checkout",
			"pre-push",
			"reference-transaction",
		]) {
			const file = path.join(repo, ".git", "hooks", name);
			await Bun.write(file, `#!/bin/sh\nprintf 'hook invoked\\n' >> '${quotedMarker}'\nexit 97\n`);
			await fs.chmod(file, 0o755);
		}
		await Bun.write(path.join(repo, "payload.txt"), "committed without hooks\n");
		await git(repo, ["add", "payload.txt"], env);
		await git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "hook contract"], env);
		await git(repo, ["checkout", "-b", "probe"], env);
		await git(repo, ["init", "--bare", remote], env);
		await git(repo, ["-c", "push.gpgsign=false", "push", remote, "HEAD:refs/heads/probe"], env);
		expect(await git(repo, ["show", "HEAD:payload.txt"], env)).toBe("committed without hooks");
		expect(await git(repo, ["rev-parse", "HEAD"], env)).toBe(
			await git(repo, ["--git-dir", remote, "rev-parse", "refs/heads/probe"], env),
		);
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});
