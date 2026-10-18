import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager, writeArtifact } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { OfflineSessionPathError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";

describe("ArtifactManager write integrity", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifact-integrity-${crypto.randomUUID()}`);
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("rejects a short write instead of publishing an unreadable artifact id", async () => {
		const manager = new ArtifactManager(freshDir());
		vi.spyOn(Bun, "write").mockResolvedValue(1);

		await expect(manager.save("complete report", "task")).rejects.toThrow(
			"Artifact write incomplete: wrote 1 of 15 bytes",
		);
	});

	it("leaves no discoverable file when the staged write falls short", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		// Faithfully model a short write: partial bytes land on the staging file,
		// and Bun.write reports fewer bytes than requested.
		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, 3));
			return 3;
		});

		await expect(writeArtifact(destination, "full report body")).rejects.toThrow("Artifact write incomplete");

		// Neither the destination nor a leftover staging file survives, so
		// agent:// / artifact:// scans cannot resolve a truncated artifact.
		expect(await fs.promises.readdir(dir)).toEqual([]);
	});

	it("preserves the prior artifact when a follow-up write fails", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original valid report");

		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, 2));
			return 2;
		});

		await expect(writeArtifact(destination, "replacement report")).rejects.toThrow("Artifact write incomplete");

		expect(await Bun.file(destination).text()).toBe("original valid report");
		expect(await fs.promises.readdir(dir)).toEqual(["Worker.md"]);
	});

	it("replaces an existing artifact when Windows rejects rename-over-target", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original report");

		const rename = fs.promises.rename.bind(fs.promises);
		let injected = false;
		vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			if (!injected && String(source).includes(".tmp-") && String(target) === destination) {
				injected = true;
				throw Object.assign(new Error("injected Windows replacement failure"), { code: "EEXIST" });
			}
			await rename(source, target);
		});

		await writeArtifact(destination, "replacement report");

		expect(injected).toBe(true);
		expect(await Bun.file(destination).text()).toBe("replacement report");
		expect(await fs.promises.readdir(dir)).toEqual(["Worker.md"]);
	});
});

describe("ArtifactManager offline runtime boundary", () => {
	let root: string;
	let runtimeRoot: string;
	let external: string;
	let offlineState: dirs.OfflineShmState | undefined;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-artifact-boundary-")));
		runtimeRoot = path.join(root, "runtime");
		external = path.join(root, "external");
		fs.mkdirSync(runtimeRoot);
		fs.mkdirSync(external);
		offlineState = {
			runtimeRoot,
			persistentRoot: external,
			domainId: crypto.randomUUID(),
		};
		vi.spyOn(dirs, "getOfflineShmState").mockImplementation(() => offlineState);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(root);
	});

	it("lists and reads real runtime attachments while reserving source ids", async () => {
		const source = path.join(runtimeRoot, "source");
		fs.mkdirSync(source);
		fs.writeFileSync(path.join(source, "8.bash.log"), "source attachment");
		const manager = new ArtifactManager(path.join(runtimeRoot, "session"), undefined, source);
		expect(await manager.listFiles()).toEqual([]);
		expect(await manager.getPath("0")).toBeNull();
		expect(await manager.save("runtime attachment", "bash")).toBe("9");
		expect(await manager.listFiles()).toEqual(["9.bash.log"]);
		expect(await manager.exists("9")).toBe(true);
		const artifact = await manager.getPath("9");
		expect(artifact).toBe(path.join(manager.dir, "9.bash.log"));
		expect(await Bun.file(artifact!).text()).toBe("runtime attachment");
	});

	it("rejects external, linked, and unnormalized linked directories before discovery", async () => {
		fs.mkdirSync(path.join(external, "nested"));
		fs.mkdirSync(path.join(external, "session"));
		fs.writeFileSync(path.join(external, "session", "0.bash.log"), "external private payload");
		const link = path.join(runtimeRoot, "linked");
		fs.symlinkSync(path.join(external, "nested"), link, process.platform === "win32" ? "junction" : "dir");
		const linkedSession = path.join(runtimeRoot, "session-link");
		fs.symlinkSync(path.join(external, "session"), linkedSession, process.platform === "win32" ? "junction" : "dir");
		for (const dir of [path.join(external, "session"), linkedSession, `${link}${path.sep}..${path.sep}session`]) {
			const manager = new ArtifactManager(dir);
			await expect(manager.listFiles()).rejects.toBeInstanceOf(OfflineSessionPathError);
			await expect(manager.exists("0")).rejects.toBeInstanceOf(OfflineSessionPathError);
			await expect(manager.getPath("0")).rejects.toBeInstanceOf(OfflineSessionPathError);
			await expect(manager.allocatePath("bash")).rejects.toBeInstanceOf(OfflineSessionPathError);
		}
	});

	it.skipIf(process.platform === "win32")(
		"rejects linked individual files until offline mode is disabled",
		async () => {
			const dir = path.join(runtimeRoot, "session");
			fs.mkdirSync(dir);
			const privateFile = path.join(external, "private.log");
			fs.writeFileSync(privateFile, "external private payload");
			const artifact = path.join(dir, "0.bash.log");
			fs.symlinkSync(privateFile, artifact);
			const manager = new ArtifactManager(dir);
			await expect(manager.listFiles()).rejects.toBeInstanceOf(OfflineSessionPathError);
			await expect(manager.exists("0")).rejects.toBeInstanceOf(OfflineSessionPathError);
			await expect(manager.getPath("0")).rejects.toBeInstanceOf(OfflineSessionPathError);
			await expect(manager.allocatePath("bash")).rejects.toBeInstanceOf(OfflineSessionPathError);
			await expect(writeArtifact(artifact, "replacement")).rejects.toBeInstanceOf(OfflineSessionPathError);
			expect(fs.readFileSync(privateFile, "utf8")).toBe("external private payload");
			offlineState = undefined;
			expect(await manager.getPath("0")).toBe(artifact);
			expect(await Bun.file((await manager.getPath("0"))!).text()).toBe("external private payload");
		},
	);

	it("rejects unsafe reserved source directories during id scans", async () => {
		fs.writeFileSync(path.join(external, "8.bash.log"), "external private payload");
		const linkedSource = path.join(runtimeRoot, "source-link");
		fs.symlinkSync(external, linkedSource, process.platform === "win32" ? "junction" : "dir");
		for (const [index, reserved] of [external, linkedSource].entries()) {
			const manager = new ArtifactManager(path.join(runtimeRoot, `session-${index}`), undefined, reserved);
			await expect(manager.allocatePath("bash")).rejects.toBeInstanceOf(OfflineSessionPathError);
		}
	});

	it.skipIf(process.platform === "win32")("rejects linked reserved source files during id scans", async () => {
		fs.writeFileSync(path.join(external, "8.bash.log"), "external private payload");
		const source = path.join(runtimeRoot, "source");
		fs.mkdirSync(source);
		fs.symlinkSync(path.join(external, "8.bash.log"), path.join(source, "8.bash.log"));
		const manager = new ArtifactManager(path.join(runtimeRoot, "session"), undefined, source);
		await expect(manager.allocatePath("bash")).rejects.toBeInstanceOf(OfflineSessionPathError);
	});

	it("keeps ordinary-mode linked attachment discovery and reading unchanged", async () => {
		offlineState = undefined;
		fs.writeFileSync(path.join(external, "0.bash.log"), "ordinary attachment");
		const dir = path.join(runtimeRoot, "linked");
		fs.symlinkSync(external, dir, process.platform === "win32" ? "junction" : "dir");
		const manager = new ArtifactManager(dir);
		expect(await manager.exists("0")).toBe(true);
		expect(await manager.listFiles()).toContain("0.bash.log");
		const artifact = await manager.getPath("0");
		expect(artifact).toBe(path.join(dir, "0.bash.log"));
		expect(await Bun.file(artifact!).text()).toBe("ordinary attachment");
	});
});
