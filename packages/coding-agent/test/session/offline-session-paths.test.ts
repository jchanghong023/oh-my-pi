import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";

const managerUrl = new URL("../../src/session/session-manager.ts", import.meta.url).href;
const storageUrl = new URL("../../src/session/session-storage.ts", import.meta.url).href;
const pathsUrl = new URL("../../src/session/session-paths.ts", import.meta.url).href;
const listingUrl = new URL("../../src/session/session-listing.ts", import.meta.url).href;
const dirsUrl = new URL("../../../utils/src/dirs.ts", import.meta.url).href;
const ttyUrl = new URL("../../../tui/src/ttyid.ts", import.meta.url).href;

/** A fresh interpreter keeps offline roots, cwd, profiles and storage caches isolated. */
function probe(body: string, offline = "1"): void {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "omp-offline-sessions-"));
	const env = {
		...process.env,
		OMP_CONFIG_ROOT: path.join(fixture, "persistent"),
		OMP_OFFLINE: offline,
		OMP_PROFILE: "session-paths",
		PI_PROFILE: "",
		PI_CODING_AGENT_DIR: path.join(fixture, "agent-override"),
		XDG_DATA_HOME: path.join(fixture, "xdg-data"),
		XDG_STATE_HOME: path.join(fixture, "xdg-state"),
		XDG_CACHE_HOME: path.join(fixture, "xdg-cache"),
		TERM_SESSION_ID: `offline-session-${crypto.randomUUID()}`,
	};
	const state = getOfflineShmState(env);
	try {
		const source = `
			import assert from "node:assert/strict";
			import { spyOn } from "bun:test";
			import * as fs from "node:fs";
			import * as os from "node:os";
			import * as path from "node:path";
			import { SessionManager } from ${JSON.stringify(managerUrl)};
			import { FileSessionStorage, MemorySessionStorage, OfflineSessionPathError, SessionLockError } from ${JSON.stringify(storageUrl)};
			import { resolveSessionDirectory, sessionDirForCwd, readTerminalBreadcrumbEntry } from ${JSON.stringify(pathsUrl)};
			import { listSessions, listSessionsReadOnly, listRecentSessions, resolveResumableSession } from ${JSON.stringify(listingUrl)};
			import { getOfflineShmState, getSessionsDir, getTerminalSessionsDir, setProfile } from ${JSON.stringify(dirsUrl)};
			import { getTerminalId } from ${JSON.stringify(ttyUrl)};
			const fixture = ${JSON.stringify(fixture)};
			const state = getOfflineShmState();
			const project = path.join(fixture, "project");
			const otherProject = path.join(fixture, "other-project");
			fs.mkdirSync(project, { recursive: true });
			fs.mkdirSync(otherProject, { recursive: true });
			const custom = path.join(fixture, "external-a", "sessions");
			const otherCustom = path.join(fixture, "external-b", "sessions");
			const storage = new FileSessionStorage();
			const withinRuntime = target => {
				assert.equal(typeof target, "string");
				assert.ok(target.startsWith(state.runtimeRoot + path.sep), target);
			};
			const writeOldSession = (file, id = "old-disk-session") => {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				const timestamp = new Date().toISOString();
				const header = { type: "session", version: 3, id, timestamp, cwd: project };
				const message = { type: "message", id: "old-user", parentId: null, timestamp,
					message: { role: "user", content: "old NFS history", timestamp: Date.now() } };
				const body = JSON.stringify(header) + "\\n" + JSON.stringify(message) + "\\n";
				fs.writeFileSync(file, body);
				return body;
			};
			${body}
			console.log("offline-session-probe-ok");
		`;
		const result = Bun.spawnSync([process.execPath, "-e", source], {
			env,
			cwd: fixture,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(result.stdout.toString()).toContain("offline-session-probe-ok");
	} finally {
		if (state) fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
		fs.rmSync(fixture, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform !== "linux")("offline session path boundaries", () => {
	it("isolates custom roots without adopting old disk sessions or changing project cwd", () => {
		probe(`
			const oldFile = path.join(custom, "old.jsonl");
			const oldBody = writeOldSession(oldFile);
			const probes = ["readFileSync", "readdirSync", "existsSync", "statSync", "realpathSync"]
				.map(method => spyOn(fs, method));
			assert.deepEqual(await SessionManager.list(project, custom), []);
			const continued = await SessionManager.continueRecent(project, custom);
			assert.equal(continued.getCwd(), project);
			assert.equal(continued.getEntries().length, 0);
			withinRuntime(continued.getSessionFile());
			await continued.ensureOnDisk();
			await continued.close();

			const first = SessionManager.create(project, custom);
			const second = SessionManager.create(project, otherCustom);
			const otherCwd = SessionManager.create(otherProject, custom);
			assert.notEqual(first.getSessionDir(), second.getSessionDir());
			assert.equal(first.getSessionDir(), otherCwd.getSessionDir());
			assert.equal(first.getSessionDir(), resolveSessionDirectory(custom, storage));
			assert.equal(resolveSessionDirectory(first.getSessionDir(), storage), first.getSessionDir());
			assert.equal(path.dirname(first.getSessionFile()), first.getSessionDir());
			assert.equal(first.getCwd(), project);
			assert.equal(otherCwd.getCwd(), otherProject);
			await first.ensureOnDisk();
			await second.ensureOnDisk();
			const artifactId = await first.saveArtifact("runtime artifact", "test");
			const artifact = await first.getArtifactPath(artifactId);
			withinRuntime(artifact);
			assert.equal(fs.readFileSync(artifact, "utf8"), "runtime artifact");
			for (const probe of probes) {
				for (const [target] of probe.mock.calls) {
					if (typeof target !== "string") continue;
					assert.ok(target !== custom && !target.startsWith(custom + path.sep), target);
					assert.ok(target !== otherCustom && !target.startsWith(otherCustom + path.sep), target);
				}
				probe.mockRestore();
			}
			assert.equal(fs.readFileSync(oldFile, "utf8"), oldBody);
			assert.deepEqual(fs.readdirSync(custom), ["old.jsonl"]);
			assert.equal(fs.existsSync(otherCustom), false);
			assert.equal(process.cwd(), fixture);
			assert.equal(process.env.OMP_CONFIG_ROOT, path.join(fixture, "persistent"));
			assert.equal(fs.existsSync(process.env.OMP_CONFIG_ROOT), false);
			await Promise.all([first.close(), second.close(), otherCwd.close()]);
		`);
	});

	it("keeps creation, new, fork, branch, list and resume paths on the actual runtime files", () => {
		probe(`
			const manager = SessionManager.create(project, custom);
			manager.appendMessage({ role: "user", content: "runtime conversation", timestamp: Date.now() });
			await manager.ensureOnDisk();
			const original = manager.getSessionFile();
			withinRuntime(original);
			const fork = await manager.fork();
			withinRuntime(fork.oldSessionFile);
			withinRuntime(fork.newSessionFile);
			assert.equal(manager.getSessionFile(), fork.newSessionFile);
			assert.ok(fs.existsSync(fork.newSessionFile));
			const branch = manager.createBranchedSession(manager.getLeafId());
			withinRuntime(branch);
			assert.equal(manager.getSessionFile(), branch);
			await manager.close();

			const forked = await SessionManager.forkFrom(original, project, otherCustom);
			withinRuntime(forked.getSessionFile());
			assert.equal(path.dirname(forked.getSessionFile()), resolveSessionDirectory(otherCustom, storage));
			const fresh = await forked.newSession({ sessionDir: custom });
			assert.equal(path.dirname(fresh), resolveSessionDirectory(custom, storage));
			assert.equal(forked.getSessionFile(), fresh);
			assert.ok(fs.existsSync(fresh));
			await forked.close();

			const sessions = await SessionManager.list(project, custom);
			assert.ok(sessions.some(session => session.path === original));
			assert.ok(sessions.some(session => session.path === fresh));
			for (const session of sessions) withinRuntime(session.path);
			assert.ok((await listSessions(custom, storage)).some(session => session.path === original));
			assert.ok((await listSessionsReadOnly(custom, storage)).some(session => session.path === original));
			assert.ok((await SessionManager.listAll()).some(session => session.path === original));
			assert.ok((await listRecentSessions({ limit: 20, sessionDir: custom })).some(session => session.path === original));
			const match = await resolveResumableSession(sessions.find(session => session.path === original).id, project, custom);
			assert.equal(match.session.path, original);
			const resumed = await SessionManager.open(original, custom);
			assert.equal(resumed.getSessionFile(), original);
			assert.equal(resumed.getSessionDir(), resolveSessionDirectory(custom, storage));
			await resumed.setSessionFile(branch);
			assert.equal(resumed.getSessionFile(), branch);
			await resumed.close();
			const continued = await SessionManager.continueRecent(project, custom);
			withinRuntime(continued.getSessionFile());
			assert.equal(continued.getSessionFile(), branch);
			await continued.close();
			const empty = SessionManager.createEmptySessionFile(project);
			withinRuntime(empty);
			assert.ok(fs.existsSync(empty));
			assert.equal(fs.existsSync(custom), false);
			assert.equal(fs.existsSync(otherCustom), false);
		`);
	});

	it("rejects external explicit files before read or mutation and allows a manual runtime restore", () => {
		probe(`
			const external = path.join(custom, "source.jsonl");
			const oldBody = writeOldSession(external);
			const expected = /Manually restore.*runtime path/;
			await assert.rejects(SessionManager.open(external, custom), expected);
			await assert.rejects(SessionManager.open(path.join(custom, "missing.jsonl")), expected);
			await assert.rejects(SessionManager.forkFrom(external, project, custom), expected);
			const manager = SessionManager.create(project, custom);
			await manager.ensureOnDisk();
			const before = manager.getSessionFile();
			await assert.rejects(manager.setSessionFile(external), expected);
			assert.equal(manager.getSessionFile(), before);
			await assert.rejects(SessionManager.forkFrom(before, project, custom, storage, { sessionFile: external }), expected);
			assert.throws(() => storage.readTextSync(external), expected);
			assert.throws(() => storage.openWriter(external), expected);
			await assert.rejects(storage.writeTextAtomic(external, "overwrite"), expected);
			const linked = path.join(manager.getSessionDir(), "linked.jsonl");
			fs.symlinkSync(external, linked);
			await assert.rejects(SessionManager.open(linked, custom), /symlinked session path/);
			assert.throws(() => storage.readTextSync(linked), /symlinked session path/);
			assert.equal(fs.readFileSync(external, "utf8"), oldBody);
			assert.deepEqual(fs.readdirSync(custom), ["source.jsonl"]);

			// This fixture copy is user-controlled restore, never application startup behavior.
			const restored = path.join(manager.getSessionDir(), "restored.jsonl");
			fs.copyFileSync(external, restored);
			const resumed = await SessionManager.open(restored, custom);
			assert.equal(resumed.getSessionFile(), restored);
			assert.equal(resumed.getSessionId(), "old-disk-session");
			assert.equal(resumed.getCwd(), project);
			assert.equal(resumed.getEntries().length, 1);
			await resumed.close();
			await manager.close();
		`);
	});

	it("checks raw symlink traversal before dot-dot normalization or filesystem access", () => {
		probe(`
			const externalRoot = path.join(fixture, "external-data");
			fs.mkdirSync(path.join(externalRoot, "subdir"), { recursive: true });
			const externalFile = path.join(externalRoot, "secret.jsonl");
			fs.writeFileSync(externalFile, "external secret\\n");
			fs.mkdirSync(state.runtimeRoot, { recursive: true });
			const link = path.join(state.runtimeRoot, "link");
			fs.symlinkSync(path.join(externalRoot, "subdir"), link);
			const raw = link + "/../secret.jsonl";
			const probes = ["readFileSync", "openSync", "writeFileSync", "statSync", "lstatSync",
				"existsSync", "renameSync", "mkdirSync"].map(method => ({ method, spy: spyOn(fs, method) }));
			try {
				assert.throws(() => storage.readTextSync(raw), OfflineSessionPathError);
				await assert.rejects(async () => storage.readText(raw), OfflineSessionPathError);
				await assert.rejects(storage.readTextSlices(raw, 32, 32), OfflineSessionPathError);
				assert.throws(() => storage.writeTextSync(raw, "replaced\\n"), OfflineSessionPathError);
				assert.throws(() => storage.writeLinesSync(raw, ["replaced\\n"]), OfflineSessionPathError);
				await assert.rejects(storage.writeText(raw, "replaced\\n"), OfflineSessionPathError);
				await assert.rejects(storage.writeTextAtomic(raw, "replaced\\n"), OfflineSessionPathError);
				await assert.rejects(storage.writeLinesAtomic(raw, ["replaced\\n"]), OfflineSessionPathError);
				for (const flags of ["a", "w"]) {
					assert.throws(() => storage.openWriter(raw, { flags }), OfflineSessionPathError);
				}
				for (const { method, spy } of probes) {
					for (const [target] of spy.mock.calls) {
						if (typeof target !== "string") continue;
						assert.ok(target !== externalRoot && !target.startsWith(externalRoot + path.sep), method + ": " + target);
						if (method === "lstatSync" && target === link) continue;
						assert.ok(target !== link && !target.startsWith(link + path.sep), method + ": " + target);
					}
				}
			} finally {
				for (const { spy } of probes) spy.mockRestore();
			}
			assert.equal(fs.readFileSync(externalFile, "utf8"), "external secret\\n");
			assert.equal(fs.existsSync(path.join(state.runtimeRoot, "secret.jsonl")), false);
			const nested = path.join(state.runtimeRoot, "nested");
			fs.mkdirSync(nested);
			const safe = nested + "/../safe.jsonl";
			storage.writeTextSync(safe, "first\\n");
			assert.equal(storage.readTextSync(safe), "first\\n");
			await storage.writeTextAtomic(safe, "second\\n");
			const writer = storage.openWriter(safe);
			await writer.append("third\\n");
			await writer.close();
			process.chdir(state.runtimeRoot);
			try {
				assert.throws(() => storage.readTextSync("link/../secret.jsonl"), OfflineSessionPathError);
				assert.equal(storage.readTextSync("nested/../safe.jsonl"), "second\\nthird\\n");
			} finally {
				process.chdir(fixture);
			}
		`);
	});

	for (const lockKind of ["live", "orphan", "dangling"]) {
		it(`rejects a restored ${lockKind} publish-lock symlink before append or rewrite accesses it`, () => {
			probe(`
				const lockKind = ${JSON.stringify(lockKind)};
				const dir = path.join(state.runtimeRoot, "lock-boundaries");
				fs.mkdirSync(dir, { recursive: true });
				const external = path.join(fixture, "external-lock");
				const lockContent = lockKind === "live" ? process.pid + ":1\\n" : "orphan";
				if (lockKind !== "dangling") {
					fs.writeFileSync(external, lockContent);
					if (lockKind === "orphan") fs.utimesSync(external, new Date(0), new Date(0));
				}
				const flows = ["sync", "lines-sync", "atomic", "lines-atomic", "append"];
				for (const flow of flows) {
					const file = path.join(dir, flow + ".jsonl");
					fs.writeFileSync(file, "original\\n");
					const writer = flow === "append" ? storage.openWriter(file) : undefined;
					const lockPath = path.join(dir, "." + path.basename(file) + ".lock");
					fs.symlinkSync(external, lockPath);
					const probes = ["openSync", "readFileSync", "statSync", "unlinkSync", "existsSync"]
						.map(method => spyOn(fs, method));
					try {
						assert.throws(() => storage.openWriter(file), OfflineSessionPathError);
						if (flow === "sync") {
							assert.throws(() => storage.writeTextSync(file, "replacement\\n"), OfflineSessionPathError);
						} else if (flow === "lines-sync") {
							assert.throws(() => storage.writeLinesSync(file, ["replacement\\n"]), OfflineSessionPathError);
						} else if (flow === "atomic") {
							await assert.rejects(storage.writeTextAtomic(file, "replacement\\n"), OfflineSessionPathError);
						} else if (flow === "lines-atomic") {
							await assert.rejects(storage.writeLinesAtomic(file, ["replacement\\n"]), OfflineSessionPathError);
						} else {
							assert.throws(() => writer.appendSync("append\\n"), OfflineSessionPathError);
							await assert.rejects(writer.close(), OfflineSessionPathError);
						}
						for (const probe of probes) {
							for (const [target] of probe.mock.calls) {
								assert.notEqual(target, lockPath);
								assert.notEqual(target, external);
							}
						}
					} finally {
						for (const probe of probes) probe.mockRestore();
					}
					assert.ok(fs.lstatSync(lockPath).isSymbolicLink());
					assert.equal(fs.readlinkSync(lockPath), external);
					assert.equal(fs.readFileSync(file, "utf8"), "original\\n");
				}
				if (lockKind === "dangling") assert.equal(fs.existsSync(external), false);
				else assert.equal(fs.readFileSync(external, "utf8"), lockContent);
				assert.deepEqual(fs.readdirSync(dir).sort(), flows.flatMap(flow => [flow + ".jsonl", "." + flow + ".jsonl.lock"]).sort());
			`);
		});
	}

	it("retains regular publish-lock ownership, stale recovery and appends after replacement", () => {
		probe(`
			const file = path.join(state.runtimeRoot, "normal-locks", "session.jsonl");
			storage.writeTextSync(file, "initial\\n");
			const lockPath = path.join(path.dirname(file), "." + path.basename(file) + ".lock");
			fs.writeFileSync(lockPath, process.pid + ":1\\n");
			assert.throws(() => storage.writeTextSync(file, "blocked\\n"), SessionLockError);
			assert.equal(fs.readFileSync(file, "utf8"), "initial\\n");
			assert.equal(fs.readFileSync(lockPath, "utf8"), process.pid + ":1\\n");
			fs.writeFileSync(lockPath, "orphan");
			fs.utimesSync(lockPath, new Date(0), new Date(0));
			const writer = storage.openWriter(file);
			await storage.writeTextAtomic(file, "replacement\\n");
			await writer.append("append\\n");
			await writer.close();
			assert.equal(storage.readTextSync(file), "replacement\\nappend\\n");
			assert.equal(fs.existsSync(lockPath), false);
			assert.deepEqual(fs.readdirSync(path.dirname(file)), ["session.jsonl"]);
		`);
	});

	for (const linkedPart of ["root", "legacy", "home", "hashed", "destination", "source-entry", "destination-entry"]) {
		it(`rejects a manually restored linked ${linkedPart} before migration can touch external sessions`, () => {
			probe(`
				const linkedPart = ${JSON.stringify(linkedPart)};
				const sessionsRoot = getSessionsDir();
				let legacyName = "--" + path.resolve(project).replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
				if (linkedPart === "home") {
					legacyName = "--" + os.homedir().replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "-restored--";
				} else if (linkedPart === "hashed") {
					legacyName = "tmp-project-" + Bun.SHA256.hash(project, "hex");
				}
				const legacyDir = path.join(sessionsRoot, legacyName);
				const destinationDir = sessionDirForCwd(project);
				const externalRoot = path.join(fixture, "persistent", "nfs-sessions");
				const externalBucket = path.join(externalRoot, legacyName);
				const externalFile = path.join(externalBucket, "sentinel.jsonl");
				const sentinel = writeOldSession(externalFile);
				const source = path.join(state.runtimeRoot, "restored-source", "source.jsonl");
				writeOldSession(source, "runtime-source");
				fs.mkdirSync(path.dirname(sessionsRoot), { recursive: true });
				let linkedPath;
				if (linkedPart === "root") {
					linkedPath = sessionsRoot;
					fs.symlinkSync(externalRoot, linkedPath);
				} else {
					fs.mkdirSync(sessionsRoot, { recursive: true });
					if (linkedPart === "legacy" || linkedPart === "home" || linkedPart === "hashed") {
						linkedPath = legacyDir;
						fs.symlinkSync(externalBucket, linkedPath);
					} else if (linkedPart === "destination") {
						writeOldSession(path.join(legacyDir, "restored.jsonl"));
						linkedPath = destinationDir;
						fs.symlinkSync(externalBucket, linkedPath);
					} else {
						fs.mkdirSync(legacyDir, { recursive: true });
						fs.mkdirSync(destinationDir, { recursive: true });
						linkedPath = path.join(
							linkedPart === "source-entry" ? legacyDir : destinationDir, "sentinel.jsonl");
						fs.symlinkSync(externalFile, linkedPath);
						if (linkedPart === "destination-entry") {
							writeOldSession(path.join(legacyDir, "sentinel.jsonl"), "restored-source");
						}
					}
				}
				const probes = ["readFileSync", "readdirSync", "existsSync", "statSync", "realpathSync",
					"renameSync", "rmSync", "rmdirSync", "writeFileSync", "mkdirSync", "openSync",
					"copyFileSync", "lstatSync"].map(method => ({ method, spy: spyOn(fs, method) }));
				try {
					const expected = /symlinked session path/;
					assert.throws(() => SessionManager.create(project), expected);
					assert.throws(() => SessionManager.createEmptySessionFile(project), expected);
					await assert.rejects(SessionManager.list(project), expected);
					await assert.rejects(SessionManager.forkFrom(source, project), expected);
					for (const { method, spy } of probes) {
						for (const args of spy.mock.calls) {
							for (const target of args) {
								if (typeof target !== "string") continue;
								assert.ok(target !== externalRoot && !target.startsWith(externalRoot + path.sep),
									method + ": " + target);
								if (method === "lstatSync" && target === linkedPath) continue;
								assert.ok(target !== linkedPath && !target.startsWith(linkedPath + path.sep),
									method + ": " + target);
							}
						}
					}
				} finally {
					for (const { spy } of probes) spy.mockRestore();
				}
				assert.equal(fs.readFileSync(externalFile, "utf8"), sentinel);
				assert.deepEqual(fs.readdirSync(externalRoot), [legacyName]);
				assert.deepEqual(fs.readdirSync(externalBucket), ["sentinel.jsonl"]);
			`);
		});
	}

	for (const offline of ["1", "false"]) {
		it(`preserves normal restored legacy migrations with OMP_OFFLINE=${offline}`, () => {
			probe(
				`
				const sessionsRoot = getSessionsDir();
				const legacyName = "--" + path.resolve(project).replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
				const legacyDir = path.join(sessionsRoot, legacyName);
				const destinationDir = sessionDirForCwd(project);
				const legacyFile = path.join(legacyDir, "restored.jsonl");
				const body = writeOldSession(legacyFile, "manually-restored");
				const existingFile = path.join(destinationDir, "existing.jsonl");
				const existingBody = writeOldSession(existingFile, "existing-runtime");
				const manager = SessionManager.create(project);
				assert.equal(manager.getSessionDir(), destinationDir);
				assert.equal(fs.existsSync(legacyDir), false);
				const restored = path.join(destinationDir, "restored.jsonl");
				assert.equal(fs.readFileSync(restored, "utf8"), body);
				assert.equal(fs.readFileSync(existingFile, "utf8"), existingBody);
				const resumed = await SessionManager.open(restored);
				assert.equal(resumed.getSessionId(), "manually-restored");
				assert.equal(resumed.getEntries().length, 1);
				await resumed.close();
				await manager.close();
				`,
				offline,
			);
		});
	}

	it("ignores restored external breadcrumbs and maps new and relocation destinations by profile", () => {
		probe(`
			const external = path.join(custom, "old.jsonl");
			writeOldSession(external);
			fs.mkdirSync(getTerminalSessionsDir(), { recursive: true });
			fs.writeFileSync(path.join(getTerminalSessionsDir(), getTerminalId()), project + "\\n" + external + "\\n");
			assert.equal(await readTerminalBreadcrumbEntry(), null);
			const first = SessionManager.create(project, custom);
			await first.ensureOnDisk();
			const defaultProfileDir = first.getSessionDir();
			const relocated = path.join(otherCustom, "moved");
			await first.moveTo(otherProject, relocated);
			assert.equal(first.getCwd(), otherProject);
			assert.equal(first.getSessionDir(), resolveSessionDirectory(relocated, storage));
			assert.equal(path.dirname(first.getSessionFile()), first.getSessionDir());
			withinRuntime(first.getSessionFile());
			await first.close();
			setProfile("another-profile");
			const another = SessionManager.create(project, custom);
			assert.notEqual(another.getSessionDir(), defaultProfileDir);
			withinRuntime(another.getSessionFile());
			assert.equal(resolveSessionDirectory(another.getSessionDir(), storage), another.getSessionDir());
			withinRuntime(sessionDirForCwd(project, custom));
			await another.close();
		`);
	});

	it("preserves custom in-memory storage keys while offline", () => {
		probe(`
			const memory = new MemorySessionStorage();
			const manager = SessionManager.create(project, custom, memory);
			assert.equal(manager.getSessionDir(), custom);
			assert.equal(resolveSessionDirectory(custom, memory), custom);
			await manager.ensureOnDisk();
			const file = manager.getSessionFile();
			assert.equal(path.dirname(file), custom);
			assert.equal(fs.existsSync(file), false);
			const opened = await SessionManager.open(file, custom, memory);
			assert.equal(opened.getSessionFile(), file);
			await opened.close();
			await manager.newSession({ sessionDir: otherCustom });
			assert.equal(manager.getSessionDir(), otherCustom);
			await manager.close();
			// Default in-memory buckets must not inspect a restored filesystem link.
			const sessionsRoot = getSessionsDir();
			fs.mkdirSync(path.dirname(sessionsRoot), { recursive: true });
			fs.symlinkSync(custom, sessionsRoot);
			const diskProbes = ["readdirSync", "existsSync", "statSync", "lstatSync"]
				.map(method => spyOn(fs, method));
			try {
				const defaultManager = SessionManager.create(project, undefined, memory);
				assert.equal(defaultManager.getSessionDir(), sessionDirForCwd(project));
				await defaultManager.ensureOnDisk();
				await defaultManager.close();
				for (const probe of diskProbes) {
					for (const [target] of probe.mock.calls) {
						if (typeof target !== "string") continue;
						assert.ok(target !== sessionsRoot && !target.startsWith(sessionsRoot + path.sep), target);
					}
				}
			} finally {
				for (const probe of diskProbes) probe.mockRestore();
			}
		`);
	});

	it("preserves external filesystem paths when offline shm is not applicable", () => {
		probe(
			`
			assert.equal(state, undefined);
			const manager = SessionManager.create(project, custom);
			await manager.ensureOnDisk();
			const file = manager.getSessionFile();
			assert.equal(manager.getSessionDir(), custom);
			assert.equal(path.dirname(file), custom);
			assert.ok(fs.existsSync(file));
			await manager.close();
			const opened = await SessionManager.open(file, custom);
			assert.equal(opened.getSessionFile(), file);
			await opened.close();
		`,
			"false",
		);
	});
});
