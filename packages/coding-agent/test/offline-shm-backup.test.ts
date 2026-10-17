import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, type OfflineShmState, TempDir } from "@oh-my-pi/pi-utils";
import { runOfflineShmBackup } from "../src/offline/backup";
import { ArtifactManager } from "../src/session/artifacts";

interface Manifest {
	status: string;
	completedAt: string;
	runtimeIdentity: string;
	deletedSincePrevious: string[];
	entries: Array<{ path: string; kind: string; sha256?: string; prefixBytes?: number; mode: number; target?: string }>;
	excluded: Array<{ path: string; reason: string }>;
}

const temporary: TempDir[] = [];
const children: Array<{ kill(signal?: NodeJS.Signals): void; exited: Promise<number> }> = [];
const disposers: Array<() => void> = [];

afterEach(async () => {
	for (const dispose of disposers.splice(0)) dispose();
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
	for (const directory of temporary.splice(0)) await directory.remove();
});

function fixture(): OfflineShmState {
	const directory = TempDir.createSync("@omp-shm-backup-");
	temporary.push(directory);
	const root = syncFs.realpathSync(directory.path());
	const runtimeRoot = path.join(root, "runtime");
	const persistentRoot = path.join(root, "persistent");
	syncFs.mkdirSync(runtimeRoot, { mode: 0o700 });
	syncFs.mkdirSync(persistentRoot, { mode: 0o700 });
	return { runtimeRoot, persistentRoot, domainId: createHash("sha256").update(root).digest("hex") };
}

function domainDirectory(state: OfflineShmState): string {
	return path.join(
		state.persistentRoot,
		".offline-shm-backups",
		createHash("sha256").update(state.domainId).digest("hex"),
	);
}

async function snapshot(state: OfflineShmState): Promise<{ root: string; manifest: Manifest }> {
	const result = await runOfflineShmBackup(state);
	expect(result.status).toBe("completed");
	expect(result.completedAt).toMatch(/^\d{4}-/);
	if (!result.backupPath) throw new Error("completed snapshot has no recovery path");
	return {
		root: result.backupPath,
		manifest: JSON.parse(await fs.readFile(path.join(result.backupPath, "manifest.json"), "utf8")) as Manifest,
	};
}

/** Observe a real checkpoint without timers, filesystem mocks, or publication hooks. */
function checkpoint(action: () => void): AbortController {
	const controller = new AbortController();
	const original = controller.signal.throwIfAborted.bind(controller.signal);
	Object.defineProperty(controller.signal, "throwIfAborted", {
		value: () => {
			action();
			original();
		},
	});
	return controller;
}

function partialCopy(state: OfflineShmState, filename: string): boolean {
	const domain = domainDirectory(state);
	if (!syncFs.existsSync(domain)) return false;
	for (const name of syncFs.readdirSync(domain)) {
		if (!name.startsWith(".staging-")) continue;
		const file = path.join(domain, name, "data", filename);
		if (syncFs.existsSync(file) && syncFs.statSync(file).size > 0) return true;
	}
	return false;
}

async function ready(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	try {
		const chunk = await reader.read();
		expect(new TextDecoder().decode(chunk.value)).toContain("ready");
	} finally {
		reader.releaseLock();
	}
}

describe("offline shm complete runtime snapshots", () => {
	it("backs up nested profiles, attachments and credentials, never overlays original persistent data, and records actual deletions", async () => {
		const state = fixture();
		const original = path.join(state.persistentRoot, "old-auth.json");
		await fs.writeFile(original, "old-unrestored-secret");
		await fs.mkdir(path.join(state.runtimeRoot, "profiles", "work", "sessions"), { recursive: true });
		const session = path.join("profiles", "work", "sessions", "session.jsonl");
		await fs.writeFile(path.join(state.runtimeRoot, session), "complete session\n");
		await fs.writeFile(path.join(state.runtimeRoot, "auth.json"), "private credential");
		await fs.writeFile(path.join(state.runtimeRoot, "attachment.bin"), Buffer.alloc(4096, 0x42));
		await fs.writeFile(path.join(state.runtimeRoot, "omp-plugins.lock.json"), "persistent plugin resolution");
		const sessionless = path.join("tmp", "omp-local", "report.txt");
		await fs.mkdir(path.dirname(path.join(state.runtimeRoot, sessionless)), { recursive: true });
		await fs.writeFile(path.join(state.runtimeRoot, sessionless), "recoverable sessionless report");
		for (const name of ["worker.pid", "gc.lock", "partial.tmp", ".offline-shm-scheduler.lock"])
			await fs.writeFile(path.join(state.runtimeRoot, name), "ephemeral");
		await fs.writeFile(path.join(state.runtimeRoot, "auth-broker.token"), "persistent auth token");
		await fs.mkdir(path.join(state.runtimeRoot, "run", "daemons", "host", "clients"), { recursive: true });
		await fs.writeFile(path.join(state.runtimeRoot, "run", "daemons", "host", "broker.token"), "process token");
		await fs.writeFile(path.join(state.runtimeRoot, "run", "daemons", "host", "clients", "123.json"), '{"pid":123}');
		await fs.writeFile(
			path.join(state.runtimeRoot, "run", "daemons", "host", "worker.log"),
			"necessary worker log\n",
		);
		const first = await snapshot(state);
		expect(first.manifest.status).toBe("complete");
		expect(await fs.readFile(path.join(first.root, "data", session), "utf8")).toBe("complete session\n");
		expect(await fs.readFile(path.join(first.root, "data", "omp-plugins.lock.json"), "utf8")).toBe(
			"persistent plugin resolution",
		);
		expect(await fs.readFile(path.join(first.root, "data", sessionless), "utf8")).toBe(
			"recoverable sessionless report",
		);
		expect(first.manifest.entries.some(entry => entry.path === "auth.json")).toBe(true);
		expect(first.manifest.entries.some(entry => entry.path.endsWith(".pid") || entry.path === "partial.tmp")).toBe(
			false,
		);
		expect(first.manifest.entries.some(entry => entry.path === "auth-broker.token")).toBe(true);
		expect(
			first.manifest.entries.some(
				entry => entry.path.endsWith("broker.token") && entry.path !== "auth-broker.token",
			),
		).toBe(false);
		expect(first.manifest.entries.some(entry => entry.path.includes("123.json"))).toBe(false);
		expect(await fs.readFile(path.join(first.root, "data", "run", "daemons", "host", "worker.log"), "utf8")).toBe(
			"necessary worker log\n",
		);
		if (process.platform !== "win32") {
			expect((await fs.stat(first.root)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(first.root, "data", "auth.json"))).mode & 0o777).toBe(0o600);
		}
		await fs.unlink(path.join(state.runtimeRoot, "attachment.bin"));
		const second = await snapshot(state);
		expect(second.manifest.deletedSincePrevious).toContain("attachment.bin");
		expect(second.manifest.deletedSincePrevious).not.toContain("old-auth.json");
		expect(await fs.readFile(original, "utf8")).toBe("old-unrestored-secret");
		expect(await fs.readFile(path.join(first.root, "data", "attachment.bin"))).toHaveLength(4096);
		expect(syncFs.existsSync(path.join(second.root, "data", "attachment.bin"))).toBe(false);
	});

	it("preserves dependency lockfiles without a package-manager allowlist and excludes process-lock namespaces", async () => {
		const state = fixture();
		const durable = [
			"plugins/bun.lock",
			"plugins/node_modules/tool/Cargo.lock",
			"agent/cache/eval-js/environments/example/uv.lock",
			"plugins/custom-resolver.lock",
			"profiles/work/plugins/bun.lock",
		];
		const transient = [
			"agent/gc.lock",
			"agent/settings.yml.lock",
			"agent/sessions/.session.jsonl.lock.lock",
			"agent/memories/sharpshooter/project/consolidate.lock",
			"agent/idbs/example/db.lock",
			"agent/cache/eval-js/project-locks/example.lock",
			"agent/cache/eval-js/environments/example.install.lock",
			"agent/cache/stt-runtime/transformers-version.lock",
			"run/daemons/host/writer.lock",
			"profiles/work/agent/gc.lock",
			"profiles/work/run/daemons/host/writer.lock",
		];
		for (const filename of [...durable, ...transient]) {
			const source = path.join(state.runtimeRoot, filename);
			await fs.mkdir(path.dirname(source), { recursive: true });
			await fs.writeFile(source, filename);
		}
		const result = await snapshot(state);
		for (const filename of durable) {
			expect(await fs.readFile(path.join(result.root, "data", filename), "utf8")).toBe(filename);
			expect(result.manifest.entries.some(entry => entry.path === path.normalize(filename))).toBe(true);
		}
		for (const filename of transient) {
			expect(syncFs.existsSync(path.join(result.root, "data", filename))).toBe(false);
			expect(result.manifest.excluded).toContainEqual({ path: path.normalize(filename), reason: "ephemeral" });
		}
	});

	it("keeps an empty initial runtime snapshot separate from untouched unrestored original files", async () => {
		const state = fixture();
		await fs.writeFile(path.join(state.persistentRoot, "settings.json"), "old settings");
		for (let round = 0; round < 3; round++) {
			const result = await snapshot(state);
			expect(result.manifest.entries).toEqual([]);
			expect(result.manifest.deletedSincePrevious).toEqual([]);
		}
		expect(await fs.readFile(path.join(state.persistentRoot, "settings.json"), "utf8")).toBe("old settings");
		expect((await fs.readdir(path.join(domainDirectory(state), "generations"))).length).toBe(2);
	});

	it("reuses unchanged large immutable backup files, never hardlinks an active file, and bounds history", async () => {
		const state = fixture();
		const active = path.join(state.runtimeRoot, "large.bin");
		await fs.writeFile(active, Buffer.alloc(3 * 1024 * 1024, 0x31));
		const first = await snapshot(state);
		const second = await snapshot(state);
		const firstFile = path.join(first.root, "data", "large.bin");
		const secondFile = path.join(second.root, "data", "large.bin");
		const firstStat = await fs.stat(firstFile, { bigint: true });
		const secondStat = await fs.stat(secondFile, { bigint: true });
		expect(secondStat.ino).toBe(firstStat.ino);
		expect(secondStat.ino).not.toBe((await fs.stat(active, { bigint: true })).ino);
		await fs.writeFile(active, "changed active data");
		const third = await snapshot(state);
		expect(await fs.readFile(secondFile)).toHaveLength(3 * 1024 * 1024);
		expect(await fs.readFile(path.join(third.root, "data", "large.bin"), "utf8")).toBe("changed active data");
		expect(syncFs.existsSync(first.root)).toBe(false);
		expect((await fs.readdir(path.join(domainDirectory(state), "generations"))).sort()).toEqual(
			[path.basename(second.root), path.basename(third.root)].sort(),
		);
	});

	it("preserves immutable tool-output logs byte-for-byte without a trailing newline", async () => {
		const state = fixture();
		const relative = path.join("agent", "sessions", "custom-example", "session");
		const artifacts = new ArtifactManager(path.join(state.runtimeRoot, relative));
		const contents = ["tool output without a newline: 雪", "first line\nlast line without a newline"];
		for (const content of contents) await artifacts.save(content, "bash");
		for (let round = 0; round < 2; round++) {
			const result = await snapshot(state);
			for (const [index, content] of contents.entries()) {
				const artifact = path.join(relative, `${index}.bash.log`);
				expect(await fs.readFile(path.join(result.root, "data", artifact))).toEqual(Buffer.from(content));
				expect(result.manifest.entries.find(entry => entry.path === artifact)?.prefixBytes).toBeUndefined();
			}
		}
	});

	for (const corruption of ["same-length", "truncated"]) {
		it(`regenerates unchanged files and SQLite snapshots when previous backup bytes are ${corruption}`, async () => {
			const state = fixture();
			await fs.writeFile(path.join(state.runtimeRoot, "stable.bin"), "healthy immutable content");
			const db = new Database(path.join(state.runtimeRoot, "state.sqlite"));
			try {
				db.exec("CREATE TABLE state(value TEXT)");
				db.exec("INSERT INTO state VALUES ('healthy snapshot')");
			} finally {
				db.close();
			}
			const first = await snapshot(state);
			const expected = new Map<string, Buffer<ArrayBufferLike>>();
			const inodes = new Map<string, bigint>();
			for (const filename of ["stable.bin", "state.sqlite"]) {
				const file = path.join(first.root, "data", filename);
				const bytes = await fs.readFile(file);
				expected.set(filename, bytes);
				inodes.set(filename, (await fs.stat(file, { bigint: true })).ino);
				await fs.writeFile(
					file,
					Buffer.alloc(corruption === "same-length" ? bytes.length : bytes.length - 1, 0x78),
				);
			}
			const second = await snapshot(state);
			for (const [filename, bytes] of expected) {
				const file = path.join(second.root, "data", filename);
				expect((await fs.readFile(file)).equals(bytes)).toBe(true);
				expect((await fs.stat(file, { bigint: true })).ino).not.toBe(inodes.get(filename)!);
				expect(second.manifest.entries.find(entry => entry.path === filename)?.sha256).toBe(
					createHash("sha256").update(bytes).digest("hex"),
				);
			}
		});
	}

	it.skipIf(process.platform === "win32")(
		"restores executable managed tools by ordinary permission-preserving copy",
		async () => {
			const state = fixture();
			const source = path.join(state.runtimeRoot, "managed-tool");
			await fs.writeFile(source, "#!/bin/sh\nprintf restored");
			await fs.chmod(source, 0o755);
			const result = await snapshot(state);
			const backedUpTool = path.join(result.root, "data", "managed-tool");
			expect((await fs.stat(backedUpTool)).mode & 0o777).toBe(0o700);
			const restored = fixture();
			await fs.cp(path.join(result.root, "data"), restored.runtimeRoot, { recursive: true });
			const process = Bun.spawn([path.join(restored.runtimeRoot, "managed-tool")], {
				stdout: "pipe",
				stderr: "pipe",
			});
			children.push(process);
			expect(await new Response(process.stdout).text()).toBe("restored");
			expect(await process.exited).toBe(0);
		},
	);

	it("captures committed WAL transactions by header without extension, with an independently opened recovery database", async () => {
		const state = fixture();
		const source = path.join(state.runtimeRoot, "index-no-extension");
		const db = new Database(source);
		try {
			db.exec("PRAGMA journal_mode=WAL");
			db.exec("PRAGMA wal_autocheckpoint=0");
			db.exec("CREATE TABLE balances (id INTEGER PRIMARY KEY, value INTEGER)");
			db.exec("INSERT INTO balances VALUES (1, 40), (2, 60)");
			await fs.writeFile(path.join(state.runtimeRoot, "ordinary.db"), "not sqlite");
			expect((await fs.stat(`${source}-wal`)).size).toBeGreaterThan(0);
			const writer = Bun.spawn(
				[
					process.execPath,
					"--no-install",
					"--eval",
					`
				import { Database } from "bun:sqlite";
				const db = new Database(${JSON.stringify(source)});
				db.exec("PRAGMA busy_timeout=1000");
				db.exec("BEGIN IMMEDIATE");
				db.exec("UPDATE balances SET value=30 WHERE id=1");
				console.log("ready");
				for await (const chunk of Bun.stdin.stream()) { break; }
				db.exec("UPDATE balances SET value=70 WHERE id=2");
				db.exec("COMMIT"); db.close();
			`,
				],
				{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			children.push(writer);
			await ready(writer.stdout);
			const during = await snapshot(state);
			expect(await fs.readdir(path.join(state.runtimeRoot, ".offline-shm-backup-work"))).toEqual([]);
			expect((await fs.stat(`${source}-wal`)).size).toBeGreaterThan(0);
			expect(during.manifest.entries.find(entry => entry.path === "index-no-extension")?.kind).toBe("sqlite");
			expect(during.manifest.entries.find(entry => entry.path === "ordinary.db")?.kind).toBe("file");
			expect(during.manifest.entries.some(entry => /-(?:wal|shm)$/.test(entry.path))).toBe(false);
			const independent = new Database(path.join(during.root, "data", "index-no-extension"), { readonly: true });
			try {
				using balances = independent.prepare("SELECT value FROM balances ORDER BY id");
				using integrity = independent.prepare("PRAGMA integrity_check");
				expect(balances.values()).toEqual([[40], [60]]);
				expect(integrity.values()).toEqual([["ok"]]);
			} finally {
				independent.close(true);
			}
			writer.stdin.write("commit");
			writer.stdin.end();
			expect(await writer.exited).toBe(0);
			const after = await snapshot(state);
			expect(await fs.readdir(path.join(state.runtimeRoot, ".offline-shm-backup-work"))).toEqual([]);
			const recovered = new Database(path.join(after.root, "data", "index-no-extension"), { readonly: true });
			try {
				using balances = recovered.prepare("SELECT value FROM balances ORDER BY id");
				expect(balances.values()).toEqual([[30], [70]]);
			} finally {
				recovered.close(true);
			}
			const preserved = new Database(path.join(during.root, "data", "index-no-extension"), { readonly: true });
			try {
				using balances = preserved.prepare("SELECT value FROM balances ORDER BY id");
				expect(balances.values()).toEqual([[40], [60]]);
			} finally {
				preserved.close(true);
			}
		} finally {
			db.close();
		}
	}, 15_000);

	it("reuses unchanged large SQLite snapshots without sharing active inodes and captures WAL-only commits independently", async () => {
		const state = fixture();
		const active = path.join(state.runtimeRoot, "large.sqlite");
		const db = new Database(active);
		const payloadBytes = 3 * 1024 * 1024;
		function readSnapshot(filename: string): unknown[][] {
			const recovered = new Database(filename, { readonly: true, create: false });
			try {
				using integrity = recovered.prepare("PRAGMA integrity_check");
				expect(integrity.values()).toEqual([["ok"]]);
				using contents = recovered.prepare("SELECT value, length(payload) FROM documents");
				return contents.values();
			} finally {
				recovered.close(true);
			}
		}
		try {
			db.exec("PRAGMA journal_mode=WAL");
			db.exec("PRAGMA wal_autocheckpoint=0");
			db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, value TEXT, payload BLOB)");
			db.exec(`INSERT INTO documents VALUES (1, 'initial', zeroblob(${payloadBytes}))`);
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			const first = await snapshot(state);
			const second = await snapshot(state);
			const firstFile = path.join(first.root, "data", "large.sqlite");
			const secondFile = path.join(second.root, "data", "large.sqlite");
			const firstStat = await fs.stat(firstFile, { bigint: true });
			const secondStat = await fs.stat(secondFile, { bigint: true });
			const activeBeforeCommit = await fs.stat(active, { bigint: true });
			expect(firstStat.size).toBeGreaterThan(BigInt(payloadBytes));
			expect(secondStat.ino).toBe(firstStat.ino);
			expect(secondStat.ino).not.toBe(activeBeforeCommit.ino);
			const fingerprint = first.manifest.entries.find(entry => entry.path === "large.sqlite")?.sha256;
			expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
			expect(second.manifest.entries.find(entry => entry.path === "large.sqlite")?.sha256).toBe(fingerprint);
			expect(readSnapshot(secondFile)).toEqual([["initial", payloadBytes]]);
			db.exec("UPDATE documents SET value='changed' WHERE id=1");
			expect((await fs.stat(`${active}-wal`)).size).toBeGreaterThan(0);
			const activeAfterCommit = await fs.stat(active, { bigint: true });
			expect(activeAfterCommit.size).toBe(activeBeforeCommit.size);
			expect(activeAfterCommit.mtimeNs).toBe(activeBeforeCommit.mtimeNs);
			expect(activeAfterCommit.ctimeNs).toBe(activeBeforeCommit.ctimeNs);
			const third = await snapshot(state);
			const thirdFile = path.join(third.root, "data", "large.sqlite");
			const thirdStat = await fs.stat(thirdFile, { bigint: true });
			expect(thirdStat.ino).not.toBe(secondStat.ino);
			expect(thirdStat.ino).not.toBe(activeAfterCommit.ino);
			expect(third.manifest.entries.find(entry => entry.path === "large.sqlite")?.sha256).not.toBe(fingerprint);
			expect(readSnapshot(thirdFile)).toEqual([["changed", payloadBytes]]);
			expect(readSnapshot(secondFile)).toEqual([["initial", payloadBytes]]);
			expect(await fs.readdir(path.join(state.runtimeRoot, ".offline-shm-backup-work"))).toEqual([]);
		} finally {
			db.close(true);
		}
	}, 15_000);

	it("rejects a changing ordinary file rather than publishing mixed contents, preserving the last generation", async () => {
		const state = fixture();
		const active = path.join(state.runtimeRoot, "large.bin");
		await fs.writeFile(active, "previous complete");
		const first = await snapshot(state);
		await fs.writeFile(active, Buffer.alloc(3 * 1024 * 1024, 0x61));
		let mutated = false;
		const controller = checkpoint(() => {
			if (mutated || !partialCopy(state, "large.bin")) return;
			mutated = true;
			syncFs.writeFileSync(active, Buffer.alloc(3 * 1024 * 1024, 0x62));
		});
		await expect(runOfflineShmBackup(state, controller.signal)).rejects.toThrow("SOURCE_CHANGED");
		expect(mutated).toBe(true);
		const pointer = JSON.parse(await fs.readFile(path.join(domainDirectory(state), "current.json"), "utf8"));
		expect(pointer.current).toBe(path.basename(first.root));
		expect(await fs.readFile(path.join(first.root, "data", "large.bin"), "utf8")).toBe("previous complete");
		expect((await fs.readdir(domainDirectory(state))).some(name => name.startsWith(".staging-"))).toBe(false);
		await snapshot(state);
	});

	it("publishes complete prefixes while session JSONL streams append throughout copying and validation", async () => {
		const state = fixture();
		const record = `${JSON.stringify({ message: "x".repeat(2048) })}\n`;
		const original = record.repeat(1100);
		await fs.writeFile(path.join(state.runtimeRoot, "session.jsonl"), `${original}unfinished-record`);
		let appends = 0;
		const controller = checkpoint(() => {
			if (!partialCopy(state, "session.jsonl")) return;
			appends++;
			syncFs.appendFileSync(path.join(state.runtimeRoot, "session.jsonl"), "tail-growing-without-newline");
		});
		const result = await runOfflineShmBackup(state, controller.signal);
		expect(result.status).toBe("completed");
		expect(appends).toBeGreaterThan(2);
		const manifest = JSON.parse(
			await fs.readFile(path.join(result.backupPath!, "manifest.json"), "utf8"),
		) as Manifest;
		expect(await fs.readFile(path.join(result.backupPath!, "data", "session.jsonl"), "utf8")).toBe(original);
		expect(manifest.entries.find(entry => entry.path === "session.jsonl")?.prefixBytes).toBe(
			Buffer.byteLength(original),
		);
		expect((await fs.stat(path.join(state.runtimeRoot, "session.jsonl"))).size).toBeGreaterThan(
			Buffer.byteLength(original),
		);
	});

	const activeLogs = [
		path.join("logs", "omp.2026-10-17.1234.log"),
		path.join("profiles", "work", "logs", "omp.2026-10-17.1234.1.log"),
		path.join("fallback-logs", "omp.2026-10-17.1234.log"),
		path.join("run", "tiny", "lfm2.5-230m-onnx.log"),
		path.join("run", "mnemopi", "embed.log"),
		path.join("profiles", "work", "run", "daemons", "host", "worker.log"),
	];
	for (const filename of activeLogs) {
		it(`accepts complete records appended during copying of active log ${filename}`, async () => {
			const state = fixture();
			const source = path.join(state.runtimeRoot, filename);
			const record = `${JSON.stringify({ message: "x".repeat(2048) })}\n`;
			const original = record.repeat(1100);
			await fs.mkdir(path.dirname(source), { recursive: true });
			await fs.writeFile(source, original);
			let appended = false;
			const controller = checkpoint(() => {
				if (appended || !partialCopy(state, filename)) return;
				appended = true;
				syncFs.appendFileSync(source, record);
			});
			const result = await runOfflineShmBackup(state, controller.signal);
			expect(appended).toBe(true);
			expect(result.status).toBe("completed");
			const manifest = JSON.parse(
				await fs.readFile(path.join(result.backupPath!, "manifest.json"), "utf8"),
			) as Manifest;
			expect(await fs.readFile(path.join(result.backupPath!, "data", filename), "utf8")).toBe(original);
			expect(manifest.entries.find(entry => entry.path === filename)?.prefixBytes).toBe(Buffer.byteLength(original));
			expect(await fs.readFile(source, "utf8")).toBe(original + record);
		});
	}

	it("omits incomplete active log records in copied and reused generations", async () => {
		const state = fixture();
		const complete = "complete runtime record 雪\n";
		const emptyLog = path.join("logs", "omp.2026-10-17.5678.log");
		for (const filename of activeLogs) {
			const source = path.join(state.runtimeRoot, filename);
			await fs.mkdir(path.dirname(source), { recursive: true });
			await fs.writeFile(source, `${complete}unfinished runtime record 雪`);
		}
		await fs.writeFile(path.join(state.runtimeRoot, emptyLog), "no complete records yet");
		for (let round = 0; round < 2; round++) {
			const result = await snapshot(state);
			for (const filename of activeLogs) {
				expect(await fs.readFile(path.join(result.root, "data", filename), "utf8")).toBe(complete);
				expect(result.manifest.entries.find(entry => entry.path === filename)?.prefixBytes).toBe(
					Buffer.byteLength(complete),
				);
			}
			expect(await fs.readFile(path.join(result.root, "data", emptyLog))).toHaveLength(0);
			expect(result.manifest.entries.find(entry => entry.path === emptyLog)?.prefixBytes).toBe(0);
		}
	});

	it("rejects append-only prefix rewrites even when the file keeps growing", async () => {
		const state = fixture();
		const source = path.join(state.runtimeRoot, "session.jsonl");
		const record = `${JSON.stringify({ text: "a".repeat(2048) })}\n`;
		await fs.writeFile(source, record.repeat(1100));
		const first = await snapshot(state);
		await fs.appendFile(source, record);
		let rewrote = false;
		const controller = checkpoint(() => {
			if (rewrote || !partialCopy(state, "session.jsonl")) return;
			rewrote = true;
			const handle = syncFs.openSync(source, "r+");
			try {
				syncFs.writeSync(handle, Buffer.from("b"), 0, 1, 10);
			} finally {
				syncFs.closeSync(handle);
			}
			syncFs.appendFileSync(source, record);
		});
		await expect(runOfflineShmBackup(state, controller.signal)).rejects.toThrow("SOURCE_CHANGED");
		expect(rewrote).toBe(true);
		expect(JSON.parse(await fs.readFile(path.join(domainDirectory(state), "current.json"), "utf8")).current).toBe(
			path.basename(first.root),
		);
	});

	it("cancels after a partial copy, preserves the pointer and active data, and retries only on the next explicit round", async () => {
		const state = fixture();
		await fs.writeFile(path.join(state.runtimeRoot, "large.bin"), "previous");
		const first = await snapshot(state);
		await fs.writeFile(path.join(state.runtimeRoot, "large.bin"), Buffer.alloc(3 * 1024 * 1024, 0x51));
		const controller = checkpoint(() => {
			if (partialCopy(state, "large.bin")) controller.abort();
		});
		await expect(runOfflineShmBackup(state, controller.signal)).rejects.toThrow("ABORTED");
		expect((await fs.stat(path.join(state.runtimeRoot, "large.bin"))).size).toBe(3 * 1024 * 1024);
		expect(JSON.parse(await fs.readFile(path.join(domainDirectory(state), "current.json"), "utf8")).current).toBe(
			path.basename(first.root),
		);
		expect((await fs.readdir(domainDirectory(state))).some(name => name.startsWith(".staging-"))).toBe(false);
		await snapshot(state);
	});

	it("leaves the previous publication authoritative when interrupted after generation completion but before pointer commit", async () => {
		const state = fixture();
		const active = path.join(state.runtimeRoot, "settings.json");
		await fs.writeFile(active, '{"value":"previous"}');
		const first = await snapshot(state);
		await fs.writeFile(active, '{"value":"next"}');
		const controller = checkpoint(() => {
			const directory = domainDirectory(state);
			if (syncFs.existsSync(directory) && syncFs.readdirSync(directory).some(name => name.startsWith(".current-")))
				controller.abort();
		});
		await expect(runOfflineShmBackup(state, controller.signal)).rejects.toThrow("ABORTED");
		expect(JSON.parse(await fs.readFile(path.join(domainDirectory(state), "current.json"), "utf8")).current).toBe(
			path.basename(first.root),
		);
		expect(await fs.readFile(path.join(first.root, "data", "settings.json"), "utf8")).toBe('{"value":"previous"}');
		expect((await fs.readdir(path.join(domainDirectory(state), "generations"))).length).toBe(2);
		const next = await snapshot(state);
		expect((await fs.readdir(path.join(domainDirectory(state), "generations"))).sort()).toEqual(
			[path.basename(first.root), path.basename(next.root)].sort(),
		);
		expect((await fs.readdir(domainDirectory(state))).some(name => name.startsWith(".current-"))).toBe(false);
	});

	it("never raw-copies a corrupt header-detected SQLite source as an ordinary file", async () => {
		const state = fixture();
		await fs.writeFile(path.join(state.runtimeRoot, "settings.json"), '{"good":true}');
		const first = await snapshot(state);
		const corrupt = Buffer.alloc(4096);
		Buffer.from("SQLite format 3\0").copy(corrupt);
		await fs.writeFile(path.join(state.runtimeRoot, "extensionless-corrupt"), corrupt);
		await expect(runOfflineShmBackup(state)).rejects.toThrow("Offline shm backup failed");
		expect(JSON.parse(await fs.readFile(path.join(domainDirectory(state), "current.json"), "utf8")).current).toBe(
			path.basename(first.root),
		);
		expect((await fs.readdir(domainDirectory(state))).some(name => name.startsWith(".staging-"))).toBe(false);
		await fs.unlink(path.join(state.runtimeRoot, "extensionless-corrupt"));
		await snapshot(state);
	});

	it("preserves quarantined corrupt SQLite evidence and sidecars as opaque files", async () => {
		const state = fixture();
		const db = new Database(path.join(state.runtimeRoot, "state.sqlite"));
		try {
			db.exec("CREATE TABLE state(value TEXT)");
			db.exec("INSERT INTO state VALUES ('replacement database')");
		} finally {
			db.close();
		}
		const quarantine = "state.sqlite.corrupt-1760000000000-12345678-1234-1234-1234-123456789abc";
		const evidence = Buffer.alloc(4096, 0x61);
		Buffer.from("SQLite format 3\0").copy(evidence);
		const filenames = ["", "-wal", "-shm", "-journal"].map(suffix => quarantine + suffix);
		for (const filename of filenames) await fs.writeFile(path.join(state.runtimeRoot, filename), evidence);
		for (let round = 0; round < 2; round++) {
			const result = await snapshot(state);
			expect(result.manifest.entries.find(entry => entry.path === "state.sqlite")?.kind).toBe("sqlite");
			for (const filename of filenames) {
				expect(await fs.readFile(path.join(result.root, "data", filename))).toEqual(evidence);
				expect(result.manifest.entries.find(entry => entry.path === filename)?.kind).toBe("file");
			}
		}
	});

	it("returns a sanitized pre-cancellation without touching the persistent target", async () => {
		const state = fixture();
		const controller = new AbortController();
		controller.abort("sensitive abort reason");
		await expect(runOfflineShmBackup(state, controller.signal)).rejects.toThrow("ABORTED");
		expect(await fs.readdir(state.persistentRoot)).toEqual([]);
	});

	it("preserves recoverable state on snapshot destination ENOSPC and emits only sanitized diagnostics", async () => {
		const state = fixture();
		const db = new Database(path.join(state.runtimeRoot, "state.sqlite"));
		try {
			db.exec("CREATE TABLE state(value TEXT)");
			db.exec("INSERT INTO state VALUES ('business-secret')");
			const first = await snapshot(state);
			// A committed change requires a new transfer; unchanged snapshots correctly reuse the prior backup.
			db.exec("UPDATE state SET value = 'new-business-secret'");
			const diagnostics: logger.LogEvent[] = [];
			disposers.push(
				logger.registerLogSink(event => {
					if (event.message.startsWith("offline_shm_backup.")) diagnostics.push(event);
				}),
			);
			const copy = spyOn(fs, "copyFile").mockRejectedValue(
				Object.assign(new Error("NFS credential-token-business-secret"), { code: "ENOSPC" }),
			);
			try {
				await expect(runOfflineShmBackup(state)).rejects.toThrow("ENOSPC");
			} finally {
				copy.mockRestore();
			}
			expect(JSON.stringify(diagnostics)).not.toContain("credential-token");
			expect(JSON.stringify(diagnostics)).not.toContain("business-secret");
			expect(
				diagnostics.find(event => event.message === "offline_shm_backup.failed")?.context?.latest_success_at,
			).toBe(first.manifest.completedAt);
			expect(db.query("SELECT value FROM state").values()).toEqual([["new-business-secret"]]);
			expect(JSON.parse(await fs.readFile(path.join(domainDirectory(state), "current.json"), "utf8")).current).toBe(
				path.basename(first.root),
			);
			const preserved = new Database(path.join(first.root, "data", "state.sqlite"), { readonly: true });
			try {
				expect(preserved.query("SELECT value FROM state").values()).toEqual([["business-secret"]]);
			} finally {
				preserved.close();
			}
			await snapshot(state);
		} finally {
			db.close();
		}
	});

	it("isolates different host/user domain IDs under one persistent target", async () => {
		const state = fixture();
		const other = fixture();
		other.persistentRoot = state.persistentRoot;
		await fs.writeFile(path.join(state.runtimeRoot, "auth.json"), "host one");
		await fs.writeFile(path.join(other.runtimeRoot, "auth.json"), "host two");
		const first = await snapshot(state);
		const second = await snapshot(other);
		expect(domainDirectory(state)).not.toBe(domainDirectory(other));
		expect(await fs.readFile(path.join(first.root, "data", "auth.json"), "utf8")).toBe("host one");
		expect(await fs.readFile(path.join(second.root, "data", "auth.json"), "utf8")).toBe("host two");
	});

	it.skipIf(process.platform === "win32")(
		"shares only the sticky backup container while leaving domain credentials and unrelated siblings private",
		async () => {
			const state = fixture();
			const shared = path.join(state.persistentRoot, ".offline-shm-backups");
			// An older owner-private container is initialized by its owner, not taken over by another user.
			await fs.mkdir(shared, { mode: 0o700 });
			const sibling = path.join(shared, "unrelated-domain");
			await fs.mkdir(sibling, { mode: 0o700 });
			await fs.writeFile(path.join(sibling, "secret"), "untouched", { mode: 0o600 });
			await fs.writeFile(path.join(state.runtimeRoot, "auth.json"), "credential");
			const first = await snapshot(state);
			const other = fixture();
			other.persistentRoot = state.persistentRoot;
			await fs.writeFile(path.join(other.runtimeRoot, "auth.json"), "other credential");
			const second = await snapshot(other);
			await snapshot(state);
			expect((await fs.stat(shared)).mode & 0o1777).toBe(0o1777);
			for (const privateRoot of [
				domainDirectory(state),
				domainDirectory(other),
				path.join(domainDirectory(state), "generations"),
				first.root,
				second.root,
				path.join(first.root, "data"),
				path.join(second.root, "data"),
				sibling,
			])
				expect((await fs.stat(privateRoot)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(first.root, "data", "auth.json"))).mode & 0o777).toBe(0o600);
			expect((await fs.stat(path.join(second.root, "data", "auth.json"))).mode & 0o777).toBe(0o600);
			expect(await fs.readFile(path.join(sibling, "secret"), "utf8")).toBe("untouched");
			expect(await fs.readFile(path.join(second.root, "data", "auth.json"), "utf8")).toBe("other credential");
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses permissive private domains without changing permissions or the completed pointer",
		async () => {
			const state = fixture();
			await fs.writeFile(path.join(state.runtimeRoot, "auth.json"), "last complete");
			const first = await snapshot(state);
			const domain = domainDirectory(state);
			const pointer = await fs.readFile(path.join(domain, "current.json"), "utf8");
			await fs.chmod(domain, 0o777);
			await expect(runOfflineShmBackup(state)).rejects.toThrow("UNSAFE_BACKUP_DIRECTORY");
			expect((await fs.stat(domain)).mode & 0o777).toBe(0o777);
			expect(await fs.readFile(path.join(domain, "current.json"), "utf8")).toBe(pointer);
			expect(await fs.readFile(path.join(first.root, "data", "auth.json"), "utf8")).toBe("last complete");
		},
	);

	it("does not claim unrestored files as deletions after runtime root recreation", async () => {
		const state = fixture();
		await fs.writeFile(path.join(state.runtimeRoot, "old-session"), "old session");
		const first = await snapshot(state);
		await fs.rename(state.runtimeRoot, `${state.runtimeRoot}-old`);
		await fs.mkdir(state.runtimeRoot, { mode: 0o700 });
		const second = await snapshot(state);
		expect(second.manifest.runtimeIdentity).not.toBe(first.manifest.runtimeIdentity);
		expect(second.manifest.deletedSincePrevious).toEqual([]);
		expect(await fs.readFile(path.join(first.root, "data", "old-session"), "utf8")).toBe("old session");
	});

	it("takes a non-waiting same-domain lease across processes and recovers it on owner death", async () => {
		const state = fixture();
		const lockModule = new URL("../../utils/src/file-lock.ts", import.meta.url).href;
		const lockPath = path.join(state.runtimeRoot, ".offline-shm-backup-round");
		const holder = Bun.spawn(
			[
				process.execPath,
				"--no-install",
				"--eval",
				`
			import { tryAcquireFileLock } from ${JSON.stringify(lockModule)};
			const lock = tryAcquireFileLock(${JSON.stringify(lockPath)});
			if (!lock) process.exit(2);
			console.log("ready");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		children.push(holder);
		await ready(holder.stdout);
		expect(await runOfflineShmBackup(state)).toEqual({ status: "busy" });
		expect(syncFs.existsSync(domainDirectory(state))).toBe(false);
		await snapshot(fixture());
		holder.kill();
		await holder.exited;
		await snapshot(state);
	}, 15_000);

	it("reclaims an interrupted process's staging tree without damaging the previous completed generation", async () => {
		const state = fixture();
		await fs.writeFile(path.join(state.runtimeRoot, "large.bin"), "last complete");
		const first = await snapshot(state);
		await fs.writeFile(path.join(state.runtimeRoot, "large.bin"), Buffer.alloc(3 * 1024 * 1024, 0x4f));
		const engine = new URL("../src/offline/backup.ts", import.meta.url).href;
		const interrupted = Bun.spawn(
			[
				process.execPath,
				"--no-install",
				"--eval",
				`
			import * as fs from "node:fs";
			import * as path from "node:path";
			import { runOfflineShmBackup } from ${JSON.stringify(engine)};
			const domain = ${JSON.stringify(domainDirectory(state))};
			const controller = new AbortController();
			Object.defineProperty(controller.signal, "throwIfAborted", { value() {
				for (const name of fs.readdirSync(domain)) {
					if (!name.startsWith(".staging-")) continue;
					const file = path.join(domain, name, "data", "large.bin");
					if (fs.existsSync(file) && fs.statSync(file).size > 0) {
						console.log("ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
					}
				}
			} });
			await runOfflineShmBackup(${JSON.stringify(state)}, controller.signal);
		`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		children.push(interrupted);
		await ready(interrupted.stdout);
		// The blocked JS thread cannot run the cleanup handler installed for SIGTERM.
		interrupted.kill("SIGKILL");
		await interrupted.exited;
		expect((await fs.readdir(domainDirectory(state))).some(name => name.startsWith(".staging-"))).toBe(true);
		expect(await fs.readFile(path.join(first.root, "data", "large.bin"), "utf8")).toBe("last complete");
		const recovered = await snapshot(state);
		expect((await fs.readdir(domainDirectory(state))).some(name => name.startsWith(".staging-"))).toBe(false);
		expect((await fs.readdir(path.join(domainDirectory(state), "generations"))).sort()).toEqual(
			[path.basename(first.root), path.basename(recovered.root)].sort(),
		);
	}, 15_000);

	it.skipIf(process.platform === "win32")(
		"preserves relative symlink semantics and relocates absolute internal links through ordinary recovery",
		async () => {
			const state = fixture();
			const external = path.join(state.persistentRoot, "external-secret");
			await fs.writeFile(external, "must not copy");
			await fs.writeFile(path.join(state.runtimeRoot, "auth.json"), "owned secret");
			await fs.symlink(external, path.join(state.runtimeRoot, "external"));
			await fs.symlink("auth.json", path.join(state.runtimeRoot, "internal"));
			await fs.mkdir(path.join(state.runtimeRoot, "nested", "deeper"), { recursive: true });
			await fs.writeFile(path.join(state.runtimeRoot, "file"), "wrong lexical target");
			await fs.writeFile(path.join(state.runtimeRoot, "nested", "file"), "correct symlink target");
			await fs.symlink(".", path.join(state.runtimeRoot, "alias"));
			await fs.symlink("nested/deeper", path.join(state.runtimeRoot, "jump"));
			await fs.symlink("jump/../file", path.join(state.runtimeRoot, "ref"));
			await fs.symlink(path.join(state.runtimeRoot, "auth.json"), path.join(state.runtimeRoot, "absolute"));
			await fs.symlink(`${state.runtimeRoot}/jump/../file`, path.join(state.runtimeRoot, "nested", "absolute-ref"));
			const externalDirectory = path.join(state.persistentRoot, "external-directory");
			await fs.mkdir(externalDirectory);
			await fs.symlink(state.runtimeRoot, path.join(externalDirectory, "back"));
			await fs.symlink(
				path.join(externalDirectory, "back", "auth.json"),
				path.join(state.runtimeRoot, "external-hop"),
			);
			const result = await snapshot(state);
			expect(result.manifest.excluded).toContainEqual({ path: "external", reason: "external-symlink" });
			expect(syncFs.existsSync(path.join(result.root, "data", "external"))).toBe(false);
			expect(await fs.readlink(path.join(result.root, "data", "internal"))).toBe("auth.json");
			expect(await fs.readFile(path.join(result.root, "data", "internal"), "utf8")).toBe("owned secret");
			expect(result.manifest.excluded).toContainEqual({ path: "external-hop", reason: "external-symlink" });
			expect(await fs.readlink(path.join(result.root, "data", "alias"))).toBe(".");
			expect(await fs.readlink(path.join(result.root, "data", "ref"))).toBe("jump/../file");
			expect(result.manifest.entries.find(entry => entry.path === "ref")?.target).toBe("jump/../file");
			expect(await fs.readFile(path.join(result.root, "data", "ref"), "utf8")).toBe("correct symlink target");
			const restored = fixture();
			await fs.cp(path.join(result.root, "data"), restored.runtimeRoot, {
				recursive: true,
				verbatimSymlinks: true,
			});
			await fs.writeFile(path.join(state.runtimeRoot, "auth.json"), "changed active credential");
			await fs.writeFile(path.join(state.runtimeRoot, "nested", "file"), "changed active file");
			expect(await fs.realpath(path.join(restored.runtimeRoot, "alias"))).toBe(restored.runtimeRoot);
			expect(await fs.readFile(path.join(restored.runtimeRoot, "ref"), "utf8")).toBe("correct symlink target");
			expect(await fs.readFile(path.join(restored.runtimeRoot, "absolute"), "utf8")).toBe("owned secret");
			expect(await fs.readFile(path.join(restored.runtimeRoot, "nested", "absolute-ref"), "utf8")).toBe(
				"correct symlink target",
			);
			// Unresolved internal links fail the new round, never replace the complete recovery point.
			const pointer = await fs.readFile(path.join(domainDirectory(state), "current.json"), "utf8");
			await fs.symlink("missing", path.join(state.runtimeRoot, "unresolved"));
			await expect(runOfflineShmBackup(state)).rejects.toThrow("UNRESOLVED_SOURCE_LINK");
			expect(await fs.readFile(path.join(domainDirectory(state), "current.json"), "utf8")).toBe(pointer);
			expect(await fs.readFile(path.join(result.root, "data", "absolute"), "utf8")).toBe("owned secret");
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses a symlinked backup namespace instead of writing through it",
		async () => {
			const state = fixture();
			const other = fixture();
			await fs.symlink(other.persistentRoot, path.join(state.persistentRoot, ".offline-shm-backups"));
			await expect(runOfflineShmBackup(state)).rejects.toThrow("UNSAFE_BACKUP_DIRECTORY");
			expect(await fs.readdir(other.persistentRoot)).toEqual([]);
		},
	);
});
