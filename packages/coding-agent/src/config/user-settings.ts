import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, MAIN_CONFIG_FILENAMES } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { setYamlConfigValue } from "@oh-my-pi/pi-utils/yaml-config";
import { isScalar, LineCounter, parseDocument, visit } from "yaml";
import type { RawSettings, SettingProvenance } from "./settings";
import { replaceFileAtomically } from "../utils/atomic-file";

export interface UserSettingValue {
	readState: "present" | "missing" | "invalid" | "unreadable";
	value?: unknown;
}
export interface UserSettingIssue {
	code: string;
	message: string;
	source?: SettingProvenance;
}
export interface UserSettingSnapshot extends UserSettingValue {
	revision: string | null;
	issues: UserSettingIssue[];
}
export interface UserSettingWrite {
	status: "saved" | "unchanged" | "failed" | "not_attempted" | "unknown";
	message?: string;
}
export interface UserSettingSaveResult {
	saveState: "complete" | "failed" | "unknown";
	write: UserSettingWrite;
}
export class UserSettingError extends Error {
	constructor(
		readonly code: "invalid_config" | "revision_conflict" | "persistence_failed" | "execution_failed",
		message: string,
		readonly data: UserSettingSaveResult,
		readonly issues?: UserSettingIssue[],
	) {
		super(message);
		this.name = "UserSettingError";
	}
}
interface LoadedSide {
	file: string;
	source: string;
	raw: RawSettings;
	state: UserSettingValue["readState"];
	message?: string;
}
export interface UserSettingMutation {
	segments: readonly string[];
	value: unknown;
	/** Optional CAS for staged Settings writes. */
	baseValue?: unknown;
	checkBase?: boolean;
}
export interface UserSettingsStoreOptions {
	agentDir: string;
	/** Existing Settings migration, applied only in memory to identify reset sources. */
	migrate?: (raw: RawSettings) => RawSettings;
}

function leaf(raw: RawSettings, keys: readonly string[]): unknown {
	let value: unknown = raw;
	for (const key of keys) {
		if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
		value = value[key];
	}
	return value;
}
function canonical(value: unknown, ancestors = new Set<object>()): string {
	if (value === undefined) return "missing";
	if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
	if (value !== null && typeof value === "object") {
		if (ancestors.has(value)) throw new Error("Cyclic settings aliases are not supported.");
		ancestors.add(value);
		try {
			if (Array.isArray(value)) return `[${value.map(item => canonical(item, ancestors)).join(",")}]`;
			if (isRecord(value))
				return `{${Object.keys(value)
					.sort()
					.map(key => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`)
					.join(",")}}`;
		} finally {
			ancestors.delete(value);
		}
	}
	return JSON.stringify(value) ?? String(value);
}
function equal(left: unknown, right: unknown): boolean {
	return canonical(left) === canonical(right);
}
function emptyReceipt(): UserSettingSaveResult {
	return {
		saveState: "failed",
		write: { status: "not_attempted" },
	};
}
function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Explicit user access only: construction never probes the configuration directory. */
export class UserSettingsStore {
	readonly #activeDir: string;
	readonly #domain: string;
	readonly #migrate: UserSettingsStoreOptions["migrate"];
	constructor(options: UserSettingsStoreOptions) {
		this.#activeDir = path.resolve(options.agentDir);
		this.#migrate = options.migrate;
		this.#domain = this.#activeDir;
	}

	async #target(directory: string): Promise<string> {
		// Resolve existing ancestors without following links into another profile, backup, or user.
		// Internal file aliases are permitted only inside this profile's agent directory.
		let cursor = path.parse(directory).root;
		for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
			cursor = path.join(cursor, part);
			try {
				const stat = await fs.lstat(cursor);
				if (stat.isSymbolicLink())
					throw new Error("Configuration directory symlinks are not safe persistence targets.");
				if (
					process.platform !== "win32" &&
					typeof process.getuid === "function" &&
					cursor === directory &&
					stat.uid !== process.getuid()
				)
					throw new Error("Configuration directory belongs to another user.");
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		for (const name of MAIN_CONFIG_FILENAMES) {
			const file = path.join(directory, name);
			let exists = false;
			try {
				await fs.lstat(file);
				exists = true;
				const actual = await fs.realpath(file);
				if (!within(directory, actual)) throw new Error("Configuration symlink escapes its profile.");
				const stat = await fs.stat(actual);
				if (!stat.isFile()) throw new Error("Configuration target is not a regular file.");
				if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid())
					throw new Error("Configuration target belongs to another user.");
				return actual;
			} catch (error) {
				if (exists || !isEnoent(error)) throw error;
			}
		}
		return path.join(directory, MAIN_CONFIG_FILENAMES[0]);
	}
	async #load(directory: string): Promise<LoadedSide> {
		let file = path.join(directory, MAIN_CONFIG_FILENAMES[0]);
		try {
			file = await this.#target(directory);
			let source: string;
			try {
				source = await fs.readFile(file, "utf8");
			} catch (error) {
				if (isEnoent(error)) return { file, source: "", raw: {}, state: "missing" };
				throw error;
			}
			try {
				const lineCounter = new LineCounter();
				const doc = parseDocument(source, { strict: true, uniqueKeys: true, prettyErrors: false, lineCounter });
				if (doc.errors.length)
					return {
						file,
						source,
						raw: {},
						state: "invalid",
						message: doc.errors
							.map(error => {
								const position = lineCounter.linePos(error.pos[0]);
								return `Invalid settings YAML: ${error.code} at line ${position.line}, column ${position.col}.`;
							})
							.join(" "),
					};
				visit(doc, {
					Map: (_key, node) => {
						const seen = new Set<string>();
						for (const pair of node.items) {
							if (!isScalar(pair.key)) throw new Error("Settings mapping keys must be scalar values.");
							const key = String(pair.key.value);
							if (seen.has(key)) throw new Error("Settings mapping contains duplicate logical keys.");
							seen.add(key);
						}
					},
				});
				const raw: unknown = doc.toJS({ maxAliasCount: 100 });
				if (raw !== null && raw !== undefined && !isRecord(raw))
					throw new Error("Settings YAML must contain a mapping.");
				canonical(raw);
				return { file, source, raw: raw ?? {}, state: "present" };
			} catch {
				// yaml conversion/alias errors can also embed user content; never expose their raw messages.
				return {
					file,
					source,
					raw: {},
					state: "invalid",
					message: "Settings YAML has an unsupported or invalid structure.",
				};
			}
		} catch (error) {
			return { file, source: "", raw: {}, state: "unreadable", message: String(error) };
		}
	}
	/** Remove legacy inputs too, preserving sibling outputs of a split migration. */
	#resetMutations(raw: RawSettings, keys: readonly string[]): UserSettingMutation[] {
		const result: UserSettingMutation[] = [{ segments: keys, value: undefined }];
		if (!this.#migrate) return result;
		const migrate = this.#migrate;
		const set = (target: RawSettings, segments: readonly string[], value: unknown) => {
			let parent: Record<string, unknown> = target;
			for (const key of segments.slice(0, -1)) {
				if (!isRecord(parent[key])) parent[key] = {};
				parent = parent[key] as Record<string, unknown>;
			}
			if (value === undefined) delete parent[segments.at(-1)!];
			else parent[segments.at(-1)!] = structuredClone(value);
		};
		const remaining = structuredClone(raw);
		set(remaining, keys, undefined);
		const visitLeaves = (value: unknown, segments: string[]) => {
			if (isRecord(value)) {
				for (const [key, child] of Object.entries(value)) visitLeaves(child, [...segments, key]);
				return;
			}
			if (segments.every((key, index) => keys[index] === key) || keys.every((key, index) => segments[index] === key))
				return;
			const isolated: RawSettings = {};
			set(isolated, segments, value);
			if (leaf(migrate(isolated), keys) === undefined) return;
			result.push({ segments, value: undefined });
			set(remaining, segments, undefined);
		};
		visitLeaves(raw, []);
		if (result.length === 1) return result;
		const before = migrate(structuredClone(raw));
		const after = migrate(remaining);
		// Some migrations retain a shadowed legacy source when an explicit target wins.
		// Such source leaves are removals, never sibling outputs to materialize again.
		for (let index = 1; index < result.length; index++) set(before, result[index].segments, undefined);
		const preserve = (value: unknown, segments: string[]) => {
			if (keys.every((key, index) => segments[index] === key)) return;
			if (isRecord(value)) {
				for (const [key, child] of Object.entries(value)) preserve(child, [...segments, key]);
			} else if (!equal(value, leaf(after, segments))) result.push({ segments, value });
		};
		preserve(before, []);
		return result;
	}
	#snapshot(active: LoadedSide, keys: readonly string[]): UserSettingSnapshot {
		const issues: UserSettingIssue[] = [];
		const side = (loaded: LoadedSide): UserSettingValue => {
			if (loaded.message) issues.push({ code: loaded.state, message: loaded.message });
			if (loaded.state === "present")
				for (let length = 1; length < keys.length; length++) {
					const parent = leaf(loaded.raw, keys.slice(0, length));
					if (parent !== undefined && parent !== null && !isRecord(parent)) {
						issues.push({ code: "invalid", message: "Setting parent must be a mapping." });
						return { readState: "invalid" };
					}
				}
			if (loaded.state === "present" || loaded.state === "missing") {
				const value = leaf(loaded.raw, keys);
				return { readState: value === undefined ? "missing" : "present", value };
			}
			return { readState: loaded.state };
		};
		const a = side(active);
		const valid = issues.length === 0;
		const activeReset = this.#resetMutations(active.raw, keys).map(mutation => [
			mutation.segments,
			leaf(active.raw, mutation.segments),
		]);
		const identity = [this.#domain, keys, active.file, canonical(a.value), canonical(activeReset)];
		return {
			revision: valid ? createHash("sha256").update(JSON.stringify(identity)).digest("hex") : null,
			...a,
			issues,
		};
	}
	async read(keys: readonly string[]): Promise<UserSettingSnapshot> {
		return this.#snapshot(await this.#load(this.#activeDir), keys);
	}
	async readActiveRaw(): Promise<RawSettings> {
		const loaded = await this.#load(this.#activeDir);
		if (loaded.message) throw new Error(loaded.message);
		return loaded.raw;
	}
	async save(mutations: readonly UserSettingMutation[], expectedRevision?: string): Promise<UserSettingSaveResult> {
		const receipt = emptyReceipt();
		const fail = (code: UserSettingError["code"], message: string, issues?: UserSettingIssue[]): never => {
			throw new UserSettingError(code, message, receipt, issues);
		};
		try {
			const initialActive = await this.#load(this.#activeDir);
			if (initialActive.message) fail("invalid_config", "Configuration cannot be safely read.");
			const initialRevisions =
				expectedRevision === undefined
					? mutations.map(mutation => this.#snapshot(initialActive, mutation.segments).revision)
					: undefined;
			if (initialRevisions?.some(revision => revision === null))
				fail("invalid_config", "Configuration cannot be safely parsed.");
			const locked = async () => {
				await fs.mkdir(path.dirname(initialActive.file), { recursive: true, mode: 0o700 });
				return withFileLock(initialActive.file, async () => {
					const active = await this.#load(this.#activeDir);
					const snapshot = this.#snapshot(active, mutations[0].segments);
					if (snapshot.revision === null)
						fail("invalid_config", "Configuration cannot be safely parsed.", snapshot.issues);
					if (active.file !== initialActive.file)
						fail("revision_conflict", "Configuration target changed while acquiring locks.");
					if (expectedRevision !== undefined && expectedRevision !== snapshot.revision)
						fail("revision_conflict", "User configuration changed. Read it before saving again.");
					if (
						initialRevisions &&
						mutations.some(
							(mutation, index) =>
								this.#snapshot(active, mutation.segments).revision !== initialRevisions[index],
						)
					)
						fail(
							"revision_conflict",
							"User configuration changed while acquiring locks. Read it before saving again.",
						);
					for (const mutation of mutations) {
						if (mutation.checkBase && !equal(leaf(active.raw, mutation.segments), mutation.baseValue))
							fail("revision_conflict", "A pending user setting conflicts with an external edit.");
						for (let length = 1; length < mutation.segments.length; length++) {
							const parent = leaf(active.raw, mutation.segments.slice(0, length));
							if (parent !== undefined && parent !== null && !isRecord(parent))
								fail("invalid_config", "Setting parent must be a mapping.");
						}
					}
					const prepare = (loaded: LoadedSide) => {
						const edits = mutations.flatMap(mutation =>
							mutation.value === undefined ? this.#resetMutations(loaded.raw, mutation.segments) : [mutation],
						);
						return {
							edits,
							source: edits.reduce(
								(source, mutation) => setYamlConfigValue(source, mutation.segments, mutation.value),
								loaded.source,
							),
						};
					};
					const activePrepared = prepare(active);
					const commit = async (
						loaded: LoadedSide,
						prepared: { edits: readonly UserSettingMutation[]; source: string },
					) => {
						const { edits, source } = prepared;
						if (edits.every(mutation => equal(leaf(loaded.raw, mutation.segments), mutation.value))) {
							receipt.write = { status: "unchanged" };
							return;
						}
						const temp = `${loaded.file}.${randomUUID()}.tmp`;
						let publishing = false;
						try {
							await fs.mkdir(path.dirname(loaded.file), { recursive: true, mode: 0o700 });
							const handle = await fs.open(temp, "wx", 0o600);
							try {
								await handle.writeFile(source, "utf8");
								await handle.sync();
							} finally {
								await handle.close();
							}
							publishing = true;
							await replaceFileAtomically(temp, loaded.file);
							const readback = await this.#load(this.#activeDir);
							if (
								readback.file !== loaded.file ||
								readback.message ||
								!edits.every(mutation => equal(leaf(readback.raw, mutation.segments), mutation.value))
							)
								throw new Error("Configuration readback could not confirm the saved fields.");
							receipt.write = { status: "saved" };
						} catch (error) {
							receipt.write = { status: publishing ? "unknown" : "failed", message: String(error) };
							receipt.saveState = publishing ? "unknown" : "failed";
							fail("persistence_failed", "User configuration persistence did not complete.");
						} finally {
							await fs.rm(temp, { force: true }).catch(() => {});
						}
					};
					await commit(active, activePrepared);
					receipt.saveState = "complete";
					return receipt;
				});
			};
			return await locked();
		} catch (error) {
			if (error instanceof UserSettingError) throw error;
			return fail("execution_failed", String(error));
		}
	}
}
