import { describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { OpenWikiSearchTool } from "../../src/tools/openwiki";

// Use the repository's installed PTY/terminal decoder, not a mocked Ink tree.
describe("OMP OpenWiki interactive link consumer", () => {
	it("creates a named workspace from the requested finder directory and queries its linked repository", async () => {
		const tuiTest = Bun.which("tui-test");
		if (!tuiTest) throw new Error("tui-test is required for OpenWiki interactive linking acceptance");
		using dir = TempDir.createSync("@omp-openwiki-link-tty-");
		const finder = dir.join("repositories");
		const first = path.join(finder, "repo-a");
		const second = path.join(finder, "repo-b");
		const config = dir.join("config");
		const env = {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			HOME: dir.path(),
			USERPROFILE: dir.path(),
			OMP_CONFIG_ROOT: config,
			OMP_PROFILE: "default",
			OMP_OFFLINE: "1",
			NO_COLOR: "1",
			GIT_CONFIG_NOSYSTEM: "1",
		};
		for (const root of [first, second]) {
			await mkdir(root, { recursive: true });
			const git = Bun.spawn(["git", "init", "--quiet"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
			const [code, error] = await Promise.all([git.exited, new Response(git.stderr).text()]);
			expect(code, error).toBe(0);
			await mkdir(path.join(root, "openwiki"));
			await writeFile(
				path.join(root, "openwiki", ".last-update.json"),
				JSON.stringify({
					updatedAt: "2026-01-01T00:00:00Z",
					command: "init",
					model: "deepseek/fixture-model",
					status: "complete",
					language: "en",
				}),
			);
			await writeFile(
				path.join(root, "openwiki", "quickstart.md"),
				`---\ntitle: ${path.basename(root)}\ntype: guide\n---\n# ${path.basename(root)}\n\n## Operation\n\nINTERACTIVE_LINK_${path.basename(root)}_BEACON\n`,
			);
		}
		const session = `openwiki-link-${crypto.randomUUID()}`;
		async function tui(...args: string[]) {
			const child = Bun.spawn([tuiTest!, "--session", session, ...args], {
				cwd: dir.path(),
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (code !== 0) throw new Error(`tui-test ${args.join(" ")} exited ${code}:\n${stdout}\n${stderr}`);
			return stdout;
		}
		try {
			await tui(
				"run",
				"--cwd",
				first,
				"--cols",
				"120",
				"--rows",
				"40",
				...Object.entries(env)
					.filter((entry): entry is [string, string] => entry[1] !== undefined)
					.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
				"--",
				process.execPath,
				path.resolve(import.meta.dir, "../../src/cli.ts"),
				"openwiki",
				"link",
				finder,
			);
			await tui("expect", "text", "Create workspace", "--timeout", "30000");
			await tui("key", "press", "Enter");
			await tui("expect", "text", "Workspace name", "--timeout", "30000");
			await tui("type", "Interactive Links");
			await tui("key", "press", "Enter");
			await tui("expect", "text", "Selected repositories", "--timeout", "30000");
			await tui("expect", "text", "repo-a", "--timeout", "30000");
			await tui("expect", "text", "repo-b", "--timeout", "30000");
			await tui("key", "press", "Space");
			const selected = async (names: string[]) => {
				const deadline = Date.now() + 10_000;
				while (true) {
					const screen = await tui("text");
					const pinned = screen.split("Selected repositories")[1]?.split("Path:")[0] ?? "";
					if (names.every(name => pinned.includes(name))) return;
					if (Date.now() > deadline) throw new Error(`Selected Wiki repositories did not update: ${screen}`);
					await Bun.sleep(50);
				}
			};
			await selected(["repo-a"]);
			await tui("key", "press", "Down");
			await tui("key", "press", "Space");
			await selected(["repo-a", "repo-b"]);
			await tui("key", "press", "Down", "Enter");
			await tui("expect", "text", "Edit wikis", "--timeout", "30000");
			await tui("key", "press", "Down", "Down", "Down", "Enter");
			await tui("expect", "text", "Create workspace", "--timeout", "30000");
			await tui("key", "press", "Down", "Down", "Enter");
			await tui("wait", "exit");
			expect(await tui("state")).toMatch(/^exited: 0\r?$/mu);
			const agent = path.join(config, "agent");
			const registry = JSON.parse(await readFile(path.join(agent, "openwiki", "wiki-workspaces.json"), "utf8"));
			expect(registry.workspaces).toHaveLength(1);
			expect(registry.workspaces[0].name).toBe("Interactive Links");
			expect(registry.workspaces[0].wikis).toHaveLength(2);
			expect(registry.wikis.map((wiki: { name: string }) => wiki.name).sort()).toEqual(["repo-a", "repo-b"]);
			const settings = Settings.isolated({});
			settings.getAgentDir = () => agent;
			const search = new OpenWikiSearchTool({
				cwd: first,
				settings,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			});
			const result = await search.execute("linked-query", { query: "INTERACTIVE_LINK_repo-b_BEACON" });
			const data = JSON.parse(result.content[0].text);
			expect(data.results[0].wiki).toBe("repo-b");
			expect(data.results[0].content).toContain("INTERACTIVE_LINK_repo-b_BEACON");
		} finally {
			await tui("close");
		}
	}, 60_000);
});
