import { expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SpecSavedRun } from "../../src/spec-driven/types";
import {
	contentText,
	continuationText,
	IMPLEMENTATION,
	IMPLEMENTATION_PATH,
	MARKER,
	REQUIREMENT,
	respond,
	rolePayload,
} from "./provider-fixture";
import {
	clearNativeDraft,
	entry,
	eventually,
	expectNativeFailure,
	nativeMessageEntries,
	nativeTranscript,
	tuiTest,
	withTui,
} from "./tui-harness";

test.skipIf(!tuiTest || process.platform === "win32")(
	"real TUI owners share a Git subtree, survive process restart and clear only corrupt Dev state",
	async () => {
		await withTui(
			{
				async setup(cwd) {
					const child = Bun.spawn(["git", "init", "--quiet", cwd], { stdout: "pipe", stderr: "pipe" });
					const error = await new Response(child.stderr).text();
					if (await child.exited) throw new Error(`Cannot prepare real Git worktree: ${error}`);
					await fs.mkdir(path.join(cwd, "src/nested"), { recursive: true });
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state, idle, stage, open, restart }) => {
				const preserved = path.join(cwd, "owner-note.txt");
				await Bun.write(preserved, "unrelated user change\n");
				await tui("submit", "/dev");
				await idle();
				await tui("submit", "/dev config");
				await tui("expect", "text", "方案 Team", "--timeout", "30000");
				await tui("key", "press", "Up", "Enter");
				await eventually(state, value => value.team);
				const peer = await open(path.join(cwd, "src/nested"));
				const beforeOccupied = await state();
				const calls = provider.requests.length;
				await peer.tui("submit", "/dev");
				await peer.tui("expect", "text", "Dev 工作区已被占用", "--timeout", "30000");
				expect(await peer.tui("text", "--full")).toContain("ordinary-root-beacon");
				expect(await state()).toEqual(beforeOccupied);
				expect(provider.requests).toHaveLength(calls);
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await clearNativeDraft(peer.tui);
				await peer.tui("submit", "/dev");
				await eventually(
					() => peer.tui("text"),
					screen => screen.split("\n").some(line => line.includes("Dev ·") && /Team[\s:：]+开/u.test(line)),
				);
				expect((await state()).team).toBe(true);
				expect(await Bun.file(path.join(cwd, "src/nested/.omp/dev/state.json")).exists()).toBe(false);
				await peer.tui("submit", "/dev");
				await peer.tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await peer.close();
				await restart();
				const beforeRestore = provider.requests.length;
				await tui("submit", "/dev");
				await idle();
				expect(provider.requests).toHaveLength(beforeRestore);
				expect(await state()).toEqual(beforeOccupied);
				await tui("submit", `/dev new ${REQUIREMENT}`);
				const saved = (await stage("requirements")).run!;
				const savedRequirementsTranscript = await nativeTranscript(saved, "requirements");
				expect((await state()).team).toBe(true);
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await restart();
				const callsBeforeRunRestore = provider.requests.length;
				await tui("submit", "/dev");
				const recovered = (await stage("requirements")).run!;
				expect(provider.requests).toHaveLength(callsBeforeRunRestore);
				expect((await state()).run?.runId).toBe(saved.runId);
				expect(Object.keys(recovered.sessions).sort()).toEqual(Object.keys(saved.sessions).sort());
				for (const role of Object.keys(saved.sessions) as Array<keyof SpecSavedRun["sessions"]>) {
					expect(recovered.sessions[role]?.role).toBe(saved.sessions[role]?.role);
					expect(recovered.sessions[role]?.sessionId).toBe(saved.sessions[role]?.sessionId);
					expect(recovered.sessions[role]?.sessionFile).toBe(saved.sessions[role]?.sessionFile);
				}
				expect(nativeMessageEntries(await nativeTranscript(recovered, "requirements"))).toEqual(
					nativeMessageEntries(savedRequirementsTranscript),
				);
				await tui("submit", "/dev");
				await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
				await Bun.write(path.join(cwd, ".omp/dev/state.json"), "{broken-old-dev-state");
				await tui("submit", "/dev");
				await tui("expect", "text", "旧 Dev 状态无法恢复，已清除", "--timeout", "30000");
				await idle();
				expect((await state()).team).toBe(false);
				expect((await state()).run).toBeUndefined();
				expect(provider.requests).toHaveLength(callsBeforeRunRestore);
				expect(await Bun.file(preserved).text()).toBe("unrelated user change\n");
				expect(await nativeTranscript(saved, "requirements")).toContain(REQUIREMENT);
				for (const file of entry(provider, "requirements").outputPaths as string[])
					expect(await Bun.file(path.join(cwd, file.replace(/\*+/, "greeting"))).exists()).toBe(true);
			},
		);
	},
	300_000,
);

test.skipIf(!tuiTest)(
	"real atomic state publication failures reject configuration and phase advancement without starting dependent work",
	async () => {
		await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle }) => {
			const statePath = path.join(cwd, ".omp/dev/state.json");
			async function obstruct(work: () => Promise<void>): Promise<void> {
				const errors: unknown[] = [];
				if (process.platform === "win32") {
					const kernel = dlopen("kernel32.dll", {
						CreateFileW: {
							args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
							returns: FFIType.ptr,
						},
						CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
						GetLastError: { args: [], returns: FFIType.u32 },
					});
					try {
						const name = new Uint16Array([...statePath.split("").map(character => character.charCodeAt(0)), 0]);
						// Allow real reads/writes, but deny atomic rename/delete while
						// leaving the active native journal and its directory untouched.
						const handle = kernel.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, 0x80, null);
						if (!handle || Number(handle) === -1 || Number(handle) === Number(0xffffffffffffffffn))
							throw new Error(`Cannot acquire fixture save obstruction: ${kernel.symbols.GetLastError()}`);
						try {
							await work();
						} catch (error) {
							errors.push(error);
						} finally {
							if (!kernel.symbols.CloseHandle(handle))
								errors.push(new Error("Cannot release fixture save obstruction"));
						}
					} finally {
						kernel.close();
					}
				} else {
					const backup = `${statePath}.fixture-backup-${crypto.randomUUID()}`;
					await fs.rename(statePath, backup);
					let occupied = false;
					try {
						await fs.mkdir(statePath);
						occupied = true;
						await work();
					} catch (error) {
						errors.push(error);
					} finally {
						try {
							if (occupied) await fs.rmdir(statePath);
							await fs.rename(backup, statePath);
						} catch (cleanupError) {
							errors.push(cleanupError);
						}
					}
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "Dev fixture work and restoration failed");
			}
			await tui("submit", "/dev");
			await idle();
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Enter");
			await eventually(() => Bun.file(statePath).exists(), Boolean);
			const saved = await state();
			const calls = provider.requests.length;
			await obstruct(async () => {
				await tui("submit", "/dev config");
				await tui("expect", "text", "方案 Team", "--timeout", "30000");
				await tui("key", "press", "Up", "Enter");
				await expectNativeFailure(tui, /EBUSY|ENOENT|EISDIR|EPERM|EACCES|EEXIST|ENOTDIR/);
				expect(provider.requests).toHaveLength(calls);
			});
			expect(await state()).toEqual(saved);
			await clearNativeDraft(tui, "/dev config");
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const original = await stage("requirements");
			await tui("expect", "text", "文件已写入。请检查实际交付文件", "--timeout", "30000");
			await idle();
			const beforeNext = provider.requests.length;
			await obstruct(async () => {
				await tui("submit", "/dev next");
				await expectNativeFailure(tui, /EBUSY|ENOENT|EISDIR|EPERM|EACCES|EEXIST|ENOTDIR/, ".omp/dev", "/dev next");
				expect(provider.requests).toHaveLength(beforeNext);
			});
			expect(await state()).toEqual(original);
			await clearNativeDraft(tui);
			await tui("submit", "/dev next");
			await stage("solution");
			expect((await state()).team).toBe(false);
		});
	},
	180_000,
);

test.skipIf(!tuiTest || process.platform === "win32")(
	"a real provider authentication failure retains the created requirements run for explicit native continuation",
	async () => {
		await withTui({ authFailureOnce: true }, [100, 28], async ({ provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await tui("expect", "text", "Local mock authentication rejected", "--timeout", "30000");
			const failed = (await stage("requirements")).run!;
			expect(failed.sessions.requirements?.sessionId).toBeString();
			expect((await state()).team).toBe(false);
			await clearNativeDraft(tui, `/dev new ${REQUIREMENT}`);
			await tui("submit", "请继续澄清需求，不批准。");
			await tui("expect", "text", `${MARKER}_REQUIREMENTS_DIALOGUE`, "--timeout", "30000");
			await idle();
			expect((await state()).run?.runId).toBe(failed.runId);
			expect((await state()).run?.sessions.requirements?.sessionId).toBe(failed.sessions.requirements?.sessionId);
			expect(provider.requests.filter(request => rolePayload(request)?.specDrivenRole === "solution")).toHaveLength(
				0,
			);
		});
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"requirements native wiki remains read-only and an authorized document hardlink cannot mutate a business alias",
	async () => {
		let proposal = "";
		let blockedCall = "";
		await withTui(
			{
				wikiQuery: "deterministic-greeting-contract",
				dialogue(request) {
					if (continuationText(request) !== "probe-linked-document") return respond(request);
					const lastUser = request.messages.findLastIndex(
						message => message.role === "user" && contentText(message.content) === "probe-linked-document",
					);
					const result = request.messages.slice(lastUser + 1).find(message => message.role === "tool");
					if (result) {
						blockedCall = result.tool_call_id ?? "";
						return { text: "native-linked-document-probe-settled" };
					}
					const write = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === "write")?.function;
					if (!write)
						throw new Error("Requirements write must be exercised at the real native permission boundary");
					return {
						tool: {
							name: write.name,
							args: {
								i: "Probing document alias restriction",
								path: proposal,
								content: "unauthorized alias mutation\n",
							},
						},
					};
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state, stage, idle }) => {
				await tui("submit", "/dev");
				await idle();
				await tui("submit", `/dev new ${REQUIREMENT}`);
				const run = (await stage("requirements")).run!;
				const originalTranscript = await nativeTranscript(run, "requirements");
				expect(originalTranscript).toContain("deterministic-greeting-contract");
				expect(originalTranscript).toContain('"toolName":"wiki"');
				proposal = (entry(provider, "requirements").outputPaths as string[])[0]!;
				const original = await Bun.file(path.join(cwd, proposal)).text();
				const business = path.join(cwd, "business-note.txt");
				await Bun.write(business, "user-owned business content\n");
				await fs.unlink(path.join(cwd, proposal));
				await fs.link(business, path.join(cwd, proposal));
				await tui("submit", "probe-linked-document");
				await tui("expect", "text", "native-linked-document-probe-settled", "--timeout", "30000");
				await idle();
				expect(await Bun.file(business).text()).toBe("user-owned business content\n");
				expect(blockedCall).toBeString();
				const rows = (await nativeTranscript(run, "requirements"))
					.trim()
					.split("\n")
					.map(line => JSON.parse(line) as { message?: { toolCallId?: string; isError?: boolean } });
				expect(rows.some(row => row.message?.toolCallId === blockedCall && row.message.isError)).toBe(true);
				expect((await state()).run?.phase).toBe("requirements");
				await fs.unlink(path.join(cwd, proposal));
				await Bun.write(path.join(cwd, proposal), original);
				await tui("submit", "/dev next");
				await stage("solution");
				expect(await Bun.file(business).text()).toBe("user-owned business content\n");
			},
		);
	},
	180_000,
);

for (const action of ["retry", "drop"] as const) {
	test.skipIf(!tuiTest)(
		`real archive destination conflict preserves accepted execution and ${action} does not invent synchronization progress`,
		async () => {
			await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle }) => {
				await tui("submit", "/dev");
				await idle();
				await tui("submit", `/dev new ${REQUIREMENT}`);
				await stage("requirements");
				await tui("submit", "/dev next");
				await stage("solution");
				await tui("submit", "/dev next pure");
				await stage("planning");
				await tui("submit", "/dev next");
				const executing = (await stage("executing")).run!;
				const report = (entry(provider, "executor").outputPaths as string[])[0]!;
				const originalReport = await Bun.file(path.join(cwd, report)).text();
				const date = new Date().toISOString().slice(0, 10);
				const destination = path.join(cwd, "openspec/changes/archive", `${date}-${executing.changeId}`);
				await fs.mkdir(destination, { recursive: true });
				const calls = provider.requests.length;
				await tui("submit", "/dev next");
				await expectNativeFailure(tui, /OpenSpec archive failed/, "archive_target_exists", "/dev next");
				await idle();
				const failed = (await state()).run!;
				expect(failed.phase).toBe("executing");
				expect(failed.sessions.executor?.sessionId).toBe(executing.sessions.executor?.sessionId);
				expect(failed.closing?.synced).not.toBe(true);
				expect(failed.archivedChangePath).toBeUndefined();
				expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).exists()).toBe(false);
				expect(provider.requests).toHaveLength(calls);
				await clearNativeDraft(tui);
				if (action === "retry") {
					await fs.rmdir(destination);
					await tui("submit", "/dev next");
					await eventually(state, value => !!value.run?.archivedChangePath);
					await idle();
					expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).text()).toContain(REQUIREMENT);
				} else {
					await tui("submit", "/dev drop");
					await eventually(state, value => !value.run && !value.team);
					await idle();
					expect((await state()).run).toBeUndefined();
					expect(await fs.readdir(destination)).toEqual([]);
					expect(
						await Bun.file(path.join(cwd, `openspec/changes/${executing.changeId}/proposal.md`)).exists(),
					).toBe(true);
					expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
				}
				expect(await Bun.file(path.join(cwd, report)).text()).toBe(originalReport);
				expect(provider.requests).toHaveLength(calls);
			});
		},
		180_000,
	);
}

test.skipIf(!tuiTest)(
	"a real non-file Dev state blocks drop and entry without claiming cleanup, and restoring the boundary permits drop retry",
	async () => {
		await withTui({}, [100, 28], async ({ cwd, provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const original = await stage("requirements");
			const statePath = path.join(cwd, ".omp/dev/state.json");
			const backup = `${statePath}.fixture-recovery`;
			const before = provider.requests.length;
			await fs.rename(statePath, backup);
			await fs.mkdir(statePath);
			try {
				await tui("submit", "/dev drop");
				// Bun's real directory-read error has EISDIR but no pathname.
				await expectNativeFailure(tui, /EISDIR|EPERM|EACCES/);
				await clearNativeDraft(tui, "/dev drop");
				expect((await fs.stat(statePath)).isDirectory()).toBe(true);
				expect(await Bun.file(backup).json()).toEqual(original);
				expect(provider.requests).toHaveLength(before);
				await tui("submit", `/dev new ${REQUIREMENT}`);
				await tui("expect", "text", "已有流程，请先丢弃", "--timeout", "30000");
				expect(provider.requests).toHaveLength(before);
				await clearNativeDraft(tui, `/dev new ${REQUIREMENT}`);
				await tui("type", "cleanup-error-keeps-native-editor");
				await tui("expect", "text", "cleanup-error-keeps-native-editor", "--timeout", "30000");
				expect(await nativeTranscript(original.run!, "requirements")).toContain(REQUIREMENT);
			} finally {
				await fs.rmdir(statePath);
				await fs.rename(backup, statePath);
			}
			await clearNativeDraft(tui);
			await tui("submit", "/dev drop");
			await eventually(state, value => !value.run && !value.team);
			await idle();
			expect((await state()).team).toBe(false);
			expect((await state()).run).toBeUndefined();
			expect(provider.requests).toHaveLength(before);
			expect(await nativeTranscript(original.run!, "requirements")).toContain(REQUIREMENT);
			await tui("submit", "/dev");
			await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
			await fs.rename(statePath, backup);
			await fs.mkdir(statePath);
			try {
				await tui("submit", "/dev");
				// Entry failed before Dev acquired the UI; this is an ordinary
				// root error, not the fixed Dev error row checked by the helper.
				await eventually(
					() => tui("text"),
					screen => !screen.includes("Dev ·") && /EISDIR|EPERM|EACCES/.test(screen),
				);
				expect(await tui("text", "--full")).toContain("ordinary-root-beacon");
				expect((await fs.stat(statePath)).isDirectory()).toBe(true);
				expect(provider.requests).toHaveLength(before);
				await clearNativeDraft(tui, "/dev");
				await tui("type", "failed-entry-keeps-root-editor");
				await tui("expect", "text", "failed-entry-keeps-root-editor", "--timeout", "30000");
			} finally {
				await fs.rmdir(statePath);
				await fs.rename(backup, statePath);
			}
			await clearNativeDraft(tui);
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const fresh = (await stage("requirements")).run!;
			expect(fresh.runId).not.toBe(original.run!.runId);
		});
	},
	180_000,
);

test.skipIf(!tuiTest || process.platform !== "win32")(
	"Windows real read-share handle prevents corrupt Dev state deletion until explicit entry retries cleanup",
	async () => {
		await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Up", "Enter");
			await eventually(state, value => value.team);
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const original = (await stage("requirements")).run!;
			await tui("submit", "/dev");
			await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
			const statePath = path.join(cwd, ".omp/dev/state.json");
			const corrupt = "{unrecoverable-state-with-a-real-delete-sharing-obstruction";
			await Bun.write(statePath, corrupt);
			const calls = provider.requests.length;
			const kernel = dlopen("kernel32.dll", {
				CreateFileW: {
					args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
					returns: FFIType.ptr,
				},
				CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
				GetLastError: { args: [], returns: FFIType.u32 },
			});
			try {
				const name = new Uint16Array([...statePath.split("").map(character => character.charCodeAt(0)), 0]);
				// GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING.
				// This is local to the isolated fixture file: reads work, but Windows
				// refuses unlink/rename while this real handle omits FILE_SHARE_DELETE.
				const handle = kernel.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, 0x80, null);
				if (!handle || Number(handle) === -1 || Number(handle) === Number(0xffffffffffffffffn))
					throw new Error(`Cannot acquire fixture deletion-sharing obstruction: ${kernel.symbols.GetLastError()}`);
				const handleErrors: unknown[] = [];
				try {
					await tui("submit", "/dev");
					// Corrupt-state cleanup failed during ordinary-root entry.
					await eventually(
						() => tui("text"),
						screen => !screen.includes("Dev ·") && /EBUSY|EPERM|EACCES|sharing|access.*denied/i.test(screen),
					);
					expect(await Bun.file(statePath).text()).toBe(corrupt);
					expect(provider.requests).toHaveLength(calls);
					expect(await tui("text", "--full")).toContain("ordinary-root-beacon");
					await clearNativeDraft(tui, "/dev");
					await tui("type", "failed-delete-keeps-root-input");
					await tui("expect", "text", "failed-delete-keeps-root-input", "--timeout", "30000");
					expect(await nativeTranscript(original, "requirements")).toContain(REQUIREMENT);
				} catch (error) {
					handleErrors.push(error);
				} finally {
					if (!kernel.symbols.CloseHandle(handle))
						handleErrors.push(new Error("Cannot release fixture file handle"));
				}
				if (handleErrors.length)
					throw new AggregateError(handleErrors, "Native file-sharing fixture or cleanup failed");
			} finally {
				kernel.close();
			}
			await clearNativeDraft(tui);
			await tui("submit", "/dev");
			await tui("expect", "text", "旧 Dev 状态无法恢复，已清除", "--timeout", "30000");
			await idle();
			expect((await state()).team).toBe(false);
			expect((await state()).run).toBeUndefined();
			expect(provider.requests).toHaveLength(calls);
			expect(await nativeTranscript(original, "requirements")).toContain(REQUIREMENT);
			for (const file of entry(provider, "requirements").outputPaths as string[])
				expect(await Bun.file(path.join(cwd, file.replace(/\*+/, "greeting"))).exists()).toBe(true);
			await tui("submit", "/dev drop");
			await eventually(state, value => !value.run && !value.team);
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			const current = (await stage("requirements")).run!;
			expect(current.runId).not.toBe(original.runId);
		});
	},
	180_000,
);
