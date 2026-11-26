import { describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings, withActiveSettings } from "../src/config/settings";
import { loadSkills } from "../src/extensibility/skills";
import { expandSlashCommand, loadSlashCommands } from "../src/extensibility/slash-commands";
import { getBundledAgent } from "../src/task/agents";

describe("bundled Developer Test Agent consumers", () => {
	it("exposes manual-only skills and the specialist, and expands a discovered /dt command", async () => {
		await using root = await TempDir.create("@omp-dta-consumer-");
		const options = { cwd: root.path(), agentDir: root.join("profile") };
		const home = spyOn(os, "homedir").mockReturnValue(root.path());
		try {
			const [{ skills }, commands] = await withActiveSettings(Settings.isolated(), () =>
				Promise.all([loadSkills(options), loadSlashCommands(options)]),
			);
			const dtSkills = skills.filter(skill => skill.source === "developer-test-agent:project");
			expect(dtSkills.map(skill => skill.name).sort()).toEqual([
				"fix-ut",
				"generate-ut",
				"improve-coverage",
				"improve-validity",
				"test-report",
			]);
			for (const skill of dtSkills) expect(skill.hide, skill.name).toBe(true);
			expect(getBundledAgent("developer-test-agent")?.hide).toBe(true);
			expect(commands.map(command => command.name)).toEqual(
				expect.arrayContaining(["cloud-dt-fix", "dt", "generate-dt-dir", "generate-dt-files", "incremental-dt"]),
			);
			const request = "为 src/service.py 生成单元测试\n保留 <T>、{{literal}} 和 $&";
			const invocation = `/dt ${request}`;
			const expanded = expandSlashCommand(invocation, commands);
			expect(expanded).not.toBe(invocation);
			expect(expanded).toContain(request);
		} finally {
			home.mockRestore();
		}
	});
});
