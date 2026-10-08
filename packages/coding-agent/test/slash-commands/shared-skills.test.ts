import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type { SkillPackument, SkillVersionManifest, SkillVersionSummary } from "@oh-my-pi/pi-wire/skillshare";
import { Settings } from "../../src/config/settings";
import { SkillshareClient } from "../../src/skillshare/client";
import { computeIntegrity } from "../../src/skillshare/installer";
import { getSkillStorePath, readSkillsLock, readSkillsManifest } from "../../src/skillshare/manifest";
import { writeTar } from "../../src/skillshare/tar";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const PACKAGE = "@alice/shared-skill";

function packageVersion(version: string) {
	const files = {
		"SKILL.md": `---\nname: shared-skill\ndescription: Shared command ${version}\n---\n# ${version}\n`,
		"scripts/check.sh": "#!/bin/sh\necho checked\n",
	};
	const encoder = new TextEncoder();
	const bytes = Bun.gzipSync(
		new Uint8Array(
			writeTar(
				Object.entries(files).map(([file, content]) => ({
					path: file,
					content: encoder.encode(content),
					executable: file.startsWith("scripts/"),
				})),
			),
		),
	);
	const summary: SkillVersionSummary = {
		version,
		publishedAt: 0,
		publisher: { username: "alice", avatar: "00" },
		integrity: computeIntegrity(bytes),
		size: bytes.length,
		unpackedSize: 0,
		fileCount: 2,
		hasScripts: true,
		yanked: false,
	};
	return { bytes, summary };
}

describe("shared skill registry commands", () => {
	let root: string;
	let project: string;
	let previousAgentDir: string;
	let registry: SkillPackument;
	let tarballs: Record<string, Uint8Array>;
	let runtime: SlashCommandRuntime;
	let output: string[];
	let clients: SkillshareClient[];
	let approve: boolean;
	const refreshSkills = vi.fn(async () => {});
	const refreshCommands = vi.fn(async () => {});
	const confirm = vi.fn(async () => approve);

	beforeEach(async () => {
		previousAgentDir = getAgentDir();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shared-skills-"));
		project = path.join(root, "project");
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		// Anchor registry discovery inside this fixture, not an ancestor's .omp.
		await fs.mkdir(path.join(project, ".omp"));
		setAgentDir(path.join(root, "agent"));
		const first = packageVersion("1.0.0");
		registry = {
			scope: "alice",
			name: "shared-skill",
			description: "Shared command skill",
			keywords: [],
			owners: [{ username: "alice", avatar: "00" }],
			distTags: { latest: "1.0.0" },
			versions: { "1.0.0": first.summary },
			createdAt: 0,
			updatedAt: 0,
			downloads: { weekly: 0, total: 0, daily: [] },
			canManage: false,
		};
		tarballs = { "1.0.0": first.bytes };
		clients = [];
		output = [];
		approve = true;
		refreshSkills.mockClear();
		refreshCommands.mockClear();
		confirm.mockClear();
		const createClient = SkillshareClient.create;
		vi.spyOn(SkillshareClient, "create").mockImplementation(async options => {
			const client = await createClient(options);
			clients.push(client);
			vi.spyOn(client, "search").mockResolvedValue({ total: 0, page: 1, perPage: 10, hits: [] });
			vi.spyOn(client, "packument").mockImplementation(async () => registry);
			vi.spyOn(client, "version").mockImplementation(
				async (_scope, _name, version): Promise<SkillVersionManifest> => ({
					...registry.versions[version]!,
					scope: "alice",
					name: "shared-skill",
					description: "Shared skill fixture",
					metadata: {},
					keywords: [],
					readmePath: "SKILL.md",
					provenance: { publisher: registry.versions[version]!.publisher, viaToken: false },
					files: [{ path: "scripts/check.sh", size: 23, sha256: "00", executable: true }],
				}),
			);
			vi.spyOn(client, "tarball").mockImplementation(async (_scope, _name, version) => tarballs[version]!);
			vi.spyOn(client, "close");
			return client;
		});
		runtime = {
			cwd: project,
			settings: Settings.isolated({ "skills.registryUrl": "https://skills.test" }),
			session: { refreshSkills, emitNotice: vi.fn() },
			sessionManager: { getCwd: () => project },
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands,
			reloadPlugins: async () => {},
			ui: { confirm, select: async () => undefined },
		} as unknown as SlashCommandRuntime;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setAgentDir(previousAgentDir);
		await removeWithRetries(root);
	});

	test("search, install, list, and update run the real shared service in the requested project", async () => {
		expect(await executeAcpBuiltinSlashCommand("/skills search shared", runtime)).toEqual({ consumed: true });
		expect(clients[0]!.search).toHaveBeenCalledWith("shared");
		expect(await executeAcpBuiltinSlashCommand(`/skills install ${PACKAGE}`, runtime)).toEqual({ consumed: true });
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(await readSkillsManifest(path.join(project, ".omp", "skills.json")), output.join("\n")).toEqual({
			skills: { [PACKAGE]: "^1.0.0" },
		});
		expect(
			await Bun.file(path.join(getSkillStorePath("alice", "shared-skill", "1.0.0"), "SKILL.md")).text(),
		).toContain("# 1.0.0");
		expect(await executeAcpBuiltinSlashCommand("/skills installed", runtime)).toEqual({ consumed: true });
		expect(output.join("\n")).toContain(PACKAGE);
		const next = packageVersion("1.1.0");
		registry.versions["1.1.0"] = next.summary;
		registry.distTags.latest = "1.1.0";
		tarballs["1.1.0"] = next.bytes;
		expect(await executeAcpBuiltinSlashCommand("/skills update", runtime)).toEqual({ consumed: true });
		expect((await readSkillsLock(path.join(project, ".omp", "skills.lock.json"))).skills[PACKAGE]!.version).toBe(
			"1.1.0",
		);
		expect(refreshSkills).toHaveBeenCalledTimes(2);
		expect(refreshCommands).toHaveBeenCalledTimes(2);
		for (const client of clients) {
			expect(client.registryUrl).toBe("https://skills.test");
			expect(client.close).toHaveBeenCalledTimes(1);
		}
	});

	test("declining script approval writes no manifest and downloads nothing", async () => {
		approve = false;
		expect(await executeAcpBuiltinSlashCommand(`/skills install ${PACKAGE}`, runtime)).toEqual({ consumed: true });
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(clients[0]!.tarball).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(project, ".omp", "skills.json")).exists()).toBe(false);
		expect(refreshSkills).not.toHaveBeenCalled();
		expect(refreshCommands).not.toHaveBeenCalled();
		expect(output.join("\n")).toContain("declined");
	});
});
