import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { TEAM_SLASH_COMMANDS } from "../../src/jch-commands/team";
import { KnowledgeService } from "../../src/knowledge/service";
import { RepoService } from "../../src/repo/service";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";
import type { TeamRunResult } from "../../src/team/types";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";
import { contentText, createProviderFixture, type ModelRequest, type Reply } from "../spec-driven/provider-fixture";

// Real registered /team handler -> native background owner -> every real child
// SDK session -> HTTP model fixture -> actual Wiki/Repo/read tools -> durable report.
// The fixture proves tool access and evidence transport, not model reasoning quality.
test("public Team stages and recheck query retained Wiki and Repo evidence without modifying project bytes", async () => {
	const state = beginSettingsTest();
	await using root = await TempDir.create("@omp-team-retrieval-");
	const cwd = root.join("project");
	const agentDir = root.join("agent");
	const documents = root.join("documents");
	await Promise.all([cwd, agentDir, documents].map(directory => fs.mkdir(directory, { recursive: true })));
	setAgentDir(agentDir);
	const source = path.join(cwd, "engine.py");
	const sourceText = "def preserve_api(): return 'TEAM_REPO_BEACON'\n";
	await fs.writeFile(source, sourceText);
	await fs.writeFile(
		path.join(documents, "guide.md"),
		"# Compatibility\nTEAM_WIKI_BEACON requires preserving the public API.\n",
	);
	const wiki = new KnowledgeService({ agentDir, cwd });
	const repo = new RepoService({ agentDir, cwd });
	const auth = await AuthStorage.create(":memory:");
	let session: AgentSession | undefined;
	const observed: Array<{ marker: string; results: string[] }> = [];
	const reply = (request: ModelRequest): Reply => {
		const task = request.messages
			.filter(message => message.role === "user")
			.map(message => contentText(message.content))
			.findLast(text => text.includes("[team-stage:"));
		const marker = task?.match(/\[team-stage:([^\]]+)\]/u)?.[1];
		if (!marker) throw new Error("Only native Team child requests are expected");
		const advertised = (name: string) => {
			const tool = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === name)?.function?.name;
			if (!tool) throw new Error(`Team child is missing ${name}`);
			return tool;
		};
		const toolNames = request.tools?.map(tool => tool.function?.name.replace(/^_/u, "")) ?? [];
		expect(toolNames).not.toEqual(expect.arrayContaining(["write"]));
		for (const forbidden of ["write", "edit", "bash", "eval", "task", "wiki"])
			expect(toolNames).not.toContain(forbidden);
		const results = request.messages
			.filter(message => message.role === "tool")
			.map(message => contentText(message.content));
		const queries = [
			{ name: "knowledge_search", args: { query: "TEAM_WIKI_BEACON", mode: "grep" } },
			{ name: "repo", args: { query: "TEAM_REPO_BEACON" } },
			{ name: "read", args: { path: source } },
		];
		if (results.length < queries.length) {
			const query = queries[results.length]!;
			return { tool: { name: advertised(query.name), args: query.args } };
		}
		expect(results).toHaveLength(3);
		expect(results[0]).toContain("TEAM_WIKI_BEACON");
		expect(results[1]).toContain("TEAM_REPO_BEACON");
		expect(results[2]).toContain(sourceText.trim());
		observed.push({ marker, results });
		let data: Record<string, unknown>;
		if (marker.startsWith("proposal"))
			data = {
				proposal: "Preserve the existing public API.",
				noViableProposal: false,
				investigationBlockedReason: "",
				keyAssumptions: [],
				risks: [],
				unknowns: [],
				acceptanceCriteria: ["Preserve the API"],
				ambiguityInterpretations: [],
				evidence: [
					{ claim: "Existing API and compatibility constraint verified", source: "guide.md:2; engine.py:1" },
				],
			};
		else if (marker.startsWith("alignment"))
			data = {
				unifiedUnderstanding: "Preserve the public API.",
				acceptanceCriteria: ["Preserve the API"],
				factDifferences: [],
				interpretationDifferences: [],
			};
		else if (marker.startsWith("revision"))
			data = {
				revisedProposal: "Preserve the existing public API and document its compatibility condition.",
				revisionSummary: "Document the verified condition.",
				responses: [
					{
						findingId: "A-F1",
						disposition: "accepted-and-revised",
						explanation: "The retained Wiki guide requires compatibility.",
					},
				],
				reviewFlags: {
					changedCoreDesign: true,
					claimsResolvedBlocking: false,
					newEvidenceChangesAssumptions: false,
					disputesBlockingFinding: false,
				},
			};
		else if (marker.startsWith("review")) {
			const finding = marker.includes("target=A") && !marker.includes("recheck");
			data = {
				noSubstantiveIssues: !finding,
				reviewSummary: "Verified current code and retained Wiki evidence.",
				findings: finding
					? [
							{
								severity: "important",
								issue: "State the compatibility condition",
								impact: "Avoid ambiguous adoption",
								evidence: "guide.md:2",
								targetAspect: "Compatibility",
							},
						]
					: [],
				blockingResolutions: [],
			};
		} else if (marker.startsWith("synthesis"))
			data = {
				reportMarkdown:
					"## Evidence\nTEAM_WIKI_BEACON and TEAM_REPO_BEACON establish the compatibility condition. Preserve the existing API.",
				recommendedProposal: "A",
				recommendationReason: "Preserves verified compatibility",
				recommendationPreconditions: "Keep the public API",
				hardConstraintViolations: [],
			};
		else throw new Error(`Unexpected native stage ${marker}`);
		return { tool: { name: advertised("yield"), args: { data } } };
	};
	await using provider = createProviderFixture({ reply });
	try {
		await wiki.init(documents, "manual");
		await fs.rm(documents, { recursive: true });
		await repo.build();
		const configFile = path.join(agentDir, "models.yml");
		await fs.writeFile(
			configFile,
			`providers:\n  deepseek:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        supportsTools: true\n        contextWindow: 1000000\n`,
		);
		const configBytes = await fs.readFile(configFile, "utf8");
		const settings = await Settings.loadIsolated({
			agentDir,
			cwd,
			inMemory: true,
			overrides: {
				"compaction.enabled": false,
				"prewalk.enabled": false,
				"tools.xdev": false,
				"todo.enabled": false,
				"mnemopi.noEmbeddings": true,
				"task.maxConcurrency": 2,
			},
		});
		const registry = new ModelRegistry(auth, configFile, { settings });
		const model = registry.find("deepseek", "chat-a");
		if (!model) throw new Error("Missing local Team model");
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			settings,
			model,
			authStorage: auth,
			modelRegistry: registry,
			sessionManager: SessionManager.create(cwd, path.join(agentDir, "sessions")),
			contextFiles: [],
			rules: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			autoTitle: false,
			bindProcessState: false,
		}));
		const output: string[] = [];
		await TEAM_SLASH_COMMANDS[0]!.handle!(
			{
				name: "team",
				args: "Use the retained Wiki and current code to plan compatible API changes.",
				text: "/team Use the retained Wiki and current code to plan compatible API changes.",
			},
			{
				session,
				settings,
				cwd,
				output: (text: string) => {
					output.push(text);
				},
			} as SlashCommandRuntime,
		);
		// Root SDK sessions own their manager; the injection option is for children.
		const jobs = session.asyncJobManager;
		const job = jobs?.getAllJobs().find(job => job.label.startsWith("/team "));
		if (!job) {
			throw new Error(
				`Public Team command did not register its background owner.\nCommand output:\n${output.join("\n") || "(none)"}`,
			);
		}
		await job.promise;
		expect(job.status).toBe("completed");
		const result = job.structured?.data as TeamRunResult;
		expect(result.status).toBe("completed");
		expect(result.candidates.map(candidate => candidate.label)).toEqual(["A", "B", "C"]);
		expect(observed.filter(call => call.marker.startsWith("proposal"))).toHaveLength(3);
		expect(observed.map(call => call.marker.split(" ")[0])).toEqual(
			expect.arrayContaining(["proposal", "alignment", "review", "revision", "synthesis"]),
		);
		expect(observed.filter(call => call.marker.includes("recheck"))).toHaveLength(1);
		expect(
			session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom_message" && entry.customType === "team-result"),
		).toHaveLength(1);
		expect(result.reportMarkdown).toContain("TEAM_WIKI_BEACON");
		expect(result.reportMarkdown).toContain("TEAM_REPO_BEACON");
		expect(await fs.readFile(source, "utf8")).toBe(sourceText);
		expect(await fs.readFile(configFile, "utf8")).toBe(configBytes);
		expect(await fs.readdir(cwd)).toEqual(["engine.py"]);
		expect(provider.failures).toEqual([]);
	} finally {
		await session?.dispose();
		auth.close();
		await wiki.close();
		repo.close();
		restoreSettingsTestState(state);
	}
}, 120_000);
