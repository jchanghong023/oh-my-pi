import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JCH_GIT_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/jch-commands/git";
import { JCH_WORKFLOW_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/jch-commands/workflow";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();
	if (result.exitCode !== 0) {
		throw new Error([`git ${args.join(" ")} failed`, stdout, stderr].filter(Boolean).join("\n"));
	}
	return stdout;
}

describe("direct JCH git slash commands", () => {
	let root: string;
	let remote: string;
	let seed: string;
	let work: string;

	async function runDiscardAll() {
		const command = JCH_GIT_SLASH_COMMANDS.find(candidate => candidate.name === "jchgitdiscardall");
		if (!command?.handleTui) throw new Error("Missing /jchgitdiscardall TUI handler");
		let status = "";
		let error = "";
		let editor = "/jchgitdiscardall";
		const result = await command.handleTui({ name: command.name, args: "", text: "/jchgitdiscardall" }, {
			ctx: {
				editor: {
					setText: (text: string) => {
						editor = text;
					},
				},
				sessionManager: { getCwd: () => work },
				showStatus: (text: string) => {
					status = text;
				},
				showError: (text: string) => {
					error = text;
				},
			},
		} as unknown as TuiSlashCommandRuntime);
		return { result, status, error, editor };
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omp-jch-git-"));
		remote = join(root, "remote.git");
		seed = join(root, "seed");
		work = join(root, "work");
		git(root, ["init", "--bare", remote]);
		git(root, ["clone", remote, seed]);
		git(seed, ["switch", "-c", "main"]);
		git(seed, ["config", "user.name", "OMP Test"]);
		git(seed, ["config", "user.email", "omp@example.invalid"]);
		writeFileSync(join(seed, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(seed, "tracked.txt"), "base\n");
		git(seed, ["add", ".gitignore", "tracked.txt"]);
		git(seed, ["commit", "-m", "base"]);
		git(seed, ["push", "-u", "origin", "main"]);
		git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		git(root, ["clone", remote, work]);
		git(work, ["config", "user.name", "OMP Test"]);
		git(work, ["config", "user.email", "omp@example.invalid"]);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("runs git pull directly", async () => {
		writeFileSync(join(seed, "remote.txt"), "remote\n");
		git(seed, ["add", "remote.txt"]);
		git(seed, ["commit", "-m", "remote update"]);
		git(seed, ["push"]);

		const command = JCH_GIT_SLASH_COMMANDS.find(candidate => candidate.name === "jchgitpull");
		if (!command?.handle) throw new Error("Missing /jchgitpull handler");
		const output: string[] = [];
		const result = await command.handle({ name: command.name, args: "", text: "/jchgitpull" }, {
			cwd: work,
			output: (text: string) => {
				output.push(text);
			},
		} as unknown as SlashCommandRuntime);

		expect(result).toEqual({ consumed: true });
		expect(readFileSync(join(work, "remote.txt"), "utf8").trim()).toBe("remote");
		expect(output.join("\n")).toContain("Updating");
	});

	it("fetches all remotes before showing short branch status", async () => {
		writeFileSync(join(seed, "remote.txt"), "remote\n");
		git(seed, ["add", "remote.txt"]);
		git(seed, ["commit", "-m", "remote update"]);
		git(seed, ["push"]);

		const command = JCH_GIT_SLASH_COMMANDS.find(candidate => candidate.name === "jchgs");
		if (!command?.handle) throw new Error("Missing /jchgs handler");
		const output: string[] = [];
		const result = await command.handle({ name: command.name, args: "", text: "/jchgs" }, {
			cwd: work,
			output: (text: string) => {
				output.push(text);
			},
		} as unknown as SlashCommandRuntime);

		expect(result).toEqual({ consumed: true });
		expect(output.join("\n")).toContain("[behind 1]");
		expect(git(work, ["rev-parse", "refs/remotes/origin/main"])).toBe(git(seed, ["rev-parse", "HEAD"]));
	});

	it("fetches, hard-resets to upstream, and cleans ignored files", async () => {
		writeFileSync(join(work, "tracked.txt"), "local commit\n");
		git(work, ["add", "tracked.txt"]);
		git(work, ["commit", "-m", "local commit"]);
		writeFileSync(join(work, "tracked.txt"), "dirty\n");
		writeFileSync(join(work, "untracked.txt"), "untracked\n");
		writeFileSync(join(work, "ignored.txt"), "ignored\n");

		const { result, status, error, editor } = await runDiscardAll();

		expect(result).toEqual({ consumed: true });
		expect(editor).toBe("");
		expect(error).toBe("");
		expect(status).toContain("HEAD is now at");
		expect(git(work, ["rev-parse", "HEAD"])).toBe(git(work, ["rev-parse", "@{upstream}"]));
		expect(readFileSync(join(work, "tracked.txt"), "utf8").trim()).toBe("base");
		expect(existsSync(join(work, "untracked.txt"))).toBe(false);
		expect(existsSync(join(work, "ignored.txt"))).toBe(false);
	});

	it("stops before reset and clean when the upstream branch was deleted", async () => {
		git(remote, ["config", "receive.denyDeleteCurrent", "ignore"]);
		git(seed, ["push", "origin", "--delete", "main"]);
		writeFileSync(join(work, "tracked.txt"), "dirty\n");
		writeFileSync(join(work, "untracked.txt"), "untracked\n");
		writeFileSync(join(work, "ignored.txt"), "ignored\n");

		const { result, status, error } = await runDiscardAll();

		expect(result).toEqual({ consumed: true });
		expect(status).toBe("");
		expect(error).toContain("git reset --hard @{upstream} failed");
		expect(readFileSync(join(work, "tracked.txt"), "utf8").trim()).toBe("dirty");
		expect(existsSync(join(work, "untracked.txt"))).toBe(true);
		expect(existsSync(join(work, "ignored.txt"))).toBe(true);
	});

	it("uses a direct local summary for bare jchcatchup", async () => {
		writeFileSync(join(work, "quick.txt"), "untracked\n");
		const command = JCH_WORKFLOW_SLASH_COMMANDS.find(candidate => candidate.name === "jchcatchup");
		if (!command?.handle) throw new Error("Missing /jchcatchup handler");
		const output: string[] = [];
		const result = await command.handle({ name: command.name, args: "", text: "/jchcatchup" }, {
			cwd: work,
			output: (text: string) => {
				output.push(text);
			},
		} as unknown as SlashCommandRuntime);

		expect(result).toEqual({ consumed: true });
		expect(output.join("\n")).toContain("?? quick.txt");
		expect(output.join("\n")).toContain("base");
	});

	it("keeps deep catchup behind the full subcommand", async () => {
		const command = JCH_WORKFLOW_SLASH_COMMANDS.find(candidate => candidate.name === "jchcatchup");
		if (!command?.handle) throw new Error("Missing /jchcatchup handler");
		const result = await command.handle(
			{
				name: command.name,
				args: "full packages/coding-agent",
				text: "/jchcatchup full packages/coding-agent",
			},
			{} as SlashCommandRuntime,
		);

		if (!result || !("prompt" in result)) throw new Error("Expected full catchup to invoke the agent");
		expect(result.prompt).toContain("读取与当前工作相关的 untracked 文本源文件");
		expect(result.prompt).toContain("默认不超过 20 个");
		expect(result.prompt).toContain("packages/coding-agent");
	});
});
