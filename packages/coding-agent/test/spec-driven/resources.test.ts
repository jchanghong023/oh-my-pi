import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import {
	ensureSpecDrivenResources,
	loadSpecDrivenSkill,
	resolveSpecDrivenResourcePath,
	runOpenSpec,
	runSuperpowersScript,
} from "../../src/spec-driven/resources";
import { archiveBase64 } from "../../src/spec-driven/vendor/archive.generated";

let temporary: string;
beforeAll(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-upstream-resources-"));
});
afterAll(async () => {
	await fs.rm(temporary, { recursive: true, force: true });
});

describe("pinned upstream resources", () => {
	it("loads all exact trusted skill identities with their complete relative trees", async () => {
		const resources = await ensureSpecDrivenResources();
		expect(resources.manifest.openspec.version).toBe("1.14.3");
		expect(resources.manifest.superpowers.revision).toBe("2ce8aa15d05bd57213e6f746f953aafb7ded7a8b");
		expect(resources.manifest.skills.filter(entry => entry.source === "openspec")).toHaveLength(13);
		expect(resources.manifest.skills.filter(entry => entry.source === "superpowers")).toHaveLength(15);
		for (const entry of resources.manifest.skills) {
			const skill = await loadSpecDrivenSkill(entry.source, entry.name);
			const ordinarilyVisible =
				entry.source === "superpowers" &&
				(entry.name === "verification-before-completion" || entry.name === "systematic-debugging");
			expect(skill.hide).toBe(!ordinarilyVisible);
			expect(skill.containRoot).toBe(
				entry.source === "openspec" ? resources.openspecRoot : resources.superpowersRoot,
			);
		}
		for (const file of resources.manifest.files) {
			const absolute = await resolveSpecDrivenResourcePath(resources.root, file.path);
			expect(
				crypto
					.createHash("sha256")
					.update(await fs.readFile(absolute))
					.digest("hex"),
			).toBe(file.sha256);
		}
		const packageMetadata = JSON.parse(
			await fs.readFile(path.join(resources.superpowersRoot, "package.json"), "utf8"),
		);
		expect(packageMetadata.type).toBe("module");
		const review = await resolveSpecDrivenResourcePath(
			resources.superpowersRoot,
			"skills/subagent-driven-development/scripts/review-package",
		);
		expect((await fs.stat(review)).isFile()).toBe(true);
		await expect(loadSpecDrivenSkill("superpowers", "../writing-plans")).rejects.toThrow("Unknown bundled");
	});

	it("rejects traversal, absolute paths and a canonical junction escape", async () => {
		const root = path.join(temporary, "containment");
		const outside = path.join(temporary, "outside");
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "private.txt"), "outside");
		await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		for (const invalid of [
			"../outside/private.txt",
			"/etc/passwd",
			"C:/Windows/win.ini",
			"skills/../../outside",
			"skills\\escape",
			"./file",
		]) {
			await expect(resolveSpecDrivenResourcePath(root, invalid)).rejects.toThrow();
		}
		await expect(resolveSpecDrivenResourcePath(root, "escape/private.txt")).rejects.toThrow("canonical root");
		await expect(runSuperpowersScript(".pi/extensions/superpowers.ts", [], temporary)).rejects.toThrow(
			"Not a bundled skill script",
		);
		await expect(runSuperpowersScript("skills/../package.json", [], temporary)).rejects.toThrow();
	});

	it("uses the real CLI for requirements-only status and proposal/spec instructions", async () => {
		const resources = await ensureSpecDrivenResources();
		const cwd = path.join(temporary, "real-project");
		await fs.mkdir(path.join(cwd, "openspec", "schemas"), { recursive: true });
		await fs.cp(path.dirname(resources.specSchemaPath), path.join(cwd, "openspec", "schemas", "omp-spec"), {
			recursive: true,
		});
		await fs.writeFile(path.join(cwd, "openspec", "config.yaml"), "schema: omp-spec\n");
		const created = await runOpenSpec(["new", "change", "resource-probe", "--schema", "omp-spec"], cwd);
		expect(created.exitCode).toBe(0);
		const initial = await runOpenSpec(["status", "--change", "resource-probe", "--json"], cwd);
		expect(initial.exitCode).toBe(0);
		const status = JSON.parse(initial.stdout);
		expect(status.artifacts.map((artifact: { id: string }) => artifact.id).sort()).toEqual(["proposal", "specs"]);
		const proposal = await runOpenSpec(["instructions", "proposal", "--change", "resource-probe", "--json"], cwd);
		expect(proposal.exitCode).toBe(0);
		expect(JSON.parse(proposal.stdout).artifactId).toBe("proposal");
		await fs.writeFile(
			path.join(cwd, "openspec", "changes", "resource-probe", "proposal.md"),
			"## Why\nExpose offline resources.\n\n## What Changes\n- Bundle upstream resources.\n\n## Capabilities\n### New Capabilities\n- `offline-resources`: offline capabilities\n### Modified Capabilities\nNone.\n\n## Impact\nOMP packaging.\n",
		);
		const specs = await runOpenSpec(["instructions", "specs", "--change", "resource-probe", "--json"], cwd);
		expect(specs.exitCode).toBe(0);
		expect(JSON.parse(specs.stdout).artifactId).toBe("specs");
		const forbidden = await runOpenSpec(["instructions", "tasks", "--change", "resource-probe", "--json"], cwd);
		expect(forbidden.exitCode).not.toBe(0);
		expect(await Bun.file(path.join(cwd, "openspec/changes/resource-probe/tasks.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(cwd, "openspec/changes/resource-probe/design.md")).exists()).toBe(false);
		const invalid = await runOpenSpec(["status", "--change", "not-a-change", "--json"], cwd);
		expect(invalid.exitCode).not.toBe(0);
	});

	it("extracts a detached package and launches upstream without source workspaces or external dependencies", async () => {
		const detached = path.join(temporary, "detached-distribution");
		await extractArchive({ bytes: Buffer.from(archiveBase64, "base64"), format: "tar.gz" }, detached);
		const isolatedCwd = path.join(temporary, "consumer-project");
		await fs.mkdir(isolatedCwd);
		const entry = path.join(detached, "openspec/bin/openspec.js");
		const child = Bun.spawn([process.execPath, entry, "--version"], {
			cwd: isolatedCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				BUN_BE_BUN: "1",
				NODE_PATH: "",
				XDG_DATA_HOME: path.join(temporary, "isolated-data"),
				XDG_CONFIG_HOME: path.join(temporary, "isolated-config"),
				DO_NOT_TRACK: "1",
				OPENSPEC_TELEMETRY: "0",
			},
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(stdout.trim()).toBe("1.14.3");
		const templates = Bun.spawn([process.execPath, entry, "templates", "--json"], {
			cwd: isolatedCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				BUN_BE_BUN: "1",
				NODE_PATH: "",
				XDG_DATA_HOME: path.join(temporary, "isolated-data"),
				XDG_CONFIG_HOME: path.join(temporary, "isolated-config"),
				DO_NOT_TRACK: "1",
				OPENSPEC_TELEMETRY: "0",
			},
		});
		const [templateOutput, templateErrors, templateExit] = await Promise.all([
			new Response(templates.stdout).text(),
			new Response(templates.stderr).text(),
			templates.exited,
		]);
		expect(templateExit).toBe(0);
		const paths = Object.values(JSON.parse(templateOutput)) as { path: string; source: string }[];
		for (const template of paths) {
			expect(typeof template.path).toBe("string");
			if (typeof template.path !== "string") throw new Error(templateErrors);
			expect(template.source).toBe("package");
			expect(path.relative(detached, template.path).startsWith("..")).toBe(false);
			expect(await Bun.file(template.path).exists()).toBe(true);
		}
	});

	it("runs original scripts through the public source CLI and forwards real failures", async () => {
		async function invoke(args: string[]) {
			const child = Bun.spawn(
				[process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts"), "superpowers", ...args],
				{
					cwd: temporary,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, BUN_BE_BUN: "1", NODE_PATH: "" },
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, exitCode };
		}

		const javascript = await invoke(["skills/writing-skills/render-graphs.js"]);
		expect(javascript.exitCode).toBe(1);
		expect(javascript.stderr).toContain("Usage: render-graphs.js");
		const bash = await invoke(["skills/subagent-driven-development/scripts/review-package"]);
		if (
			bash.stderr.includes("Superpowers scripts require Bash and POSIX utilities (Git for Windows Bash on Windows)")
		) {
			expect(bash.exitCode).toBe(1);
		} else {
			expect(bash.exitCode).toBe(2);
			expect(bash.stderr).toContain("usage: review-package");
		}
		const missing = await invoke([]);
		expect(missing.exitCode).toBe(2);
		expect(missing.stderr).toContain("Usage: omp superpowers <relative-skill-script> [args...]");
		const help = await invoke(["--help"]);
		expect(help.exitCode).toBe(0);
		expect(help.stderr).toBe("");
		expect(help.stdout).toContain("skills/writing-skills/render-graphs.js");
		for (const script of ["skills/not-a-script.js", ".pi/extensions/superpowers.ts", "../package.json"]) {
			const rejected = await invoke([script]);
			expect(rejected.exitCode).toBe(1);
			expect(rejected.stderr).toContain(`Not a bundled skill script: ${script}`);
		}
	});

	it("launches original Bash and Node scripts and preserves their real usage failures", async () => {
		const javascript = await runSuperpowersScript("skills/writing-skills/render-graphs.js", [], temporary);
		expect(javascript.exitCode).toBe(1);
		expect(javascript.stderr).toContain("Usage: render-graphs.js");
		try {
			const bash = await runSuperpowersScript(
				"skills/subagent-driven-development/scripts/review-package",
				[],
				temporary,
			);
			expect(bash.exitCode).toBe(2);
			expect(bash.stderr).toContain("usage: review-package");
		} catch (error) {
			// A machine without Bash is a supported, explicit missing prerequisite, not a success.
			expect(error instanceof Error ? error.message : String(error)).toBe(
				"Superpowers scripts require Bash and POSIX utilities (Git for Windows Bash on Windows)",
			);
		}
		const abort = new AbortController();
		abort.abort();
		await expect(runOpenSpec(["--version"], temporary, abort.signal)).rejects.toThrow();
	});
});
