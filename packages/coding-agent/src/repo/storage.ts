import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import type { FileRead } from "./files";
import type { RepoFailure, RepoSymbolHit } from "./types";

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT, checked_at INTEGER, epoch INTEGER NOT NULL DEFAULT 0, change_seq INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, generation TEXT NOT NULL, path TEXT NOT NULL, category TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, text TEXT NOT NULL, UNIQUE(generation,path));
CREATE INDEX IF NOT EXISTS files_gen ON files(generation,path);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(text, tokenize='trigram');
CREATE TABLE IF NOT EXISTS symbols (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, name TEXT NOT NULL, qualname TEXT NOT NULL, name_folded TEXT NOT NULL, qualname_folded TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT);
CREATE TABLE IF NOT EXISTS failures (generation TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(generation,path));
CREATE TABLE IF NOT EXISTS pending (path TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uncertainty (reason TEXT PRIMARY KEY, seq INTEGER NOT NULL);
`;

/** The auxiliary FTS text and symbol keys follow JavaScript's locale-independent lowercase policy. */
const foldCase = (value: string): string => value.toLowerCase();
const SCOPE_RULES_CHANGED = "Ignore or Git scope rules changed; complete reconciliation required";

function affectsScope(pathname: string): boolean {
	const basename = path.posix.basename(pathname);
	return (
		basename === ".ignore" ||
		basename === ".gitignore" ||
		basename === ".rgignore" ||
		pathname === ".git/info/exclude" ||
		pathname === ".git/config" ||
		pathname === ".gitconfig" ||
		pathname === ".config/git/ignore" ||
		pathname === ".config/git/config"
	);
}

/** Index location shared by storage and lifecycle without opening or creating the database. */
export function repoIndexPath(agentDir: string, root: string): string {
	return path.join(agentDir, "repo", `${createHash("sha256").update(root).digest("hex")}.db`);
}

export interface IndexedFile extends FileRead {
	symbols: Omit<RepoSymbolHit, "path" | "category">[];
}
export interface StateRow {
	generation: string | null;
	checked_at: number | null;
	epoch: number;
	change_seq: number;
}

export class RepoStorage {
	readonly path: string;
	#db?: Database;
	#recoveryError?: Error;
	get recoveryError(): Error | undefined {
		return this.#recoveryError;
	}
	get db(): Database {
		if (this.#recoveryError) throw this.#recoveryError;
		if (!this.#db) throw new Error("Repository index storage is closed");
		return this.#db;
	}
	constructor(agentDir: string, root: string) {
		this.path = repoIndexPath(agentDir, root);
		mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
		try {
			const db = new Database(this.path, { create: true, strict: true });
			this.#db = db;
			chmodSync(this.path, 0o600);
			db.run("PRAGMA busy_timeout=5000");
			const versionRow = db.query("PRAGMA user_version").get();
			if (
				!versionRow ||
				typeof versionRow !== "object" ||
				!("user_version" in versionRow) ||
				typeof versionRow.user_version !== "number"
			)
				throw new Error("Repository index has no readable schema version");
			const version = versionRow.user_version;
			if (version > 2) throw new Error(`Repository index schema ${version} is newer than supported version 2`);
			if (version === 1) throw new Error("Repository index schema 1 needs recovery for Unicode case matching");
			db.exec(SCHEMA);
			db.run("PRAGMA user_version=2");
			const state = db.query("SELECT generation,checked_at,epoch,change_seq FROM state WHERE id=1").get();
			if (
				!state ||
				typeof state !== "object" ||
				!("generation" in state) ||
				(state.generation !== null && typeof state.generation !== "string") ||
				!("epoch" in state) ||
				typeof state.epoch !== "number"
			)
				throw new Error("Repository index state is missing or malformed");
			db.query("SELECT generation,path,category,hash,size,mtime,text FROM files LIMIT 0").all();
			db.query("SELECT rowid,text FROM files_fts LIMIT 0").all();
			db.query(
				"SELECT file_id,name,qualname,name_folded,qualname_folded,kind,start_line,end_line,signature FROM symbols LIMIT 0",
			).all();
			db.query("SELECT generation,path,kind,message FROM failures LIMIT 0").all();
			db.query("SELECT path,seq FROM pending LIMIT 0").all();
			db.query("SELECT reason,seq FROM uncertainty LIMIT 0").all();
		} catch (error) {
			this.#db?.close();
			this.#db = undefined;
			this.#recoveryError = new Error(
				`Repository index recovery required: ${error instanceof Error ? error.message : String(error)}. Use recover() to replace it after a successful rebuild.`,
				{ cause: error },
			);
		}
	}

	/** Promote a fully built staging index while holding the repository index file lock. */
	replaceFrom(staged: RepoStorage): void {
		staged.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		staged.db.run("PRAGMA journal_mode=DELETE");
		staged.close();
		const backup = `${this.path}.backup-${createHash("sha256").update(staged.path).digest("hex").slice(0, 12)}`;
		const moved: string[] = [];
		let restored: Database | undefined;
		try {
			for (const suffix of ["", "-wal", "-shm"]) {
				if (!existsSync(`${this.path}${suffix}`)) continue;
				renameSync(`${this.path}${suffix}`, `${backup}${suffix}`);
				moved.push(suffix);
			}
			renameSync(staged.path, this.path);
			restored = new Database(this.path, { strict: true });
			restored.run("PRAGMA busy_timeout=5000");
			restored.run("PRAGMA journal_mode=WAL");
		} catch (error) {
			restored?.close();
			if (existsSync(this.path)) renameSync(this.path, staged.path);
			for (const suffix of moved.reverse()) renameSync(`${backup}${suffix}`, `${this.path}${suffix}`);
			throw error;
		}
		this.#db = restored;
		this.#recoveryError = undefined;
		for (const suffix of moved) unlinkSync(`${backup}${suffix}`);
	}

	transaction<T>(fn: () => T): T {
		return this.db.transaction(fn).immediate();
	}
	read<T>(fn: () => T): T {
		return this.db.transaction(fn).deferred();
	}
	state(): StateRow {
		return this.db.query("SELECT generation,checked_at,epoch,change_seq FROM state WHERE id=1").get() as StateRow;
	}
	pending(limit = -1): Array<{ path: string; seq: number }> {
		return this.db.query("SELECT path,seq FROM pending ORDER BY path LIMIT ?").all(limit) as Array<{
			path: string;
			seq: number;
		}>;
	}
	uncertainty(limit = -1): string[] {
		return (
			this.db.query("SELECT reason FROM uncertainty ORDER BY reason LIMIT ?").all(limit) as Array<{ reason: string }>
		).map(row => row.reason);
	}
	markChanged(paths: string[]): void {
		if (!paths.length) return;
		this.transaction(() => {
			this.db.run("UPDATE state SET change_seq=change_seq+1 WHERE id=1");
			const seq = this.state().change_seq;
			const insert = this.db.query(
				"INSERT INTO pending(path,seq) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET seq=excluded.seq",
			);
			for (const name of paths) insert.run(name, seq);
			if (paths.some(affectsScope))
				this.db
					.query(
						"INSERT INTO uncertainty(reason,seq) VALUES(?,?) ON CONFLICT(reason) DO UPDATE SET seq=excluded.seq",
					)
					.run(SCOPE_RULES_CHANGED, seq);
		});
	}
	markUncertain(reason: string): void {
		this.transaction(() => {
			this.db.run("UPDATE state SET change_seq=change_seq+1 WHERE id=1");
			this.db
				.query("INSERT INTO uncertainty(reason,seq) VALUES(?,?) ON CONFLICT(reason) DO UPDATE SET seq=excluded.seq")
				.run(reason, this.state().change_seq);
		});
	}
	getFile(pathname: string, generation: string): { hash: string; id: number } | null {
		return this.db.query("SELECT id,hash FROM files WHERE generation=? AND path=?").get(generation, pathname) as {
			hash: string;
			id: number;
		} | null;
	}
	failures(generation: string, limit = -1): RepoFailure[] {
		return this.db
			.query("SELECT path,kind,message FROM failures WHERE generation=? ORDER BY path LIMIT ?")
			.all(generation, limit) as RepoFailure[];
	}
	counts(generation: string): { files: number; symbols: number } {
		return this.db
			.query(
				"SELECT (SELECT count(*) FROM files WHERE generation=?) files,(SELECT count(*) FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.generation=?) symbols",
			)
			.get(generation, generation) as { files: number; symbols: number };
	}
	insertFile(file: IndexedFile, generation: string): void {
		this.db
			.query("INSERT INTO files(generation,path,category,hash,size,mtime,text) VALUES(?,?,?,?,?,?,?)")
			.run(generation, file.path, file.category, file.hash, file.size, file.mtimeMs, file.text);
		const id = Number((this.db.query("SELECT last_insert_rowid() id").get() as { id: number }).id);
		this.db.query("INSERT INTO files_fts(rowid,text) VALUES(?,?)").run(id, foldCase(file.text));
		const insert = this.db.query(
			"INSERT INTO symbols(file_id,name,qualname,name_folded,qualname_folded,kind,start_line,end_line,signature) VALUES(?,?,?,?,?,?,?,?,?)",
		);
		for (const symbol of file.symbols)
			insert.run(
				id,
				symbol.name,
				symbol.qualname,
				foldCase(symbol.name),
				foldCase(symbol.qualname),
				symbol.kind,
				symbol.startLine,
				symbol.endLine,
				symbol.signature ?? null,
			);
	}
	removeFile(id: number): void {
		this.db.query("DELETE FROM files_fts WHERE rowid=?").run(id);
		this.db.query("DELETE FROM files WHERE id=?").run(id);
	}
	removeGeneration(generation: string): void {
		this.db.query("DELETE FROM files_fts WHERE rowid IN (SELECT id FROM files WHERE generation=?)").run(generation);
		this.db.query("DELETE FROM files WHERE generation=?").run(generation);
		this.db.query("DELETE FROM failures WHERE generation=?").run(generation);
	}
	putFailure(failure: RepoFailure, generation: string): void {
		this.db
			.query(
				"INSERT INTO failures(generation,path,kind,message) VALUES(?,?,?,?) ON CONFLICT(generation,path) DO UPDATE SET kind=excluded.kind,message=excluded.message",
			)
			.run(generation, failure.path, failure.kind, failure.message);
	}
	clearFailure(pathname: string, generation: string): void {
		this.db.query("DELETE FROM failures WHERE generation=? AND path=?").run(generation, pathname);
	}
	clearPending(paths: string[], maxSeq: number): void {
		const stmt = this.db.query("DELETE FROM pending WHERE path=? AND seq<=?");
		for (const pathname of paths) stmt.run(pathname, maxSeq);
	}
	remove(): void {
		this.transaction(() => {
			this.db.exec(
				"DELETE FROM files_fts; DELETE FROM files; DELETE FROM failures; DELETE FROM pending; DELETE FROM uncertainty",
			);
			this.db.run("UPDATE state SET generation=NULL,checked_at=NULL,epoch=epoch+1 WHERE id=1");
		});
	}
	close(): void {
		this.#db?.close();
		this.#db = undefined;
	}
}
