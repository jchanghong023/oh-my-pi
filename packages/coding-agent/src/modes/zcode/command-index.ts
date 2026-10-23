import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as timers from "node:timers/promises";
import type { AgentStorage, CommandIndexRow } from "../../session/agent-storage";
import type { SessionEntry } from "../../session/session-entries";
import { loadSessionFile } from "../../session/session-loader";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../../session/messages";
import type { CommandKey } from "./schema";

interface SourceCommand extends CommandKey {
	fingerprint: string;
	epoch?: string;
}

/** No user/model bodies, attachments or tool output are retained in agent.db. */
export type CommandEvidence =
	| { type: "custom"; customType: string; data: unknown }
	| { type: "message"; message: { inputId: string; sourceCommand?: SourceCommand } }
	| { type: "custom_message"; customType: string; details: { jobId: string } };

export interface CommandJournal {
	id: string;
	path: string;
	entries: readonly CommandEvidence[];
}

export interface CommandIndexSource {
	listCommandJournals(): Promise<readonly string[]>;
	commandIndexStorage(): Promise<AgentStorage>;
	withCommandJournalRead<T>(file: string, read: () => Promise<T>): Promise<T | undefined>;
}

function commandKey(value: unknown): string | null {
	if (!value || typeof value !== "object" || !("commandId" in value) || !("sessionId" in value)) return null;
	if (typeof value.commandId !== "string" || (value.sessionId !== null && typeof value.sessionId !== "string"))
		return null;
	return JSON.stringify([value.sessionId, value.commandId]);
}

export function extractCommandEvidence(entries: readonly SessionEntry[]): CommandEvidence[] {
	const facts: CommandEvidence[] = [];
	for (const entry of entries) {
		if (entry.type === "custom") {
			if (entry.customType === "zcode_command_result" || entry.customType === "zcode_produced_session") {
				facts.push({ type: "custom", customType: entry.customType, data: entry.data });
			} else if (entry.customType === "session_input" || entry.customType === "zcode_tan_admission") {
				const data = entry.data as
					| { inputId?: string; state?: string; sourceCommand?: SourceCommand; jobId?: string; reason?: string }
					| undefined;
				if (data)
					facts.push({
						type: "custom",
						customType: entry.customType,
						data: {
							inputId: data.inputId,
							state: data.state,
							sourceCommand: data.sourceCommand,
							jobId: data.jobId,
							reason: data.reason,
						},
					});
			}
		} else if (entry.type === "message" && "inputId" in entry.message && typeof entry.message.inputId === "string") {
			facts.push({
				type: "message",
				message: {
					inputId: entry.message.inputId,
					sourceCommand:
						"sourceCommand" in entry.message ? (entry.message.sourceCommand as SourceCommand) : undefined,
				},
			});
		} else if (entry.type === "custom_message" && entry.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
			const details: unknown = entry.details;
			if (details && typeof details === "object" && "jobId" in details && typeof details.jobId === "string") {
				facts.push({ type: "custom_message", customType: entry.customType, details: { jobId: details.jobId } });
			}
		}
	}
	return facts;
}

function rowsFor(entries: readonly CommandEvidence[]): CommandIndexRow[] {
	return entries.map((entry, entryOrder) => {
		let key: string | null = null;
		if (entry.type === "message") key = commandKey(entry.message.sourceCommand);
		if (entry.type === "custom" && entry.data && typeof entry.data === "object") {
			if ("key" in entry.data) key = commandKey(entry.data.key);
			else if ("sourceCommand" in entry.data) key = commandKey(entry.data.sourceCommand);
		}
		return { entryOrder, commandKey: key, data: JSON.stringify(entry) };
	});
}

async function versionOf(file: string): Promise<string> {
	const stat = await fs.stat(file, { bigint: true });
	if (!stat.isFile()) throw new Error(`Command journal is not a file: ${file}`);
	// 原子替换、同 ID 重建及外部写入都必须失效；仅 size/mtime 会漏掉同长替换。
	return [1, stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size].join(":");
}

/** A cache, not another fact owner. Every read proves the complete current file inventory first. */
export class ZCodeCommandIndex {
	readonly #source: CommandIndexSource;
	readonly #dirty = new Set<string>();
	readonly #known = new Set<string>();
	#tail: Promise<unknown> = Promise.resolve();

	constructor(source: CommandIndexSource) {
		this.#source = source;
	}

	invalidate(file: string): void {
		this.#dirty.add(path.resolve(file));
	}

	async warm(signal?: AbortSignal): Promise<void> {
		await this.#scan(undefined, signal);
	}

	read(
		keys: readonly CommandKey[],
		accept?: (journals: readonly CommandJournal[]) => boolean,
	): Promise<readonly CommandJournal[]> {
		return this.#serialized(() => this.#scan(keys, undefined, accept));
	}

	#serialized<T>(action: () => Promise<T>): Promise<T> {
		const running = this.#tail.then(action);
		this.#tail = running.catch(() => {});
		return running;
	}

	async #scan(
		keys?: readonly CommandKey[],
		signal?: AbortSignal,
		accept?: (journals: readonly CommandJournal[]) => boolean,
	): Promise<CommandJournal[]> {
		// 暖回填只按文件占用现有串行链；前台可以在文件之间插入，不能被整轮历史扫描挡住。
		const step = <T>(action: () => Promise<T>): Promise<T> => (keys ? action() : this.#serialized(action));
		let storage: AgentStorage | undefined;
		const files = await step(async () => {
			signal?.throwIfAborted();
			// Discovery errors are never an empty scope. A failed database can fall back to the same strict source scan.
			const files = [...new Set((await this.#source.listCommandJournals()).map(file => path.resolve(file)))];
			try {
				storage = await this.#source.commandIndexStorage();
			} catch {
				/* Journal remains authoritative. */
			}
			const current = new Set(files);
			for (const old of this.#known) {
				if (!current.has(old)) {
					try {
						storage?.removeCommandJournal(old);
					} catch {
						storage = undefined;
					}
					this.#known.delete(old);
				}
			}
			return files;
		});
		const result: CommandJournal[] = [];
		const failures: unknown[] = [];
		const encodedKeys = keys?.map(key => JSON.stringify([key.sessionId, key.commandId]));
		for (const file of files) {
			await step(async () => {
				signal?.throwIfAborted();
				try {
					const journal = await this.#source.withCommandJournalRead(file, async () => {
						const before = await versionOf(file);
						if (storage && !this.#dirty.has(file)) {
							let cached: CommandJournal | undefined;
							let covered = false;
							try {
								const coverage = storage.getCommandJournalCoverage(file);
								if (coverage?.version === before) {
									covered = !keys || !storage.commandJournalMatches(file, encodedKeys!);
									if (!covered) {
										const snapshot = storage.readCommandJournal(file);
										if (snapshot.coverage?.version === before)
											cached = {
												id: snapshot.coverage.sessionId,
												path: file,
												entries: snapshot.rows.map(row => JSON.parse(row.data) as CommandEvidence),
											};
									}
								}
							} catch {
								storage = undefined;
							}
							// 正常并发追加使缓存失效时只回源当前文件，不把它误判为坏 journal。
							if ((covered || cached) && (await versionOf(file)) === before) return cached;
						}
						const loaded = await loadSessionFile(file, undefined, { throwIfMissing: true });
						const header = loaded.entries.find(entry => entry.type === "session");
						if (loaded.invalidHeader || loaded.malformedRecords || header?.type !== "session") {
							throw new Error(`Cannot prove command journal coverage: ${file}`);
						}
						const extracted = {
							id: header.id,
							path: file,
							entries: extractCommandEvidence(
								loaded.entries.filter((entry): entry is SessionEntry => entry.type !== "session"),
							),
						};
						// 有效快照仍可用于当前裁决；变动中的文件不能发布完整 coverage。
						if ((await versionOf(file)) === before) {
							try {
								storage?.replaceCommandJournal(
									{ journalPath: file, sessionId: extracted.id, version: before },
									rowsFor(extracted.entries),
								);
							} catch {
								storage = undefined;
							}
							if ((await versionOf(file)) === before) this.#dirty.delete(file);
							else {
								this.#dirty.add(file);
								try {
									storage?.removeCommandJournal(file);
								} catch {
									storage = undefined;
								}
							}
						} else {
							this.#dirty.add(file);
							try {
								storage?.removeCommandJournal(file);
							} catch {
								storage = undefined;
							}
						}
						return extracted;
					});
					this.#known.add(file);
					if (keys && journal) result.push(journal);
				} catch (error) {
					if (!keys) throw error;
					failures.push(error);
				}
			});
			// 只有调用方认可的完整回执才能提前收口；未知或低优先级事实仍需证明全部来源。
			if (keys && accept?.(result)) return result;
			if (signal) await timers.setImmediate();
		}
		// 只有调用方已证明完整回执时才能保留既有早返回语义；缺席和低优先级事实不能吞错。
		if (failures.length && !accept?.(result)) throw failures[0];
		return result;
	}
}
