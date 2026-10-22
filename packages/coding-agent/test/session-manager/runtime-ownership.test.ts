import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorageWriter } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function deferred() {
	return Promise.withResolvers<void>();
}

// All persistence and ownership operations remain real. Only the completion
// boundary is gated, so the assertions do not depend on filesystem timing.
class DeferredCloseStorage extends FileSessionStorage {
	readonly entered = deferred();
	readonly resume = deferred();
	armed = false;

	constructor(readonly boundary: "writer" | "drain") {
		super();
	}

	override openWriter(
		file: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(file, options);
		return {
			append: line => writer.append(line),
			appendSync: line => writer.appendSync!(line),
			flush: () => writer.flush(),
			flushSync: () => writer.flushSync!(),
			isOpen: () => writer.isOpen(),
			getError: () => writer.getError(),
			close: async () => {
				if (this.armed && this.boundary === "writer") {
					this.entered.resolve();
					await this.resume.promise;
				}
				await writer.close();
			},
		};
	}

	override async drain(): Promise<void> {
		if (this.armed && this.boundary === "drain") {
			this.entered.resolve();
			await this.resume.promise;
		}
		await super.drain();
	}
}

async function seedJournal(root: string): Promise<string> {
	const seed = SessionManager.create(root, root);
	try {
		seed.appendMessage({ role: "user", content: "persistent history", timestamp: 1 });
		await seed.ensureOnDisk();
		await seed.flush();
		const file = seed.getSessionFile();
		if (!file) throw new Error("Expected a persistent journal");
		expect(fs.existsSync(file)).toBe(true);
		const header = fs
			.readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line))
			.find(entry => entry.type === "session");
		expect(header?.id).toBe(seed.getSessionId());
		return file;
	} finally {
		await seed.close();
	}
}

describe("SessionManager runtime ownership", () => {
	it("rejects an independent same-process runtime for the same journal", async () => {
		using temp = TempDir.createSync("@pi-runtime-owner-unique-");
		const file = await seedJournal(temp.path());
		const owner = await SessionManager.open(file, temp.path(), new FileSessionStorage());
		const contender = await SessionManager.open(file, temp.path(), new FileSessionStorage());
		const witness = await SessionManager.open(file, temp.path(), new FileSessionStorage());
		try {
			owner.acquireRuntimeOwnership();
			// Reacquiring through the actual owner is idempotent, not a second owner.
			owner.acquireRuntimeOwnership();
			const before = fs.readFileSync(file, "utf8");
			expect(() => contender.acquireRuntimeOwnership()).toThrow();
			await contender.close();
			// Closing a rejected manager must not release the owner's native lease.
			expect(() => witness.acquireRuntimeOwnership()).toThrow();
			expect(fs.readFileSync(file, "utf8")).toBe(before);
			expect(owner.getSessionFile()).toBe(file);
			expect(contender.getSessionFile()).toBe(file);
			await owner.close();
			expect(() => witness.acquireRuntimeOwnership()).not.toThrow();
		} finally {
			await contender.close();
			await witness.close();
			await owner.close();
		}
	});

	for (const boundary of ["writer", "drain"] as const) {
		it(`holds runtime ownership until deferred ${boundary} completion`, async () => {
			using temp = TempDir.createSync(`@pi-runtime-owner-${boundary}-`);
			const file = await seedJournal(temp.path());
			const storage = new DeferredCloseStorage(boundary);
			const owner = await SessionManager.open(file, temp.path(), storage);
			const contender = await SessionManager.open(file, temp.path(), new FileSessionStorage());
			let closing: Promise<void> | undefined;
			try {
				owner.acquireRuntimeOwnership();
				owner.appendMessage({ role: "user", content: "before shutdown", timestamp: 2 });
				await owner.flush();
				storage.armed = true;
				closing = owner.close();
				await storage.entered.promise;
				expect(() => contender.acquireRuntimeOwnership()).toThrow();
				expect(contender.getSessionFile()).toBe(file);
				storage.resume.resolve();
				await closing;
				expect(() => contender.acquireRuntimeOwnership()).not.toThrow();
				expect(owner.getSessionFile()).toBe(file);
			} finally {
				storage.resume.resolve();
				await closing;
				await contender.close();
				await owner.close();
			}
		});
	}

	it("rejects runtime-open of a foreign live legacy journal before migration or sibling creation", async () => {
		using temp = TempDir.createSync("@pi-runtime-owner-migration-");
		const file = path.join(temp.path(), "legacy.jsonl");
		const original = `${[
			JSON.stringify({
				type: "session",
				id: crypto.randomUUID(),
				timestamp: "2025-01-01T00:00:00Z",
				cwd: temp.path(),
			}),
			JSON.stringify({
				type: "message",
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "legacy history", timestamp: 1 },
			}),
		].join("\n")}\n`;
		fs.writeFileSync(file, original);
		const owner = await SessionManager.open(file, temp.path());
		let inspector: SessionManager | undefined;
		let attempted: SessionManager | undefined;
		try {
			owner.acquireRuntimeOwnership();
			const files = fs.readdirSync(temp.path()).sort();
			inspector = await SessionManager.open(file, temp.path());
			expect(inspector.getEntries()).toHaveLength(1);
			expect(fs.readFileSync(file, "utf8")).toBe(original);
			await inspector.close();
			const opening = SessionManager.open(file, temp.path(), new FileSessionStorage(), {
				runtimeOwnership: true,
			}).then(manager => {
				attempted = manager;
				return manager;
			});
			await expect(opening).rejects.toThrow();
			expect(fs.readFileSync(file, "utf8")).toBe(original);
			expect(fs.readdirSync(temp.path()).sort()).toEqual(files);
			expect(owner.getSessionFile()).toBe(file);
			await owner.close();
			attempted = await SessionManager.open(file, temp.path(), new FileSessionStorage(), {
				runtimeOwnership: true,
			});
			expect(attempted.getSessionFile()).toBe(file);
			expect(attempted.getEntries()).toHaveLength(1);
			attempted.appendMessage({ role: "user", content: "after ownership transfer", timestamp: 2 });
			await attempted.flush();
			const entries = fs
				.readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(entries.find(entry => entry.type === "session")?.version).toBe(3);
			expect(entries.filter(entry => entry.type === "message")).toHaveLength(2);
		} finally {
			await attempted?.close();
			await inspector?.close();
			await owner.close();
		}
	});

	it("retains the original runtime lease through a switch and rollback", async () => {
		using temp = TempDir.createSync("@pi-runtime-owner-rollback-");
		const original = await seedJournal(temp.path());
		const target = await seedJournal(temp.path());
		const owner = await SessionManager.open(original, temp.path(), new FileSessionStorage(), {
			runtimeOwnership: true,
		});
		const originalWitness = await SessionManager.open(original, temp.path());
		const targetWitness = await SessionManager.open(target, temp.path());
		try {
			const snapshot = owner.captureState();
			{
				using retained = owner.retainRuntimeOwnership();
				await owner.setSessionFile(target);
				expect(owner.getSessionFile()).toBe(target);
				expect(() => originalWitness.acquireRuntimeOwnership()).toThrow();
				expect(() => targetWitness.acquireRuntimeOwnership()).toThrow();
				owner.restoreState(snapshot);
				expect(owner.getSessionFile()).toBe(original);
				expect(() => originalWitness.acquireRuntimeOwnership()).toThrow();
				expect(() => targetWitness.acquireRuntimeOwnership()).not.toThrow();
			}
			// Disposing the switch guard after rollback must not release the
			// restored claim which is once again the manager's current claim.
			expect(() => originalWitness.acquireRuntimeOwnership()).toThrow();
			await owner.close();
			expect(() => originalWitness.acquireRuntimeOwnership()).not.toThrow();
		} finally {
			await targetWitness.close();
			await originalWitness.close();
			await owner.close();
		}
	});
});
