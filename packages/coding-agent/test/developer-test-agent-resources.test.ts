import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "../src/capability/types";
import { loadDeveloperTestCommands, loadDeveloperTestSkills } from "../src/discovery/developer-test-agent";
import { getDeveloperTestAgentRoot } from "../src/extensibility/plugins/developer-test-agent-resources";
import { expandSlashCommand } from "../src/extensibility/slash-commands";
import { getBundledAgent } from "../src/task/agents";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function context(): Promise<LoadContext> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dta-consumer-"));
	directories.push(cwd);
	return { cwd, home: cwd, repoRoot: null, agentDir: path.join(cwd, "profile") };
}

describe("bundled Developer Test Agent consumers", () => {
	it("discovers the specialist, all five skills and all five file commands in an empty project", async () => {
		const ctx = await context();
		const root = await getDeveloperTestAgentRoot(ctx.agentDir);
		const skills = await loadDeveloperTestSkills(ctx);
		expect(skills.items.map(skill => skill.name).sort()).toEqual([
			"fix-ut",
			"generate-ut",
			"improve-coverage",
			"improve-validity",
			"test-report",
		]);
		for (const skill of skills.items) {
			expect(skill.containRoot).toBe(root);
			expect(path.isAbsolute(skill.path)).toBe(true);
			expect(path.relative(ctx.cwd, skill.path).startsWith("..")).toBe(true);
			expect(skill.frontmatter?.disableModelInvocation).toBe(true);
		}
		const commands = await loadDeveloperTestCommands(ctx);
		expect(commands.items.map(command => command.name).sort()).toEqual([
			"cloud-dt-fix",
			"dt",
			"generate-dt-dir",
			"generate-dt-files",
			"incremental-dt",
		]);
		const agent = getBundledAgent("developer-test-agent");
		expect(agent).toMatchObject({ name: "developer-test-agent", source: "bundled", hide: true });
		const dt = commands.items.find(command => command.name === "dt")!;
		const request = "为 src/service.py 生成单元测试\n保留 <T>、{{literal}} 和 $&";
		const expanded = expandSlashCommand(`/dt ${request}`, [
			{
				name: dt.name,
				content: dt.content,
				description: "DT",
				source: "bundled",
			},
		]);
		expect(expanded).toContain(request);
		expect(expanded).not.toContain("{{{rawArguments}}}");
	});
});
