import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { loadFilesFromDir, scanSkillsFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { parseFrontmatter, removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("parseFrontmatter", () => {
	const parse = (content: string) => parseFrontmatter(content, { source: "tests:frontmatter", level: "off" });

	test("parses mixed complex YAML", () => {
		const content = `---
name: complex-test
version: 1.0.0
tags:
  - prod
  - critical
metadata:
  author: tester
  created: 2024-01-01
description: |
  Multi-line description
  with formatting
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			name: "complex-test",
			version: "1.0.0",
			tags: ["prod", "critical"],
			metadata: {
				author: "tester",
				created: "2024-01-01",
			},
			description: "Multi-line description\nwith formatting\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("handles missing frontmatter", () => {
		const content = "Just body content";
		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Just body content");
	});

	test("handles empty frontmatter", () => {
		const content = `---
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Body content");
	});

	test("normalizes kebab-case keys to camelCase", () => {
		const content = `---
thinking-level: medium
output-schema: json
nested-field:
  inner-key: value
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			thinkingLevel: "medium",
			outputSchema: "json",
			nestedField: { innerKey: "value" },
		});
		expect(result.body).toBe("Body content");
	});
});

describe("loadFilesFromDir recursion", () => {
	let tempDir!: string;
	let ctx!: LoadContext;

	const write = (rel: string, content: string) => {
		const full = path.join(tempDir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	};

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loadfiles-recursion-"));
		ctx = { cwd: tempDir, home: tempDir, repoRoot: tempDir };
		// Top-level tool plus a Python-venv-style frontend asset nested below it,
		// mirroring the ~/.codex/tools/mineru/Lib/site-packages layout from #8552.
		write("my-tool.ts", "export default () => ({});\n");
		write(
			path.join("mineru", "Lib", "site-packages", "gradio", "assets", "svelte", "media-query-D37ajmZt.js"),
			"window.matchMedia;\n",
		);
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	const names = (dir: string, recursive?: boolean) =>
		loadFilesFromDir<{ name: string }>(ctx, dir, "test", "user", {
			extensions: ["ts", "js"],
			recursive,
			transform: (_name, _content, filePath) => ({ name: path.relative(dir, filePath) }),
		}).then(r => r.items.map(i => i.name).sort());

	// Regression for #8552: the non-recursive default must NOT descend into the
	// venv subtree. The native glob defaults recursive=true, so before the fix
	// `*.{ts,js}` was rewritten to `**/*.{ts,js}` and imported the Svelte asset.
	test("default scan stays top-level and skips the venv subtree", async () => {
		expect(await names(tempDir)).toEqual(["my-tool.ts"]);
	});

	test("recursive:true still walks the whole subtree", async () => {
		expect(await names(tempDir, true)).toEqual([
			path.join("mineru", "Lib", "site-packages", "gradio", "assets", "svelte", "media-query-D37ajmZt.js"),
			"my-tool.ts",
		]);
	});
});

describe("offline custom skill scans", () => {
	let tempDir: string;
	let platform: NodeJS.Platform;
	let offline: string | undefined;

	beforeEach(() => {
		clearCache();
		platform = process.platform;
		offline = process.env.OMP_OFFLINE;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-offline-skills-"));
		for (const name of ["valid", "missing", "invalid", ".hidden"]) {
			fs.mkdirSync(path.join(tempDir, name));
		}
		fs.writeFileSync(
			path.join(tempDir, "valid", "SKILL.md"),
			"---\nname: valid\ndescription: Valid skill\n---\nBody",
		);
		fs.mkdirSync(path.join(tempDir, "invalid", "SKILL.md"));
		fs.writeFileSync(path.join(tempDir, ".hidden", "SKILL.md"), "---\nname: hidden\n---\nBody");
		fs.writeFileSync(path.join(tempDir, "not-a-directory"), "ignored");
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: platform });
		if (offline === undefined) delete process.env.OMP_OFFLINE;
		else process.env.OMP_OFFLINE = offline;
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	test.each([
		["linux", " YeS ", "custom", false],
		["linux", "false", "custom", true],
		["win32", "true", "custom", true],
		["linux", "true", "agents", true],
	] as const)("preserves scan semantics on %s offline=%s provider=%s", async (host, value, providerId, probes) => {
		Object.defineProperty(process, "platform", { value: host });
		process.env.OMP_OFFLINE = value;
		const exists = spyOn(fs, "existsSync");
		try {
			const ctx = { cwd: tempDir, home: tempDir, repoRoot: null };
			const result = await scanSkillsFromDir(ctx, { dir: tempDir, providerId, level: "user", includeSelf: true });
			expect(result.items.map(skill => skill.name)).toEqual(["valid"]);
			expect(result.warnings).toEqual([]);
			expect(exists.mock.calls.length > 0).toBe(probes);
			const missing = await scanSkillsFromDir(ctx, {
				dir: path.join(tempDir, "absent"),
				providerId,
				level: "user",
			});
			expect(missing).toEqual({ items: [], warnings: [] });
		} finally {
			exists.mockRestore();
		}
	});

	test("follows linked skill directories without relaxing file type checks", async () => {
		fs.symlinkSync(
			path.join(tempDir, "valid"),
			path.join(tempDir, "linked"),
			platform === "win32" ? "junction" : "dir",
		);
		if (platform !== "win32") {
			fs.symlinkSync(path.join(tempDir, "absent"), path.join(tempDir, "broken"), "dir");
			fs.symlinkSync(path.join(tempDir, "valid", "SKILL.md"), path.join(tempDir, "missing", "SKILL.md"));
		}
		Object.defineProperty(process, "platform", { value: "linux" });
		process.env.OMP_OFFLINE = "on";
		const result = await scanSkillsFromDir(
			{ cwd: tempDir, home: tempDir, repoRoot: null },
			{ dir: tempDir, providerId: "custom", level: "user" },
		);
		expect(result.items).toHaveLength(platform === "win32" ? 2 : 3);
		expect(result.items.every(skill => skill.name === "valid")).toBe(true);
		expect(result.warnings).toEqual([]);
	});
});
