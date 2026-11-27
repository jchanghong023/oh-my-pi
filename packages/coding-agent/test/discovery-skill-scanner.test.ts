import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("skill directory asynchronous scanner contract", () => {
	it("loads valid skills without probing candidate files synchronously", async () => {
		using root = TempDir.createSync("@omp-discovery-scanner-");
		const valid = root.join("valid", "SKILL.md");
		const missing = root.join("missing", "SKILL.md");
		const notFile = root.join("not-file", "SKILL.md");
		await fs.promises.mkdir(path.dirname(valid), { recursive: true });
		await fs.promises.mkdir(path.dirname(missing), { recursive: true });
		await fs.promises.mkdir(notFile, { recursive: true });
		await fs.promises.writeFile(valid, "---\nname: valid\ndescription: Async scanner\n---\nReal skill body\n");
		const exists = spyOn(fs, "existsSync");
		const stat = spyOn(fs, "statSync");
		const lstat = spyOn(fs, "lstatSync");
		const access = spyOn(fs, "accessSync");
		try {
			const loaded = await loadSkillsFromDir({ dir: root.path(), source: "custom:user" });

			expect(loaded.skills.map(skill => ({ name: skill.name, filePath: skill.filePath }))).toEqual([
				{ name: "valid", filePath: valid },
			]);
			for (const calls of [exists.mock.calls, stat.mock.calls, lstat.mock.calls, access.mock.calls]) {
				expect(calls.filter(call => path.basename(String(call[0])) === "SKILL.md")).toEqual([]);
			}
		} finally {
			access.mockRestore();
			lstat.mockRestore();
			stat.mockRestore();
			exists.mockRestore();
		}
	});
});
